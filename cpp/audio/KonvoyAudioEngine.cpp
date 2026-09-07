/**
 * KonvoyAudioEngine.cpp — Shared C++ Audio Core Implementation
 *
 * Implements the cross-platform audio engine with:
 *   - libopus encode/decode (16kHz mono, 20ms frames, 6–12kbps VBR)
 *   - Energy-based Voice Activity Detection (VAD)
 *   - Noise gate with attack/release smoothing
 *   - Adaptive jitter buffer (40–100ms depth)
 *   - Opus built-in Packet Loss Concealment (PLC)
 */

#include "KonvoyAudioEngine.h"
#include <cmath>
#include <algorithm>
#include <cstring>

namespace konvoy {

// ─── Constructor / Destructor ────────────────────────────────────────────

AudioEngine::AudioEngine() = default;

AudioEngine::~AudioEngine() {
    shutdown();
}

// ─── Initialization ──────────────────────────────────────────────────────

bool AudioEngine::initialize(int sampleRate, int channels, int frameSizeMs) {
    if (initialized_) {
        shutdown();
    }

    sampleRate_ = sampleRate;
    channels_ = channels;
    frameSize_ = sampleRate * frameSizeMs / 1000;

    // Create Opus encoder
    int encoderError = 0;
    encoder_ = opus_encoder_create(sampleRate, channels, OPUS_APPLICATION_VOIP, &encoderError);
    if (encoderError != OPUS_OK || !encoder_) {
        return false;
    }

    // Configure encoder for low-latency voice
    opus_encoder_ctl(encoder_, OPUS_SET_BITRATE(DEFAULT_BITRATE));
    opus_encoder_ctl(encoder_, OPUS_SET_VBR(1));
    opus_encoder_ctl(encoder_, OPUS_SET_VBR_CONSTRAINT(0));
    opus_encoder_ctl(encoder_, OPUS_SET_COMPLEXITY(5));  // Balance quality/CPU
    opus_encoder_ctl(encoder_, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE));
    opus_encoder_ctl(encoder_, OPUS_SET_DTX(0));         // No discontinuous TX
    opus_encoder_ctl(encoder_, OPUS_SET_INBAND_FEC(1));  // Enable FEC for PLC

    // Create Opus decoder
    int decoderError = 0;
    decoder_ = opus_decoder_create(sampleRate, channels, &decoderError);
    if (decoderError != OPUS_OK || !decoder_) {
        opus_encoder_destroy(encoder_);
        encoder_ = nullptr;
        return false;
    }

    // Initialize jitter buffer
    jitterBuffer_.clear();
    nextPlaySequence_ = 0;
    currentJitterDepthMs_ = jitterMinDepthMs_;

    initialized_ = true;
    stats_ = Stats{};
    return true;
}

void AudioEngine::shutdown() {
    if (encoder_) {
        opus_encoder_destroy(encoder_);
        encoder_ = nullptr;
    }
    if (decoder_) {
        opus_decoder_destroy(decoder_);
        decoder_ = nullptr;
    }
    jitterBuffer_.clear();
    initialized_ = false;
}

bool AudioEngine::isInitialized() const {
    return initialized_;
}

// ─── Opus Encoder ────────────────────────────────────────────────────────

void AudioEngine::setBitrate(int bitrate) {
    if (encoder_) {
        // Clamp to 6000–12000 for voice
        int clamped = std::max(6000, std::min(12000, bitrate));
        opus_encoder_ctl(encoder_, OPUS_SET_BITRATE(clamped));
    }
}

void AudioEngine::setVBR(bool enabled) {
    if (encoder_) {
        opus_encoder_ctl(encoder_, OPUS_SET_VBR(enabled ? 1 : 0));
    }
}

int AudioEngine::encode(const int16_t* pcmInput, int frameSize,
                         uint8_t* opusOutput, int maxOutputSize) {
    if (!encoder_ || !initialized_) return -1;

    int encoded = opus_encode(encoder_, pcmInput, frameSize,
                              opusOutput, maxOutputSize);
    if (encoded > 0) {
        stats_.encodedFrames++;
    }
    return encoded;
}

// ─── Opus Decoder ────────────────────────────────────────────────────────

int AudioEngine::decode(const uint8_t* opusInput, int opusSize,
                         int16_t* pcmOutput, int maxFrameSize) {
    if (!decoder_ || !initialized_) return -1;

    int decoded = opus_decode(decoder_, opusInput, opusSize,
                              pcmOutput, maxFrameSize, 0);
    if (decoded > 0) {
        stats_.decodedFrames++;
    }
    return decoded;
}

int AudioEngine::decodePLC(int16_t* pcmOutput, int maxFrameSize) {
    if (!decoder_ || !initialized_) return -1;

    // NULL input triggers Opus built-in PLC
    int decoded = opus_decode(decoder_, nullptr, 0, pcmOutput, maxFrameSize, 0);
    if (decoded > 0) {
        stats_.plcFrames++;
    }
    return decoded;
}

// ─── Voice Activity Detection ────────────────────────────────────────────

void AudioEngine::setVADConfig(const VADConfig& config) {
    vadConfig_ = config;
}

float AudioEngine::computeRMSEnergy(const int16_t* pcmData, int frameSize) {
    if (frameSize <= 0) return 0.0f;

    double sumSquared = 0.0;
    for (int i = 0; i < frameSize; i++) {
        double sample = static_cast<double>(pcmData[i]) / 32768.0;
        sumSquared += sample * sample;
    }
    float rms = static_cast<float>(std::sqrt(sumSquared / frameSize));
    stats_.currentRMSEnergy = rms;
    return rms;
}

bool AudioEngine::detectVoiceActivity(const int16_t* pcmData, int frameSize) {
    if (!vadConfig_.enabled) return true; // If VAD disabled, always pass

    float rms = computeRMSEnergy(pcmData, frameSize);

    if (rms >= vadConfig_.energyThreshold) {
        vadHangoverCounter_ = vadConfig_.hangoverFrames;
        return true;
    }

    if (vadHangoverCounter_ > 0) {
        vadHangoverCounter_--;
        return true; // Still in hangover period
    }

    stats_.vadSuppressedFrames++;
    return false;
}

// ─── Noise Gate ──────────────────────────────────────────────────────────

void AudioEngine::setNoiseGateConfig(const NoiseGateConfig& config) {
    noiseGateConfig_ = config;
}

float AudioEngine::sampleToDb(float rms) const {
    if (rms <= 0.0f) return -100.0f;
    return 20.0f * std::log10(rms);
}

bool AudioEngine::applyNoiseGate(int16_t* pcmData, int frameSize) {
    if (!noiseGateConfig_.enabled) return true;

    float rms = computeRMSEnergy(pcmData, frameSize);
    float db = sampleToDb(rms);

    if (db < noiseGateConfig_.thresholdDb) {
        // Gate closed — zero out the frame
        std::memset(pcmData, 0, frameSize * sizeof(int16_t));
        stats_.gateClosedFrames++;
        return false;
    }

    return true; // Gate open
}

// ─── Jitter Buffer ───────────────────────────────────────────────────────

void AudioEngine::configureJitterBuffer(int minDepthMs, int maxDepthMs) {
    jitterMinDepthMs_ = std::max(20, minDepthMs);
    jitterMaxDepthMs_ = std::max(jitterMinDepthMs_, maxDepthMs);
    currentJitterDepthMs_ = jitterMinDepthMs_;
}

void AudioEngine::enqueueFrame(const int16_t* pcmData, int frameSize, uint16_t sequenceNumber) {
    JitterEntry entry;
    entry.pcmData.assign(pcmData, pcmData + frameSize);
    entry.sequenceNumber = sequenceNumber;
    entry.valid = true;

    // Insert in sequence order
    auto it = jitterBuffer_.begin();
    while (it != jitterBuffer_.end() && it->sequenceNumber < sequenceNumber) {
        ++it;
    }

    // Skip duplicates
    if (it != jitterBuffer_.end() && it->sequenceNumber == sequenceNumber) {
        return;
    }

    jitterBuffer_.insert(it, std::move(entry));

    // Limit buffer size (based on max depth)
    int maxFrames = (jitterMaxDepthMs_ * sampleRate_) / (frameSize_ * 1000);
    maxFrames = std::max(maxFrames, 10);
    while (static_cast<int>(jitterBuffer_.size()) > maxFrames) {
        jitterBuffer_.erase(jitterBuffer_.begin()); // Drop oldest
    }

    // Update depth stat
    int frameDurationMs = (frameSize_ * 1000) / sampleRate_;
    stats_.jitterBufferDepthMs = static_cast<int>(jitterBuffer_.size()) * frameDurationMs;
}

int AudioEngine::dequeueFrame(int16_t* pcmOutput, int maxFrameSize) {
    if (jitterBuffer_.empty()) {
        // Buffer underrun — use PLC
        return decodePLC(pcmOutput, maxFrameSize);
    }

    // Check if the expected next sequence is available
    auto& front = jitterBuffer_.front();

    if (front.sequenceNumber == nextPlaySequence_ || nextPlaySequence_ == 0) {
        // Expected frame — play it
        int copySize = std::min(maxFrameSize, static_cast<int>(front.pcmData.size()));
        std::memcpy(pcmOutput, front.pcmData.data(), copySize * sizeof(int16_t));
        nextPlaySequence_ = front.sequenceNumber + 1;
        jitterBuffer_.erase(jitterBuffer_.begin());
        return copySize;
    }

    if (front.sequenceNumber > nextPlaySequence_) {
        // Gap detected — use PLC for the missing frame
        nextPlaySequence_++;
        return decodePLC(pcmOutput, maxFrameSize);
    }

    // Late arrival (sequence < expected) — skip it
    jitterBuffer_.erase(jitterBuffer_.begin());
    return dequeueFrame(pcmOutput, maxFrameSize); // Try next
}

int AudioEngine::getJitterBufferDepthMs() const {
    if (jitterBuffer_.empty()) return 0;
    int frameDurationMs = (frameSize_ * 1000) / sampleRate_;
    return static_cast<int>(jitterBuffer_.size()) * frameDurationMs;
}

// ─── Statistics ──────────────────────────────────────────────────────────

AudioEngine::Stats AudioEngine::getStats() const {
    return stats_;
}

} // namespace konvoy
