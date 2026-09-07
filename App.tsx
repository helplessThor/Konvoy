/**
 * Konvoy — Off-Grid Rider Convoy Intercom & Mesh Map
 *
 * Root React Native Application
 * Ties together:
 *   - Background service orchestration (BLE + Wi-Fi Direct + Nostr)
 *   - High-contrast sunlight-readable OLED theme
 *   - Tactical Map HUD with CRDT OR-Set hazard gossip
 *   - Full-Duplex low-latency Intercom with massive PTT button & VAD
 *   - Settings for ephemeral crypto identity and DSP configuration
 *   - HID Button Listener for handlebar Bluetooth remotes
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  StatusBar,
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Vibration,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, Typography, Spacing, TouchTargets, Radius } from './src/ui/theme/tokens';
import { MapScreen } from './src/ui/screens/MapScreen';
import { IntercomScreen } from './src/ui/screens/IntercomScreen';
import { SettingsScreen } from './src/ui/screens/SettingsScreen';
import { HIDButtonListener } from './src/ui/components/HIDButtonListener';
import { BackgroundService } from './src/services/BackgroundService';
import { HazardType } from './src/core/net/wire';
import type { HazardEntry } from './src/core/map/crdt';

type TabKey = 'MAP' | 'INTERCOM' | 'SETTINGS';

export default function App(): React.JSX.Element {
  const [currentTab, setCurrentTab] = useState<TabKey>('INTERCOM');
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);

  // Background mesh lifecycle
  useEffect(() => {
    BackgroundService.start();
    return () => {
      BackgroundService.stop();
    };
  }, []);

  const handleStartTalk = useCallback(() => {
    setIsTransmitting(true);
  }, []);

  const handleStopTalk = useCallback(() => {
    setIsTransmitting(false);
  }, []);

  const handleTabChange = (tab: TabKey) => {
    Vibration.vibrate(15);
    setCurrentTab(tab);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" />

      {/* Invisible listener for handlebar BLE / media button PTT toggles */}
      <HIDButtonListener
        onPTTPress={handleStartTalk}
        onPTTRelease={handleStopTalk}
      />

      {/* Screen Body */}
      <View style={styles.screenContainer}>
        {currentTab === 'MAP' && (
          <MapScreen />
        )}
        {currentTab === 'INTERCOM' && (
          <IntercomScreen
            isTransmitting={isTransmitting}
            activeSpeakerName={activeSpeaker}
            onStartTalk={handleStartTalk}
            onStopTalk={handleStopTalk}
          />
        )}
        {currentTab === 'SETTINGS' && (
          <SettingsScreen />
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
            TACTICAL MAP
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
