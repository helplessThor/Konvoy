/**
 * NativeAudioModule — TurboModule Spec
 *
 * Exposes the native audio pipeline: microphone capture,
 * Opus encode/decode, VAD, noise gate, jitter buffer, and playback.
 *
 * All audio processing happens in native C++ (shared core) —
 * the JS layer only orchestrates start/stop and receives encoded frames.
 *
 * Platform bindings:
 *   - Android: AudioRecord (VOICE_COMMUNICATION) + AudioTrack
 *   - iOS: AVAudioEngine with input tap + output node
 */

import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  // ─── Capture ───────────────────────────────────────────────────

  /**
   * Start audio capture from the microphone.
   * @param sampleRate - Sample rate in Hz (default: 16000).
   * @param frameSizeMs - Frame size in milliseconds (default: 20).
   * Audio frames are delivered via the 'onAudioFrame' event.
   */
  startCapture(sampleRate: number, frameSizeMs: number): void;

  /**
   * Stop audio capture.
   */
  stopCapture(): void;

  /**
   * Check if capture is currently active.
   */
  isCapturing(): boolean;

  // ─── Opus Codec ────────────────────────────────────────────────

  /**
   * Encode a PCM audio frame to Opus.
   * @param pcmBase64 - Raw PCM samples (16-bit mono, base64).
   * @returns Opus-encoded frame (base64).
   */
  opusEncode(pcmBase64: string): string;

  /**
   * Decode an Opus frame to PCM.
   * @param opusBase64 - Opus-encoded frame (base64).
   * @returns Decoded PCM samples (16-bit mono, base64).
   */
  opusDecode(opusBase64: string): string;

  /**
   * Perform Packet Loss Concealment (decode with null input).
   * @returns Synthesized PCM frame to cover a lost packet (base64).
   */
  opusPLC(): string;

  // ─── Playback ──────────────────────────────────────────────────

  /**
   * Enqueue a decoded PCM frame for playback through the jitter buffer.
   * @param pcmBase64 - Decoded PCM samples (base64).
   * @param sequenceNumber - Packet sequence for jitter buffer ordering.
   */
  enqueuePlayback(pcmBase64: string, sequenceNumber: number): void;

  /**
   * Start the playback pipeline (jitter buffer → speaker).
   */
  startPlayback(): void;

  /**
   * Stop playback.
   */
  stopPlayback(): void;

  // ─── VAD & Noise Gate ──────────────────────────────────────────

  /**
   * Enable/disable Voice Activity Detection.
   * When enabled, only frames with detected voice are emitted via onAudioFrame.
   * @param enabled - Whether VAD is active.
   * @param energyThreshold - RMS energy threshold (0.0–1.0). Default: 0.01.
   */
  setVADEnabled(enabled: boolean, energyThreshold: number): void;

  /**
   * Enable/disable the noise gate.
   * @param enabled - Whether noise gate is active.
   * @param thresholdDb - Gate threshold in dB (negative). Default: -40.
   */
  setNoiseGateEnabled(enabled: boolean, thresholdDb: number): void;

  // ─── Jitter Buffer Config ─────────────────────────────────────

  /**
   * Configure the adaptive jitter buffer.
   * @param minDepthMs - Minimum buffer depth (default: 40).
   * @param maxDepthMs - Maximum buffer depth (default: 100).
   */
  configureJitterBuffer(minDepthMs: number, maxDepthMs: number): void;

  // ─── Codec Config ──────────────────────────────────────────────

  /**
   * Set Opus encoder bitrate.
   * @param bitrate - Target bitrate in bps (6000–12000 for voice).
   */
  setOpusBitrate(bitrate: number): void;

  /**
   * Enable/disable Opus VBR (Variable Bitrate).
   */
  setOpusVBR(enabled: boolean): void;

  // ─── Diagnostics ───────────────────────────────────────────────

  /**
   * Get audio pipeline statistics.
   */
  getAudioStats(): {
    captureActive: boolean;
    playbackActive: boolean;
    vadActive: boolean;
    noiseGateActive: boolean;
    jitterBufferDepthMs: number;
    encodedFrameCount: number;
    decodedFrameCount: number;
    plcFrameCount: number;
    currentEnergyRMS: number;
  };
}

export default TurboModuleRegistry.getEnforcing<Spec>('KonvoyAudio');
