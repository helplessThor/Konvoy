/**
 * NostrTransport.ts — Internet Relay Channel Transport
 *
 * Bridges the Konvoy mesh over public Nostr relays using ephemeral events (kind 29333).
 * To ensure absolute privacy over public internet relays, all binary payloads are
 * symmetrically encrypted via AES-256-GCM using a shared key derived from the
 * user-provided Channel Secret.
 */

import { SimplePool, generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import crypto from 'react-native-quick-crypto';
import { Buffer } from 'buffer';
import { uint8ArrayToBase64, base64ToUint8Array } from '../utils/base64';

export type OnNostrPacketReceived = (peerId: string, data: ArrayBuffer) => void;
export type OnNostrSignalReceived = (signalJson: string) => void;

const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

export class NostrTransport {
  private pool: SimplePool;
  private burnerSecretKey: Uint8Array;
  private burnerPublicKey: string;

  private isRunning: boolean = false;
  private channelHash: string | null = null;
  private encryptionKey: Uint8Array | null = null;

  private onPacketReceived: OnNostrPacketReceived | null = null;
  private onSignalReceived: OnNostrSignalReceived | null = null;
  private sub: any = null;

  // Track recent events to prevent echo loops
  private seenEventIds = new Set<string>();

  constructor() {
    this.pool = new SimplePool();
    // Generate a fresh random burner identity for Nostr relays per session
    this.burnerSecretKey = generateSecretKey();
    this.burnerPublicKey = getPublicKey(this.burnerSecretKey);
  }

  setCallbacks(onPacketReceived: OnNostrPacketReceived) {
    this.onPacketReceived = onPacketReceived;
  }

  setSignalCallback(onSignalReceived: OnNostrSignalReceived) {
    this.onSignalReceived = onSignalReceived;
  }

  /**
   * Connect to the internet channel.
   * @param channelSecret The shared secret phrase
   */
  async connect(channelSecret: string): Promise<void> {
    if (this.isRunning) {
      this.disconnect();
    }

    // 1. Derive strong 32-byte AES key using SHA-256(secret)
    const secretBuffer = Buffer.from(channelSecret, 'utf-8');
    this.encryptionKey = new Uint8Array(crypto.createHash('sha256').update(secretBuffer).digest());

    // 2. Derive channel tag hash for routing: SHA-256(encryptionKey)
    // We hash it again so the encryption key is never exposed in the tags
    const tagHashBuffer = crypto.createHash('sha256').update(Buffer.from(this.encryptionKey)).digest();
    this.channelHash = tagHashBuffer.toString('hex');

    this.isRunning = true;

    // 3. Subscribe to the channel tag
    this.sub = this.pool.subscribeMany(
      RELAYS,
      {
        kinds: [29333],
        '#h': [this.channelHash],
      } as any,
      {
        onevent: (event) => this.handleEvent(event),
      }
    );

    console.log(`[NostrTransport] Connected to channel hash: ${this.channelHash.substring(0, 8)}...`);
  }

  disconnect() {
    this.isRunning = false;
    if (this.sub) {
      this.sub.close();
      this.sub = null;
    }
    this.channelHash = null;
    this.encryptionKey = null;
    console.log('[NostrTransport] Disconnected');
  }

  /**
   * Broadcast a mesh packet over Nostr.
   */
  async broadcastPacket(data: ArrayBuffer): Promise<void> {
    if (!this.isRunning || !this.encryptionKey || !this.channelHash) return;

    try {
      // 1. Encrypt payload
      const payloadBytes = new Uint8Array(data);
      const iv = crypto.randomBytes(12);
      
      const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
      const encrypted = Buffer.concat([cipher.update(Buffer.from(payloadBytes) as any), cipher.final()]);
      const authTag = cipher.getAuthTag();

      // Format: [12 bytes IV] [16 bytes AuthTag] [Encrypted Payload]
      const outBuffer = new Uint8Array(12 + 16 + encrypted.length);
      outBuffer.set(iv, 0);
      outBuffer.set(authTag, 12);
      outBuffer.set(encrypted, 28);

      const base64Content = uint8ArrayToBase64(outBuffer);

      // 2. Wrap in Nostr Event
      const eventTemplate = {
        kind: 29333, // Ephemeral event
        created_at: Math.floor(Date.now() / 1000),
        tags: [['h', this.channelHash]],
        content: base64Content,
      };

      const event = finalizeEvent(eventTemplate, this.burnerSecretKey);
      
      // Track our own event to prevent echoing
      this.seenEventIds.add(event.id);
      
      // 3. Fire-and-forget publish to relays
      const publishes = this.pool.publish(RELAYS, event);
      Promise.allSettled(publishes).then((results) => {
        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length === RELAYS.length) {
          console.warn('[Nostr] All relays failed to publish packet');
        }
      });
    } catch (err) {
      console.warn('[NostrTransport] Failed to encrypt/publish packet:', err);
    }
  }

  /**
   * Broadcast a raw JSON signal over Nostr (unencrypted)
   */
  async publishSignal(signalJson: string): Promise<void> {
    if (!this.isRunning || !this.channelHash) return;

    try {
      const eventTemplate = {
        kind: 29333,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['h', this.channelHash],
          ['webrtc-signal', 'true']
        ],
        content: signalJson,
      };

      const event = finalizeEvent(eventTemplate, this.burnerSecretKey);
      this.seenEventIds.add(event.id);
      
      this.pool.publish(RELAYS, event).forEach(p => p.catch(() => {}));
    } catch (err) {
      console.warn('[NostrTransport] Failed to publish signal:', err);
    }
  }

  private handleEvent(event: any) {
    if (!this.onPacketReceived || !this.encryptionKey) return;
    
    // Ignore events we published
    if (event.pubkey === this.burnerPublicKey || this.seenEventIds.has(event.id)) return;
    this.seenEventIds.add(event.id);

    // Keep memory clean
    if (this.seenEventIds.size > 1000) {
      this.seenEventIds.clear();
    }

    // Check if this is a WebRTC signal
    const isSignal = event.tags?.some((t: string[]) => t[0] === 'webrtc-signal' && t[1] === 'true');
    if (isSignal) {
      if (this.onSignalReceived) {
        this.onSignalReceived(event.content);
      }
      return;
    }

    if (!this.onPacketReceived) return;

    try {
      // 1. Decode base64
      const buf = base64ToUint8Array(event.content);
      if (buf.length < 28) return; // Invalid length (requires at least IV + AuthTag)

      const iv = buf.subarray(0, 12);
      const authTag = buf.subarray(12, 28);
      const encrypted = buf.subarray(28);

      // 2. Decrypt AES-256-GCM
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(iv) as any);
      decipher.setAuthTag(Buffer.from(authTag) as any);
      
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encrypted) as any),
        decipher.final()
      ]);

      // 3. Forward to Router
      // The router uses the pubkey as the "peerId" transport identifier
      const decryptedUint8 = new Uint8Array(decrypted);
      this.onPacketReceived(event.pubkey, decryptedUint8.buffer.slice(decryptedUint8.byteOffset, decryptedUint8.byteOffset + decryptedUint8.byteLength));
    } catch (err) {
      // Failed to decrypt or parse - likely wrong channel secret or corrupted packet
    }
  }
}
