/**
 * KonvoyAudioEngine.h — Shared C++ Audio Core
 *
 * Cross-platform audio processing engine wrapping libopus for
 * encode/decode, with integrated VAD, noise gate, adaptive jitter
 * buffer, and packet loss concealment (PLC).
 *
 * This is compiled as a static library linked into both
 * Android (via NDK/CMake) and iOS (via Xcode).
 */

#pragma once

#include <cstdint>
#include <cstddef>
#include <vector>
#include <memory>
#include <opus/opus.h>

namespace konvoy {

// ─── Constants ───────────────────────────────────────────────────────────

constexpr int DEFAULT_SAMPLE_RATE = 16000;
constexpr int DEFAULT_CHANNELS = 1;
constexpr int DEFAULT_FRAME_SIZE_MS = 20;
constexpr int DEFAULT_BITRATE = 12000;        // 12 kbps
constexpr int DEFAULT_FRAME_SIZE = DEFAULT_SAMPLE_RATE * DEFAULT_FRAME_SIZE_MS / 1000; // 320 samples
constexpr int MAX_OPUS_PACKET_SIZE = 512;      // Max encoded frame bytes
constexpr int MAX_PCM_FRAME_SIZE = 960;        // Max samples per frame (48kHz/20ms)

// ─── VAD Configuration ───────────────────────────────────────────────────

struct VADConfig {
    bool enabled = false;
    float energyThreshold = 0.01f;   // RMS energy threshold (0.0–1.0)
    int hangoverFrames = 5;           // Keep transmitting N frames after voice stops
};

// ─── Noise Gate Configuration ────────────────────────────────────────────

struct NoiseGateConfig {
    bool enabled = false;
    float thresholdDb = -40.0f;       // Gate threshold in dB
    float attackMs = 1.0f;            // Attack time
    float releaseMs = 50.0f;          // Release time
};

// ─── Jitter Buffer Entry ─────────────────────────────────────────────────

struct JitterEntry {
    std::vector<int16_t> pcmData;
    uint16_t sequenceNumber;
    bool valid;
};

// ─── Audio Engine ────────────────────────────────────────────────────────

class AudioEngine {
public:
    AudioEngine();
    ~AudioEngine();

    // Initialization
    bool initialize(int sampleRate = DEFAULT_SAMPLE_RATE,
                    int channels = DEFAULT_CHANNELS,
                    int frameSizeMs = DEFAULT_FRAME_SIZE_MS);
    void shutdown();
    bool isInitialized() const;

    // Opus Encoder
    void setBitrate(int bitrate);
    void setVBR(bool enabled);
    int encode(const int16_t* pcmInput, int frameSize,
               uint8_t* opusOutput, int maxOutputSize);

    // Opus Decoder
    int decode(const uint8_t* opusInput, int opusSize,
               int16_t* pcmOutput, int maxFrameSize);
    int decodePLC(int16_t* pcmOutput, int maxFrameSize);

    // VAD
    void setVADConfig(const VADConfig& config);
    bool detectVoiceActivity(const int16_t* pcmData, int frameSize);
    float computeRMSEnergy(const int16_t* pcmData, int frameSize);

    // Noise Gate
    void setNoiseGateConfig(const NoiseGateConfig& config);
    bool applyNoiseGate(int16_t* pcmData, int frameSize);

    // Jitter Buffer
    void configureJitterBuffer(int minDepthMs, int maxDepthMs);
    void enqueueFrame(const int16_t* pcmData, int frameSize, uint16_t sequenceNumber);
    int dequeueFrame(int16_t* pcmOutput, int maxFrameSize);
    int getJitterBufferDepthMs() const;

    // Statistics
    struct Stats {
        uint64_t encodedFrames = 0;
        uint64_t decodedFrames = 0;
        uint64_t plcFrames = 0;
        uint64_t vadSuppressedFrames = 0;
        uint64_t gateClosedFrames = 0;
        float currentRMSEnergy = 0.0f;
        int jitterBufferDepthMs = 0;
    };
    Stats getStats() const;

private:
    // Opus state
    OpusEncoder* encoder_ = nullptr;
    OpusDecoder* decoder_ = nullptr;

    // Configuration
    int sampleRate_ = DEFAULT_SAMPLE_RATE;
    int channels_ = DEFAULT_CHANNELS;
    int frameSize_ = DEFAULT_FRAME_SIZE;
    bool initialized_ = false;

    // VAD state
    VADConfig vadConfig_;
    int vadHangoverCounter_ = 0;

    // Noise gate state
    NoiseGateConfig noiseGateConfig_;
    float gateGain_ = 0.0f;

    // Jitter buffer
    int jitterMinDepthMs_ = 40;
    int jitterMaxDepthMs_ = 100;
    std::vector<JitterEntry> jitterBuffer_;
    uint16_t nextPlaySequence_ = 0;
    int currentJitterDepthMs_ = 40;

    // Statistics
    Stats stats_;

    // Internal helpers
    float sampleToDb(float rms) const;
    void adaptJitterDepth(int arrivalJitterMs);
};

} // namespace konvoy
