/**
 * Konvoy Gossip Sync Protocol
 *
 * Implements anti-entropy gossip for CRDT state replication across
 * the mesh network. Each node periodically selects a random peer
 * and performs a state digest comparison. If digests differ, a
 * delta exchange is performed.
 *
 * Protocol flow:
 *   1. Every GOSSIP_INTERVAL_MS, select a random connected peer
 *   2. Send our CRDT state digest (stateHash + maxVectorClock)
 *   3. Peer compares with its own digest
 *   4. If mismatch → exchange delta entries since lastSyncVectorClock
 *   5. Both sides merge → convergence
 *
 * Wire integration:
 *   - Gossip messages use PacketType.HazardPin (0x03) with the
 *     CRDT merge happening at the application layer.
 *   - Individual hazard pins from user interaction are also broadcast
 *     immediately (push-on-write) without waiting for gossip tick.
 */

import { HazardCRDT, type HazardEntry, type CRDTDigest } from './crdt';
import { HazardType } from '../net/wire';

// ─── Types ───────────────────────────────────────────────────────────────

export interface GossipPeerState {
  /** Peer's mesh fingerprint (hex) */
  peerId: string;
  /** Last known vector clock from this peer */
  lastSyncVectorClock: number;
  /** Timestamp of last successful sync */
  lastSyncTime: number;
  /** Number of successful syncs with this peer */
  syncCount: number;
}

export interface GossipConfig {
  /** How often to initiate a gossip round (ms). Default: 5000 */
  gossipIntervalMs: number;
  /** Maximum entries to send in a single delta sync. Default: 100 */
  maxDeltaBatchSize: number;
  /** Time (ms) after which to force a full-state sync instead of delta. Default: 300000 (5 min) */
  fullSyncThresholdMs: number;
}

export type SendGossipDigestFn = (peerId: string, digest: CRDTDigest) => void;
export type SendGossipDeltaFn = (peerId: string, entries: HazardEntry[]) => void;
export type GetConnectedPeerIdsFn = () => string[];

const DEFAULT_CONFIG: GossipConfig = {
  gossipIntervalMs: 5_000,
  maxDeltaBatchSize: 100,
  fullSyncThresholdMs: 300_000,
};

// ─── Gossip Manager ──────────────────────────────────────────────────────

export class GossipSync {
  private crdt: HazardCRDT;
  private config: GossipConfig;

  /** Per-peer sync state */
  private peerStates: Map<string, GossipPeerState> = new Map();

  /** Transport callbacks */
  private sendDigest: SendGossipDigestFn | null = null;
  private sendDelta: SendGossipDeltaFn | null = null;
  private getConnectedPeers: GetConnectedPeerIdsFn | null = null;

  /** Gossip tick timer */
  private gossipTimer: ReturnType<typeof setInterval> | null = null;

  constructor(crdt: HazardCRDT, config?: Partial<GossipConfig>) {
    this.crdt = crdt;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register transport callbacks.
   */
  setTransport(
    sendDigest: SendGossipDigestFn,
    sendDelta: SendGossipDeltaFn,
    getConnectedPeers: GetConnectedPeerIdsFn,
  ): void {
    this.sendDigest = sendDigest;
    this.sendDelta = sendDelta;
    this.getConnectedPeers = getConnectedPeers;
  }

  /**
   * Start the gossip protocol.
   */
  start(): void {
    if (this.gossipTimer) return;
    this.gossipTimer = setInterval(() => this.gossipTick(), this.config.gossipIntervalMs);
  }

  /**
   * Stop the gossip protocol.
   */
  stop(): void {
    if (this.gossipTimer) {
      clearInterval(this.gossipTimer);
      this.gossipTimer = null;
    }
  }

  /**
   * Perform one gossip round: select a random peer and send our digest.
   */
  private gossipTick(): void {
    if (!this.sendDigest || !this.getConnectedPeers) return;

    const peers = this.getConnectedPeers();
    if (peers.length === 0) return;

    // Select a random peer using crypto-grade randomness (or Math.random as fallback)
    const randomIndex = Math.floor(Math.random() * peers.length);
    const selectedPeer = peers[randomIndex]!;

    // Send our digest
    const digest = this.crdt.getDigest();
    this.sendDigest(selectedPeer, digest);
  }

  /**
   * Handle an incoming digest from a peer.
   * Compare with our local state and respond with delta if needed.
   */
  handleIncomingDigest(peerId: string, remoteDigest: CRDTDigest): void {
    const localDigest = this.crdt.getDigest();

    // If digests match, we're in sync
    if (localDigest.stateHash === remoteDigest.stateHash) {
      this.updatePeerState(peerId, remoteDigest.maxVectorClock);
      return;
    }

    // Digests differ — send our delta
    const peerState = this.peerStates.get(peerId);
    const now = Date.now();

    let entriesToSend: HazardEntry[];

    if (
      !peerState ||
      (now - peerState.lastSyncTime) > this.config.fullSyncThresholdMs
    ) {
      // No prior sync or stale peer → full state
      entriesToSend = this.crdt.getFullState();
    } else {
      // Delta since last sync
      entriesToSend = this.crdt.getDeltaSince(peerState.lastSyncVectorClock);
    }

    // Batch limit
    if (entriesToSend.length > this.config.maxDeltaBatchSize) {
      entriesToSend = entriesToSend.slice(0, this.config.maxDeltaBatchSize);
    }

    if (entriesToSend.length > 0 && this.sendDelta) {
      this.sendDelta(peerId, entriesToSend);
    }

    this.updatePeerState(peerId, remoteDigest.maxVectorClock);
  }

  /**
   * Handle incoming delta entries from a peer.
   * Merge into our local CRDT state.
   */
  handleIncomingDelta(peerId: string, entries: HazardEntry[]): {
    added: number;
    updated: number;
    conflicts: number;
  } {
    const result = this.crdt.merge(entries);

    // Update peer state with the max clock from the delta
    let maxClock = 0;
    for (const entry of entries) {
      maxClock = Math.max(maxClock, entry.vectorClock);
    }
    this.updatePeerState(peerId, maxClock);

    return result;
  }

  /**
   * Update our tracking of a peer's sync state.
   */
  private updatePeerState(peerId: string, vectorClock: number): void {
    const existing = this.peerStates.get(peerId);
    this.peerStates.set(peerId, {
      peerId,
      lastSyncVectorClock: Math.max(existing?.lastSyncVectorClock ?? 0, vectorClock),
      lastSyncTime: Date.now(),
      syncCount: (existing?.syncCount ?? 0) + 1,
    });
  }

  /**
   * Remove tracking for a peer that has left.
   */
  removePeer(peerId: string): void {
    this.peerStates.delete(peerId);
  }

  /**
   * Get sync stats for diagnostics.
   */
  getStats(): {
    peerCount: number;
    peers: GossipPeerState[];
    crdtDigest: CRDTDigest;
  } {
    return {
      peerCount: this.peerStates.size,
      peers: Array.from(this.peerStates.values()),
      crdtDigest: this.crdt.getDigest(),
    };
  }

  /**
   * Destroy — clean up timers and state.
   */
  destroy(): void {
    this.stop();
    this.peerStates.clear();
  }
}
