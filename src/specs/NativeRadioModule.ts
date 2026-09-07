/**
 * NativeRadioModule — TurboModule Spec
 *
 * Abstracts BLE (discovery/beacons) and Wi-Fi P2P (high-throughput
 * data sockets) into a unified radio interface. Platform-specific
 * implementations:
 *   - Android: BluetoothLeAdvertiser/Scanner + WifiP2pManager
 *   - iOS: CoreBluetooth + WiFiAwareSession (iOS 19+)
 */

import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  // ─── BLE Beacon / Discovery ─────────────────────────────────────

  /**
   * Start advertising a BLE beacon with service UUID and advertisement data.
   * The advertisement data encodes our fingerprint + channel token.
   * @param serviceUUID - The service UUID to advertise.
   * @param advertisementDataBase64 - Encoded advertisement payload (base64, ≤31 bytes).
   */
  startBLEBeacon(serviceUUID: string, advertisementDataBase64: string): void;

  /**
   * Stop BLE advertising.
   */
  stopBLEBeacon(): void;

  /**
   * Start scanning for BLE beacons matching the service UUID.
   * Discovered peers trigger the 'onPeerDiscovered' event.
   */
  startBLEScan(serviceUUID: string): void;

  /**
   * Stop BLE scanning.
   */
  stopBLEScan(): void;

  // ─── Wi-Fi P2P / High-Bandwidth Data ───────────────────────────

  /**
   * Create or join a Wi-Fi P2P group and start a TCP server socket.
   * Returns the local address and port for peer connections.
   * @param channelToken - Hex-encoded channel token for service discovery filtering.
   */
  startWiFiP2PGroup(channelToken: string): Promise<{
    address: string;
    port: number;
    isGroupOwner: boolean;
  }>;

  /**
   * Connect to a Wi-Fi P2P peer's data socket.
   * @param address - Peer's IP address.
   * @param port - Peer's TCP port.
   */
  connectWiFiP2P(address: string, port: number): Promise<string>; // returns peerId

  /**
   * Disconnect from a Wi-Fi P2P group.
   */
  disconnectWiFiP2P(): void;

  // ─── Unified Packet I/O ────────────────────────────────────────

  /**
   * Send a raw binary packet to a specific peer.
   * @param peerId - The peer's identifier.
   * @param dataBase64 - The packet data (base64-encoded).
   */
  sendPacket(peerId: string, dataBase64: string): void;

  /**
   * Broadcast a packet to all connected peers.
   * @param dataBase64 - The packet data (base64-encoded).
   */
  broadcastPacket(dataBase64: string): void;

  /**
   * Get the list of currently connected peer IDs.
   */
  getConnectedPeers(): string[];

  // ─── State Queries ─────────────────────────────────────────────

  /**
   * Check if BLE is available and enabled on this device.
   */
  isBLEAvailable(): boolean;

  /**
   * Check if Wi-Fi P2P is available on this device.
   */
  isWiFiP2PAvailable(): boolean;

  /**
   * Get the current radio state.
   */
  getRadioState(): {
    bleAdvertising: boolean;
    bleScanning: boolean;
    wifiP2PConnected: boolean;
    connectedPeerCount: number;
  };
}

export default TurboModuleRegistry.getEnforcing<Spec>('KonvoyRadio');
