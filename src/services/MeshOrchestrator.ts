/**
 * MeshOrchestrator.ts — Central Networking Glue
 *
 * This class brings together the native RadioTransport, the MeshRouter,
 * and the TelemetryManager to create a fully functional mesh network.
 * It handles the lifecycle and wires all events together.
 */

import { RadioTransport } from '../core/radio/transport';
import { NostrTransport } from '../core/radio/nostr';
import { MeshRouter } from '../core/net/router';
import { TelemetryManager } from '../core/map/telemetry';
import { locationService } from './LocationService';
import { useIdentityStore } from '../core/crypto/identity';
import { useConvoyStore } from '../core/map/telemetry';
import { useHazardStore } from '../core/map/crdt';

export class MeshOrchestrator {
  private static instance: MeshOrchestrator | null = null;
  
  public transport: RadioTransport;
  public nostr: NostrTransport;
  public router: MeshRouter;
  public telemetry: TelemetryManager;

  private isRunning: boolean = false;

  private constructor() {
    this.transport = new RadioTransport();
    this.nostr = new NostrTransport();
    this.router = new MeshRouter();
    this.telemetry = new TelemetryManager();

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
        if (peerId === 'nostr-channel') {
          this.nostr.broadcastPacket(data);
        } else {
          this.transport.sendPacket(peerId, data);
        }
      },
      () => {
        const peers = this.transport.getConnectedPeers();
        // Expose Nostr channel as a connected peer so the router broadcasts to it
        if ((this.nostr as any).isRunning) {
          peers.push('nostr-channel');
        }
        return peers;
      }
    );

    // 2. Configure Transport -> Router (Incoming)
    this.transport.setCallbacks({
      onPacketReceived: (peerId, data) => {
        this.router.handleIncoming(peerId, data);
      },
      onPeerDiscovered: (peer) => {
        console.log('[MeshOrchestrator] Discovered peer:', peer.peerId);
        // We could update a UI store here if needed for discovering status
      },
      onPeerLost: (peerId) => {
        console.log('[MeshOrchestrator] Lost peer:', peerId);
      }
    });

    this.nostr.setCallbacks((peerId, data) => {
      this.router.handleIncoming(peerId, data);
    });

    // 3. Configure Telemetry -> Router (Outgoing GPS packets)
    this.telemetry.configure({
      originatePacket: (header, payload) => this.router.originatePacket(header, payload),
      getFingerprint: () => useIdentityStore.getState().identity?.fingerprint ?? null,
      getChannelToken: () => {
        // Use a generic group token or derived from identity
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

    // Must be called after React Native native modules are ready
    this.transport.initialize();

    const identity = useIdentityStore.getState().identity;
    const advData = identity?.fingerprint ?? new Uint8Array(16);

    // Start native BLE and Wi-Fi Direct
    await this.transport.start(advData);

    // Try starting a Wi-Fi Direct group implicitly using a generic token for the local mesh
    const tokenBuffer = new Uint8Array(8);
    tokenBuffer.fill(0x01); // Generic fallback token for now
    const channelTokenHex = Array.from(tokenBuffer).map(b => b.toString(16).padStart(2, '0')).join('');
    this.transport.startWiFiP2PDiscovery(channelTokenHex).catch(err => {
      console.warn('[MeshOrchestrator] Failed to start Wi-Fi P2P discovery:', err);
    });

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

    this.transport.stop();
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
