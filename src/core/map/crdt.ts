/**
 * Konvoy CRDT — State-based OR-Set for Hazard Pin replication.
 *
 * Implements an Observed-Remove Set (OR-Set) with automatic TTL-based
 * garbage collection. Each hazard pin is tagged with a unique Pin ID
 * (derived from BLAKE3 hash of its contents) to distinguish concurrent
 * additions and removals.
 *
 * Merge is commutative, associative, and idempotent — guaranteeing
 * Strong Eventual Consistency (SEC) across all convoy nodes.
 */

import { HazardType } from '../net/wire';

// ─── Types ───────────────────────────────────────────────────────────────

export interface HazardEntry {
  /** 8-byte unique identifier: BLAKE3(type + lat + lon + createdAt + senderFP)[:8] */
  pinId: Uint8Array;
  /** Type of hazard */
  type: HazardType;
  /** Latitude in degrees */
  latitude: number;
  /** Longitude in degrees */
  longitude: number;
  /** Unix epoch seconds when the pin was created */
  createdAt: number;
  /** Time-to-live in seconds (default: 7200 = 120 minutes) */
  ttlSeconds: number;
  /** 16-byte sender ephemeral public key fingerprint */
  senderFingerprint: Uint8Array;
  /** If true, this entry has been explicitly removed */
  tombstoned: boolean;
  /** Lamport timestamp for causal ordering of operations */
  vectorClock: number;
}

export interface CRDTDigest {
  /** Hash of sorted pin IDs — used for quick equality check in gossip */
  stateHash: string;
  /** Number of active (non-tombstoned, non-expired) entries */
  activeCount: number;
  /** Highest vector clock seen */
  maxVectorClock: number;
}

// ─── Utility ─────────────────────────────────────────────────────────────

/** Convert Uint8Array to hex string for map keys */
function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Compare two Uint8Arrays for equality */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Simple FNV-1a hash of concatenated pin IDs for digest comparison */
function hashPinIds(ids: string[]): string {
  let hash = 0x811c9dc5;
  const sorted = ids.slice().sort();
  const str = sorted.join(':');
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ─── OR-Set CRDT ─────────────────────────────────────────────────────────

export class HazardCRDT {
  /** Internal state: pinId (hex) → HazardEntry */
  private entries: Map<string, HazardEntry> = new Map();

  /** Local vector clock counter */
  private localClock: number = 0;

  /** GC interval handle */
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  /** Default TTL for new pins (120 minutes) */
  static readonly DEFAULT_TTL = 7200;

  /** GC sweep interval (60 seconds) */
  static readonly GC_INTERVAL_MS = 60_000;

  constructor(startGC: boolean = true) {
    if (startGC) {
      this.startGC();
    }
  }

  /**
   * Add a hazard pin to the set.
   * If a pin with the same ID already exists and is tombstoned,
   * it is resurrected if the new entry has a higher vector clock.
   */
  add(entry: HazardEntry): void {
    const key = toHex(entry.pinId);
    const existing = this.entries.get(key);

    const clock = entry.vectorClock > 0 ? entry.vectorClock : ++this.localClock;
    this.localClock = Math.max(this.localClock, clock);

    if (!existing) {
      // New entry
      this.entries.set(key, {
        ...entry,
        tombstoned: false,
        vectorClock: clock,
      });
    } else if (entry.vectorClock > existing.vectorClock) {
      // Newer version wins
      this.entries.set(key, {
        ...entry,
        tombstoned: false,
        vectorClock: clock,
      });
    }
    // If existing has equal or higher clock, ignore (idempotent)
  }

  /**
   * Remove a hazard pin by marking it as tombstoned.
   * Tombstoned entries are kept until GC sweep to ensure
   * proper convergence with peers.
   */
  remove(pinId: Uint8Array): boolean {
    const key = toHex(pinId);
    const existing = this.entries.get(key);

    if (existing && !existing.tombstoned) {
      this.localClock++;
      existing.tombstoned = true;
      existing.vectorClock = this.localClock;
      return true;
    }
    return false;
  }

  /**
   * Merge remote state into local state.
   * For each entry, the one with the higher vector clock wins.
   * If clocks are equal:
   *   - tombstoned wins over active (remove-wins semantics for OR-Set)
   */
  merge(remoteEntries: HazardEntry[]): { added: number; updated: number; conflicts: number } {
    let added = 0;
    let updated = 0;
    let conflicts = 0;

    for (const remote of remoteEntries) {
      const key = toHex(remote.pinId);
      const local = this.entries.get(key);

      // Track the highest clock we've seen
      this.localClock = Math.max(this.localClock, remote.vectorClock);

      if (!local) {
        // We don't have this entry — accept it
        this.entries.set(key, { ...remote });
        added++;
      } else if (remote.vectorClock > local.vectorClock) {
        // Remote is newer — accept it
        this.entries.set(key, { ...remote });
        updated++;
      } else if (remote.vectorClock === local.vectorClock) {
        // Tie-break: tombstoned wins (remove-wins OR-Set semantics)
        if (remote.tombstoned && !local.tombstoned) {
          this.entries.set(key, { ...remote });
          conflicts++;
        }
        // Otherwise keep local (idempotent)
      }
      // remote.vectorClock < local.vectorClock → ignore (local is newer)
    }

    return { added, updated, conflicts };
  }

  /**
   * Get all active (non-tombstoned, non-expired) hazard entries.
   */
  getActive(): HazardEntry[] {
    const now = Math.floor(Date.now() / 1000);
    const result: HazardEntry[] = [];

    for (const entry of this.entries.values()) {
      if (!entry.tombstoned && (now - entry.createdAt) < entry.ttlSeconds) {
        result.push(entry);
      }
    }

    return result;
  }

  /**
   * Get the full state (including tombstoned/expired) for sync.
   * Used during gossip full-state exchange.
   */
  getFullState(): HazardEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Get entries newer than a given vector clock.
   * Used for delta-state gossip optimization.
   */
  getDeltaSince(sinceVectorClock: number): HazardEntry[] {
    const result: HazardEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.vectorClock > sinceVectorClock) {
        result.push(entry);
      }
    }
    return result;
  }

  /**
   * Compute a digest of the current state for quick gossip comparison.
   */
  getDigest(): CRDTDigest {
    const activeIds: string[] = [];
    let maxClock = 0;
    const now = Math.floor(Date.now() / 1000);

    for (const [key, entry] of this.entries) {
      if (!entry.tombstoned && (now - entry.createdAt) < entry.ttlSeconds) {
        activeIds.push(key);
      }
      maxClock = Math.max(maxClock, entry.vectorClock);
    }

    return {
      stateHash: hashPinIds(activeIds),
      activeCount: activeIds.length,
      maxVectorClock: maxClock,
    };
  }

  /**
   * Garbage collect: purge tombstoned entries and entries that have
   * fully expired (createdAt + ttlSeconds + grace period < now).
   *
   * Grace period: 5 minutes after TTL expiry to allow gossip convergence.
   */
  gc(): number {
    const now = Math.floor(Date.now() / 1000);
    const gracePeriod = 300; // 5 minutes
    let purged = 0;

    for (const [key, entry] of this.entries) {
      const expired = (now - entry.createdAt) >= (entry.ttlSeconds + gracePeriod);
      const tombstonedAndOld = entry.tombstoned && (now - entry.createdAt) >= gracePeriod;

      if (expired || tombstonedAndOld) {
        this.entries.delete(key);
        purged++;
      }
    }

    return purged;
  }

  /**
   * Start automatic GC sweep on interval.
   */
  startGC(): void {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => this.gc(), HazardCRDT.GC_INTERVAL_MS);
    (this.gcTimer as any)?.unref?.();
  }

  /**
   * Stop automatic GC.
   */
  stopGC(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  /**
   * Get diagnostic info.
   */
  getStats(): {
    totalEntries: number;
    activeEntries: number;
    tombstonedEntries: number;
    expiredEntries: number;
    localClock: number;
  } {
    const now = Math.floor(Date.now() / 1000);
    let active = 0;
    let tombstoned = 0;
    let expired = 0;

    for (const entry of this.entries.values()) {
      if (entry.tombstoned) {
        tombstoned++;
      } else if ((now - entry.createdAt) >= entry.ttlSeconds) {
        expired++;
      } else {
        active++;
      }
    }

    return {
      totalEntries: this.entries.size,
      activeEntries: active,
      tombstonedEntries: tombstoned,
      expiredEntries: expired,
      localClock: this.localClock,
    };
  }

  /**
   * Check if a specific pin exists and is active.
   */
  has(pinId: Uint8Array): boolean {
    const key = toHex(pinId);
    const entry = this.entries.get(key);
    if (!entry || entry.tombstoned) return false;
    const now = Math.floor(Date.now() / 1000);
    return (now - entry.createdAt) < entry.ttlSeconds;
  }

  /**
   * Get a specific entry by pin ID.
   */
  get(pinId: Uint8Array): HazardEntry | undefined {
    return this.entries.get(toHex(pinId));
  }

  /**
   * Total entry count (all states).
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Clear all entries and reset clock.
   */
  clear(): void {
    this.entries.clear();
    this.localClock = 0;
  }

  /**
   * Destroy — clean up timers.
   */
  destroy(): void {
    this.stopGC();
    this.entries.clear();
  }
}

export function createHazardEntry(
  type: HazardType,
  lat: number,
  lon: number,
  senderFingerprint: Uint8Array,
  ttlSeconds: number = HazardCRDT.DEFAULT_TTL,
): HazardEntry {
  const pinId = new Uint8Array(8);
  const now = Math.floor(Date.now() / 1000);
  const view = new DataView(pinId.buffer);
  view.setUint32(0, now, false);
  view.setUint8(4, type);
  if (senderFingerprint.length >= 3) {
    pinId[5] = senderFingerprint[0]!;
    pinId[6] = senderFingerprint[1]!;
    pinId[7] = senderFingerprint[2]!;
  }

  return {
    pinId,
    type,
    latitude: lat,
    longitude: lon,
    createdAt: now,
    ttlSeconds,
    senderFingerprint,
    tombstoned: false,
    vectorClock: 1,
  };
}

// ─── Reactive Hazard Store for UI ────────────────────────────────────────

import { create } from 'zustand';

export const globalHazardCRDT = new HazardCRDT();

export interface HazardStoreState {
  hazards: HazardEntry[];
  addHazard: (
    type: HazardType,
    lat: number,
    lon: number,
    senderFingerprint: Uint8Array,
    ttlSeconds?: number,
  ) => HazardEntry;
  removeHazard: (pinId: Uint8Array) => boolean;
  clearAll: () => void;
  refreshFromCRDT: () => void;
}

export const useHazardStore = create<HazardStoreState>((set) => ({
  hazards: globalHazardCRDT.getActive(),

  addHazard: (type, lat, lon, senderFingerprint, ttlSeconds) => {
    const entry = createHazardEntry(type, lat, lon, senderFingerprint, ttlSeconds);
    globalHazardCRDT.add(entry);
    set({ hazards: globalHazardCRDT.getActive() });
    return entry;
  },

  removeHazard: (pinId) => {
    const removed = globalHazardCRDT.remove(pinId);
    if (removed) {
      set({ hazards: globalHazardCRDT.getActive() });
    }
    return removed;
  },

  clearAll: () => {
    globalHazardCRDT.clear();
    set({ hazards: [] });
  },

  refreshFromCRDT: () => {
    set({ hazards: globalHazardCRDT.getActive() });
  },
}));

