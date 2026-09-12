/**
 * MeshOrchestrator.ts — Central Networking Glue
 *
 * This class brings together the native RadioTransport, the MeshRouter,
 * and the TelemetryManager to create a fully functional mesh network.
 * It handles the lifecycle and wires all events together.
 */


import { Buffer } from 'buffer';
import { NostrTransport } from '../core/radio/nostr';
import { WebRTCTransport } from '../core/radio/WebRTCTransport';
import { MeshRouter } from '../core/net/router';
import { TelemetryManager } from '../core/map/telemetry';
import { locationService } from './LocationService';
import { useIdentityStore } from '../core/crypto/identity';
import { useConvoyStore } from '../core/map/telemetry';
import { useHazardStore } from '../core/map/crdt';

export class MeshOrchestrator {
  private static instance: MeshOrchestrator | null = null;
  

  public nostr: NostrTransport;
  public webrtc: WebRTCTransport;
  public router: MeshRouter;
  public telemetry: TelemetryManager;

  private isRunning: boolean = false;

  private constructor() {

    this.nostr = new NostrTransport();
    this.router = new MeshRouter();
    this.telemetry = new TelemetryManager();
    // Use an empty fingerprint initially, update when starting
    this.webrtc = new WebRTCTransport(this.nostr, '');

    this.wireSubsystems();
  }

  static getInstance(): MeshOrchestrator {
    if (!this.instance) {
      this.instance = new MeshOrchestrator();
    }
    return this.instance;
  }

  private wireSubsystems() {
    // 1. Configure Router -> Transport (Outgoing)
    this.router.setTransport(
      (peerId, data) => {
        // Broadcast all packets to WebRTC data channels
        this.webrtc.broadcastPacket(data);
        
        // Also broadcast over Nostr as a fallback for GPS (Nostr might drop voice)
        if (peerId === 'nostr-channel') {
          this.nostr.broadcastPacket(data);
        }
      },
      () => {
        const peers: string[] = [];
        // Expose Nostr channel as a connected peer so the router broadcasts to it
        if ((this.nostr as any).isRunning) {
          peers.push('nostr-channel');
        }
        return peers;
      }
    );

    // 2. Configure Transport -> Router (Incoming)

    this.nostr.setCallbacks((peerId, data) => {
        // Automatically attempt to upgrade any Nostr peer to WebRTC
        this.webrtc.initiateConnection(peerId);
        this.router.handleIncoming(peerId, data);
    });

    this.nostr.setSignalCallback((signalJson) => {
      this.webrtc.handleSignal(signalJson);
    });
    
    this.webrtc.setCallbacks((peerId, data) => {
      this.router.handleIncoming(peerId, data);
    });

    // 3. Configure Telemetry -> Router (Outgoing GPS packets)
    this.telemetry.configure({
      originatePacket: (header, payload) => this.router.originatePacket(header, payload),
      getFingerprint: () => useIdentityStore.getState().identity?.fingerprint ?? null,
      getChannelToken: () => {
        // Use a generic group token or derived from identity
        const identity = useIdentityStore.getState().identity;
        const advData = identity?.fingerprint ?? new Uint8Array(16);
        // Update WebRTC local fingerprint
        (this.webrtc as any).localFingerprint = identity?.fingerprint ? Buffer.from(identity.fingerprint).toString('hex') : 'local';
        const token = new Uint8Array(16);
        token.fill(0x01);
        return token;
      },
      onPeersUpdated: (peersMap) => {
        // Sync active peers to the Zustand store for the UI
        const activePeers = Array.from(peersMap.values());
        useConvoyStore.getState().setPeers(activePeers);
      }
    });

    // 4. Configure Router -> Telemetry (Incoming GPS packets)
    this.router.setHandlers({
      onGPSTelemetry: (senderFp, payload, header) => {
        this.telemetry.handleIncomingTelemetry(senderFp, payload);
      },
      onHazardPin: (senderFp, pin, header) => {
        // Sync incoming hazards to UI
        useHazardStore.getState().addHazard(pin.hazardType, pin.latitude, pin.longitude, senderFp);
      }
      // Audio intercom handles its own wiring in src/core/audio/intercom.ts
    });

    // 5. Configure Location -> Telemetry (Live GPS updates)
    locationService.setOnPositionUpdate((pos) => {
      this.telemetry.updateOwnPosition(pos);
    });
  }

  /**
   * Start the mesh networking stack.
   */
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    // Start velocity-adaptive broadcasting
    this.telemetry.startBroadcasting();
    useConvoyStore.getState().setIsBroadcasting(true);
    
    // Set active radio type to UI
    // If we have connected peers, we can show WIFI_DIRECT, otherwise BLE/SEARCHING
    // For now we rely on the MapScreen logic which uses convoyPeers.length > 0
  }

  /**
   * Stop all mesh operations.
   */
  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;

    this.telemetry.stopBroadcasting();
    useConvoyStore.getState().setIsBroadcasting(false);

    this.nostr.disconnect();
  }

  /**
   * Connect to an internet channel via Nostr
   */
  async connectInternetChannel(secret: string) {
    await this.nostr.connect(secret);
  }

  /**
   * Disconnect from internet channel
   */
  disconnectInternetChannel() {
    this.nostr.disconnect();
  }
}

export const meshOrchestrator = MeshOrchestrator.getInstance();
