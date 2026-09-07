/**
 * SettingsScreen.tsx — Konvoy Mesh & Hardware Configuration
 *
 * Provides control over ephemeral identity lifecycle, radio transports (BLE / Wi-Fi Direct / Nostr),
 * audio DSP thresholds (VAD, noise gate, bitrate), glove ergonomics, and offline tile management.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
  TouchableOpacity,
  Alert,
  Vibration,
} from 'react-native';
import { Colors, Typography, Spacing, TouchTargets, Radius, Shadows } from '../theme/tokens';

interface SettingsScreenProps {
  sessionFingerprint?: string;
  onBurnIdentity?: () => void;
  onClearCRDTCache?: () => void;
}

export const SettingsScreen: React.FC<SettingsScreenProps> = ({
  sessionFingerprint = 'Initializing...',
  onBurnIdentity,
  onClearCRDTCache,
}) => {
  // Radio toggles
  const [bleEnabled, setBleEnabled] = useState(true);
  const [wifiDirectEnabled, setWifiDirectEnabled] = useState(true);
  const [nostrFallbackEnabled, setNostrFallbackEnabled] = useState(true);

  // Audio toggles & config
  const [noiseGateActive, setNoiseGateActive] = useState(true);
  const [highContrastMode, setHighContrastMode] = useState(false);
  const [pttToggleMode, setPttToggleMode] = useState(false); // false = hold, true = toggle
  const [selectedBitrate, setSelectedBitrate] = useState<'8' | '12' | '16'>('12');

  // Handlebar remote
  const [handlebarConnected, setHandlebarConnected] = useState(true);

  const confirmBurnSession = () => {
    Vibration.vibrate(50);
    Alert.alert(
      'Burn Session Identity?',
      'This will destroy your current ephemeral Ed25519 and X25519 keys immediately. A fresh cryptographic identity will be generated.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Burn Identity',
          style: 'destructive',
          onPress: () => {
            onBurnIdentity?.();
            Vibration.vibrate(100);
          },
        },
      ]
    );
  };

  const confirmClearCache = () => {
    Alert.alert(
      'Clear CRDT Hazard Cache?',
      'All local hazard pins and gossip history will be cleared.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear Cache',
          style: 'destructive',
          onPress: () => {
            onClearCRDTCache?.();
            Vibration.vibrate(30);
          },
        },
      ]
    );
  };

  return (
    <View style={styles.container}>
      {/* ─── Top Header ─────────────────────────────────────────────── */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>SYSTEM CONFIGURATION</Text>
        <Text style={styles.headerSubtitle}>OFF-GRID P2P MESH INTERCOM</Text>
      </View>

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {/* ─── Ephemeral Identity Card ──────────────────────────────── */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>EPHEMERAL IDENTITY</Text>
            <View style={styles.ephemeralBadge}>
              <Text style={styles.ephemeralBadgeText}>AIR-GAPPED</Text>
            </View>
          </View>
          <Text style={styles.cardDescription}>
            Every session uses zero-knowledge local keypairs. No phone numbers, emails, or hardware UUIDs.
          </Text>

          <View style={styles.fingerprintBox}>
            <Text style={styles.fingerprintLabel}>PUBLIC FINGERPRINT</Text>
            <Text style={styles.fingerprintValue}>{sessionFingerprint}</Text>
          </View>

          <TouchableOpacity
            style={styles.burnButton}
            onPress={confirmBurnSession}
            activeOpacity={0.8}
          >
            <Text style={styles.burnButtonEmoji}>🔥</Text>
            <Text style={styles.burnButtonText}>BURN SESSION IDENTITY</Text>
          </TouchableOpacity>
        </View>

        {/* ─── Radio Transports ──────────────────────────────────────── */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>RADIO TRANSPORTS</Text>
          <Text style={styles.cardDescription}>
            Bandwidth-segregated dual radio strategy for ultra-low latency audio and telemetry.
          </Text>

          <View style={styles.toggleRow}>
            <View style={styles.toggleInfo}>
              <Text style={styles.toggleTitle}>BLE 5.0 Discovery & Beacons</Text>
              <Text style={styles.toggleSubtitle}>Gossip pins & peer discovery (low power)</Text>
            </View>
            <Switch
              value={bleEnabled}
              onValueChange={setBleEnabled}
              trackColor={{ false: Colors.surfaceBorder, true: Colors.primary }}
              thumbColor={Colors.textPrimary}
            />
          </View>

          <View style={styles.divider} />

          <View style={styles.toggleRow}>
            <View style={styles.toggleInfo}>
              <Text style={styles.toggleTitle}>Wi-Fi Direct High-Throughput</Text>
              <Text style={styles.toggleSubtitle}>Full-duplex Opus voice stream & radar vectors</Text>
            </View>
            <Switch
              value={wifiDirectEnabled}
              onValueChange={setWifiDirectEnabled}
              trackColor={{ false: Colors.surfaceBorder, true: Colors.primary }}
              thumbColor={Colors.textPrimary}
            />
          </View>

          <View style={styles.divider} />

          <View style={styles.toggleRow}>
            <View style={styles.toggleInfo}>
              <Text style={styles.toggleTitle}>Nostr Relay Fallback</Text>
              <Text style={styles.toggleSubtitle}>NIP-17/44 encrypted bridge when cellular is back</Text>
            </View>
            <Switch
              value={nostrFallbackEnabled}
              onValueChange={setNostrFallbackEnabled}
              trackColor={{ false: Colors.surfaceBorder, true: Colors.primary }}
              thumbColor={Colors.textPrimary}
            />
          </View>
        </View>

        {/* ─── Audio DSP Engine ──────────────────────────────────────── */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>AUDIO DSP ENGINE</Text>
          <Text style={styles.cardDescription}>
            libopus 16kHz wideband audio pipeline with acoustic echo cancellation and VAD.
          </Text>

          <View style={styles.toggleRow}>
            <View style={styles.toggleInfo}>
              <Text style={styles.toggleTitle}>PTT Button Mode</Text>
              <Text style={styles.toggleSubtitle}>
                {pttToggleMode ? 'Toggle to Talk (Tap once)' : 'Hold to Talk (Continuous press)'}
              </Text>
            </View>
            <Switch
              value={pttToggleMode}
              onValueChange={setPttToggleMode}
              trackColor={{ false: Colors.surfaceBorder, true: Colors.primary }}
              thumbColor={Colors.textPrimary}
            />
          </View>

          <View style={styles.divider} />

          <View style={styles.toggleRow}>
            <View style={styles.toggleInfo}>
              <Text style={styles.toggleTitle}>Motorcycle Noise Gate</Text>
              <Text style={styles.toggleSubtitle}>Suppresses high-speed exhaust & wind howl</Text>
            </View>
            <Switch
              value={noiseGateActive}
              onValueChange={setNoiseGateActive}
              trackColor={{ false: Colors.surfaceBorder, true: Colors.primary }}
              thumbColor={Colors.textPrimary}
            />
          </View>

          <View style={styles.divider} />

          <View style={styles.settingBlock}>
            <Text style={styles.settingLabel}>OPUS VOICE BITRATE</Text>
            <View style={styles.segmentedRow}>
              {(['8', '12', '16'] as const).map((rate) => (
                <TouchableOpacity
                  key={`rate-${rate}`}
                  style={[
                    styles.segmentButton,
                    selectedBitrate === rate && styles.segmentButtonActive,
                  ]}
                  onPress={() => setSelectedBitrate(rate)}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      selectedBitrate === rate && styles.segmentTextActive,
                    ]}
                  >
                    {rate} KBPS
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>

        {/* ─── Handlebar BLE Remote ──────────────────────────────────── */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>HANDLEBAR PTT REMOTE</Text>
            <View
              style={[
                styles.statusPill,
                { backgroundColor: handlebarConnected ? 'rgba(74, 222, 128, 0.2)' : 'rgba(239, 68, 68, 0.2)' },
              ]}
            >
              <Text
                style={[
                  styles.statusPillText,
                  { color: handlebarConnected ? Colors.success : Colors.danger },
                ]}
              >
                {handlebarConnected ? 'CONNECTED' : 'DISCONNECTED'}
              </Text>
            </View>
          </View>

          <Text style={styles.cardDescription}>
            Bluetooth Media / BLE HID Handlebar Button mapped to instantaneous PTT toggle.
          </Text>

          <View style={styles.deviceRow}>
            <Text style={styles.deviceName}>Sena / Cardo / BLE PTT Remote</Text>
            <Text style={styles.deviceBattery}>🔋 85%</Text>
          </View>
        </View>

        {/* ─── Storage & Diagnostics ─────────────────────────────────── */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>CACHE & MAINTENANCE</Text>

          <TouchableOpacity
            style={styles.actionButtonSecondary}
            onPress={confirmClearCache}
            activeOpacity={0.8}
          >
            <Text style={styles.actionButtonSecondaryText}>PURGE HAZARD CACHE</Text>
          </TouchableOpacity>
        </View>

        {/* ─── Build Info ─────────────────────────────────────────────── */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>Konvoy v1.0.0 (Build 2026.09)</Text>
          <Text style={styles.footerSubtext}>Zero-Infrastructure Convoy Mesh • New Architecture</Text>
        </View>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    paddingTop: 54,
    paddingHorizontal: Spacing.base,
    paddingBottom: Spacing.md,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceBorder,
  },
  headerTitle: {
    fontSize: Typography.size.md,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textPrimary,
    letterSpacing: 1,
  },
  headerSubtitle: {
    fontSize: 10,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.primary,
    marginTop: 2,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: Spacing.base,
    paddingBottom: 60,
  },
  card: {
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    marginBottom: Spacing.base,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.xs,
  },
  cardTitle: {
    fontSize: Typography.size.sm,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textPrimary,
    letterSpacing: 1,
  },
  cardDescription: {
    fontSize: Typography.size.xs,
    color: Colors.textSecondary,
    lineHeight: 18,
    marginBottom: Spacing.md,
  },
  ephemeralBadge: {
    backgroundColor: 'rgba(0, 229, 255, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Colors.accent,
  },
  ephemeralBadgeText: {
    fontSize: 9,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.accent,
  },
  fingerprintBox: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  fingerprintLabel: {
    fontSize: 9,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textSecondary,
    marginBottom: 4,
  },
  fingerprintValue: {
    fontSize: Typography.size.sm,
    fontFamily: Typography.fontFamily.mono,
    color: Colors.accent,
  },
  burnButton: {
    height: TouchTargets.button,
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1.5,
    borderColor: Colors.danger,
    borderRadius: Radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  burnButtonEmoji: {
    fontSize: 18,
    marginRight: Spacing.sm,
  },
  burnButtonText: {
    fontSize: Typography.size.xs,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.danger,
    letterSpacing: 1,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.sm,
  },
  toggleInfo: {
    flex: 1,
    marginRight: Spacing.md,
  },
  toggleTitle: {
    fontSize: Typography.size.sm,
    fontFamily: Typography.fontFamily.semibold,
    color: Colors.textPrimary,
  },
  toggleSubtitle: {
    fontSize: Typography.size.xs,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.surfaceBorder,
    marginVertical: Spacing.xs,
  },
  settingBlock: {
    marginTop: Spacing.sm,
  },
  settingLabel: {
    fontSize: 10,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textSecondary,
    marginBottom: Spacing.sm,
  },
  segmentedRow: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: 3,
  },
  segmentButton: {
    flex: 1,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.sm,
  },
  segmentButtonActive: {
    backgroundColor: Colors.primary,
  },
  segmentText: {
    fontSize: Typography.size.xs,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textSecondary,
  },
  segmentTextActive: {
    color: Colors.textInverse,
  },
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radius.sm,
  },
  statusPillText: {
    fontSize: 9,
    fontFamily: Typography.fontFamily.bold,
  },
  deviceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    padding: Spacing.md,
    borderRadius: Radius.md,
  },
  deviceName: {
    fontSize: Typography.size.xs,
    fontFamily: Typography.fontFamily.semibold,
    color: Colors.textPrimary,
  },
  deviceBattery: {
    fontSize: Typography.size.xs,
    fontFamily: Typography.fontFamily.mono,
    color: Colors.success,
  },
  actionButtonSecondary: {
    height: TouchTargets.minimum,
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  actionButtonSecondaryText: {
    fontSize: Typography.size.xs,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textSecondary,
    letterSpacing: 1,
  },
  footer: {
    alignItems: 'center',
    marginTop: Spacing.lg,
  },
  footerText: {
    fontSize: Typography.size.xs,
    fontFamily: Typography.fontFamily.semibold,
    color: Colors.textSecondary,
  },
  footerSubtext: {
    fontSize: 10,
    color: Colors.surfaceBorder,
    marginTop: 2,
  },
});

export default SettingsScreen;
