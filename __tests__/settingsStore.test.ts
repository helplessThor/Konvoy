import { useSettingsStore } from '../src/core/settings/settingsStore';
import { IntercomMode } from '../src/core/audio/intercom';

describe('SettingsStore Persistence and State', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetToDefaults();
  });

  test('initializes with default values', () => {
    const state = useSettingsStore.getState();
    expect(state.bleEnabled).toBe(true);
    expect(state.wifiDirectEnabled).toBe(true);
    expect(state.nostrFallbackEnabled).toBe(true);
    expect(state.pttToggleMode).toBe(false);
    expect(state.intercomMode).toBe(IntercomMode.PushToTalk);
    expect(state.mapStyle).toBe('GOOGLE_ROAD');
    expect(state.noiseGateActive).toBe(true);
    expect(state.selectedBitrate).toBe('12');
    expect(state.handlebarConnected).toBe(false);
  });

  test('updates and stores pttToggleMode', () => {
    useSettingsStore.getState().setPttToggleMode(true);
    expect(useSettingsStore.getState().pttToggleMode).toBe(true);

    useSettingsStore.getState().setPttToggleMode(false);
    expect(useSettingsStore.getState().pttToggleMode).toBe(false);
  });

  test('updates and stores mapStyle', () => {
    useSettingsStore.getState().setMapStyle('GOOGLE_HYBRID');
    expect(useSettingsStore.getState().mapStyle).toBe('GOOGLE_HYBRID');

    useSettingsStore.getState().setMapStyle('DARK');
    expect(useSettingsStore.getState().mapStyle).toBe('DARK');
  });

  test('updates and stores intercomMode', () => {
    useSettingsStore.getState().setIntercomMode(IntercomMode.HandsFreeVAD);
    expect(useSettingsStore.getState().intercomMode).toBe(IntercomMode.HandsFreeVAD);
  });

  test('resets to defaults cleanly', () => {
    useSettingsStore.getState().setPttToggleMode(true);
    useSettingsStore.getState().setMapStyle('GOOGLE_HYBRID');
    useSettingsStore.getState().resetToDefaults();

    expect(useSettingsStore.getState().pttToggleMode).toBe(false);
    expect(useSettingsStore.getState().mapStyle).toBe('GOOGLE_ROAD');
  });
});
