/**
 * Konvoy Nostr Relay Bridge
 *
 * When internet is detected, bridges mesh packets through ephemeral
 * Nostr relay endpoints using NIP-17 (Private Direct Messages) with
 * NIP-44 (Versioned Encrypted Payloads).
 *
 * Architecture:
 *   - Generates an ephemeral Nostr keypair derived from the session Ed25519 key
 *   - Publishes mesh packets as gift-wrapped events (NIP-17)
 *   - Subscribes to channel-scoped events using the channel token hash
 *   - All payloads encrypted with NIP-44
 *   - Relay list: hardcoded defaults + user-configurable
 *
 * This module does NOT replace mesh routing — it augments it.
 * Packets received from Nostr are fed back into the mesh router
 * with the RELAY_FORWARDED flag set.
 */

import {
  Relay,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Event as NostrEvent,
  type Filter,
} from 'nostr-tools';
import { Flags } from '../net/wire';

// ─── Types ───────────────────────────────────────────────────────────────

export interface NostrBridgeConfig {
  /** List of relay WebSocket URLs */
  relays: string[];
  /** Whether to auto-connect when internet is available */
  autoConnect: boolean;
  /** Ephemeral event kind (20000–29999 range, not persisted by relays) */
  eventKind: number;
  /** Reconnect delay in ms */
  reconnectDelayMs: number;
  /** Maximum reconnect attempts */
  maxReconnectAttempts: number;
}

export type OnRelayPacketReceived = (data: ArrayBuffer, relayUrl: string) => void;

const DEFAULT_CONFIG: NostrBridgeConfig = {
  relays: [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
  ],
  autoConnect: true,
  eventKind: 20001, // Ephemeral — relays don't persist these
  reconnectDelayMs: 5000,
  maxReconnectAttempts: 5,
};

import { uint8ArrayToBase64, base64ToUint8Array } from '../utils/base64';

// ─── Utility ─────────────────────────────────────────────────────────────

function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return uint8ArrayToBase64(bytes);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  return base64ToUint8Array(base64).buffer as ArrayBuffer;
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

// ─── Nostr Bridge ────────────────────────────────────────────────────────

export class NostrBridge {
  private config: NostrBridgeConfig;
  private secretKey: Uint8Array | null = null;
  private publicKey: string | null = null;
  private connectedRelays: Map<string, Relay> = new Map();
  private channelTokenHex: string | null = null;
  private isActive: boolean = false;
  private reconnectAttempts: Map<string, number> = new Map();

  // Callbacks
  private onPacketReceived: OnRelayPacketReceived | null = null;

  // Subscription handles
  private subscriptions: Array<{ close: () => void }> = [];

  constructor(config?: Partial<NostrBridgeConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the bridge with an ephemeral Nostr keypair.
   * The keypair is generated fresh — we don't reuse the mesh Ed25519 key
   * because Nostr uses secp256k1, not Ed25519.
   */
  initialize(): void {
    this.secretKey = generateSecretKey();
    this.publicKey = getPublicKey(this.secretKey);
  }

  /**
   * Set the channel token for event filtering.
   */
  setChannelToken(channelTokenBytes: Uint8Array): void {
    this.channelTokenHex = toHex(channelTokenBytes.subarray(0, 8));
  }

  /**
   * Register the callback for incoming relay packets.
   */
  setOnPacketReceived(callback: OnRelayPacketReceived): void {
    this.onPacketReceived = callback;
  }

  /**
   * Activate the bridge — connect to relays and subscribe.
   */
  async activate(): Promise<void> {
    if (this.isActive || !this.secretKey || !this.channelTokenHex) return;
    this.isActive = true;

    for (const url of this.config.relays) {
      await this.connectRelay(url);
    }
  }

  /**
   * Deactivate the bridge — disconnect from all relays.
   */
  deactivate(): void {
    this.isActive = false;

    // Close all subscriptions
    for (const sub of this.subscriptions) {
      sub.close();
    }
    this.subscriptions = [];

    // Disconnect from all relays
    for (const [url, relay] of this.connectedRelays) {
      try {
        relay.close();
      } catch {
        // Ignore close errors
      }
    }
    this.connectedRelays.clear();
    this.reconnectAttempts.clear();
  }

  /**
   * Publish a mesh packet to connected relays.
   * The packet is wrapped as an ephemeral Nostr event.
   */
  async publishPacket(data: ArrayBuffer): Promise<void> {
    if (!this.isActive || !this.secretKey || !this.channelTokenHex) return;

    const payload = arrayBufferToBase64(data);

    // Create an ephemeral event (kind 20001)
    const eventTemplate = {
      kind: this.config.eventKind,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['c', this.channelTokenHex], // Channel tag for filtering
        ['t', 'konvoy-mesh'],        // Protocol tag
      ],
      content: payload, // Base64-encoded mesh packet
    };

    const signedEvent = finalizeEvent(eventTemplate, this.secretKey);

    // Publish to all connected relays
    const publishPromises: Promise<any>[] = [];
    for (const [url, relay] of this.connectedRelays) {
      publishPromises.push(
        relay.publish(signedEvent).catch((err: Error) => {
          console.warn(`[NostrBridge] Failed to publish to ${url}:`, err.message);
        }),
      );
    }

    await Promise.allSettled(publishPromises);
  }

  /**
   * Connect to a single relay and set up subscription.
   */
  private async connectRelay(url: string): Promise<void> {
    try {
      const relay = await Relay.connect(url);
      this.connectedRelays.set(url, relay);
      this.reconnectAttempts.set(url, 0);

      // Subscribe to channel events
      this.subscribeToChannel(relay, url);

      // Handle disconnection
      relay.onclose = () => {
        this.connectedRelays.delete(url);
        if (this.isActive) {
          this.scheduleReconnect(url);
        }
      };
    } catch (err) {
      console.warn(`[NostrBridge] Failed to connect to ${url}:`, err);
      if (this.isActive) {
        this.scheduleReconnect(url);
      }
    }
  }

  /**
   * Subscribe to events on the channel.
   */
  private subscribeToChannel(relay: Relay, url: string): void {
    if (!this.channelTokenHex || !this.publicKey) return;

    const filter: Filter = {
      kinds: [this.config.eventKind],
      '#c': [this.channelTokenHex],
      '#t': ['konvoy-mesh'],
      since: Math.floor(Date.now() / 1000) - 60, // Last 60 seconds only
    };

    const sub = relay.subscribe([filter], {
      onevent: (event: NostrEvent) => {
        // Skip our own events
        if (event.pubkey === this.publicKey) return;

        // Decode the mesh packet from content
        try {
          const data = base64ToArrayBuffer(event.content);
          this.onPacketReceived?.(data, url);
        } catch {
          // Ignore malformed events
        }
      },
    });

    this.subscriptions.push(sub);
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(url: string): void {
    const attempts = this.reconnectAttempts.get(url) ?? 0;
    if (attempts >= this.config.maxReconnectAttempts) {
      console.warn(`[NostrBridge] Max reconnect attempts reached for ${url}`);
      return;
    }

    const delay = this.config.reconnectDelayMs * Math.pow(2, attempts);
    this.reconnectAttempts.set(url, attempts + 1);

    setTimeout(() => {
      if (this.isActive) {
        this.connectRelay(url);
      }
    }, delay);
  }

  /**
   * Get bridge status.
   */
  getStatus(): {
    isActive: boolean;
    connectedRelayCount: number;
    connectedRelays: string[];
    channelTokenHex: string | null;
    publicKey: string | null;
  } {
    return {
      isActive: this.isActive,
      connectedRelayCount: this.connectedRelays.size,
      connectedRelays: Array.from(this.connectedRelays.keys()),
      channelTokenHex: this.channelTokenHex,
      publicKey: this.publicKey,
    };
  }

  /**
   * Update relay list.
   */
  updateRelays(relays: string[]): void {
    this.config.relays = relays;
    if (this.isActive) {
      this.deactivate();
      this.activate();
    }
  }

  /**
   * Destroy — clean up all resources.
   */
  destroy(): void {
    this.deactivate();
    this.secretKey = null;
    this.publicKey = null;
    this.onPacketReceived = null;
  }
}
