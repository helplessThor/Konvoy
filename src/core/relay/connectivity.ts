/**
 * Konvoy Network Connectivity Monitor
 *
 * Watches for internet availability and manages the Nostr relay
 * bridge activation/deactivation. Uses @react-native-community/netinfo
 * for real connectivity detection.
 */

import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { create } from 'zustand';

// ─── Types ───────────────────────────────────────────────────────────────

export type ConnectivityMode = 'offline' | 'online';

export interface ConnectivityState {
  mode: ConnectivityMode;
  isInternetReachable: boolean;
  connectionType: string | null;
  lastOnlineAt: number | null;
}

export type OnConnectivityChange = (state: ConnectivityState) => void;

// ─── Connectivity Monitor ────────────────────────────────────────────────

export class ConnectivityMonitor {
  private unsubscribe: (() => void) | null = null;
  private onChangeCallback: OnConnectivityChange | null = null;
  private currentState: ConnectivityState = {
    mode: 'offline',
    isInternetReachable: false,
    connectionType: null,
    lastOnlineAt: null,
  };

  /**
   * Start monitoring network state changes.
   */
  start(onChange: OnConnectivityChange): void {
    this.onChangeCallback = onChange;

    this.unsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
      const isOnline = state.isInternetReachable === true;
      const newState: ConnectivityState = {
        mode: isOnline ? 'online' : 'offline',
        isInternetReachable: isOnline,
        connectionType: state.type,
        lastOnlineAt: isOnline ? Date.now() : this.currentState.lastOnlineAt,
      };

      const changed = this.currentState.mode !== newState.mode;
      this.currentState = newState;

      if (changed) {
        this.onChangeCallback?.(newState);
        useConnectivityStore.getState().updateState(newState);
      }
    });
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.onChangeCallback = null;
  }

  /**
   * Get current connectivity state.
   */
  getState(): ConnectivityState {
    return { ...this.currentState };
  }

  /**
   * Force a one-time check.
   */
  async check(): Promise<ConnectivityState> {
    const state = await NetInfo.fetch();
    const isOnline = state.isInternetReachable === true;
    this.currentState = {
      mode: isOnline ? 'online' : 'offline',
      isInternetReachable: isOnline,
      connectionType: state.type,
      lastOnlineAt: isOnline ? Date.now() : this.currentState.lastOnlineAt,
    };
    useConnectivityStore.getState().updateState(this.currentState);
    return { ...this.currentState };
  }
}

// ─── Zustand Store ───────────────────────────────────────────────────────

interface ConnectivityStoreState extends ConnectivityState {
  updateState: (state: ConnectivityState) => void;
}

export const useConnectivityStore = create<ConnectivityStoreState>((set) => ({
  mode: 'offline',
  isInternetReachable: false,
  connectionType: null,
  lastOnlineAt: null,

  updateState: (state) =>
    set({
      mode: state.mode,
      isInternetReachable: state.isInternetReachable,
      connectionType: state.connectionType,
      lastOnlineAt: state.lastOnlineAt,
    }),
}));
