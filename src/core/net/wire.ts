/**
 * Konvoy Wire Protocol — 64-byte header + typed payloads.
 *
 * All multi-byte integers are big-endian.
 * Header layout:
 *   0x00  2  Magic (0x4B56 = "KV")
 *   0x02  1  Protocol Version
 *   0x03  1  Packet Type
 *   0x04  1  Hop Limit / TTL
 *   0x05  1  Flags
 *   0x06  2  Sequence Number
 *   0x08  8  Packet ID (BLAKE3 nonce)
 *   0x10  8  Channel Token Hash
 *   0x18  16 Sender PK Fingerprint
 *   0x28  2  Payload Size
 *   0x2A  2  CRC-16/CCITT checksum (over 0x00–0x29)
 *   0x2C  20 Reserved padding
 *   ----
 *   Total: 64 bytes (0x40)
 */

// ─── Constants ───────────────────────────────────────────────────────────

export const HEADER_SIZE = 64;
export const MAGIC = 0x4b56; // "KV"
export const PROTOCOL_VERSION = 0x01;
export const DEFAULT_TTL = 0x04;

// ─── Enums ───────────────────────────────────────────────────────────────

export enum PacketType {
  Voice = 0x01,
  GPSTelemetry = 0x02,
  HazardPin = 0x03,
  TopologyDiscovery = 0x04,
  Heartbeat = 0x05,
}

export enum HazardType {
  Police = 0x01,
  Accident = 0x02,
  RoadHazard = 0x03,
  Congestion = 0x04,
}

export enum Flags {
  Encrypted = 1 << 0,
  Compressed = 1 << 1,
  RelayForwarded = 1 << 2,
  RequiresAck = 1 << 3,
}

// ─── Types ───────────────────────────────────────────────────────────────

export interface PacketHeader {
  magic: number;
  version: number;
  type: PacketType;
  ttl: number;
  flags: number;
  sequenceNumber: number;
  packetId: Uint8Array; // 8 bytes
  channelToken: Uint8Array; // 8 bytes
  senderFingerprint: Uint8Array; // 16 bytes
  payloadSize: number;
  checksum: number;
}

export interface GPSTelemetry {
  latitude: number; // degrees
  longitude: number; // degrees
  heading: number; // degrees (0–360)
  speed: number; // km/h
  timestamp: number; // Unix epoch seconds
  altitude: number; // meters (signed)
  accuracy: number; // meters
}

export interface HazardPin {
  hazardType: HazardType;
  latitude: number;
  longitude: number;
  createdAt: number;
  ttlSeconds: number;
  pinId: Uint8Array; // 8 bytes
  senderFingerprint: Uint8Array; // 16 bytes
}

export interface TopologyNode {
  nodeFingerprint: Uint8Array; // 16 bytes
  radioCaps: number; // bitfield: bit0=BLE, bit1=WiFiDirect, bit2=WiFiAware
  batteryLevel: number; // 0–100
  latitude: number;
  longitude: number;
  peerCount: number;
  channelCount: number;
  uptime: number; // seconds
}

export interface DecodedPacket {
  header: PacketHeader;
  payload: ArrayBuffer;
}

// ─── CRC-16/CCITT ────────────────────────────────────────────────────────

/**
 * CRC-16/CCITT (polynomial 0x1021, init 0xFFFF).
 * Computed over the first 42 bytes of the header (0x00–0x29).
 */
export function crc16ccitt(data: Uint8Array, start: number, length: number): number {
  let crc = 0xffff;
  for (let i = start; i < start + length; i++) {
    crc ^= (data[i]! << 8) & 0xffff;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc;
}

// ─── Coordinate Encoding ─────────────────────────────────────────────────

/** Encode degrees to int32 (degrees × 1e7). Precision: ~1.1cm */
function encodeCoord(degrees: number): number {
  return Math.round(degrees * 1e7);
}

/** Decode int32 back to degrees */
function decodeCoord(encoded: number): number {
  return encoded / 1e7;
}

// ─── Header Codec ────────────────────────────────────────────────────────

export function encodeHeader(header: PacketHeader): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER_SIZE);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // Magic
  view.setUint16(0x00, MAGIC, false);
  // Protocol Version
  view.setUint8(0x02, header.version);
  // Packet Type
  view.setUint8(0x03, header.type);
  // TTL
  view.setUint8(0x04, header.ttl);
  // Flags
  view.setUint8(0x05, header.flags);
  // Sequence Number
  view.setUint16(0x06, header.sequenceNumber, false);
  // Packet ID (8 bytes)
  bytes.set(header.packetId.subarray(0, 8), 0x08);
  // Channel Token (8 bytes)
  bytes.set(header.channelToken.subarray(0, 8), 0x10);
  // Sender Fingerprint (16 bytes)
  bytes.set(header.senderFingerprint.subarray(0, 16), 0x18);
  // Payload Size
  view.setUint16(0x28, header.payloadSize, false);

  // CRC-16 over bytes 0x00–0x29 (42 bytes)
  const checksum = crc16ccitt(bytes, 0x00, 0x2a);
  view.setUint16(0x2a, checksum, false);

  // Reserved padding (0x2C–0x3F) is already zeroed

  return buf;
}

export function decodeHeader(buffer: ArrayBuffer): PacketHeader {
  if (buffer.byteLength < HEADER_SIZE) {
    throw new Error(`Header too short: ${buffer.byteLength} < ${HEADER_SIZE}`);
  }

  const view = new DataView(buffer, 0, HEADER_SIZE);
  const bytes = new Uint8Array(buffer, 0, HEADER_SIZE);

  const magic = view.getUint16(0x00, false);
  if (magic !== MAGIC) {
    throw new Error(`Invalid magic: 0x${magic.toString(16)} (expected 0x4B56)`);
  }

  const version = view.getUint8(0x02);
  if (version !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version: ${version}`);
  }

  // Verify CRC
  const storedChecksum = view.getUint16(0x2a, false);
  const computedChecksum = crc16ccitt(bytes, 0x00, 0x2a);
  if (storedChecksum !== computedChecksum) {
    throw new Error(
      `CRC mismatch: stored=0x${storedChecksum.toString(16)} computed=0x${computedChecksum.toString(16)}`
    );
  }

  return {
    magic,
    version,
    type: view.getUint8(0x03) as PacketType,
    ttl: view.getUint8(0x04),
    flags: view.getUint8(0x05),
    sequenceNumber: view.getUint16(0x06, false),
    packetId: new Uint8Array(buffer.slice(0x08, 0x10)),
    channelToken: new Uint8Array(buffer.slice(0x10, 0x18)),
    senderFingerprint: new Uint8Array(buffer.slice(0x18, 0x28)),
    payloadSize: view.getUint16(0x28, false),
    checksum: storedChecksum,
  };
}

// ─── Full Packet Codec ───────────────────────────────────────────────────

/**
 * Assemble a complete packet: 64-byte header + payload.
 */
export function encodePacket(header: PacketHeader, payload: ArrayBuffer): ArrayBuffer {
  const headerBuf = encodeHeader(header);
  const packet = new Uint8Array(HEADER_SIZE + payload.byteLength);
  packet.set(new Uint8Array(headerBuf), 0);
  packet.set(new Uint8Array(payload), HEADER_SIZE);
  return packet.buffer;
}

/**
 * Split a raw buffer into header + payload.
 */
export function decodePacket(buffer: ArrayBuffer): DecodedPacket {
  const header = decodeHeader(buffer);
  const payload = buffer.slice(HEADER_SIZE, HEADER_SIZE + header.payloadSize);
  return { header, payload };
}

// ─── Payload: GPS Telemetry (0x02) — 26 bytes ───────────────────────────

export const GPS_PAYLOAD_SIZE = 26;

export function encodeGPSTelemetry(telem: GPSTelemetry): ArrayBuffer {
  const buf = new ArrayBuffer(GPS_PAYLOAD_SIZE);
  const view = new DataView(buf);

  view.setInt32(0, encodeCoord(telem.latitude), false);
  view.setInt32(4, encodeCoord(telem.longitude), false);
  view.setUint16(8, Math.round(telem.heading * 100), false);
  view.setUint16(10, Math.round(telem.speed * 100), false);
  view.setUint32(12, telem.timestamp >>> 0, false); // lower 32 bits
  view.setInt16(16, Math.round(telem.altitude), false);
  view.setUint16(18, Math.round(telem.accuracy * 10), false);
  // bytes 20–25: padding (zeroed)

  return buf;
}

export function decodeGPSTelemetry(payload: ArrayBuffer): GPSTelemetry {
  if (payload.byteLength < GPS_PAYLOAD_SIZE) {
    throw new Error(`GPS payload too short: ${payload.byteLength} < ${GPS_PAYLOAD_SIZE}`);
  }
  const view = new DataView(payload);

  return {
    latitude: decodeCoord(view.getInt32(0, false)),
    longitude: decodeCoord(view.getInt32(4, false)),
    heading: view.getUint16(8, false) / 100,
    speed: view.getUint16(10, false) / 100,
    timestamp: view.getUint32(12, false),
    altitude: view.getInt16(16, false),
    accuracy: view.getUint16(18, false) / 10,
  };
}

// ─── Payload: Hazard Pin (0x03) — 41 bytes ───────────────────────────────

export const HAZARD_PAYLOAD_SIZE = 41;

export function encodeHazardPin(pin: HazardPin): ArrayBuffer {
  const buf = new ArrayBuffer(HAZARD_PAYLOAD_SIZE);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  view.setUint8(0, pin.hazardType);
  view.setInt32(1, encodeCoord(pin.latitude), false);
  view.setInt32(5, encodeCoord(pin.longitude), false);
  view.setUint32(9, pin.createdAt, false);
  view.setUint32(13, pin.ttlSeconds, false);
  bytes.set(pin.pinId.subarray(0, 8), 17);
  bytes.set(pin.senderFingerprint.subarray(0, 16), 25);

  return buf;
}

export function decodeHazardPin(payload: ArrayBuffer): HazardPin {
  if (payload.byteLength < HAZARD_PAYLOAD_SIZE) {
    throw new Error(`Hazard payload too short: ${payload.byteLength} < ${HAZARD_PAYLOAD_SIZE}`);
  }
  const view = new DataView(payload);
  const bytes = new Uint8Array(payload);

  return {
    hazardType: view.getUint8(0) as HazardType,
    latitude: decodeCoord(view.getInt32(1, false)),
    longitude: decodeCoord(view.getInt32(5, false)),
    createdAt: view.getUint32(9, false),
    ttlSeconds: view.getUint32(13, false),
    pinId: new Uint8Array(payload.slice(17, 25)),
    senderFingerprint: new Uint8Array(payload.slice(25, 41)),
  };
}

// ─── Payload: Topology Discovery (0x04) — 34 bytes ──────────────────────

export const TOPOLOGY_PAYLOAD_SIZE = 34;

export function encodeTopologyDiscovery(node: TopologyNode): ArrayBuffer {
  const buf = new ArrayBuffer(TOPOLOGY_PAYLOAD_SIZE);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  bytes.set(node.nodeFingerprint.subarray(0, 16), 0);
  view.setUint8(16, node.radioCaps);
  view.setUint8(17, Math.min(node.batteryLevel, 100));
  view.setInt32(18, encodeCoord(node.latitude), false);
  view.setInt32(22, encodeCoord(node.longitude), false);
  view.setUint16(26, node.peerCount, false);
  view.setUint16(28, node.channelCount, false);
  view.setUint32(30, node.uptime, false);

  return buf;
}

export function decodeTopologyDiscovery(payload: ArrayBuffer): TopologyNode {
  if (payload.byteLength < TOPOLOGY_PAYLOAD_SIZE) {
    throw new Error(`Topology payload too short: ${payload.byteLength} < ${TOPOLOGY_PAYLOAD_SIZE}`);
  }
  const view = new DataView(payload);

  return {
    nodeFingerprint: new Uint8Array(payload.slice(0, 16)),
    radioCaps: view.getUint8(16),
    batteryLevel: view.getUint8(17),
    latitude: decodeCoord(view.getInt32(18, false)),
    longitude: decodeCoord(view.getInt32(22, false)),
    peerCount: view.getUint16(26, false),
    channelCount: view.getUint16(28, false),
    uptime: view.getUint32(30, false),
  };
}
