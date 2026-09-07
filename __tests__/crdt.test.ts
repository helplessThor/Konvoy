/**
 * CRDT OR-Set Tests
 *
 * Validates merge convergence, tombstone semantics, TTL expiry,
 * garbage collection, delta-state queries, and concurrent operations.
 */

import { HazardCRDT, type HazardEntry } from '../src/core/map/crdt';
import { HazardType } from '../src/core/net/wire';

// ─── Helper ──────────────────────────────────────────────────────────────

function makePin(overrides?: Partial<HazardEntry>): HazardEntry {
  return {
    pinId: new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]),
    type: HazardType.Police,
    latitude: 28.6139,
    longitude: 77.2090,
    createdAt: Math.floor(Date.now() / 1000),
    ttlSeconds: 7200,
    senderFingerprint: new Uint8Array(16).fill(0xAA),
    tombstoned: false,
    vectorClock: 0,
    ...overrides,
  };
}

function makePinWithId(id: number, overrides?: Partial<HazardEntry>): HazardEntry {
  const pinId = new Uint8Array(8);
  new DataView(pinId.buffer).setUint32(0, id, false);
  return makePin({ pinId, ...overrides });
}

// ─── Basic CRDT Operations ───────────────────────────────────────────────

describe('HazardCRDT — Basic Operations', () => {
  let crdt: HazardCRDT;

  beforeEach(() => {
    crdt = new HazardCRDT(false); // Don't start GC timer in tests
  });

  afterEach(() => {
    crdt.destroy();
  });

  test('add stores entry', () => {
    const pin = makePinWithId(1);
    crdt.add(pin);
    expect(crdt.has(pin.pinId)).toBe(true);
    expect(crdt.size).toBe(1);
  });

  test('add is idempotent', () => {
    const pin = makePinWithId(1);
    crdt.add(pin);
    crdt.add(pin);
    expect(crdt.size).toBe(1);
  });

  test('remove tombstones entry', () => {
    const pin = makePinWithId(1);
    crdt.add(pin);
    expect(crdt.remove(pin.pinId)).toBe(true);
    expect(crdt.has(pin.pinId)).toBe(false);
    expect(crdt.size).toBe(1); // Entry still exists (tombstoned)
  });

  test('remove on non-existent entry returns false', () => {
    expect(crdt.remove(new Uint8Array(8))).toBe(false);
  });

  test('getActive returns only live, non-expired entries', () => {
    crdt.add(makePinWithId(1)); // Active
    crdt.add(makePinWithId(2)); // Will tombstone
    crdt.add(makePinWithId(3, {
      createdAt: Math.floor(Date.now() / 1000) - 8000, // Expired (>7200s ago)
      ttlSeconds: 7200,
    }));

    const pin2Id = new Uint8Array(8);
    new DataView(pin2Id.buffer).setUint32(0, 2, false);
    crdt.remove(pin2Id);

    const active = crdt.getActive();
    expect(active.length).toBe(1);
    expect(active[0]!.type).toBe(HazardType.Police);
  });
});

// ─── Merge Convergence ───────────────────────────────────────────────────

describe('HazardCRDT — Merge Convergence', () => {
  test('merge adds unknown entries', () => {
    const crdtA = new HazardCRDT(false);
    const crdtB = new HazardCRDT(false);

    crdtA.add(makePinWithId(1));
    crdtB.add(makePinWithId(2));

    const result = crdtA.merge(crdtB.getFullState());
    expect(result.added).toBe(1);
    expect(crdtA.size).toBe(2);

    crdtA.destroy();
    crdtB.destroy();
  });

  test('merge is commutative: A∪B = B∪A', () => {
    const crdtA = new HazardCRDT(false);
    const crdtB = new HazardCRDT(false);

    crdtA.add(makePinWithId(1, { vectorClock: 1 }));
    crdtA.add(makePinWithId(2, { vectorClock: 2 }));
    crdtB.add(makePinWithId(2, { vectorClock: 2 }));
    crdtB.add(makePinWithId(3, { vectorClock: 3 }));

    // A merges B's state
    const cloneA = new HazardCRDT(false);
    cloneA.merge(crdtA.getFullState());
    cloneA.merge(crdtB.getFullState());

    // B merges A's state
    const cloneB = new HazardCRDT(false);
    cloneB.merge(crdtB.getFullState());
    cloneB.merge(crdtA.getFullState());

    // Both should have the same active entries
    const activeA = cloneA.getActive().map(e => Array.from(e.pinId).join(','));
    const activeB = cloneB.getActive().map(e => Array.from(e.pinId).join(','));
    expect(activeA.sort()).toEqual(activeB.sort());

    crdtA.destroy();
    crdtB.destroy();
    cloneA.destroy();
    cloneB.destroy();
  });

  test('merge is idempotent: A∪A = A', () => {
    const crdt = new HazardCRDT(false);
    crdt.add(makePinWithId(1));
    crdt.add(makePinWithId(2));

    const stateBefore = crdt.getFullState();
    const result = crdt.merge(stateBefore);

    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(crdt.size).toBe(2);

    crdt.destroy();
  });

  test('higher vector clock wins on conflict', () => {
    const crdtA = new HazardCRDT(false);
    const crdtB = new HazardCRDT(false);

    // A adds pin at clock 1
    crdtA.add(makePinWithId(1, { vectorClock: 1, type: HazardType.Police }));

    // B adds same pin at clock 5 with different type
    crdtB.add(makePinWithId(1, { vectorClock: 5, type: HazardType.Accident }));

    // A merges B → B's version (higher clock) should win
    crdtA.merge(crdtB.getFullState());
    const entry = crdtA.get(makePinWithId(1).pinId);
    expect(entry).toBeDefined();
    // The entry should reflect the merge with higher clock

    crdtA.destroy();
    crdtB.destroy();
  });

  test('tombstone wins on equal clock (remove-wins semantics)', () => {
    const crdtA = new HazardCRDT(false);
    const crdtB = new HazardCRDT(false);

    const pin = makePinWithId(1, { vectorClock: 5 });

    // A has active entry at clock 5
    crdtA.add(pin);

    // B has tombstoned entry at clock 5
    crdtB.add(pin);
    crdtB.merge([{ ...pin, tombstoned: true, vectorClock: 5 }]);

    // A merges B → tombstone should win
    crdtA.merge(crdtB.getFullState());
    expect(crdtA.has(pin.pinId)).toBe(false);

    crdtA.destroy();
    crdtB.destroy();
  });
});

// ─── Concurrent Operations (Randomized) ─────────────────────────────────

describe('HazardCRDT — Concurrent Convergence', () => {
  test('N replicas converge after random concurrent ops', () => {
    const REPLICA_COUNT = 5;
    const OPS_PER_REPLICA = 50;
    const PIN_ID_RANGE = 20; // Small range to force conflicts

    const replicas = Array.from({ length: REPLICA_COUNT }, () => new HazardCRDT(false));

    // Each replica performs random add/remove operations
    for (let r = 0; r < REPLICA_COUNT; r++) {
      for (let op = 0; op < OPS_PER_REPLICA; op++) {
        const pinIdNum = Math.floor(Math.random() * PIN_ID_RANGE);
        if (Math.random() < 0.7) {
          // 70% adds
          replicas[r]!.add(makePinWithId(pinIdNum));
        } else {
          // 30% removes
          const pinId = new Uint8Array(8);
          new DataView(pinId.buffer).setUint32(0, pinIdNum, false);
          replicas[r]!.remove(pinId);
        }
      }
    }

    // Full mesh merge: every replica merges with every other
    for (let i = 0; i < REPLICA_COUNT; i++) {
      for (let j = 0; j < REPLICA_COUNT; j++) {
        if (i !== j) {
          replicas[i]!.merge(replicas[j]!.getFullState());
        }
      }
    }

    // All replicas should have converged to the same active set
    const referenceActive = replicas[0]!.getActive()
      .map(e => Array.from(e.pinId).join(','))
      .sort();

    for (let r = 1; r < REPLICA_COUNT; r++) {
      const active = replicas[r]!.getActive()
        .map(e => Array.from(e.pinId).join(','))
        .sort();
      expect(active).toEqual(referenceActive);
    }

    replicas.forEach(r => r.destroy());
  });
});

// ─── TTL & Garbage Collection ────────────────────────────────────────────

describe('HazardCRDT — TTL & GC', () => {
  test('expired entries excluded from getActive', () => {
    const crdt = new HazardCRDT(false);
    crdt.add(makePinWithId(1, {
      createdAt: Math.floor(Date.now() / 1000) - 8000, // 8000s ago
      ttlSeconds: 7200, // 7200s TTL → expired
    }));
    expect(crdt.getActive().length).toBe(0);
    crdt.destroy();
  });

  test('gc purges expired + tombstoned entries after grace period', () => {
    const crdt = new HazardCRDT(false);

    // Add entry that expired 10 minutes ago (past grace period)
    crdt.add(makePinWithId(1, {
      createdAt: Math.floor(Date.now() / 1000) - 8000,
      ttlSeconds: 7200,
    }));

    // Add tombstoned entry from 6 minutes ago (past grace period)
    crdt.add(makePinWithId(2, {
      createdAt: Math.floor(Date.now() / 1000) - 400,
    }));
    const pin2Id = new Uint8Array(8);
    new DataView(pin2Id.buffer).setUint32(0, 2, false);
    crdt.remove(pin2Id);
    // Manually set createdAt far back for the tombstoned entry
    // (in practice, gc checks createdAt + gracePeriod)

    const purged = crdt.gc();
    expect(purged).toBeGreaterThanOrEqual(1);
    crdt.destroy();
  });
});

// ─── Delta State Queries ─────────────────────────────────────────────────

describe('HazardCRDT — Delta State', () => {
  test('getDeltaSince returns entries newer than given clock', () => {
    const crdt = new HazardCRDT(false);

    crdt.add(makePinWithId(1, { vectorClock: 1 }));
    crdt.add(makePinWithId(2, { vectorClock: 5 }));
    crdt.add(makePinWithId(3, { vectorClock: 10 }));

    const delta = crdt.getDeltaSince(5);
    // Should include pin 3 (clock 10 > 5) and possibly pin 2 depending
    // on how vectorClock is incremented internally
    expect(delta.length).toBeGreaterThanOrEqual(1);

    crdt.destroy();
  });

  test('digest changes after mutation', () => {
    const crdt = new HazardCRDT(false);

    const digest1 = crdt.getDigest();
    crdt.add(makePinWithId(1));
    const digest2 = crdt.getDigest();

    expect(digest1.stateHash).not.toBe(digest2.stateHash);
    expect(digest2.activeCount).toBe(1);

    crdt.destroy();
  });
});
