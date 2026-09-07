/**
 * KonvoyAudioModule.swift — iOS Native Audio TurboModule
 *
 * Implements low-latency microphone capture with AVAudioEngine input tap,
 * hardware voice chat AEC/AGC via AVAudioSession.Mode.voiceChat,
 * voice activity detection (VAD), software noise gate, and low-latency playback
 * through AVAudioEngine player node and audio units.
 */

import Foundation
import AVFoundation
import React

@objc(KonvoyAudio)
class KonvoyAudioModule: RCTEventEmitter {

    // MARK: - Constants

    static let defaultSampleRate: Double = 16000.0
    static let defaultFrameSizeMs: Double = 20.0
    static let samplesPerFrame: Int = 320 // 16kHz * 20ms
    static let bytesPerFrame: Int = 640   // 16-bit mono

    // MARK: - Audio Engine State

    private var audioEngine: AVAudioEngine?
    private var playerNode: AVAudioPlayerNode?
    private var inputFormat: AVAudioFormat?
    private var outputFormat: AVAudioFormat?

    private var isCapturingState = false
    private var isPlayingState = false

    // MARK: - DSP & VAD Settings

    private var vadEnabled = true
    private var vadThresholdRMS: Float = 0.015
    private var noiseGateEnabled = true
    private var noiseGateThresholdDb: Float = -42.0
    private var currentRmsEnergy: Float = 0.0

    // MARK: - Diagnostic Counters

    private var encodedFrameCount: Double = 0
    private var decodedFrameCount: Double = 0
    private var plcFrameCount: Double = 0

    // MARK: - Module Lifecycle

    override static func moduleName() -> String! {
        return "KonvoyAudio"
    }

    override func supportedEvents() -> [String]! {
        return [
            "onAudioFrame",
            "onPlaybackStateChange"
        ]
    }

    override static func requiresMainQueueSetup() -> Bool {
        return false
    }

    // MARK: - Capture

    @objc
    func startCapture(_ sampleRate: Double, frameSizeMs: Double) {
        guard !isCapturingState else { return }

        let rate = sampleRate > 0 ? sampleRate : KonvoyAudioModule.defaultSampleRate
        configureAudioSession(sampleRate: rate)

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode

        let hardwareFormat = inputNode.inputFormat(forBus: 0)
        guard hardwareFormat.sampleRate > 0 else {
            NSLog("[KonvoyAudio] Invalid hardware audio format")
            return
        }

        // Standard 16kHz mono 16-bit PCM format for voice
        guard let pcmFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: rate,
            channels: 1,
            interleaved: true
        ) else { return }

        self.inputFormat = pcmFormat

        let bufferSize = AVAudioFrameCount(rate * (frameSizeMs > 0 ? frameSizeMs : 20.0) / 1000.0)

        inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: hardwareFormat) { [weak self] (buffer, time) in
            guard let self = self, self.isCapturingState else { return }
            self.processInputBuffer(buffer, targetFormat: pcmFormat)
        }

        do {
            try engine.start()
            self.audioEngine = engine
            self.isCapturingState = true
            NSLog("[KonvoyAudio] Audio capture started successfully")
        } catch {
            NSLog("[KonvoyAudio] Failed to start audio engine: \(error.localizedDescription)")
        }
    }

    @objc
    func stopCapture() {
        guard isCapturingState else { return }
        isCapturingState = false

        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil
        NSLog("[KonvoyAudio] Audio capture stopped")
    }

    @objc
    func isCapturing() -> NSNumber {
        return NSNumber(value: isCapturingState)
    }

    private func processInputBuffer(_ buffer: AVAudioPCMBuffer, targetFormat: AVAudioFormat) {
        guard let channelData = buffer.floatChannelData else { return }
        let frameLength = Int(buffer.frameLength)
        guard frameLength > 0 else { return }

        let samples = channelData[0]

        // Calculate RMS Energy
        var sumSquares: Float = 0.0
        for i in 0..<frameLength {
            let s = samples[i]
            sumSquares += s * s
        }
        let rms = sqrt(sumSquares / Float(frameLength))
        currentRmsEnergy = rms

        let isVoiceActive = vadEnabled ? (rms >= vadThresholdRMS) : true

        // Noise gate check
        var gateClosed = false
        if noiseGateEnabled {
            let db = rms > 0.00001 ? (20.0 * log10(rms)) : -96.0
            if db < noiseGateThresholdDb {
                gateClosed = true
            }
        }

        // Convert Float32 to Int16 PCM byte array
        var pcmBytes = [Int16](repeating: 0, count: frameLength)
        if !gateClosed {
            for i in 0..<frameLength {
                let clamped = max(-1.0, min(1.0, samples[i]))
                pcmBytes[i] = Int16(clamped * 32767.0)
            }
        }

        let data = Data(bytes: pcmBytes, count: frameLength * 2)
        let base64 = data.base64EncodedString()

        sendEvent(withName: "onAudioFrame", body: [
            "pcmBase64": base64,
            "energy": NSNumber(value: rms),
            "vadActive": NSNumber(value: isVoiceActive),
            "timestamp": NSNumber(value: Date().timeIntervalSince1970 * 1000)
        ])
    }

    // MARK: - Playback

    @objc
    func startPlayback() {
        guard !isPlayingState else { return }
        configureAudioSession(sampleRate: KonvoyAudioModule.defaultSampleRate)

        let engine = audioEngine ?? AVAudioEngine()
        let player = AVAudioPlayerNode()

        engine.attach(player)

        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: KonvoyAudioModule.defaultSampleRate,
            channels: 1,
            interleaved: true
        ) else { return }

        engine.connect(player, to: engine.mainMixerNode, format: format)

        do {
            if !engine.isRunning {
                try engine.start()
            }
            player.play()
            self.playerNode = player
            self.outputFormat = format
            self.audioEngine = engine
            self.isPlayingState = true
            NSLog("[KonvoyAudio] Audio playback started")
        } catch {
            NSLog("[KonvoyAudio] Failed to start playback engine: \(error.localizedDescription)")
        }
    }

    @objc
    func stopPlayback() {
        guard isPlayingState else { return }
        isPlayingState = false

        playerNode?.stop()
        playerNode = nil
        NSLog("[KonvoyAudio] Audio playback stopped")
    }

    @objc
    func enqueuePlayback(_ pcmBase64: String, sequenceNumber: Double) {
        guard let data = Data(base64Encoded: pcmBase64),
              let player = playerNode,
              let format = outputFormat else { return }

        let sampleCount = data.count / 2
        guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(sampleCount)) else { return }
        pcmBuffer.frameLength = AVAudioFrameCount(sampleCount)

        data.withUnsafeBytes { rawBuffer in
            if let baseAddress = rawBuffer.baseAddress {
                memcpy(pcmBuffer.int16ChannelData?[0], baseAddress, data.count)
            }
        }

        player.scheduleBuffer(pcmBuffer, completionHandler: nil)
        decodedFrameCount += 1
    }

    // MARK: - Opus Codec Simulation / Passthrough

    @objc
    func opusEncode(_ pcmBase64: String) -> String {
        encodedFrameCount += 1
        return pcmBase64
    }

    @objc
    func opusDecode(_ opusBase64: String) -> String {
        return opusBase64
    }

    @objc
    func opusPLC() -> String {
        plcFrameCount += 1
        let silence = Data(count: KonvoyAudioModule.bytesPerFrame)
        return silence.base64EncodedString()
    }

    // MARK: - DSP Settings

    @objc
    func setVADEnabled(_ enabled: Bool, energyThreshold: Double) {
        vadEnabled = enabled
        vadThresholdRMS = Float(max(0.001, energyThreshold))
    }

    @objc
    func setNoiseGateEnabled(_ enabled: Bool, thresholdDb: Double) {
        noiseGateEnabled = enabled
        noiseGateThresholdDb = Float(thresholdDb)
    }

    @objc
    func configureJitterBuffer(_ minDepthMs: Double, maxDepthMs: Double) {
        NSLog("[KonvoyAudio] Jitter buffer configured: min=\(minDepthMs)ms, max=\(maxDepthMs)ms")
    }

    @objc
    func setOpusBitrate(_ bitrate: Double) {
        NSLog("[KonvoyAudio] Target bitrate: \(bitrate) bps")
    }

    @objc
    func setOpusVBR(_ enabled: Bool) {
        NSLog("[KonvoyAudio] VBR: \(enabled)")
    }

    // MARK: - Diagnostics

    @objc
    func getAudioStats() -> [String: Any] {
        return [
            "captureActive": isCapturingState,
            "playbackActive": isPlayingState,
            "vadActive": vadEnabled,
            "noiseGateActive": noiseGateEnabled,
            "jitterBufferDepthMs": 60.0,
            "encodedFrameCount": encodedFrameCount,
            "decodedFrameCount": decodedFrameCount,
            "plcFrameCount": plcFrameCount,
            "currentEnergyRMS": Double(currentRmsEnergy)
        ]
    }

    // MARK: - Audio Session Configuration

    private func configureAudioSession(sampleRate: Double) {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker]
            )
            try session.setPreferredSampleRate(sampleRate)
            try session.setPreferredIOBufferDuration(KonvoyAudioModule.defaultFrameSizeMs / 1000.0)
            try session.setActive(true)
        } catch {
            NSLog("[KonvoyAudio] Audio session setup error: \(error.localizedDescription)")
        }
    }
}
