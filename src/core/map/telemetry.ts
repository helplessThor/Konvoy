/**
 * Konvoy GPS Telemetry — Delta Vector Broadcasting
 *
 * Manages device location subscriptions, velocity-adaptive broadcast
 * intervals, delta vector encoding, and convoy peer tracking.
 *
 * Broadcast cadence (velocity-adaptive):
 *   - >60 km/h → every 1 second
 *   - 30–60 km/h → every 2 seconds
 *   - <30 km/h → every 3 seconds
 *
 * Maintains a live convoy map of all discovered peers with their
 * latest position, heading, speed, and staleness tracking.
 */

import { create } from 'zustand';
import {
  PacketType,
  encodeGPSTelemetry,
  type GPSTelemetry,
  type PacketHeader,
  MAGIC,
  PROTOCOL_VERSION,
  DEFAULT_TTL,
} from '../net/wire';

// ─── Types ───────────────────────────────────────────────────────────────

export interface ConvoyPeer {
  /** 16-byte fingerprint as hex string */
  fingerprintHex: string;
  /** Last known latitude */
  latitude: number;
  /** Last known longitude */
  longitude: number;
  /** Heading in degrees (0–360) */
  heading: number;
  /** Speed in km/h */
  speed: number;
  /** Altitude in meters */
  altitude: number;
  /** GPS accuracy in meters */
  accuracy: number;
  /** Unix timestamp (seconds) of this reading */
  timestamp: number;
  /** Local reception time (Date.now()) for staleness tracking */
  lastSeenMs: number;
}

export interface OwnPosition {
  latitude: number;
  longitude: number;
  heading: number;
  speed: number;
  altitude: number;
  accuracy: number;
  timestamp: number;
}

export interface TelemetryConfig {
  /** Broadcast interval at high speed (>60 km/h), ms. Default: 1000 */
  highSpeedIntervalMs: number;
  /** Broadcast interval at medium speed (30–60 km/h), ms. Default: 2000 */
  medSpeedIntervalMs: number;
  /** Broadcast interval at low speed (<30 km/h), ms. Default: 3000 */
  lowSpeedIntervalMs: number;
  /** Time (ms) after which a peer is considered stale. Default: 30000 */
  stalePeerThresholdMs: number;
  /** High speed threshold (km/h). Default: 60 */
  highSpeedThreshold: number;
  /** Medium speed threshold (km/h). Default: 30 */
  medSpeedThreshold: number;
}

export interface ConvoyState {
  /** Our own current position */
  ownPosition: OwnPosition | null;
  /** All known convoy peers */
  peers: Map<string, ConvoyPeer>;
  /** Whether telemetry broadcasting is active */
  isBroadcasting: boolean;
  /** Number of active (non-stale) peers */
  activePeerCount: number;
}

// ─── Utility ─────────────────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

// ─── Default Config ──────────────────────────────────────────────────────

const DEFAULT_CONFIG: TelemetryConfig = {
  highSpeedIntervalMs: 1000,
  medSpeedIntervalMs: 2000,
  lowSpeedIntervalMs: 3000,
  stalePeerThresholdMs: 30_000,
  highSpeedThreshold: 60,
  medSpeedThreshold: 30,
};

// ─── Telemetry Manager ──────────────────────────────────────────────────

export type OriginatePacketFn = (header: PacketHeader, payload: ArrayBuffer) => void;

export class TelemetryManager {
  private config: TelemetryConfig;
  private ownPosition: OwnPosition | null = null;
  private peers: Map<string, ConvoyPeer> = new Map();
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private staleGcTimer: ReturnType<typeof setInterval> | null = null;
  private isBroadcasting: boolean = false;

  /** Callbacks */
  private originatePacket: OriginatePacketFn | null = null;
  private getFingerprint: (() => Uint8Array | null) | null = null;
  private getChannelToken: (() => Uint8Array | null) | null = null;
  private onPeersUpdated: ((peers: Map<string, ConvoyPeer>) => void) | null = null;

  /** Sequence counter for outgoing GPS packets */
  private sequenceNumber: number = 0;

  constructor(config?: Partial<TelemetryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set up transport and identity callbacks.
   */
  configure(opts: {
    originatePacket: OriginatePacketFn;
    getFingerprint: () => Uint8Array | null;
    getChannelToken: () => Uint8Array | null;
    onPeersUpdated?: (peers: Map<string, ConvoyPeer>) => void;
  }): void {
    this.originatePacket = opts.originatePacket;
    this.getFingerprint = opts.getFingerprint;
    this.getChannelToken = opts.getChannelToken;
    this.onPeersUpdated = opts.onPeersUpdated ?? null;
  }

  /**
   * Update our own position (called by platform location listener).
   */
  updateOwnPosition(position: OwnPosition): void {
    this.ownPosition = position;
  }

  /**
   * Handle an incoming GPS telemetry packet from a peer.
   */
  handleIncomingTelemetry(senderFingerprint: Uint8Array, telemetry: GPSTelemetry): void {
    const fpHex = toHex(senderFingerprint);

    this.peers.set(fpHex, {
      fingerprintHex: fpHex,
      latitude: telemetry.latitude,
      longitude: telemetry.longitude,
      heading: telemetry.heading,
      speed: telemetry.speed,
      altitude: telemetry.altitude,
      accuracy: telemetry.accuracy,
      timestamp: telemetry.timestamp,
      lastSeenMs: Date.now(),
    });

    this.onPeersUpdated?.(this.peers);
  }

  /**
   * Start velocity-adaptive broadcasting.
   */
  startBroadcasting(): void {
    if (this.isBroadcasting) return;
    this.isBroadcasting = true;
    this.scheduleBroadcast();

    // Start stale peer GC
    this.staleGcTimer = setInterval(
      () => this.evictStalePeers(),
      this.config.stalePeerThresholdMs / 2,
    );
  }

  /**
   * Stop broadcasting.
   */
  stopBroadcasting(): void {
    this.isBroadcasting = false;
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    if (this.staleGcTimer) {
      clearInterval(this.staleGcTimer);
      this.staleGcTimer = null;
    }
  }

  /**
   * Schedule the next broadcast based on current velocity.
   */
  private scheduleBroadcast(): void {
    if (!this.isBroadcasting) return;

    const interval = this.getCurrentInterval();

    this.broadcastTimer = setTimeout(() => {
      this.broadcastPosition();
      this.scheduleBroadcast(); // reschedule with possibly new interval
    }, interval);
  }

  /**
   * Get the broadcast interval based on current speed.
   */
  private getCurrentInterval(): number {
    const speed = this.ownPosition?.speed ?? 0;

    if (speed > this.config.highSpeedThreshold) {
      return this.config.highSpeedIntervalMs;
    } else if (speed > this.config.medSpeedThreshold) {
      return this.config.medSpeedIntervalMs;
    } else {
      return this.config.lowSpeedIntervalMs;
    }
  }

  /**
   * Broadcast our current position as a GPS Telemetry packet.
   */
  private broadcastPosition(): void {
    if (!this.originatePacket || !this.getFingerprint || !this.getChannelToken) {
      return;
    }

    const fingerprint = this.getFingerprint();
    const channelToken = this.getChannelToken();
    if (!fingerprint || !channelToken) return;

    // Provide a zero-coordinate fallback if GPS hasn't locked yet.
    // This ensures peer discovery works indoors or before GPS fixes.
    const pos = this.ownPosition || {
      latitude: 0,
      longitude: 0,
      heading: 0,
      speed: 0,
      altitude: 0,
      accuracy: 9999,
      timestamp: Math.floor(Date.now() / 1000),
    };

    const payload = encodeGPSTelemetry(pos);

    // Create a simple packet ID from sequence + fingerprint bytes
    const packetId = new Uint8Array(8);
    const seqView = new DataView(packetId.buffer);
    seqView.setUint32(0, this.sequenceNumber++, false);
    packetId.set(fingerprint.subarray(0, 4), 4);

    const header: PacketHeader = {
      magic: MAGIC,
      version: PROTOCOL_VERSION,
      type: PacketType.GPSTelemetry,
      ttl: DEFAULT_TTL,
      flags: 0,
      sequenceNumber: this.sequenceNumber & 0xffff,
      packetId,
      channelToken: channelToken.subarray(0, 8),
      senderFingerprint: fingerprint,
      payloadSize: payload.byteLength,
      checksum: 0, // computed during encoding
    };

    this.originatePacket(header, payload);
  }

  /**
   * Evict peers not seen within the stale threshold.
   */
  private evictStalePeers(): void {
    const now = Date.now();
    let evicted = false;

    for (const [key, peer] of this.peers) {
      if (now - peer.lastSeenMs > this.config.stalePeerThresholdMs) {
        this.peers.delete(key);
        evicted = true;
      }
    }

    if (evicted) {
      this.onPeersUpdated?.(this.peers);
    }
  }

  /**
   * Get all currently active (non-stale) peers.
   */
  getActivePeers(): ConvoyPeer[] {
    const now = Date.now();
    const active: ConvoyPeer[] = [];
    for (const peer of this.peers.values()) {
      if (now - peer.lastSeenMs <= this.config.stalePeerThresholdMs) {
        active.push(peer);
      }
    }
    return active;
  }

  /**
   * Get own position.
   */
  getOwnPosition(): OwnPosition | null {
    return this.ownPosition;
  }

  /**
   * Diagnostic stats.
   */
  getStats(): {
    isBroadcasting: boolean;
    ownPosition: OwnPosition | null;
    totalPeers: number;
    activePeers: number;
    currentIntervalMs: number;
    sequenceNumber: number;
  } {
    return {
      isBroadcasting: this.isBroadcasting,
      ownPosition: this.ownPosition,
      totalPeers: this.peers.size,
      activePeers: this.getActivePeers().length,
      currentIntervalMs: this.getCurrentInterval(),
      sequenceNumber: this.sequenceNumber,
    };
  }

  /**
   * Destroy — clean up all timers.
   */
  destroy(): void {
    this.stopBroadcasting();
    this.peers.clear();
  }
}

// ─── Zustand Store ───────────────────────────────────────────────────────

export interface ConvoyStoreState {
  ownPosition: OwnPosition | null;
  peers: ConvoyPeer[];
  activePeerCount: number;
  isBroadcasting: boolean;

  setOwnPosition: (pos: OwnPosition) => void;
  setPeers: (peers: ConvoyPeer[]) => void;
  setIsBroadcasting: (value: boolean) => void;
}

export const useConvoyStore = create<ConvoyStoreState>((set) => ({
  ownPosition: null,
  peers: [],
  activePeerCount: 0,
  isBroadcasting: false,

  setOwnPosition: (pos) => set({ ownPosition: pos }),
  setPeers: (peers) => set({ peers, activePeerCount: peers.length }),
  setIsBroadcasting: (value) => set({ isBroadcasting: value }),
}));
