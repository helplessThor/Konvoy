/**
 * Konvoy Unified Radio Transport
 *
 * Abstracts over the native BLE and Wi-Fi P2P modules, providing a
 * single interface for the mesh router. Automatically selects the
 * appropriate transport based on packet type:
 *
 *   - BLE: Topology Discovery (0x04), Heartbeat (0x05),
 *          GPS Telemetry (0x02) when Wi-Fi P2P is unavailable
 *   - Wi-Fi P2P: Voice (0x01), Hazard Pin (0x03),
 *                GPS Telemetry (0x02) when Wi-Fi P2P is available
 *
 * Event model:
 *   - Native radio modules emit events via NativeEventEmitter
 *   - This transport subscribes and forwards to the mesh router
 */

import { NativeEventEmitter, NativeModules } from 'react-native';
import { PacketType, HEADER_SIZE } from '../net/wire';

// ─── Types ───────────────────────────────────────────────────────────────

export interface PeerInfo {
  peerId: string;
  rssi: number;
  transport: 'ble' | 'wifi-p2p';
  discoveredAt: number;
  lastSeenAt: number;
  advertisementData?: Uint8Array;
}

export interface TransportConfig {
  /** BLE service UUID for Konvoy discovery */
  bleServiceUUID: string;
  /** BLE scan interval when actively scanning */
  bleScanIntervalMs: number;
  /** Whether to auto-promote BLE peers to Wi-Fi P2P */
  autoPromoteToWiFi: boolean;
}

export type OnPacketReceived = (peerId: string, data: ArrayBuffer) => void;
export type OnPeerDiscovered = (peer: PeerInfo) => void;
export type OnPeerLost = (peerId: string) => void;

const DEFAULT_CONFIG: TransportConfig = {
  bleServiceUUID: '6B6F6E76-6F79-4D65-7368-000000000001', // "konvoyMesh"
  bleScanIntervalMs: 3000,
  autoPromoteToWiFi: true,
};

import { uint8ArrayToBase64, base64ToUint8Array } from '../utils/base64';

// ─── Base64 Utility ──────────────────────────────────────────────────────

function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return uint8ArrayToBase64(bytes);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  return base64ToUint8Array(base64).buffer as ArrayBuffer;
}

// ─── Radio Transport ─────────────────────────────────────────────────────

export class RadioTransport {
  private config: TransportConfig;
  private discoveredPeers: Map<string, PeerInfo> = new Map();
  private isRunning: boolean = false;

  // Native module references (lazy-loaded)
  private radioModule: any = null;
  private radioEmitter: NativeEventEmitter | null = null;

  // Event subscriptions
  private subscriptions: Array<{ remove: () => void }> = [];

  // Callbacks
  private onPacketReceived: OnPacketReceived | null = null;
  private onPeerDiscovered: OnPeerDiscovered | null = null;
  private onPeerLost: OnPeerLost | null = null;

  constructor(config?: Partial<TransportConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize native module references.
   * Must be called after React Native has loaded native modules.
   */
  initialize(): void {
    try {
      this.radioModule = NativeModules.KonvoyRadio;
      if (this.radioModule) {
        this.radioEmitter = new NativeEventEmitter(this.radioModule);
      }
    } catch (err) {
      console.error('[RadioTransport] Failed to initialize native radio module:', err);
    }
  }

  /**
   * Register event callbacks.
   */
  setCallbacks(opts: {
    onPacketReceived: OnPacketReceived;
    onPeerDiscovered?: OnPeerDiscovered;
    onPeerLost?: OnPeerLost;
  }): void {
    this.onPacketReceived = opts.onPacketReceived;
    this.onPeerDiscovered = opts.onPeerDiscovered ?? null;
    this.onPeerLost = opts.onPeerLost ?? null;
  }

  /**
   * Start radio operations: begin BLE scanning and advertising.
   */
  async start(advertisementData: Uint8Array): Promise<void> {
    if (this.isRunning || !this.radioModule) return;
    this.isRunning = true;

    // Subscribe to native events
    this.setupEventListeners();

    // Start BLE beacon + scan
    const advBase64 = arrayBufferToBase64(advertisementData);
    this.radioModule.startBLEBeacon(this.config.bleServiceUUID, advBase64);
    this.radioModule.startBLEScan(this.config.bleServiceUUID);
  }

  /**
   * Stop all radio operations.
   */
  stop(): void {
    if (!this.isRunning || !this.radioModule) return;
    this.isRunning = false;

    // Unsubscribe from events
    for (const sub of this.subscriptions) {
      sub.remove();
    }
    this.subscriptions = [];

    // Stop native radio
    this.radioModule.stopBLEBeacon();
    this.radioModule.stopBLEScan();
    this.radioModule.disconnectWiFiP2P();

    this.discoveredPeers.clear();
  }

  /**
   * Start Wi-Fi P2P autonomous discovery using DNS-SD.
   */
  async startWiFiP2PDiscovery(channelToken: string): Promise<boolean> {
    if (!this.radioModule) {
      throw new Error('Radio module not available');
    }
    return this.radioModule.startWiFiP2PDiscovery(channelToken);
  }
  /**
   * Connect to a Wi-Fi P2P peer.
   */
  async connectToPeer(address: string, port: number): Promise<string> {
    if (!this.radioModule) {
      throw new Error('Radio module not available');
    }
    return this.radioModule.connectWiFiP2P(address, port);
  }

  /**
   * Send a packet to a specific peer via the appropriate transport.
   */
  sendPacket(peerId: string, data: ArrayBuffer): void {
    if (!this.radioModule) return;
    const base64 = arrayBufferToBase64(data);
    this.radioModule.sendPacket(peerId, base64);
  }

  /**
   * Broadcast a packet to all connected peers.
   */
  broadcastPacket(data: ArrayBuffer): void {
    if (!this.radioModule) return;
    const base64 = arrayBufferToBase64(data);
    this.radioModule.broadcastPacket(base64);
  }

  /**
   * Get list of connected peer IDs.
   */
  getConnectedPeers(): string[] {
    if (!this.radioModule) return [];
    return this.radioModule.getConnectedPeers();
  }

  /**
   * Get all discovered peers (including those not yet connected).
   */
  getDiscoveredPeers(): PeerInfo[] {
    return Array.from(this.discoveredPeers.values());
  }

  /**
   * Check transport capabilities.
   */
  getCapabilities(): { ble: boolean; wifiP2P: boolean } {
    if (!this.radioModule) return { ble: false, wifiP2P: false };
    return {
      ble: this.radioModule.isBLEAvailable(),
      wifiP2P: this.radioModule.isWiFiP2PAvailable(),
    };
  }

  /**
   * Determine the best transport for a given packet type.
   */
  static getPreferredTransport(packetType: PacketType): 'ble' | 'wifi-p2p' {
    switch (packetType) {
      case PacketType.Voice:
        return 'wifi-p2p'; // High bandwidth needed
      case PacketType.GPSTelemetry:
        return 'wifi-p2p'; // Prefer Wi-Fi for lower latency
      case PacketType.HazardPin:
        return 'wifi-p2p'; // Moderate size
      case PacketType.TopologyDiscovery:
        return 'ble'; // Small, discovery-oriented
      case PacketType.Heartbeat:
        return 'ble'; // Header-only, tiny
      default:
        return 'wifi-p2p';
    }
  }

  // ─── Event Listener Setup ─────────────────────────────────────

  private setupEventListeners(): void {
    if (!this.radioEmitter) return;

    // Peer discovered via BLE scan
    const peerSub = this.radioEmitter.addListener(
      'KonvoyPeerDiscovered',
      (event: any) => {
        const peer: PeerInfo = {
          peerId: event.peerId,
          rssi: event.rssi,
          transport: 'ble',
          discoveredAt: Date.now(),
          lastSeenAt: Date.now(),
          advertisementData: new Uint8Array(base64ToArrayBuffer(event.dataBase64)),
        };

        this.discoveredPeers.set(event.peerId, peer);
        this.onPeerDiscovered?.(peer);

        // Auto-promote to Wi-Fi P2P if configured and available
        if (this.config.autoPromoteToWiFi && this.radioModule?.isWiFiP2PAvailable()) {
          // Promotion logic handled by the native module
        }
      },
    );
    this.subscriptions.push(peerSub);

    // Packet received
    const packetSub = this.radioEmitter.addListener(
      'KonvoyPacketReceived',
      (event: any) => {
        const data = base64ToArrayBuffer(event.dataBase64);
        this.onPacketReceived?.(event.peerId, data);

        // Update last seen
        const peer = this.discoveredPeers.get(event.peerId);
        if (peer) {
          peer.lastSeenAt = Date.now();
        }
      },
    );
    this.subscriptions.push(packetSub);

    // Peer lost / disconnected
    const lostSub = this.radioEmitter.addListener(
      'KonvoyPeerLost',
      (event: any) => {
        this.discoveredPeers.delete(event.peerId);
        this.onPeerLost?.(event.peerId);
      },
    );
    this.subscriptions.push(lostSub);
  }

  /**
   * Destroy — clean up all resources.
   */
  destroy(): void {
    this.stop();
    this.onPacketReceived = null;
    this.onPeerDiscovered = null;
    this.onPeerLost = null;
  }
}
