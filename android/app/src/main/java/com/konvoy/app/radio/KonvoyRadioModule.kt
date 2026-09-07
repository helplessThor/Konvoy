/**
 * KonvoyRadioModule.kt — Android Native Radio TurboModule
 *
 * Implements BLE beacon/scan using Android BluetoothLE APIs and
 * Wi-Fi Direct P2P using WifiP2pManager with DNS-SD service discovery.
 * Runs all radio operations on a dedicated HandlerThread.
 */

package com.konvoy.app.radio

import android.Manifest
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.wifi.p2p.*
import android.net.wifi.p2p.nsd.*
import android.os.*
import android.util.Base64
import android.util.Log
import androidx.core.app.ActivityCompat
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.*
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap

class KonvoyRadioModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val TAG = "KonvoyRadio"
        const val MODULE_NAME = "KonvoyRadio"

        // Konvoy BLE Service UUID
        const val KONVOY_SERVICE_UUID = "6b6f6e76-6f79-4d65-7368-000000000001"

        // Wi-Fi Direct service info
        const val SERVICE_INSTANCE = "_konvoy"
        const val SERVICE_TYPE = "_mesh._tcp"

        // TCP server port range
        const val SERVER_PORT_MIN = 18500
        const val SERVER_PORT_MAX = 18600
    }

    override fun getName(): String = MODULE_NAME

    // ─── Bluetooth LE ─────────────────────────────────────────────────

    private var bluetoothAdapter: BluetoothAdapter? = null
    private var bleAdvertiser: BluetoothLeAdvertiser? = null
    private var bleScanner: BluetoothLeScanner? = null
    private var isAdvertising = false
    private var isScanning = false

    // ─── Wi-Fi P2P ────────────────────────────────────────────────────

    private var wifiP2pManager: WifiP2pManager? = null
    private var wifiP2pChannel: WifiP2pManager.Channel? = null
    private var isWifiP2PConnected = false

    // ─── Peer Management ──────────────────────────────────────────────

    private val connectedPeers = ConcurrentHashMap<String, PeerConnection>()
    private var serverSocket: ServerSocket? = null
    private val radioThread = HandlerThread("KonvoyRadioThread").also { it.start() }
    private val radioHandler = Handler(radioThread.looper)

    // ─── Peer Connection ──────────────────────────────────────────────

    data class PeerConnection(
        val peerId: String,
        val socket: Socket,
        val outputStream: OutputStream,
        val inputStream: InputStream,
        var lastSeenMs: Long = System.currentTimeMillis()
    )

    // ─── Initialization ───────────────────────────────────────────────

    init {
        val bluetoothManager = reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        bluetoothAdapter = bluetoothManager?.adapter
        bleAdvertiser = bluetoothAdapter?.bluetoothLeAdvertiser
        bleScanner = bluetoothAdapter?.bluetoothLeScanner

        wifiP2pManager = reactContext.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager
        wifiP2pChannel = wifiP2pManager?.initialize(reactContext, radioThread.looper, null)
    }

    // ─── BLE Beacon ───────────────────────────────────────────────────

    @ReactMethod
    fun startBLEBeacon(serviceUUID: String, advertisementDataBase64: String) {
        if (isAdvertising || bleAdvertiser == null) return

        val parcelUuid = ParcelUuid.fromString(serviceUUID)
        val advData = Base64.decode(advertisementDataBase64, Base64.NO_WRAP)

        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(false)
            .setTimeout(0) // Advertise indefinitely
            .build()

        val data = AdvertiseData.Builder()
            .addServiceUuid(parcelUuid)
            .addServiceData(parcelUuid, advData.take(20).toByteArray()) // Max 20 bytes service data
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .build()

        val callback = object : AdvertiseCallback() {
            override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
                isAdvertising = true
                Log.i(TAG, "BLE beacon started")
            }

            override fun onStartFailure(errorCode: Int) {
                Log.e(TAG, "BLE beacon start failed: $errorCode")
            }
        }

        try {
            bleAdvertiser?.startAdvertising(settings, data, callback)
        } catch (e: SecurityException) {
            Log.e(TAG, "BLE permission denied", e)
        }
    }

    @ReactMethod
    fun stopBLEBeacon() {
        if (!isAdvertising) return
        try {
            bleAdvertiser?.stopAdvertising(object : AdvertiseCallback() {})
        } catch (e: SecurityException) {
            Log.e(TAG, "BLE stop permission denied", e)
        }
        isAdvertising = false
    }

    // ─── BLE Scan ─────────────────────────────────────────────────────

    @ReactMethod
    fun startBLEScan(serviceUUID: String) {
        if (isScanning || bleScanner == null) return

        val parcelUuid = ParcelUuid.fromString(serviceUUID)
        val filter = ScanFilter.Builder()
            .setServiceUuid(parcelUuid)
            .build()

        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .setReportDelay(0)
            .build()

        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val serviceData = result.scanRecord?.getServiceData(parcelUuid)
                val peerId = result.device.address
                val rssi = result.rssi

                val params = Arguments.createMap().apply {
                    putString("peerId", peerId)
                    putInt("rssi", rssi)
                    putString("dataBase64",
                        Base64.encodeToString(serviceData ?: ByteArray(0), Base64.NO_WRAP)
                    )
                }

                sendEvent("KonvoyPeerDiscovered", params)
            }

            override fun onScanFailed(errorCode: Int) {
                Log.e(TAG, "BLE scan failed: $errorCode")
            }
        }

        try {
            bleScanner?.startScan(listOf(filter), settings, callback)
            isScanning = true
        } catch (e: SecurityException) {
            Log.e(TAG, "BLE scan permission denied", e)
        }
    }

    @ReactMethod
    fun stopBLEScan() {
        if (!isScanning) return
        try {
            bleScanner?.stopScan(object : ScanCallback() {})
        } catch (e: SecurityException) {
            Log.e(TAG, "BLE stop scan permission denied", e)
        }
        isScanning = false
    }

    // ─── Wi-Fi P2P Group ──────────────────────────────────────────────

    @ReactMethod
    fun startWiFiP2PGroup(channelToken: String, promise: Promise) {
        radioHandler.post {
            try {
                // Register DNS-SD local service
                val record = mapOf("channel" to channelToken, "proto" to "konvoy")
                val serviceInfo = WifiP2pDnsSdServiceInfo.newInstance(
                    SERVICE_INSTANCE, SERVICE_TYPE, record
                )

                wifiP2pManager?.addLocalService(wifiP2pChannel, serviceInfo,
                    object : WifiP2pManager.ActionListener {
                        override fun onSuccess() {
                            Log.i(TAG, "Wi-Fi P2P service registered")
                        }
                        override fun onFailure(reason: Int) {
                            Log.e(TAG, "Wi-Fi P2P service registration failed: $reason")
                        }
                    }
                )

                // Create group
                wifiP2pManager?.createGroup(wifiP2pChannel,
                    object : WifiP2pManager.ActionListener {
                        override fun onSuccess() {
                            // Start TCP server for data exchange
                            startTCPServer(promise)
                        }
                        override fun onFailure(reason: Int) {
                            promise.reject("WIFI_P2P_ERROR", "Failed to create group: $reason")
                        }
                    }
                )
            } catch (e: SecurityException) {
                promise.reject("PERMISSION_ERROR", "Wi-Fi P2P permission denied", e)
            }
        }
    }

    private fun startTCPServer(promise: Promise) {
        radioHandler.post {
            try {
                serverSocket = ServerSocket(0) // OS assigns port
                val port = serverSocket!!.localPort

                val result = Arguments.createMap().apply {
                    putString("address", "0.0.0.0")
                    putInt("port", port)
                    putBoolean("isGroupOwner", true)
                }
                promise.resolve(result)

                // Accept connections in background
                Thread {
                    while (serverSocket != null && !serverSocket!!.isClosed) {
                        try {
                            val clientSocket = serverSocket!!.accept()
                            val peerId = clientSocket.remoteSocketAddress.toString()
                            val peer = PeerConnection(
                                peerId = peerId,
                                socket = clientSocket,
                                outputStream = clientSocket.getOutputStream(),
                                inputStream = clientSocket.getInputStream()
                            )
                            connectedPeers[peerId] = peer
                            startReadLoop(peer)
                        } catch (e: Exception) {
                            if (serverSocket?.isClosed != true) {
                                Log.e(TAG, "Accept error", e)
                            }
                        }
                    }
                }.start()
            } catch (e: Exception) {
                promise.reject("TCP_ERROR", "Failed to start TCP server", e)
            }
        }
    }

    @ReactMethod
    fun connectWiFiP2P(address: String, port: Int, promise: Promise) {
        radioHandler.post {
            try {
                val socket = Socket(address, port)
                val peerId = "$address:$port"
                val peer = PeerConnection(
                    peerId = peerId,
                    socket = socket,
                    outputStream = socket.getOutputStream(),
                    inputStream = socket.getInputStream()
                )
                connectedPeers[peerId] = peer
                startReadLoop(peer)
                promise.resolve(peerId)
            } catch (e: Exception) {
                promise.reject("CONNECT_ERROR", "Failed to connect", e)
            }
        }
    }

    @ReactMethod
    fun disconnectWiFiP2P() {
        radioHandler.post {
            connectedPeers.values.forEach { peer ->
                try {
                    peer.socket.close()
                } catch (e: Exception) {
                    // Ignore
                }
            }
            connectedPeers.clear()
            serverSocket?.close()
            serverSocket = null
            isWifiP2PConnected = false
        }
    }

    // ─── Packet I/O ───────────────────────────────────────────────────

    @ReactMethod
    fun sendPacket(peerId: String, dataBase64: String) {
        radioHandler.post {
            val peer = connectedPeers[peerId] ?: return@post
            try {
                val data = Base64.decode(dataBase64, Base64.NO_WRAP)
                // Write length-prefixed frame: [4-byte length][data]
                val lengthBytes = ByteArray(4)
                lengthBytes[0] = ((data.size shr 24) and 0xFF).toByte()
                lengthBytes[1] = ((data.size shr 16) and 0xFF).toByte()
                lengthBytes[2] = ((data.size shr 8) and 0xFF).toByte()
                lengthBytes[3] = (data.size and 0xFF).toByte()
                peer.outputStream.write(lengthBytes)
                peer.outputStream.write(data)
                peer.outputStream.flush()
            } catch (e: Exception) {
                Log.e(TAG, "Send error to $peerId", e)
                removePeer(peerId)
            }
        }
    }

    @ReactMethod
    fun broadcastPacket(dataBase64: String) {
        radioHandler.post {
            connectedPeers.keys.toList().forEach { peerId ->
                sendPacket(peerId, dataBase64)
            }
        }
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getConnectedPeers(): WritableArray {
        val array = Arguments.createArray()
        connectedPeers.keys.forEach { array.pushString(it) }
        return array
    }

    // ─── State Queries ────────────────────────────────────────────────

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun isBLEAvailable(): Boolean {
        return bluetoothAdapter?.isEnabled == true && bleAdvertiser != null
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun isWiFiP2PAvailable(): Boolean {
        return reactApplicationContext.packageManager
            .hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT)
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getRadioState(): WritableMap {
        return Arguments.createMap().apply {
            putBoolean("bleAdvertising", isAdvertising)
            putBoolean("bleScanning", isScanning)
            putBoolean("wifiP2PConnected", isWifiP2PConnected)
            putInt("connectedPeerCount", connectedPeers.size)
        }
    }

    // ─── Internal ─────────────────────────────────────────────────────

    private fun startReadLoop(peer: PeerConnection) {
        Thread {
            val lengthBuf = ByteArray(4)
            try {
                while (!peer.socket.isClosed) {
                    // Read length prefix
                    var bytesRead = 0
                    while (bytesRead < 4) {
                        val r = peer.inputStream.read(lengthBuf, bytesRead, 4 - bytesRead)
                        if (r == -1) throw IOException("EOF")
                        bytesRead += r
                    }

                    val length = ((lengthBuf[0].toInt() and 0xFF) shl 24) or
                            ((lengthBuf[1].toInt() and 0xFF) shl 16) or
                            ((lengthBuf[2].toInt() and 0xFF) shl 8) or
                            (lengthBuf[3].toInt() and 0xFF)

                    if (length <= 0 || length > 65536) {
                        Log.w(TAG, "Invalid frame length: $length")
                        continue
                    }

                    // Read data
                    val data = ByteArray(length)
                    bytesRead = 0
                    while (bytesRead < length) {
                        val r = peer.inputStream.read(data, bytesRead, length - bytesRead)
                        if (r == -1) throw IOException("EOF")
                        bytesRead += r
                    }

                    peer.lastSeenMs = System.currentTimeMillis()

                    // Emit to JS
                    val params = Arguments.createMap().apply {
                        putString("peerId", peer.peerId)
                        putString("dataBase64", Base64.encodeToString(data, Base64.NO_WRAP))
                    }
                    sendEvent("KonvoyPacketReceived", params)
                }
            } catch (e: Exception) {
                if (!peer.socket.isClosed) {
                    Log.e(TAG, "Read error from ${peer.peerId}", e)
                }
                removePeer(peer.peerId)
            }
        }.start()
    }

    private fun removePeer(peerId: String) {
        val peer = connectedPeers.remove(peerId) ?: return
        try { peer.socket.close() } catch (e: Exception) { /* ignore */ }

        val params = Arguments.createMap().apply {
            putString("peerId", peerId)
        }
        sendEvent("KonvoyPeerLost", params)
    }

    private fun sendEvent(eventName: String, params: WritableMap) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            ?.emit(eventName, params)
    }

    // ─── Cleanup ──────────────────────────────────────────────────────

    override fun onCatalystInstanceDestroy() {
        super.onCatalystInstanceDestroy()
        stopBLEBeacon()
        stopBLEScan()
        disconnectWiFiP2P()
        radioThread.quitSafely()
    }
}
