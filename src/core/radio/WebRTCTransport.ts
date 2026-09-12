/**
 * WebRTCTransport.ts — Internet-Only Voice & Data using WebRTC
 * 
 * This module uses Nostr strictly as a signaling server (to exchange SDP 
 * offers/answers and ICE candidates). Once connected, a WebRTC DataChannel 
 * is used to blast high-frequency Intercom packets P2P over the internet 
 * without hitting any Nostr relay rate limits.
 */

import { RTCPeerConnection, RTCIceCandidate, RTCSessionDescription } from 'react-native-webrtc';
import { Buffer } from 'buffer';
import { NostrTransport } from './nostr';

type OnPacketReceived = (peerId: string, data: ArrayBuffer) => void;

interface SignalMessage {
  type: 'offer' | 'answer' | 'candidate';
  senderFingerprint: string;
  targetFingerprint?: string;
  data: any;
}

export class WebRTCTransport {
  private nostr: NostrTransport;
  private localFingerprint: string;
  private connections: Map<string, RTCPeerConnection> = new Map();
  private dataChannels: Map<string, any> = new Map();
  private onPacketReceived: OnPacketReceived | null = null;
  private iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  constructor(nostrTransport: NostrTransport, localFingerprint: string) {
    this.nostr = nostrTransport;
    this.localFingerprint = localFingerprint;
  }

  setCallbacks(onPacketReceived: OnPacketReceived) {
    this.onPacketReceived = onPacketReceived;
  }

  async initiateConnection(peerFingerprint: string) {
    if (this.connections.has(peerFingerprint)) return;
    if (peerFingerprint === this.localFingerprint) return;

    if (this.localFingerprint < peerFingerprint) {
      return; 
    }

    try {
      const pc = this.createPeerConnection(peerFingerprint);
      
      const dataChannel = pc.createDataChannel('konvoy-mesh', {
        ordered: false,
        maxRetransmits: 0
      });
      this.setupDataChannel(peerFingerprint, dataChannel);

      const offer = await pc.createOffer({});
      await pc.setLocalDescription(offer);
      
      this.sendSignal({
        type: 'offer',
        senderFingerprint: this.localFingerprint,
        targetFingerprint: peerFingerprint,
        data: offer
      });
    } catch (err) {
      console.error(`[WebRTC] Failed to initiate connection to ${peerFingerprint}`, err);
    }
  }

  async handleSignal(messageJson: string) {
    try {
      const signal: SignalMessage = JSON.parse(messageJson);
      
      if (signal.targetFingerprint && signal.targetFingerprint !== this.localFingerprint) return;
      if (signal.senderFingerprint === this.localFingerprint) return;

      const peerId = signal.senderFingerprint;

      let pc = this.connections.get(peerId);
      if (!pc && signal.type === 'offer') {
        pc = this.createPeerConnection(peerId);
      }

      if (!pc) return;

      if (signal.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.data));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        this.sendSignal({
          type: 'answer',
          senderFingerprint: this.localFingerprint,
          targetFingerprint: peerId,
          data: answer
        });
      } else if (signal.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.data));
      } else if (signal.type === 'candidate') {
        await pc.addIceCandidate(new RTCIceCandidate(signal.data));
      }

    } catch (err) {
    }
  }

  private createPeerConnection(peerFingerprint: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    
    pc.onicecandidate = (event: any) => {
      if (event.candidate) {
        this.sendSignal({
          type: 'candidate',
          senderFingerprint: this.localFingerprint,
          targetFingerprint: peerFingerprint,
          data: event.candidate
        });
      }
    };

    pc.ondatachannel = (event: any) => {
      this.setupDataChannel(peerFingerprint, event.channel);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.connections.delete(peerFingerprint);
        this.dataChannels.delete(peerFingerprint);
      }
    };

    this.connections.set(peerFingerprint, pc);
    return pc;
  }

  private setupDataChannel(peerFingerprint: string, channel: any) {
    channel.onopen = () => {
      this.dataChannels.set(peerFingerprint, channel);
    };

    channel.onclose = () => {
      this.dataChannels.delete(peerFingerprint);
    };

    channel.onmessage = (event: any) => {
      if (this.onPacketReceived) {
        let dataBuf: ArrayBuffer;
        if (typeof event.data === 'string') {
          dataBuf = this.base64ToArrayBuffer(event.data);
        } else {
          dataBuf = event.data;
        }
        this.onPacketReceived(peerFingerprint, dataBuf);
      }
    };
  }

  broadcastPacket(data: ArrayBuffer) {
    const base64 = this.arrayBufferToBase64(data);
    for (const [peerId, channel] of this.dataChannels.entries()) {
      if (channel.readyState === 'open') {
        channel.send(base64); 
      }
    }
  }

  private sendSignal(signal: SignalMessage) {
    this.nostr.publishSignal(JSON.stringify(signal));
  }

  private arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return (globalThis as any).btoa ? (globalThis as any).btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = (globalThis as any).atob ? (globalThis as any).atob(base64) : Buffer.from(base64, 'base64').toString('binary');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer as ArrayBuffer;
  }
}
