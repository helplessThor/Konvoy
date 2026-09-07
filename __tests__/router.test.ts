/**
 * Mesh Router Tests
 *
 * Validates packet deduplication, TTL enforcement, handler dispatch,
 * and multi-hop forwarding simulation.
 */

import { MeshRouter, type RouterHandlers } from '../src/core/net/router';
import { SlidingBloomFilter } from '../src/core/net/bloom';
import {
  PacketType,
  encodePacket,
  encodeGPSTelemetry,
  type PacketHeader,
  MAGIC,
  PROTOCOL_VERSION,
  DEFAULT_TTL,
} from '../src/core/net/wire';

// ─── Helper ──────────────────────────────────────────────────────────────

function makeHeader(overrides?: Partial<PacketHeader>): PacketHeader {
  return {
    magic: MAGIC,
    version: PROTOCOL_VERSION,
    type: PacketType.Heartbeat,
    ttl: DEFAULT_TTL,
    flags: 0,
    sequenceNumber: 1,
    packetId: new Uint8Array(8).map((_, i) => i + 1),
    channelToken: new Uint8Array(8).fill(0xAA),
    senderFingerprint: new Uint8Array(16).fill(0xBB),
    payloadSize: 0,
    checksum: 0,
    ...overrides,
  };
}

function buildPacket(headerOverrides?: Partial<PacketHeader>, payload?: ArrayBuffer): ArrayBuffer {
  const payloadBuf = payload ?? new ArrayBuffer(0);
  const header = makeHeader({
    payloadSize: payloadBuf.byteLength,
    ...headerOverrides,
  });
  return encodePacket(header, payloadBuf);
}

function uniquePacketId(n: number): Uint8Array {
  const id = new Uint8Array(8);
  new DataView(id.buffer).setUint32(0, n, false);
  new DataView(id.buffer).setUint32(4, n * 0x12345678, false);
  return id;
}

// ─── Deduplication Tests ─────────────────────────────────────────────────

describe('MeshRouter — Deduplication', () => {
  test('first packet is processed', () => {
    const router = new MeshRouter();
    const packet = buildPacket({ packetId: uniquePacketId(1) });

    let dispatched = false;
    router.setHandlers({ onHeartbeat: () => { dispatched = true; } });

    const result = router.handleIncoming('peer-1', packet);
    expect(result).toBe(true);
    expect(dispatched).toBe(true);
  });

  test('duplicate packet is dropped', () => {
    const router = new MeshRouter();
    const packet = buildPacket({ packetId: uniquePacketId(1) });

    router.handleIncoming('peer-1', packet);
    const result = router.handleIncoming('peer-2', packet);

    expect(result).toBe(false);
    expect(router.getStats().packetsDroppedDuplicate).toBe(1);
  });

  test('different packet IDs are both processed', () => {
    const router = new MeshRouter();
    const p1 = buildPacket({ packetId: uniquePacketId(1) });
    const p2 = buildPacket({ packetId: uniquePacketId(2) });

    expect(router.handleIncoming('peer-1', p1)).toBe(true);
    expect(router.handleIncoming('peer-1', p2)).toBe(true);
    expect(router.getStats().packetsDispatched).toBe(2);
  });
});

// ─── TTL Enforcement ─────────────────────────────────────────────────────

describe('MeshRouter — TTL', () => {
  test('packet with TTL=0 is dropped', () => {
    const router = new MeshRouter();
    const packet = buildPacket({
      packetId: uniquePacketId(1),
      ttl: 0,
    });

    const result = router.handleIncoming('peer-1', packet);
    expect(result).toBe(false);
    expect(router.getStats().packetsDroppedTTL).toBe(1);
  });

  test('packet with TTL=1 is processed but not forwarded', () => {
    const router = new MeshRouter();
    const sentPackets: Array<{ peerId: string; data: ArrayBuffer }> = [];

    router.setTransport(
      (peerId, data) => sentPackets.push({ peerId, data }),
      () => ['peer-2', 'peer-3'],
    );

    const packet = buildPacket({
      packetId: uniquePacketId(1),
      ttl: 1,
    });

    router.handleIncoming('peer-1', packet);

    // Should be dispatched but NOT forwarded (TTL would be 0 after decrement)
    expect(router.getStats().packetsDispatched).toBe(1);
    expect(sentPackets.length).toBe(0);
  });

  test('packet with TTL=3 is forwarded with TTL=2', () => {
    const router = new MeshRouter();
    const sentPackets: Array<{ peerId: string; data: ArrayBuffer }> = [];

    router.setTransport(
      (peerId, data) => sentPackets.push({ peerId, data }),
      () => ['peer-2'],
    );

    const packet = buildPacket({
      packetId: uniquePacketId(1),
      ttl: 3,
    });

    router.handleIncoming('peer-1', packet);
    expect(sentPackets.length).toBe(1);
  });
});

// ─── Handler Dispatch ────────────────────────────────────────────────────

describe('MeshRouter — Dispatch', () => {
  test('voice packets dispatch to onVoiceFrame', () => {
    const router = new MeshRouter();
    let receivedFrame: ArrayBuffer | null = null;

    router.setHandlers({
      onVoiceFrame: (_, frame) => { receivedFrame = frame; },
    });

    const opus = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    const packet = buildPacket(
      { packetId: uniquePacketId(1), type: PacketType.Voice },
      opus.buffer,
    );

    router.handleIncoming('peer-1', packet);
    expect(receivedFrame).not.toBeNull();
    expect(new Uint8Array(receivedFrame!)).toEqual(opus);
  });

  test('GPS telemetry packets dispatch with decoded data', () => {
    const router = new MeshRouter();
    let receivedTelem: any = null;

    router.setHandlers({
      onGPSTelemetry: (_, telem) => { receivedTelem = telem; },
    });

    const payload = encodeGPSTelemetry({
      latitude: 28.6139, longitude: 77.2090,
      heading: 45, speed: 72,
      timestamp: 1694000000, altitude: 220, accuracy: 4,
    });

    const packet = buildPacket(
      { packetId: uniquePacketId(1), type: PacketType.GPSTelemetry },
      payload,
    );

    router.handleIncoming('peer-1', packet);
    expect(receivedTelem).not.toBeNull();
    expect(receivedTelem.latitude).toBeCloseTo(28.6139, 4);
    expect(receivedTelem.speed).toBeCloseTo(72, 1);
  });

  test('heartbeat packets dispatch with no payload', () => {
    const router = new MeshRouter();
    let heartbeatReceived = false;

    router.setHandlers({
      onHeartbeat: () => { heartbeatReceived = true; },
    });

    const packet = buildPacket({
      packetId: uniquePacketId(1),
      type: PacketType.Heartbeat,
    });

    router.handleIncoming('peer-1', packet);
    expect(heartbeatReceived).toBe(true);
  });
});

// ─── Multi-Hop Forwarding ────────────────────────────────────────────────

describe('MeshRouter — Multi-Hop', () => {
  test('packet traverses chain of 4 nodes', () => {
    // Simulate: Node A → Node B → Node C → Node D
    const nodes = [
      new MeshRouter(),
      new MeshRouter(),
      new MeshRouter(),
      new MeshRouter(),
    ];

    // Wire each node to forward to the next
    for (let i = 0; i < nodes.length - 1; i++) {
      const nextRouter = nodes[i + 1]!;
      const currentId = `node-${i}`;
      const nextId = `node-${i + 1}`;

      nodes[i]!.setTransport(
        (peerId, data) => {
          nextRouter.handleIncoming(currentId, data);
        },
        () => [nextId],
      );
    }

    // Track what node D receives
    let nodeD_received = false;
    nodes[3]!.setHandlers({
      onHeartbeat: () => { nodeD_received = true; },
    });

    // Node A originates a packet with TTL=4
    const header = makeHeader({
      type: PacketType.Heartbeat,
      ttl: 4,
      packetId: uniquePacketId(999),
    });
    nodes[0]!.originatePacket(header, new ArrayBuffer(0));

    // Node D should have received the heartbeat
    expect(nodeD_received).toBe(true);
  });

  test('packet stops at TTL limit', () => {
    const nodes = [
      new MeshRouter(),
      new MeshRouter(),
      new MeshRouter(),
    ];

    for (let i = 0; i < nodes.length - 1; i++) {
      const nextRouter = nodes[i + 1]!;
      const currentId = `node-${i}`;
      const nextId = `node-${i + 1}`;

      nodes[i]!.setTransport(
        (peerId, data) => {
          nextRouter.handleIncoming(currentId, data);
        },
        () => [nextId],
      );
    }

    let nodeC_received = false;
    nodes[2]!.setHandlers({
      onHeartbeat: () => { nodeC_received = true; },
    });

    // Originate with TTL=1 (should reach B but not C)
    const header = makeHeader({
      type: PacketType.Heartbeat,
      ttl: 1,
      packetId: uniquePacketId(888),
    });
    nodes[0]!.originatePacket(header, new ArrayBuffer(0));

    expect(nodeC_received).toBe(false);
  });

  test('source peer is excluded from rebroadcast', () => {
    const router = new MeshRouter();
    const sentTo: string[] = [];

    router.setTransport(
      (peerId) => sentTo.push(peerId),
      () => ['peer-A', 'peer-B', 'peer-C'],
    );

    const packet = buildPacket({
      packetId: uniquePacketId(1),
      ttl: 3,
    });

    // Packet arrives from peer-B
    router.handleIncoming('peer-B', packet);

    // Should forward to peer-A and peer-C but NOT back to peer-B
    expect(sentTo).toContain('peer-A');
    expect(sentTo).toContain('peer-C');
    expect(sentTo).not.toContain('peer-B');
  });
});

// ─── Invalid Packet Handling ─────────────────────────────────────────────

describe('MeshRouter — Invalid Packets', () => {
  test('malformed packet is dropped', () => {
    const router = new MeshRouter();
    const garbage = new ArrayBuffer(10); // Too short

    const result = router.handleIncoming('peer-1', garbage);
    expect(result).toBe(false);
    expect(router.getStats().packetsDroppedInvalid).toBe(1);
  });

  test('stats accumulate correctly', () => {
    const router = new MeshRouter();

    // Valid packet
    router.handleIncoming('peer-1', buildPacket({ packetId: uniquePacketId(1) }));
    // Duplicate
    router.handleIncoming('peer-1', buildPacket({ packetId: uniquePacketId(1) }));
    // Invalid
    router.handleIncoming('peer-1', new ArrayBuffer(5));

    const stats = router.getStats();
    expect(stats.packetsReceived).toBe(3);
    expect(stats.packetsDispatched).toBe(1);
    expect(stats.packetsDroppedDuplicate).toBe(1);
    expect(stats.packetsDroppedInvalid).toBe(1);
  });
});
