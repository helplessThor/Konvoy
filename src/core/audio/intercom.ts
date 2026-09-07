/**
 * Konvoy Audio Intercom Orchestrator
 *
 * Bridges the native audio TurboModule with the mesh router to
 * provide Push-to-Talk (PTT) and Hands-Free (Always-On) intercom modes.
 *
 * TX path: Mic → Native Capture → Opus Encode → Wire Packet → Mesh Router
 * RX path: Mesh Router → Jitter Buffer → Opus Decode → Native Playback
 */

import { NativeEventEmitter, NativeModules } from 'react-native';
import { create } from 'zustand';
import {
  PacketType,
  type PacketHeader,
  MAGIC,
  PROTOCOL_VERSION,
  DEFAULT_TTL,
} from '../net/wire';

import { uint8ArrayToBase64, base64ToUint8Array } from '../utils/base64';

// ─── Types ───────────────────────────────────────────────────────────────

export enum IntercomMode {
  PushToTalk = 'ptt',
  HandsFreeVAD = 'hands-free',
}

export interface IntercomConfig {
  /** Sample rate in Hz. Default: 16000 */
  sampleRate: number;
  /** Frame size in ms. Default: 20 */
  frameSizeMs: number;
  /** Opus bitrate in bps. Default: 12000 */
  opusBitrate: number;
  /** VAD energy threshold (0.0–1.0). Default: 0.01 */
  vadThreshold: number;
  /** Noise gate threshold in dB. Default: -40 */
  noiseGateThresholdDb: number;
  /** Jitter buffer min depth ms. Default: 40 */
  jitterMinMs: number;
  /** Jitter buffer max depth ms. Default: 100 */
  jitterMaxMs: number;
}

export interface ActiveSpeaker {
  fingerprintHex: string;
  lastFrameTime: number;
  energy: number;
}

const DEFAULT_CONFIG: IntercomConfig = {
  sampleRate: 16000,
  frameSizeMs: 20,
  opusBitrate: 12000,
  vadThreshold: 0.01,
  noiseGateThresholdDb: -40,
  jitterMinMs: 40,
  jitterMaxMs: 100,
};

// ─── Utility ─────────────────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return uint8ArrayToBase64(new Uint8Array(buffer));
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  return base64ToUint8Array(base64).buffer as ArrayBuffer;
}

// ─── Packet Origination ──────────────────────────────────────────────────

export type OriginatePacketFn = (header: PacketHeader, payload: ArrayBuffer) => void;

// ─── Intercom Manager ────────────────────────────────────────────────────

export class IntercomManager {
  private config: IntercomConfig;
  private mode: IntercomMode = IntercomMode.PushToTalk;
  private isTransmitting: boolean = false;
  private isReceiving: boolean = false;

  // Native module
  private audioModule: any = null;
  private audioEmitter: NativeEventEmitter | null = null;
  private subscriptions: Array<{ remove: () => void }> = [];

  // Mesh integration
  private originatePacket: OriginatePacketFn | null = null;
  private getFingerprint: (() => Uint8Array | null) | null = null;
  private getChannelToken: (() => Uint8Array | null) | null = null;

  // Active speakers tracking
  private activeSpeakers: Map<string, ActiveSpeaker> = new Map();
  private speakerTimeoutMs = 3000; // Speaker considered inactive after 3s

  // Sequence counter
  private txSequence: number = 0;

  constructor(config?: Partial<IntercomConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize native audio module.
   */
  initialize(): void {
    try {
      this.audioModule = NativeModules.KonvoyAudio;
      if (this.audioModule) {
        this.audioEmitter = new NativeEventEmitter(this.audioModule);
      }
    } catch (err) {
      console.error('[IntercomManager] Failed to initialize native audio module:', err);
    }
  }

  /**
   * Configure mesh integration callbacks.
   */
  configure(opts: {
    originatePacket: OriginatePacketFn;
    getFingerprint: () => Uint8Array | null;
    getChannelToken: () => Uint8Array | null;
  }): void {
    this.originatePacket = opts.originatePacket;
    this.getFingerprint = opts.getFingerprint;
    this.getChannelToken = opts.getChannelToken;
  }

  /**
   * Set intercom mode.
   */
  setMode(mode: IntercomMode): void {
    const wasTransmitting = this.isTransmitting;

    if (wasTransmitting) {
      this.stopTransmitting();
    }

    this.mode = mode;

    if (!this.audioModule) return;

    if (mode === 'hands-free') {
      // Enable VAD and noise gate for hands-free
      this.audioModule.setVADEnabled(true, this.config.vadThreshold);
      this.audioModule.setNoiseGateEnabled(true, this.config.noiseGateThresholdDb);
      // Auto-start transmitting in hands-free mode
      this.startTransmitting();
    } else {
      // Disable VAD for PTT (user controls when to transmit)
      this.audioModule.setVADEnabled(false, 0);
      this.audioModule.setNoiseGateEnabled(false, 0);
    }

    // Update store
    useIntercomStore.getState().setMode(mode);
  }

  /**
   * Start transmitting (PTT press or hands-free auto-start).
   */
  startTransmitting(): void {
    if (this.isTransmitting || !this.audioModule) return;
    this.isTransmitting = true;

    // Configure codec
    this.audioModule.setOpusBitrate(this.config.opusBitrate);
    this.audioModule.setOpusVBR(true);
    this.audioModule.configureJitterBuffer(this.config.jitterMinMs, this.config.jitterMaxMs);

    // Start native capture
    this.audioModule.startCapture(this.config.sampleRate, this.config.frameSizeMs);

    // Listen for encoded audio frames from native
    this.setupTXListeners();

    useIntercomStore.getState().setIsTransmitting(true);
  }

  /**
   * Stop transmitting (PTT release).
   */
  stopTransmitting(): void {
    if (!this.isTransmitting || !this.audioModule) return;
    this.isTransmitting = false;

    this.audioModule.stopCapture();
    this.teardownTXListeners();

    useIntercomStore.getState().setIsTransmitting(false);
  }

  /**
   * Start receiving and playing back incoming voice frames.
   */
  startReceiving(): void {
    if (this.isReceiving || !this.audioModule) return;
    this.isReceiving = true;

    this.audioModule.startPlayback();
    useIntercomStore.getState().setIsReceiving(true);
  }

  /**
   * Stop receiving.
   */
  stopReceiving(): void {
    if (!this.isReceiving || !this.audioModule) return;
    this.isReceiving = false;

    this.audioModule.stopPlayback();
    useIntercomStore.getState().setIsReceiving(false);
  }

  /**
   * Handle an incoming voice frame from the mesh router.
   */
  handleIncomingVoice(senderFingerprint: Uint8Array, opusFrame: ArrayBuffer, header: PacketHeader): void {
    if (!this.audioModule || !this.isReceiving) return;

    const fpHex = toHex(senderFingerprint);

    // Track active speaker
    this.activeSpeakers.set(fpHex, {
      fingerprintHex: fpHex,
      lastFrameTime: Date.now(),
      energy: 0, // Could be computed from decoded PCM if needed
    });

    // Decode and enqueue for playback
    const opusBase64 = arrayBufferToBase64(opusFrame);
    const pcmBase64 = this.audioModule.opusDecode(opusBase64);
    this.audioModule.enqueuePlayback(pcmBase64, header.sequenceNumber);

    // Update store with active speakers
    this.updateActiveSpeakersStore();
  }

  /**
   * PTT toggle (for handlebar button / HID integration).
   */
  togglePTT(): void {
    if (this.mode !== 'ptt') return;

    if (this.isTransmitting) {
      this.stopTransmitting();
    } else {
      this.startTransmitting();
    }
  }

  // ─── TX Event Handling ─────────────────────────────────────────

  private setupTXListeners(): void {
    if (!this.audioEmitter) return;

    // Native emits encoded Opus frames
    const frameSub = this.audioEmitter.addListener(
      'KonvoyAudioFrame',
      (event: any) => {
        this.handleOutgoingFrame(event.opusBase64, event.energy);
      },
    );
    this.subscriptions.push(frameSub);
  }

  private teardownTXListeners(): void {
    for (const sub of this.subscriptions) {
      sub.remove();
    }
    this.subscriptions = [];
  }

  private handleOutgoingFrame(opusBase64: string, energy: number): void {
    if (!this.originatePacket || !this.getFingerprint || !this.getChannelToken) return;

    const fingerprint = this.getFingerprint();
    const channelToken = this.getChannelToken();
    if (!fingerprint || !channelToken) return;

    const payload = base64ToArrayBuffer(opusBase64);

    // Generate packet ID
    const packetId = new Uint8Array(8);
    const seqView = new DataView(packetId.buffer);
    seqView.setUint32(0, this.txSequence++, false);
    packetId.set(fingerprint.subarray(0, 4), 4);

    const header: PacketHeader = {
      magic: MAGIC,
      version: PROTOCOL_VERSION,
      type: PacketType.Voice,
      ttl: DEFAULT_TTL,
      flags: 0,
      sequenceNumber: this.txSequence & 0xffff,
      packetId,
      channelToken: channelToken.subarray(0, 8),
      senderFingerprint: fingerprint,
      payloadSize: payload.byteLength,
      checksum: 0,
    };

    this.originatePacket(header, payload);

    // Update UI energy level
    useIntercomStore.getState().setOwnEnergy(energy);
  }

  // ─── Active Speaker Tracking ───────────────────────────────────

  private updateActiveSpeakersStore(): void {
    const now = Date.now();
    const active: ActiveSpeaker[] = [];

    this.activeSpeakers.forEach((speaker, key) => {
      if (now - speaker.lastFrameTime <= this.speakerTimeoutMs) {
        active.push(speaker);
      } else {
        this.activeSpeakers.delete(key);
      }
    });

    useIntercomStore.getState().setActiveSpeakers(active);
  }

  /**
   * Destroy — clean up all resources.
   */
  destroy(): void {
    this.stopTransmitting();
    this.stopReceiving();
    this.activeSpeakers.clear();
  }
}

// ─── Zustand Store ───────────────────────────────────────────────────────

export interface IntercomStoreState {
  mode: IntercomMode;
  isTransmitting: boolean;
  isReceiving: boolean;
  activeSpeakers: ActiveSpeaker[];
  ownEnergy: number;

  setMode: (mode: IntercomMode) => void;
  setIsTransmitting: (value: boolean) => void;
  setIsReceiving: (value: boolean) => void;
  setActiveSpeakers: (speakers: ActiveSpeaker[]) => void;
  setOwnEnergy: (energy: number) => void;
}

export const useIntercomStore = create<IntercomStoreState>((set) => ({
  mode: IntercomMode.PushToTalk,
  isTransmitting: false,
  isReceiving: false,
  activeSpeakers: [],
  ownEnergy: 0,

  setMode: (mode) => set({ mode }),
  setIsTransmitting: (value) => set({ isTransmitting: value }),
  setIsReceiving: (value) => set({ isReceiving: value }),
  setActiveSpeakers: (speakers) => set({ activeSpeakers: speakers }),
  setOwnEnergy: (energy) => set({ ownEnergy: energy }),
}));
