/**
 * Konvoy — Off-Grid Rider Convoy Intercom & Mesh Map
 *
 * Root React Native Application
 * Real Production Integration:
 *   - Background service orchestration (BLE + Wi-Fi Direct + Nostr)
 *   - Live high-accuracy GPS tracking (react-native-geolocation-service)
 *   - Ephemeral Ed25519/X25519 identity generation (@noble/curves)
 *   - CRDT OR-Set hazard pin gossip with persistent state
 *   - Real MapLibre tactical cartographic map with heading & peer overlays
 *   - Full-Duplex low-latency Intercom with PTT and VAD
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  StatusBar,
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Vibration,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, Typography, Spacing, TouchTargets, Radius } from './src/ui/theme/tokens';
import { MapScreen, type PeerTelemetry } from './src/ui/screens/MapScreen';
import { IntercomScreen } from './src/ui/screens/IntercomScreen';
import { SettingsScreen } from './src/ui/screens/SettingsScreen';
import { HIDButtonListener } from './src/ui/components/HIDButtonListener';
import { BackgroundService } from './src/services/BackgroundService';
import { locationService } from './src/services/LocationService';
import { useIdentityStore } from './src/core/crypto/identity';
import { useConvoyStore, TelemetryManager } from './src/core/map/telemetry';
import { useIntercomStore, IntercomMode } from './src/core/audio/intercom';
import { useHazardStore } from './src/core/map/crdt';
import { HazardType } from './src/core/net/wire';
import { useSettingsStore } from './src/core/settings/settingsStore';
import { useDeviceBattery } from './src/services/BatteryService';
import { meshOrchestrator } from './src/services/MeshOrchestrator';

type TabKey = 'MAP' | 'INTERCOM' | 'SETTINGS';

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export default function App(): React.JSX.Element {
  const [currentTab, setCurrentTab] = useState<TabKey>('MAP');

  // Core reactive stores
  const identity = useIdentityStore((state) => state.identity);
  const initializeIdentity = useIdentityStore((state) => state.initialize);
  const resetIdentity = useIdentityStore((state) => state.resetIdentity);

  const ownPosition = useConvoyStore((state) => state.ownPosition);
  const convoyPeers = useConvoyStore((state) => state.peers);

  // Persistent Settings
  const intercomMode = useSettingsStore((state) => state.intercomMode);
  const setIntercomMode = useSettingsStore((state) => state.setIntercomMode);
  const pttToggleMode = useSettingsStore((state) => state.pttToggleMode);
  const ownBattery = useDeviceBattery();

  const isTransmitting = useIntercomStore((state) => state.isTransmitting);
  const activeSpeakers = useIntercomStore((state) => state.activeSpeakers);
  const ownEnergy = useIntercomStore((state) => state.ownEnergy);
  const setIsTransmitting = useIntercomStore((state) => state.setIsTransmitting);

  const hazards = useHazardStore((state) => state.hazards);
  const addHazard = useHazardStore((state) => state.addHazard);
  const removeHazard = useHazardStore((state) => state.removeHazard);
  const clearHazards = useHazardStore((state) => state.clearAll);

  // Initialize all native and cryptographic services on app mount
  useEffect(() => {
    // 1. Generate or restore real cryptographic identity
    initializeIdentity();

    // 2. Start Android foreground service
    BackgroundService.start();

    // 3. Start high-precision GPS tracking with runtime permissions
    locationService.start().then(() => {
      // Start mesh orchestrator once location and permissions are granted
      meshOrchestrator.start();
    });

    return () => {
      meshOrchestrator.stop();
      locationService.stop();
      BackgroundService.stop();
    };
  }, [initializeIdentity]);

  // Transmit handlers for Intercom & Handlebar PTT
  const handleStartTalk = useCallback(() => {
    setIsTransmitting(true);
    Vibration.vibrate(30);
  }, [setIsTransmitting]);

  const handleStopTalk = useCallback(() => {
    setIsTransmitting(false);
    Vibration.vibrate(15);
  }, [setIsTransmitting]);

  const handleTabChange = (tab: TabKey) => {
    Vibration.vibrate(15);
    setCurrentTab(tab);
  };

  // Map convoy store peers to MapScreen peer telemetry
  const mapPeers: PeerTelemetry[] = useMemo(() => {
    return convoyPeers.map((peer) => ({
      fingerprint: fromHex(peer.fingerprintHex),
      fingerprintHex: peer.fingerprintHex,
      latitude: peer.latitude,
      longitude: peer.longitude,
      heading: peer.heading,
      speed: peer.speed,
      altitude: peer.altitude,
      lastSeen: peer.lastSeenMs,
      callsign: `Member ${peer.fingerprintHex.substring(0, 4).toUpperCase()}`,
    }));
  }, [convoyPeers]);

  // Map convoy peers to Intercom peer voice state
  const voicePeers = useMemo(() => {
    return convoyPeers.map((peer, idx) => ({
      peerId: peer.fingerprintHex,
      callsign: `Member ${peer.fingerprintHex.substring(0, 4).toUpperCase()}`,
      role: (idx === 0 ? 'LEAD' : 'MEMBER') as 'LEAD' | 'TAIL' | 'MEMBER',
      batteryPercent: undefined,
      rssi: -62,
      isSpeaking: activeSpeakers.some((s) => s.fingerprintHex === peer.fingerprintHex),
      isMuted: false,
      transport: 'WIFI_P2P' as const,
    }));
  }, [convoyPeers, activeSpeakers]);

  // Real public fingerprint for Settings
  const formattedFingerprint = useMemo(() => {
    if (!identity) return 'Generating session keypair...';
    const hex = identity.fingerprintHex;
    return `${hex.substring(0, 4)}...${hex.substring(hex.length - 4)} (Ed25519)`;
  }, [identity]);

  // Real hazard drop handler using actual GPS position
  const handleAddHazard = useCallback(
    (type: HazardType, lat: number, lng: number) => {
      const senderFp = identity?.fingerprint ?? new Uint8Array(16);
      addHazard(type, lat, lng, senderFp);
    },
    [identity, addHazard]
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" />

      {/* Handlebar BLE / Media button PTT toggle listener */}
      <HIDButtonListener
        onPTTPress={
          pttToggleMode || intercomMode === IntercomMode.HandsFreeVAD
            ? (isTransmitting ? handleStopTalk : handleStartTalk)
            : handleStartTalk
        }
        onPTTRelease={
          pttToggleMode || intercomMode === IntercomMode.HandsFreeVAD
            ? () => {}
            : handleStopTalk
        }
      />

      {/* Screen Body */}
      <View style={styles.screenContainer}>
        {currentTab === 'MAP' && (
          <MapScreen
            currentSpeed={ownPosition?.speed ?? 0}
            currentHeading={ownPosition?.heading ?? 0}
            currentAltitude={ownPosition?.altitude ?? 0}
            currentLatitude={ownPosition?.latitude ?? 0}
            currentLongitude={ownPosition?.longitude ?? 0}
            isGpsLocked={!!ownPosition && (ownPosition.latitude !== 0 || ownPosition.longitude !== 0)}
            peers={mapPeers}
            hazards={hazards}
            onAddHazard={handleAddHazard}
            onRemoveHazard={removeHazard}
            activeRadioType={convoyPeers.length > 0 ? 'WIFI_DIRECT' : 'BLE'}
          />
        )}
        {currentTab === 'INTERCOM' && (
          <IntercomScreen
            isTransmitting={isTransmitting}
            activeSpeakerName={
              activeSpeakers.length > 0
                ? `Member ${activeSpeakers[0]!.fingerprintHex.substring(0, 4).toUpperCase()}`
                : null
            }
            intercomMode={intercomMode}
            onModeChange={setIntercomMode}
            currentAudioLevel={ownEnergy}
            onStartTalk={handleStartTalk}
            onStopTalk={handleStopTalk}
            peers={voicePeers}
            ownBatteryPercent={ownBattery}
            pttToggleMode={pttToggleMode}
          />
        )}
        {currentTab === 'SETTINGS' && (
          <SettingsScreen
            sessionFingerprint={formattedFingerprint}
            onBurnIdentity={resetIdentity}
            onClearCRDTCache={clearHazards}
          />
        )}
      </View>

      {/* ─── Gloved-Finger Bottom Navigation Bar ───────────────────────── */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tabButton, currentTab === 'MAP' && styles.tabButtonActive]}
          onPress={() => handleTabChange('MAP')}
          activeOpacity={0.8}
        >
          <Text style={styles.tabEmoji}>🗺️</Text>
          <Text
            style={[styles.tabLabel, currentTab === 'MAP' && styles.tabLabelActive]}
          >
            MAP
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.tabButton,
            styles.tabButtonCenter,
            currentTab === 'INTERCOM' && styles.tabButtonActive,
            isTransmitting && styles.tabButtonTransmitting,
          ]}
          onPress={() => handleTabChange('INTERCOM')}
          activeOpacity={0.8}
        >
          <Text style={styles.tabEmoji}>{isTransmitting ? '🎙️' : '📻'}</Text>
          <Text
            style={[
              styles.tabLabel,
              currentTab === 'INTERCOM' && styles.tabLabelActive,
            ]}
          >
            INTERCOM
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabButton, currentTab === 'SETTINGS' && styles.tabButtonActive]}
          onPress={() => handleTabChange('SETTINGS')}
          activeOpacity={0.8}
        >
          <Text style={styles.tabEmoji}>⚙️</Text>
          <Text
            style={[
              styles.tabLabel,
              currentTab === 'SETTINGS' && styles.tabLabelActive,
            ]}
          >
            SETTINGS
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  screenContainer: {
    flex: 1,
  },
  tabBar: {
    height: TouchTargets.tabBar,
    backgroundColor: Colors.surface,
    borderTopWidth: 1,
    borderTopColor: Colors.surfaceBorder,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: Spacing.sm,
  },
  tabButton: {
    flex: 1,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.md,
    marginHorizontal: 4,
  },
  tabButtonCenter: {
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  tabButtonActive: {
    backgroundColor: 'rgba(255, 107, 44, 0.15)',
    borderColor: Colors.primary,
  },
  tabButtonTransmitting: {
    backgroundColor: 'rgba(255, 107, 44, 0.3)',
    borderColor: Colors.primaryLight,
  },
  tabEmoji: {
    fontSize: 20,
    marginBottom: 2,
  },
  tabLabel: {
    fontSize: 10,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textSecondary,
    letterSpacing: 1,
  },
  tabLabelActive: {
    color: Colors.primary,
  },
});
