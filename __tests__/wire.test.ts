/**
 * Wire Protocol Codec Tests
 *
 * Validates encode → decode round-trip for all packet types,
 * CRC integrity, coordinate precision, and error handling.
 */

import {
  encodeHeader,
  decodeHeader,
  encodePacket,
  decodePacket,
  encodeGPSTelemetry,
  decodeGPSTelemetry,
  encodeHazardPin,
  decodeHazardPin,
  encodeTopologyDiscovery,
  decodeTopologyDiscovery,
  crc16ccitt,
  PacketType,
  HazardType,
  Flags,
  HEADER_SIZE,
  MAGIC,
  PROTOCOL_VERSION,
  DEFAULT_TTL,
  GPS_PAYLOAD_SIZE,
  HAZARD_PAYLOAD_SIZE,
  TOPOLOGY_PAYLOAD_SIZE,
  type PacketHeader,
  type GPSTelemetry,
  type HazardPin,
  type TopologyNode,
} from '../src/core/net/wire';

// ─── Helper ──────────────────────────────────────────────────────────────

function makeHeader(overrides?: Partial<PacketHeader>): PacketHeader {
  return {
    magic: MAGIC,
    version: PROTOCOL_VERSION,
    type: PacketType.Heartbeat,
    ttl: DEFAULT_TTL,
    flags: 0,
    sequenceNumber: 42,
    packetId: new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]),
    channelToken: new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x11, 0x22]),
    senderFingerprint: new Uint8Array(16).fill(0x42),
    payloadSize: 0,
    checksum: 0,
    ...overrides,
  };
}

// ─── Header Tests ────────────────────────────────────────────────────────

describe('Wire Protocol — Header', () => {
  test('header encodes to exactly 64 bytes', () => {
    const header = makeHeader();
    const buf = encodeHeader(header);
    expect(buf.byteLength).toBe(HEADER_SIZE);
    expect(buf.byteLength).toBe(64);
  });

  test('header round-trip preserves all fields', () => {
    const original = makeHeader({
      type: PacketType.Voice,
      ttl: 3,
      flags: Flags.Encrypted | Flags.RequiresAck,
      sequenceNumber: 0xBEEF,
      payloadSize: 160,
    });

    const encoded = encodeHeader(original);
    const decoded = decodeHeader(encoded);

    expect(decoded.magic).toBe(MAGIC);
    expect(decoded.version).toBe(PROTOCOL_VERSION);
    expect(decoded.type).toBe(PacketType.Voice);
    expect(decoded.ttl).toBe(3);
    expect(decoded.flags).toBe(Flags.Encrypted | Flags.RequiresAck);
    expect(decoded.sequenceNumber).toBe(0xBEEF);
    expect(decoded.payloadSize).toBe(160);
    expect(Array.from(decoded.packetId)).toEqual([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    expect(Array.from(decoded.channelToken)).toEqual([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x11, 0x22]);
    expect(Array.from(decoded.senderFingerprint)).toEqual(Array(16).fill(0x42));
  });

  test('magic word is KV (0x4B56)', () => {
    const buf = encodeHeader(makeHeader());
    const view = new DataView(buf);
    expect(view.getUint16(0, false)).toBe(0x4B56);
  });

  test('rejects invalid magic', () => {
    const buf = encodeHeader(makeHeader());
    const bytes = new Uint8Array(buf);
    bytes[0] = 0xFF; // Corrupt magic
    expect(() => decodeHeader(buf)).toThrow(/Invalid magic/);
  });

  test('rejects invalid protocol version', () => {
    const buf = encodeHeader(makeHeader());
    const bytes = new Uint8Array(buf);
    bytes[2] = 0x99; // Bad version
    // Need to recompute CRC for this test to work
    const crc = crc16ccitt(bytes, 0, 0x2a);
    const view = new DataView(buf);
    view.setUint16(0x2a, crc, false);
    expect(() => decodeHeader(buf)).toThrow(/Unsupported protocol version/);
  });

  test('CRC detects corruption', () => {
    const buf = encodeHeader(makeHeader());
    const bytes = new Uint8Array(buf);
    // Corrupt a payload field without updating CRC
    bytes[0x04] = 0xFF; // Change TTL
    expect(() => decodeHeader(buf)).toThrow(/CRC mismatch/);
  });

  test('rejects buffer shorter than 64 bytes', () => {
    const buf = new ArrayBuffer(32);
    expect(() => decodeHeader(buf)).toThrow(/Header too short/);
  });

  test('all packet types encode as expected byte value', () => {
    for (const [name, value] of [
      ['Voice', 0x01],
      ['GPSTelemetry', 0x02],
      ['HazardPin', 0x03],
      ['TopologyDiscovery', 0x04],
      ['Heartbeat', 0x05],
    ] as const) {
      const header = makeHeader({ type: value as PacketType });
      const buf = encodeHeader(header);
      const view = new DataView(buf);
      expect(view.getUint8(0x03)).toBe(value);
    }
  });
});

// ─── Full Packet Tests ───────────────────────────────────────────────────

describe('Wire Protocol — Full Packet', () => {
  test('packet = header + payload', () => {
    const payload = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    const header = makeHeader({ type: PacketType.Voice, payloadSize: payload.length });
    const packet = encodePacket(header, payload.buffer);

    expect(packet.byteLength).toBe(HEADER_SIZE + 4);
  });

  test('packet round-trip preserves payload', () => {
    const payload = new Uint8Array(160);
    for (let i = 0; i < 160; i++) payload[i] = i % 256;

    const header = makeHeader({ type: PacketType.Voice, payloadSize: 160 });
    const packet = encodePacket(header, payload.buffer);
    const decoded = decodePacket(packet);

    expect(decoded.header.type).toBe(PacketType.Voice);
    expect(decoded.header.payloadSize).toBe(160);
    expect(new Uint8Array(decoded.payload)).toEqual(payload);
  });

  test('heartbeat packet has zero-length payload', () => {
    const header = makeHeader({ type: PacketType.Heartbeat, payloadSize: 0 });
    const packet = encodePacket(header, new ArrayBuffer(0));
    expect(packet.byteLength).toBe(HEADER_SIZE);

    const decoded = decodePacket(packet);
    expect(decoded.header.type).toBe(PacketType.Heartbeat);
    expect(decoded.payload.byteLength).toBe(0);
  });
});

// ─── GPS Telemetry Tests ─────────────────────────────────────────────────

describe('Wire Protocol — GPS Telemetry', () => {
  test('payload size is exactly 26 bytes', () => {
    const payload = encodeGPSTelemetry({
      latitude: 28.6139, longitude: 77.2090,
      heading: 45.5, speed: 72.3,
      timestamp: 1694000000, altitude: 220, accuracy: 4.5,
    });
    expect(payload.byteLength).toBe(GPS_PAYLOAD_SIZE);
  });

  test('round-trip preserves coordinates with ≤1.1cm precision', () => {
    const original: GPSTelemetry = {
      latitude: 28.6138901,    // Delhi
      longitude: 77.2090214,
      heading: 123.45,
      speed: 87.65,
      timestamp: 1694000000,
      altitude: -12,           // Below sea level
      accuracy: 3.2,
    };

    const encoded = encodeGPSTelemetry(original);
    const decoded = decodeGPSTelemetry(encoded);

    // Coordinate precision: int32 × 1e7 → ≤1.1cm error
    expect(Math.abs(decoded.latitude - original.latitude)).toBeLessThan(1.1e-7);
    expect(Math.abs(decoded.longitude - original.longitude)).toBeLessThan(1.1e-7);

    // Heading: uint16 × 100 → 0.01° precision
    expect(Math.abs(decoded.heading - original.heading)).toBeLessThan(0.01);

    // Speed: uint16 × 100 → 0.01 km/h precision
    expect(Math.abs(decoded.speed - original.speed)).toBeLessThan(0.01);

    expect(decoded.timestamp).toBe(original.timestamp);
    expect(decoded.altitude).toBe(original.altitude);
    expect(Math.abs(decoded.accuracy - original.accuracy)).toBeLessThan(0.1);
  });

  test('handles negative coordinates (southern/western hemispheres)', () => {
    const original: GPSTelemetry = {
      latitude: -33.8688,    // Sydney
      longitude: 151.2093,
      heading: 0, speed: 0,
      timestamp: 1694000000, altitude: 0, accuracy: 1,
    };

    const decoded = decodeGPSTelemetry(encodeGPSTelemetry(original));
    expect(decoded.latitude).toBeCloseTo(-33.8688, 4);
    expect(decoded.longitude).toBeCloseTo(151.2093, 4);
  });

  test('handles extreme coordinates', () => {
    // North Pole
    const np = decodeGPSTelemetry(encodeGPSTelemetry({
      latitude: 90, longitude: 0,
      heading: 0, speed: 0, timestamp: 0, altitude: 0, accuracy: 0,
    }));
    expect(np.latitude).toBeCloseTo(90, 4);

    // South Pole
    const sp = decodeGPSTelemetry(encodeGPSTelemetry({
      latitude: -90, longitude: -180,
      heading: 360, speed: 0, timestamp: 0, altitude: -420, accuracy: 0,
    }));
    expect(sp.latitude).toBeCloseTo(-90, 4);
    expect(sp.longitude).toBeCloseTo(-180, 4);
    expect(sp.altitude).toBe(-420);
  });
});

// ─── Hazard Pin Tests ────────────────────────────────────────────────────

describe('Wire Protocol — Hazard Pin', () => {
  test('payload size is exactly 41 bytes', () => {
    const payload = encodeHazardPin({
      hazardType: HazardType.Police,
      latitude: 28.6139, longitude: 77.2090,
      createdAt: 1694000000, ttlSeconds: 7200,
      pinId: new Uint8Array(8).fill(0xAA),
      senderFingerprint: new Uint8Array(16).fill(0xBB),
    });
    expect(payload.byteLength).toBe(HAZARD_PAYLOAD_SIZE);
  });

  test('round-trip preserves all hazard types', () => {
    for (const type of [HazardType.Police, HazardType.Accident, HazardType.RoadHazard, HazardType.Congestion]) {
      const pin: HazardPin = {
        hazardType: type,
        latitude: 19.076, longitude: 72.8777, // Mumbai
        createdAt: 1694000000, ttlSeconds: 7200,
        pinId: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        senderFingerprint: new Uint8Array(16).fill(0xCC),
      };
      const decoded = decodeHazardPin(encodeHazardPin(pin));
      expect(decoded.hazardType).toBe(type);
      expect(decoded.ttlSeconds).toBe(7200);
      expect(Array.from(decoded.pinId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    }
  });
});

// ─── Topology Discovery Tests ────────────────────────────────────────────

describe('Wire Protocol — Topology Discovery', () => {
  test('payload size is exactly 34 bytes', () => {
    const payload = encodeTopologyDiscovery({
      nodeFingerprint: new Uint8Array(16).fill(0xDD),
      radioCaps: 0b111, // BLE + WiFiDirect + WiFiAware
      batteryLevel: 85,
      latitude: 28.6139, longitude: 77.2090,
      peerCount: 5, channelCount: 2, uptime: 3600,
    });
    expect(payload.byteLength).toBe(TOPOLOGY_PAYLOAD_SIZE);
  });

  test('round-trip preserves all fields', () => {
    const original: TopologyNode = {
      nodeFingerprint: new Uint8Array(16).map((_, i) => i),
      radioCaps: 0b101, // BLE + WiFiAware
      batteryLevel: 42,
      latitude: 12.9716, longitude: 77.5946, // Bangalore
      peerCount: 12, channelCount: 3, uptime: 86400,
    };
    const decoded = decodeTopologyDiscovery(encodeTopologyDiscovery(original));

    expect(Array.from(decoded.nodeFingerprint)).toEqual(Array.from(original.nodeFingerprint));
    expect(decoded.radioCaps).toBe(0b101);
    expect(decoded.batteryLevel).toBe(42);
    expect(decoded.peerCount).toBe(12);
    expect(decoded.channelCount).toBe(3);
    expect(decoded.uptime).toBe(86400);
  });

  test('battery clamped to 100', () => {
    const node: TopologyNode = {
      nodeFingerprint: new Uint8Array(16),
      radioCaps: 0, batteryLevel: 150, // Over 100
      latitude: 0, longitude: 0,
      peerCount: 0, channelCount: 0, uptime: 0,
    };
    const decoded = decodeTopologyDiscovery(encodeTopologyDiscovery(node));
    expect(decoded.batteryLevel).toBe(100);
  });
});

// ─── CRC-16 Tests ────────────────────────────────────────────────────────

describe('CRC-16/CCITT', () => {
  test('empty input returns 0xFFFF', () => {
    expect(crc16ccitt(new Uint8Array(0), 0, 0)).toBe(0xFFFF);
  });

  test('deterministic for same input', () => {
    const data = new Uint8Array([0x01, 0x02, 0x03]);
    const crc1 = crc16ccitt(data, 0, 3);
    const crc2 = crc16ccitt(data, 0, 3);
    expect(crc1).toBe(crc2);
  });

  test('different inputs produce different CRCs', () => {
    const a = crc16ccitt(new Uint8Array([0x01]), 0, 1);
    const b = crc16ccitt(new Uint8Array([0x02]), 0, 1);
    expect(a).not.toBe(b);
  });
});
