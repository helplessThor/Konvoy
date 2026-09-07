/**
 * Konvoy Persistent Settings Store
 *
 * Backed by MMKV for instantaneous persistent storage with in-memory fallback.
 * Manages radio toggles, audio DSP configuration, PTT button modes,
 * and cartographic map style preferences.
 */

import { create } from 'zustand';
import { IntercomMode } from '../audio/intercom';

export type MapStyleKey = 'GOOGLE_ROAD' | 'GOOGLE_HYBRID' | 'GOOGLE_TERRAIN' | 'DARK';

export interface SettingsState {
  // Radio transports
  bleEnabled: boolean;
  wifiDirectEnabled: boolean;
  nostrFallbackEnabled: boolean;

  // Audio DSP & PTT
  pttToggleMode: boolean; // false = hold to talk, true = tap to toggle
  intercomMode: IntercomMode; // ptt or hands-free
  noiseGateActive: boolean;
  selectedBitrate: '8' | '12' | '16';

  // Map preferences
  mapStyle: MapStyleKey;

  // Handlebar remote
  handlebarConnected: boolean;

  // Actions
  setBleEnabled: (val: boolean) => void;
  setWifiDirectEnabled: (val: boolean) => void;
  setNostrFallbackEnabled: (val: boolean) => void;
  setPttToggleMode: (val: boolean) => void;
  setIntercomMode: (mode: IntercomMode) => void;
  setNoiseGateActive: (val: boolean) => void;
  setSelectedBitrate: (rate: '8' | '12' | '16') => void;
  setMapStyle: (style: MapStyleKey) => void;
  setHandlebarConnected: (val: boolean) => void;
  resetToDefaults: () => void;
}

// ─── Storage Adapter (MMKV with in-memory fallback) ─────────────────────────

interface IStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
}

class SettingsStorage implements IStorage {
  private mmkv: any = null;
  private mem = new Map<string, string>();

  constructor() {
    try {
      const { MMKV } = require('react-native-mmkv');
      if (MMKV) {
        this.mmkv = new MMKV({ id: 'konvoy.app.settings' });
      }
    } catch {
      // In-memory fallback (e.g. during Jest tests)
    }
  }

  getString(key: string): string | undefined {
    if (this.mmkv) {
      try {
        const val = this.mmkv.getString(key);
        return val !== undefined ? val : undefined;
      } catch {
        return this.mem.get(key);
      }
    }
    return this.mem.get(key);
  }

  set(key: string, value: string): void {
    if (this.mmkv) {
      try {
        this.mmkv.set(key, value);
        return;
      } catch {
        // Fall back to mem
      }
    }
    this.mem.set(key, value);
  }
}

const storage = new SettingsStorage();
const STORAGE_KEY = 'konvoy_user_settings_v1';

const DEFAULT_SETTINGS: Omit<
  SettingsState,
  | 'setBleEnabled'
  | 'setWifiDirectEnabled'
  | 'setNostrFallbackEnabled'
  | 'setPttToggleMode'
  | 'setIntercomMode'
  | 'setNoiseGateActive'
  | 'setSelectedBitrate'
  | 'setMapStyle'
  | 'setHandlebarConnected'
  | 'resetToDefaults'
> = {
  bleEnabled: true,
  wifiDirectEnabled: true,
  nostrFallbackEnabled: true,
  pttToggleMode: false,
  intercomMode: IntercomMode.PushToTalk,
  noiseGateActive: true,
  selectedBitrate: '12',
  mapStyle: 'GOOGLE_ROAD',
  handlebarConnected: false,
};

function loadSavedSettings(): typeof DEFAULT_SETTINGS {
  try {
    const raw = storage.getString(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch {
    // Ignore JSON parse errors
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(state: typeof DEFAULT_SETTINGS): void {
  try {
    storage.set(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore
  }
}

const initial = loadSavedSettings();

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...initial,

  setBleEnabled: (val) => {
    set({ bleEnabled: val });
    saveSettings({ ...get(), bleEnabled: val });
  },

  setWifiDirectEnabled: (val) => {
    set({ wifiDirectEnabled: val });
    saveSettings({ ...get(), wifiDirectEnabled: val });
  },

  setNostrFallbackEnabled: (val) => {
    set({ nostrFallbackEnabled: val });
    saveSettings({ ...get(), nostrFallbackEnabled: val });
  },

  setPttToggleMode: (val) => {
    set({ pttToggleMode: val });
    saveSettings({ ...get(), pttToggleMode: val });
  },

  setIntercomMode: (mode) => {
    set({ intercomMode: mode });
    saveSettings({ ...get(), intercomMode: mode });
  },

  setNoiseGateActive: (val) => {
    set({ noiseGateActive: val });
    saveSettings({ ...get(), noiseGateActive: val });
  },

  setSelectedBitrate: (rate) => {
    set({ selectedBitrate: rate });
    saveSettings({ ...get(), selectedBitrate: rate });
  },

  setMapStyle: (style) => {
    set({ mapStyle: style });
    saveSettings({ ...get(), mapStyle: style });
  },

  setHandlebarConnected: (val) => {
    set({ handlebarConnected: val });
    saveSettings({ ...get(), handlebarConnected: val });
  },

  resetToDefaults: () => {
    set({ ...DEFAULT_SETTINGS });
    saveSettings(DEFAULT_SETTINGS);
  },
}));
