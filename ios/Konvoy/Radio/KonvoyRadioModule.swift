/**
 * KonvoyRadioModule.swift — iOS Native Radio TurboModule
 *
 * Implements BLE beacon/scan using CoreBluetooth with background
 * state restoration, and Wi-Fi P2P using WiFiAwareSession (iOS 19+)
 * or Network.framework fallback for local peer data sockets.
 */

import Foundation
import CoreBluetooth
import Network
import React

@objc(KonvoyRadio)
class KonvoyRadioModule: RCTEventEmitter {

    // MARK: - Constants

    static let konvoyServiceUUID = CBUUID(string: "6B6F6E76-6F79-4D65-7368-000000000001")
    static let konvoyCharUUID = CBUUID(string: "6B6F6E76-6F79-4D65-7368-000000000002")
    static let restoreIdentifier = "com.konvoy.app.bluetooth"

    // MARK: - BLE State

    private var centralManager: CBCentralManager?
    private var peripheralManager: CBPeripheralManager?
    private var isAdvertising = false
    private var isScanning = false
    private var advertisementData: Data?

    // MARK: - Network / P2P State

    private var listener: NWListener?
    private var connections: [String: NWConnection] = [:]
    private var connectedPeers: [String] = []
    private let networkQueue = DispatchQueue(label: "com.konvoy.app.radio.network", qos: .userInitiated)

    // MARK: - Module Setup

    override static func moduleName() -> String! {
        return "KonvoyRadio"
    }

    override func supportedEvents() -> [String]! {
        return [
            "KonvoyPeerDiscovered",
            "KonvoyPacketReceived",
            "KonvoyPeerLost"
        ]
    }

    override static func requiresMainQueueSetup() -> Bool {
        return false
    }

    // MARK: - BLE Beacon

    @objc
    func startBLEBeacon(_ serviceUUID: String, advertisementDataBase64: String) {
        guard !isAdvertising else { return }

        advertisementData = Data(base64Encoded: advertisementDataBase64)

        // Initialize peripheral manager with state restoration
        peripheralManager = CBPeripheralManager(
            delegate: self,
            queue: networkQueue,
            options: [
                CBPeripheralManagerOptionRestoreIdentifierKey: KonvoyRadioModule.restoreIdentifier + ".peripheral"
            ]
        )
    }

    @objc
    func stopBLEBeacon() {
        guard isAdvertising else { return }
        peripheralManager?.stopAdvertising()
        isAdvertising = false
    }

    // MARK: - BLE Scan

    @objc
    func startBLEScan(_ serviceUUID: String) {
        guard !isScanning else { return }

        // Initialize central manager with state restoration
        centralManager = CBCentralManager(
            delegate: self,
            queue: networkQueue,
            options: [
                CBCentralManagerOptionRestoreIdentifierKey: KonvoyRadioModule.restoreIdentifier + ".central"
            ]
        )
    }

    @objc
    func stopBLEScan() {
        guard isScanning else { return }
        centralManager?.stopScan()
        isScanning = false
    }

    // MARK: - Wi-Fi P2P / Network.framework

    @objc
    func startWiFiP2PGroup(_ channelToken: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
        networkQueue.async { [weak self] in
            guard let self = self else { return }

            do {
                // Create NWListener on a random available port
                let params = NWParameters.tcp
                params.includePeerToPeer = true

                // Set Bonjour service for discovery
                let service = NWListener.Service(
                    name: "konvoy-\(channelToken.prefix(8))",
                    type: "_konvoy._tcp"
                )

                let listener = try NWListener(using: params)
                listener.service = service

                listener.stateUpdateHandler = { [weak self] state in
                    switch state {
                    case .ready:
                        let port = listener.port?.rawValue ?? 0
                        let result: [String: Any] = [
                            "address": "0.0.0.0",
                            "port": Int(port),
                            "isGroupOwner": true
                        ]
                        resolve(result)

                    case .failed(let error):
                        reject("LISTENER_ERROR", "NWListener failed: \(error)", error)

                    default:
                        break
                    }
                }

                listener.newConnectionHandler = { [weak self] connection in
                    self?.handleNewConnection(connection)
                }

                listener.start(queue: self.networkQueue)
                self.listener = listener

            } catch {
                reject("LISTENER_ERROR", "Failed to create listener", error)
            }
        }
    }

    @objc
    func connectWiFiP2P(_ address: String, port: Int, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
        networkQueue.async { [weak self] in
            guard let self = self else { return }

            let host = NWEndpoint.Host(address)
            let nwPort = NWEndpoint.Port(rawValue: UInt16(port))!
            let params = NWParameters.tcp
            params.includePeerToPeer = true

            let connection = NWConnection(host: host, port: nwPort, using: params)
            let peerId = "\(address):\(port)"

            connection.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    self?.connections[peerId] = connection
                    self?.connectedPeers.append(peerId)
                    self?.startReceiveLoop(connection: connection, peerId: peerId)
                    resolve(peerId)

                case .failed(let error):
                    reject("CONNECT_ERROR", "Connection failed: \(error)", error)

                default:
                    break
                }
            }

            connection.start(queue: self.networkQueue)
        }
    }

    @objc
    func disconnectWiFiP2P() {
        networkQueue.async { [weak self] in
            self?.connections.values.forEach { $0.cancel() }
            self?.connections.removeAll()
            self?.connectedPeers.removeAll()
            self?.listener?.cancel()
            self?.listener = nil
        }
    }

    // MARK: - Packet I/O

    @objc
    func sendPacket(_ peerId: String, dataBase64: String) {
        networkQueue.async { [weak self] in
            guard let connection = self?.connections[peerId],
                  let data = Data(base64Encoded: dataBase64) else { return }

            // Length-prefixed frame: [4-byte big-endian length][data]
            var length = UInt32(data.count).bigEndian
            var frame = Data(bytes: &length, count: 4)
            frame.append(data)

            connection.send(content: frame, completion: .contentProcessed { error in
                if let error = error {
                    NSLog("[KonvoyRadio] Send error to \(peerId): \(error)")
                    self?.removePeer(peerId)
                }
            })
        }
    }

    @objc
    func broadcastPacket(_ dataBase64: String) {
        networkQueue.async { [weak self] in
            self?.connectedPeers.forEach { peerId in
                self?.sendPacket(peerId, dataBase64: dataBase64)
            }
        }
    }

    @objc(getConnectedPeers)
    func getConnectedPeers() -> [String] {
        return connectedPeers
    }

    // MARK: - State Queries

    @objc(isBLEAvailable)
    func isBLEAvailable() -> Bool {
        return centralManager?.state == .poweredOn
    }

    @objc(isWiFiP2PAvailable)
    func isWiFiP2PAvailable() -> Bool {
        // Wi-Fi Aware / Network.framework P2P is available on iOS 12+
        return true
    }

    @objc(getRadioState)
    func getRadioState() -> [String: Any] {
        return [
            "bleAdvertising": isAdvertising,
            "bleScanning": isScanning,
            "wifiP2PConnected": !connections.isEmpty,
            "connectedPeerCount": connections.count
        ]
    }

    // MARK: - Internal

    private func handleNewConnection(_ connection: NWConnection) {
        let peerId = connection.endpoint.debugDescription

        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.connections[peerId] = connection
                self?.connectedPeers.append(peerId)
                self?.startReceiveLoop(connection: connection, peerId: peerId)

            case .failed, .cancelled:
                self?.removePeer(peerId)

            default:
                break
            }
        }

        connection.start(queue: networkQueue)
    }

    private func startReceiveLoop(connection: NWConnection, peerId: String) {
        // Read 4-byte length prefix
        connection.receive(minimumIncompleteLength: 4, maximumLength: 4) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }

            if isComplete || error != nil {
                self.removePeer(peerId)
                return
            }

            guard let lengthData = data, lengthData.count == 4 else {
                self.startReceiveLoop(connection: connection, peerId: peerId)
                return
            }

            let length = lengthData.withUnsafeBytes { $0.load(as: UInt32.self).bigEndian }

            guard length > 0 && length <= 65536 else {
                self.startReceiveLoop(connection: connection, peerId: peerId)
                return
            }

            // Read payload
            connection.receive(minimumIncompleteLength: Int(length), maximumLength: Int(length)) { [weak self] payloadData, _, isComplete, error in
                guard let self = self else { return }

                if isComplete || error != nil {
                    self.removePeer(peerId)
                    return
                }

                if let payload = payloadData {
                    let base64 = payload.base64EncodedString()
                    self.sendEvent(withName: "KonvoyPacketReceived", body: [
                        "peerId": peerId,
                        "dataBase64": base64
                    ])
                }

                // Continue reading
                self.startReceiveLoop(connection: connection, peerId: peerId)
            }
        }
    }

    private func removePeer(_ peerId: String) {
        connections[peerId]?.cancel()
        connections.removeValue(forKey: peerId)
        connectedPeers.removeAll { $0 == peerId }

        sendEvent(withName: "KonvoyPeerLost", body: [
            "peerId": peerId
        ])
    }
}

// MARK: - CBCentralManagerDelegate

extension KonvoyRadioModule: CBCentralManagerDelegate {

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn && !isScanning {
            // Start scanning with service UUID filter (required for background)
            central.scanForPeripherals(
                withServices: [KonvoyRadioModule.konvoyServiceUUID],
                options: [
                    CBCentralManagerScanOptionAllowDuplicatesKey: true
                ]
            )
            isScanning = true
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let peerId = peripheral.identifier.uuidString
        let serviceData = advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data]
        let data = serviceData?[KonvoyRadioModule.konvoyServiceUUID] ?? Data()

        sendEvent(withName: "KonvoyPeerDiscovered", body: [
            "peerId": peerId,
            "rssi": RSSI.intValue,
            "dataBase64": data.base64EncodedString()
        ])
    }

    // State restoration — critical for background BLE
    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        NSLog("[KonvoyRadio] Central manager state restored")
        // Resume scanning upon restoration
        if central.state == .poweredOn {
            central.scanForPeripherals(
                withServices: [KonvoyRadioModule.konvoyServiceUUID],
                options: nil
            )
            isScanning = true
        }
    }
}

// MARK: - CBPeripheralManagerDelegate

extension KonvoyRadioModule: CBPeripheralManagerDelegate {

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        if peripheral.state == .poweredOn && !isAdvertising {
            let advData: [String: Any] = [
                CBAdvertisementDataServiceUUIDsKey: [KonvoyRadioModule.konvoyServiceUUID],
                CBAdvertisementDataLocalNameKey: "Konvoy"
            ]
            peripheral.startAdvertising(advData)
            isAdvertising = true
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, willRestoreState dict: [String: Any]) {
        NSLog("[KonvoyRadio] Peripheral manager state restored")
    }
}
