/**
 * Konvoy Epidemic Mesh Router
 *
 * Receives raw packets from the radio transport layer, deduplicates using
 * the Bloom filter, enforces TTL, and dispatches to the appropriate
 * subsystem handler. Rebroadcasts valid packets to all connected peers
 * (excluding the source) for epidemic flood propagation.
 *
 * Flow:
 *   Radio → Router.handleIncoming() → [Bloom check] → [TTL check]
 *         → dispatch to handler → rebroadcast to peers
 */

import {
  PacketType,
  PacketHeader,
  DecodedPacket,
  decodePacket,
  encodePacket,
  encodeHeader,
  decodeGPSTelemetry,
  decodeHazardPin,
  decodeTopologyDiscovery,
  HEADER_SIZE,
  PROTOCOL_VERSION,
  MAGIC,
  DEFAULT_TTL,
  type GPSTelemetry,
  type HazardPin,
  type TopologyNode,
} from './wire';
import { SlidingBloomFilter } from './bloom';

// ─── Types ───────────────────────────────────────────────────────────────

export type VoiceFrameHandler = (
  senderFingerprint: Uint8Array,
  opusFrame: ArrayBuffer,
  header: PacketHeader,
) => void;

export type GPSTelemetryHandler = (
  senderFingerprint: Uint8Array,
  telemetry: GPSTelemetry,
  header: PacketHeader,
) => void;

export type HazardPinHandler = (
  senderFingerprint: Uint8Array,
  pin: HazardPin,
  header: PacketHeader,
) => void;

export type TopologyHandler = (
  senderFingerprint: Uint8Array,
  node: TopologyNode,
  header: PacketHeader,
) => void;

export type HeartbeatHandler = (
  senderFingerprint: Uint8Array,
  header: PacketHeader,
) => void;

export type SendPacketFn = (peerId: string, data: ArrayBuffer) => void;
export type GetConnectedPeersFn = () => string[];

export interface RouterHandlers {
  onVoiceFrame?: VoiceFrameHandler;
  onGPSTelemetry?: GPSTelemetryHandler;
  onHazardPin?: HazardPinHandler;
  onTopology?: TopologyHandler;
  onHeartbeat?: HeartbeatHandler;
}

export interface RouterStats {
  packetsReceived: number;
  packetsDroppedDuplicate: number;
  packetsDroppedTTL: number;
  packetsDroppedInvalid: number;
  packetsForwarded: number;
  packetsDispatched: number;
}

// ─── Router ──────────────────────────────────────────────────────────────

export class MeshRouter {
  private bloomFilter: SlidingBloomFilter;
  private handlers: RouterHandlers = {};
  private sendPacket: SendPacketFn | null = null;
  private getConnectedPeers: GetConnectedPeersFn | null = null;

  // Stats
  private stats: RouterStats = {
    packetsReceived: 0,
    packetsDroppedDuplicate: 0,
    packetsDroppedTTL: 0,
    packetsDroppedInvalid: 0,
    packetsForwarded: 0,
    packetsDispatched: 0,
  };

  constructor(bloomFilter?: SlidingBloomFilter) {
    this.bloomFilter = bloomFilter ?? new SlidingBloomFilter();
  }

  /**
   * Register the transport layer's send function and peer list accessor.
   */
  setTransport(sendPacket: SendPacketFn, getConnectedPeers: GetConnectedPeersFn): void {
    this.sendPacket = sendPacket;
    this.getConnectedPeers = getConnectedPeers;
  }

  /**
   * Register handlers for each packet type.
   */
  setHandlers(handlers: RouterHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  /**
   * Process an incoming raw packet from the radio layer.
   *
   * @param sourcePeerId - The peer ID of the direct sender (used to exclude from rebroadcast).
   * @param rawPacket - The raw binary packet (header + payload).
   * @returns true if the packet was processed, false if dropped.
   */
  handleIncoming(sourcePeerId: string, rawPacket: ArrayBuffer): boolean {
    this.stats.packetsReceived++;

    // 1. Decode header
    let decoded: DecodedPacket;
    try {
      decoded = decodePacket(rawPacket);
    } catch (err) {
      this.stats.packetsDroppedInvalid++;
      return false;
    }

    const { header, payload } = decoded;

    // 2. Bloom filter deduplication
    if (this.bloomFilter.mightContain(header.packetId)) {
      this.stats.packetsDroppedDuplicate++;
      return false;
    }

    // Insert into Bloom filter immediately
    this.bloomFilter.insert(header.packetId);

    // 3. TTL enforcement
    if (header.ttl <= 0) {
      this.stats.packetsDroppedTTL++;
      return false;
    }

    // 4. Dispatch to handler
    this.dispatch(header, payload);
    this.stats.packetsDispatched++;

    // 5. Rebroadcast with decremented TTL (if TTL > 1)
    if (header.ttl > 1) {
      this.rebroadcast(sourcePeerId, header, payload);
    }

    return true;
  }

  /**
   * Originate a new packet from this node.
   * Inserts into Bloom filter and sends to all connected peers.
   *
   * @param header - The packet header (TTL, type, etc. must be set).
   * @param payload - The payload buffer.
   */
  originatePacket(header: PacketHeader, payload: ArrayBuffer): void {
    // Mark our own packet in the Bloom filter to prevent self-echo
    this.bloomFilter.insert(header.packetId);

    // Build complete packet
    const packet = encodePacket(header, payload);

    // Send to all connected peers
    if (this.sendPacket && this.getConnectedPeers) {
      const peers = this.getConnectedPeers();
      for (const peerId of peers) {
        this.sendPacket(peerId, packet);
      }
      this.stats.packetsForwarded += peers.length;
    }
  }

  /**
   * Dispatch a decoded packet to the registered handler.
   */
  private dispatch(header: PacketHeader, payload: ArrayBuffer): void {
    switch (header.type) {
      case PacketType.Voice:
        this.handlers.onVoiceFrame?.(header.senderFingerprint, payload, header);
        break;

      case PacketType.GPSTelemetry:
        try {
          const telemetry = decodeGPSTelemetry(payload);
          this.handlers.onGPSTelemetry?.(header.senderFingerprint, telemetry, header);
        } catch {
          this.stats.packetsDroppedInvalid++;
        }
        break;

      case PacketType.HazardPin:
        try {
          const pin = decodeHazardPin(payload);
          this.handlers.onHazardPin?.(header.senderFingerprint, pin, header);
        } catch {
          this.stats.packetsDroppedInvalid++;
        }
        break;

      case PacketType.TopologyDiscovery:
        try {
          const node = decodeTopologyDiscovery(payload);
          this.handlers.onTopology?.(header.senderFingerprint, node, header);
        } catch {
          this.stats.packetsDroppedInvalid++;
        }
        break;

      case PacketType.Heartbeat:
        this.handlers.onHeartbeat?.(header.senderFingerprint, header);
        break;

      default:
        this.stats.packetsDroppedInvalid++;
        break;
    }
  }

  /**
   * Rebroadcast a packet to all connected peers except the source.
   * Decrements TTL before forwarding.
   */
  private rebroadcast(
    sourcePeerId: string,
    originalHeader: PacketHeader,
    payload: ArrayBuffer,
  ): void {
    if (!this.sendPacket || !this.getConnectedPeers) return;

    // Create a new header with decremented TTL
    const forwardHeader: PacketHeader = {
      ...originalHeader,
      ttl: originalHeader.ttl - 1,
    };

    const packet = encodePacket(forwardHeader, payload);
    const peers = this.getConnectedPeers();

    for (const peerId of peers) {
      if (peerId !== sourcePeerId) {
        this.sendPacket(peerId, packet);
        this.stats.packetsForwarded++;
      }
    }
  }

  /**
   * Get router statistics.
   */
  getStats(): RouterStats {
    return { ...this.stats };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = {
      packetsReceived: 0,
      packetsDroppedDuplicate: 0,
      packetsDroppedTTL: 0,
      packetsDroppedInvalid: 0,
      packetsForwarded: 0,
      packetsDispatched: 0,
    };
  }

  /**
   * Get the underlying Bloom filter (for testing/diagnostics).
   */
  getBloomFilter(): SlidingBloomFilter {
    return this.bloomFilter;
  }
}
