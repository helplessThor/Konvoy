/**
 * MapScreen.tsx — Live Convoy Map & Hazard Gossip HUD
 *
 * Designed for glove-friendly motorcycle cockpit operation with high-contrast,
 * sunlight-readable typography and large touch targets (≥48dp).
 *
 * Displays:
 *   - Convoy telemetry (speed, heading, altitude, peer markers with vector trails)
 *   - CRDT OR-Set hazard pins (Police, Accident, Road Hazard, Congestion)
 *   - Quick 1-tap Hazard Drop buttons (Police, Accident, Hazard, Debris)
 *   - Mesh radio status & relay fallback indicators
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  Modal,
  ScrollView,
  Animated,
} from 'react-native';
import { Colors, Typography, Spacing, TouchTargets, Radius, Shadows } from '../theme/tokens';
import { HazardType } from '../../core/net/wire';
import type { HazardEntry } from '../../core/map/crdt';

export interface PeerTelemetry {
  fingerprint: Uint8Array;
  latitude: number;
  longitude: number;
  heading: number;
  speed: number;
  altitude: number;
  lastSeen: number;
  distanceMeters?: number;
  isLead?: boolean;
  isSweeper?: boolean;
  callsign?: string;
}

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

interface MapScreenProps {
  currentSpeed?: number;
  currentHeading?: number;
  currentAltitude?: number;
  peers?: PeerTelemetry[];
  hazards?: HazardEntry[];
  onAddHazard?: (type: HazardType, lat: number, lng: number) => void;
  onRemoveHazard?: (pinId: Uint8Array) => void;
  activeRadioType?: 'BLE' | 'WIFI_DIRECT' | 'NOSTR' | 'AIR_GAPPED';
}

export const MapScreen: React.FC<MapScreenProps> = ({
  currentSpeed = 68,
  currentHeading = 215,
  currentAltitude = 340,
  peers = [
    {
      fingerprint: new Uint8Array([1, 2, 3, 4]),
      latitude: 37.7749,
      longitude: -122.4194,
      heading: 210,
      speed: 70,
      altitude: 338,
      lastSeen: Date.now(),
      distanceMeters: 42,
      isLead: true,
      callsign: 'Lead (Ghost)',
    },
    {
      fingerprint: new Uint8Array([5, 6, 7, 8]),
      latitude: 37.7739,
      longitude: -122.4204,
      heading: 218,
      speed: 66,
      altitude: 341,
      lastSeen: Date.now(),
      distanceMeters: 85,
      isSweeper: true,
      callsign: 'Tail (Viper)',
    },
  ],
  hazards = [
    {
      pinId: new Uint8Array([0xAA, 0x01]),
      type: HazardType.Police,
      latitude: 37.776,
      longitude: -122.418,
      createdAt: Math.floor(Date.now() / 1000) - 120,
      ttlSeconds: 7200,
      senderFingerprint: new Uint8Array(16),
      tombstoned: false,
      vectorClock: 1,
    },
    {
      pinId: new Uint8Array([0xBB, 0x02]),
      type: HazardType.RoadHazard,
      latitude: 37.772,
      longitude: -122.421,
      createdAt: Math.floor(Date.now() / 1000) - 300,
      ttlSeconds: 3600,
      senderFingerprint: new Uint8Array(16),
      tombstoned: false,
      vectorClock: 2,
    },
  ],
  onAddHazard,
  onRemoveHazard,
  activeRadioType = 'WIFI_DIRECT',
}) => {
  const [selectedHazard, setSelectedHazard] = useState<HazardEntry | null>(null);
  const [dropHazardModalVisible, setDropHazardModalVisible] = useState(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Pulse animation for own position marker
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.3,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1.0,
          duration: 1000,
          useNativeDriver: true,
        }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [pulseAnim]);

  const getHazardBadgeColor = (type: HazardType): string => {
    switch (type) {
      case HazardType.Police:
        return Colors.hazardPolice;
      case HazardType.Accident:
        return Colors.hazardAccident;
      case HazardType.RoadHazard:
        return Colors.hazardRoad;
      case HazardType.Congestion:
        return Colors.hazardCongestion;
      default:
        return Colors.warning;
    }
  };

  const getHazardLabel = (type: HazardType): string => {
    switch (type) {
      case HazardType.Police:
        return 'POLICE SPEED TRAP';
      case HazardType.Accident:
        return 'COLLISION / ACCIDENT';
      case HazardType.RoadHazard:
        return 'ROAD DEBRIS / OIL';
      case HazardType.Congestion:
        return 'TRAFFIC BOTTLENECK';
      default:
        return 'UNKNOWN HAZARD';
    }
  };

  const handleQuickDrop = (type: HazardType) => {
    setDropHazardModalVisible(false);
    onAddHazard?.(type, 37.7749, -122.4194);
  };

  return (
    <View style={styles.container}>
      {/* ─── Top Telemetry HUD ────────────────────────────────────────── */}
      <View style={styles.hudOverlayTop}>
        <View style={styles.speedCluster}>
          <Text style={styles.speedValue}>{Math.round(currentSpeed)}</Text>
          <Text style={styles.speedUnit}>KM/H</Text>
        </View>

        <View style={styles.telemetryStats}>
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>HEADING</Text>
            <Text style={styles.statValue}>{Math.round(currentHeading)}° SW</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>ALTITUDE</Text>
            <Text style={styles.statValue}>{Math.round(currentAltitude)} M</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>MESH CONVOY</Text>
            <Text style={[styles.statValue, { color: Colors.accent }]}>
              {peers.length + 1} RIDERS
            </Text>
          </View>
        </View>

        {/* Radio Link Status Pill */}
        <View style={styles.radioPill}>
          <View
            style={[
              styles.radioDot,
              {
                backgroundColor:
                  activeRadioType === 'WIFI_DIRECT'
                    ? Colors.success
                    : activeRadioType === 'BLE'
                    ? Colors.accent
                    : Colors.warning,
              },
            ]}
          />
          <Text style={styles.radioText}>{activeRadioType}</Text>
        </View>
      </View>

      {/* ─── Radar / Map Canvas Area ───────────────────────────────────── */}
      <View style={styles.radarContainer}>
        {/* Concentric distance rings */}
        <View style={[styles.radarRing, { width: 120, height: 120, borderRadius: 60 }]} />
        <View style={[styles.radarRing, { width: 220, height: 220, borderRadius: 110 }]} />
        <View style={[styles.radarRing, { width: 320, height: 320, borderRadius: 160 }]} />

        {/* Range text */}
        <Text style={styles.radarRangeText}>100m Range</Text>

        {/* Own bike marker (center) */}
        <View style={styles.centerMarkerContainer}>
          <Animated.View
            style={[
              styles.ownPulseRing,
              {
                transform: [{ scale: pulseAnim }],
              },
            ]}
          />
          <View style={[styles.ownRiderMarker, { transform: [{ rotate: `${currentHeading}deg` }] }]}>
            <View style={styles.riderArrow} />
          </View>
          <Text style={styles.ownLabel}>YOU</Text>
        </View>

        {/* Peer Convoy Markers */}
        {peers.map((peer, idx) => {
          // Offsets simulated on 2D tactical radar display
          const topOffset = idx === 0 ? -70 : 85;
          const leftOffset = idx === 0 ? 30 : -45;

          return (
            <View
              key={`peer-${idx}`}
              style={[
                styles.peerMarkerContainer,
                {
                  transform: [{ translateX: leftOffset }, { translateY: topOffset }],
                },
              ]}
            >
              <View style={[styles.peerMarker, { transform: [{ rotate: `${peer.heading}deg` }] }]}>
                <View style={styles.peerArrow} />
              </View>
              <View style={styles.peerBadge}>
                <Text style={styles.peerCallsign}>{peer.callsign || `Rider ${idx + 1}`}</Text>
                <Text style={styles.peerSpeed}>{Math.round(peer.speed)} km/h • {peer.distanceMeters}m</Text>
              </View>
            </View>
          );
        })}

        {/* Hazard Pins on Radar */}
        {hazards.map((hazard, idx) => {
          const topOffset = idx === 0 ? -110 : 50;
          const leftOffset = idx === 0 ? -80 : 90;
          const color = getHazardBadgeColor(hazard.type);

          return (
            <TouchableOpacity
              key={`hazard-${idx}`}
              style={[
                styles.hazardMarker,
                {
                  backgroundColor: color,
                  transform: [{ translateX: leftOffset }, { translateY: topOffset }],
                },
              ]}
              onPress={() => setSelectedHazard(hazard)}
              activeOpacity={0.8}
            >
              <Text style={styles.hazardIcon}>⚠️</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ─── Bottom HUD & Quick Action Bar ────────────────────────────── */}
      <View style={styles.bottomBar}>
        <TouchableOpacity
          style={styles.dropHazardButton}
          onPress={() => setDropHazardModalVisible(true)}
          activeOpacity={0.8}
        >
          <Text style={styles.dropHazardIcon}>⚠️</Text>
          <Text style={styles.dropHazardText}>REPORT HAZARD</Text>
        </TouchableOpacity>

        <View style={styles.quickHazardRow}>
          <TouchableOpacity
            style={[styles.quickTile, { borderColor: Colors.hazardPolice }]}
            onPress={() => handleQuickDrop(HazardType.Police)}
          >
            <Text style={styles.quickEmoji}>🚔</Text>
            <Text style={styles.quickText}>POLICE</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.quickTile, { borderColor: Colors.hazardAccident }]}
            onPress={() => handleQuickDrop(HazardType.Accident)}
          >
            <Text style={styles.quickEmoji}>💥</Text>
            <Text style={styles.quickText}>CRASH</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.quickTile, { borderColor: Colors.hazardRoad }]}
            onPress={() => handleQuickDrop(HazardType.RoadHazard)}
          >
            <Text style={styles.quickEmoji}>🛢️</Text>
            <Text style={styles.quickText}>OIL / ROAD</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ─── Hazard Detail Modal ───────────────────────────────────────── */}
      {selectedHazard && (
        <Modal
          transparent
          animationType="fade"
          visible={!!selectedHazard}
          onRequestClose={() => setSelectedHazard(null)}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <View
                style={[
                  styles.modalHeaderBadge,
                  { backgroundColor: getHazardBadgeColor(selectedHazard.type) },
                ]}
              >
                <Text style={styles.modalHeaderText}>
                  {getHazardLabel(selectedHazard.type)}
                </Text>
              </View>

              <Text style={styles.modalSubtext}>
                Reported by Mesh Peer • Synchronized via CRDT OR-Set
              </Text>

              <View style={styles.modalDetailsBox}>
                <Text style={styles.modalDetailRow}>
                  TTL Remaining: {Math.max(0, Math.floor(selectedHazard.ttlSeconds / 60))} mins
                </Text>
                <Text style={styles.modalDetailRow}>
                  Vector Clock: v{selectedHazard.vectorClock}
                </Text>
              </View>

              <View style={styles.modalActionRow}>
                <TouchableOpacity
                  style={[styles.modalButton, styles.dismissButton]}
                  onPress={() => setSelectedHazard(null)}
                >
                  <Text style={styles.dismissButtonText}>CLOSE</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.modalButton, styles.clearHazardButton]}
                  onPress={() => {
                    onRemoveHazard?.(selectedHazard.pinId);
                    setSelectedHazard(null);
                  }}
                >
                  <Text style={styles.clearHazardButtonText}>HAZARD CLEARED</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}

      {/* ─── Quick Drop Drawer Modal ───────────────────────────────────── */}
      <Modal
        transparent
        animationType="slide"
        visible={dropHazardModalVisible}
        onRequestClose={() => setDropHazardModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.hazardDrawerContent}>
            <Text style={styles.drawerTitle}>SELECT HAZARD TO BROADCAST</Text>
            <Text style={styles.drawerSubtitle}>
              Gossip synced to all peer bikes within radio mesh
            </Text>

            <View style={styles.drawerGrid}>
              <TouchableOpacity
                style={[styles.drawerItem, { backgroundColor: Colors.hazardPolice }]}
                onPress={() => handleQuickDrop(HazardType.Police)}
              >
                <Text style={styles.drawerEmoji}>🚔</Text>
                <Text style={styles.drawerItemText}>POLICE TRAP</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.drawerItem, { backgroundColor: Colors.hazardAccident }]}
                onPress={() => handleQuickDrop(HazardType.Accident)}
              >
                <Text style={styles.drawerEmoji}>💥</Text>
                <Text style={styles.drawerItemText}>ACCIDENT</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.drawerItem, { backgroundColor: Colors.hazardRoad }]}
                onPress={() => handleQuickDrop(HazardType.RoadHazard)}
              >
                <Text style={styles.drawerEmoji}>⚠️</Text>
                <Text style={styles.drawerItemText}>ROAD HAZARD</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.drawerItem, { backgroundColor: Colors.hazardCongestion }]}
                onPress={() => handleQuickDrop(HazardType.Congestion)}
              >
                <Text style={styles.drawerEmoji}>🚗</Text>
                <Text style={styles.drawerItemText}>CONGESTION</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={styles.cancelDrawerButton}
              onPress={() => setDropHazardModalVisible(false)}
            >
              <Text style={styles.cancelDrawerText}>CANCEL</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  hudOverlayTop: {
    paddingTop: 54,
    paddingHorizontal: Spacing.base,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceBorder,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: Spacing.md,
  },
  speedCluster: {
    alignItems: 'center',
    minWidth: 90,
  },
  speedValue: {
    fontSize: Typography.size['4xl'],
    fontFamily: Typography.fontFamily.bold,
    color: Colors.primary,
    lineHeight: 52,
  },
  speedUnit: {
    fontSize: Typography.size.xs,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textSecondary,
    letterSpacing: 1.5,
  },
  telemetryStats: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.md,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
  },
  statBox: {
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
  },
  statDivider: {
    width: 1,
    height: 26,
    backgroundColor: Colors.surfaceBorder,
  },
  statLabel: {
    fontSize: 9,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textSecondary,
    letterSpacing: 1,
  },
  statValue: {
    fontSize: Typography.size.sm,
    fontFamily: Typography.fontFamily.semibold,
    color: Colors.textPrimary,
    marginTop: 2,
  },
  radioPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceElevated,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  radioText: {
    fontSize: 10,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textPrimary,
  },

  // ─── Tactical Radar Display ──────────────────────────────────────────
  radarContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    overflow: 'hidden',
  },
  radarRing: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  radarRangeText: {
    position: 'absolute',
    top: Spacing.base,
    left: Spacing.base,
    fontSize: Typography.size.xs,
    fontFamily: Typography.fontFamily.mono,
    color: Colors.textSecondary,
  },
  centerMarkerContainer: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ownPulseRing: {
    position: 'absolute',
    width: 50,
    height: 50,
    borderRadius: 25,
    borderWidth: 2,
    borderColor: Colors.primaryGlow,
    backgroundColor: 'rgba(255, 107, 44, 0.15)',
  },
  ownRiderMarker: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.textPrimary,
    ...Shadows.md,
  },
  riderArrow: {
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderBottomWidth: 10,
    borderStyle: 'solid',
    backgroundColor: 'transparent',
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: Colors.background,
  },
  ownLabel: {
    fontSize: 10,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.primary,
    marginTop: 4,
  },

  // Peer Markers
  peerMarkerContainer: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  peerMarker: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.surface,
  },
  peerArrow: {
    width: 0,
    height: 0,
    borderLeftWidth: 4,
    borderRightWidth: 4,
    borderBottomWidth: 8,
    borderStyle: 'solid',
    backgroundColor: 'transparent',
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: Colors.background,
  },
  peerBadge: {
    backgroundColor: Colors.surfaceElevated,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: Radius.sm,
    marginTop: 4,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  peerCallsign: {
    fontSize: 10,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.accent,
  },
  peerSpeed: {
    fontSize: 8,
    fontFamily: Typography.fontFamily.regular,
    color: Colors.textSecondary,
  },

  // Hazard Markers
  hazardMarker: {
    position: 'absolute',
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.textPrimary,
    ...Shadows.md,
  },
  hazardIcon: {
    fontSize: 18,
  },

  // ─── Bottom Actions HUD ──────────────────────────────────────────────
  bottomBar: {
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.md,
    paddingBottom: 34,
    borderTopWidth: 1,
    borderTopColor: Colors.surfaceBorder,
  },
  dropHazardButton: {
    height: TouchTargets.button,
    backgroundColor: Colors.primary,
    borderRadius: Radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadows.md,
  },
  dropHazardIcon: {
    fontSize: 20,
    marginRight: Spacing.sm,
  },
  dropHazardText: {
    fontSize: Typography.size.md,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textInverse,
    letterSpacing: 1,
  },
  quickHazardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: Spacing.md,
  },
  quickTile: {
    flex: 1,
    height: 52,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1.5,
    borderRadius: Radius.md,
    marginHorizontal: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickEmoji: {
    fontSize: 18,
    marginRight: 6,
  },
  quickText: {
    fontSize: Typography.size.xs,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textPrimary,
  },

  // ─── Modals ──────────────────────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: Colors.scrim,
    justifyContent: 'center',
    padding: Spacing.xl,
  },
  modalContent: {
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.lg,
    padding: Spacing.xl,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  modalHeaderBadge: {
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.sm,
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  modalHeaderText: {
    fontSize: Typography.size.md,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textPrimary,
  },
  modalSubtext: {
    fontSize: Typography.size.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginBottom: Spacing.base,
  },
  modalDetailsBox: {
    backgroundColor: Colors.surface,
    padding: Spacing.md,
    borderRadius: Radius.md,
    marginBottom: Spacing.xl,
  },
  modalDetailRow: {
    fontSize: Typography.size.sm,
    fontFamily: Typography.fontFamily.mono,
    color: Colors.textPrimary,
    marginVertical: 2,
  },
  modalActionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  modalButton: {
    flex: 1,
    height: TouchTargets.button,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dismissButton: {
    backgroundColor: Colors.surface,
    marginRight: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  dismissButtonText: {
    fontSize: Typography.size.sm,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textSecondary,
  },
  clearHazardButton: {
    backgroundColor: Colors.success,
    marginLeft: Spacing.sm,
  },
  clearHazardButtonText: {
    fontSize: Typography.size.sm,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textInverse,
  },

  // ─── Drawer Modal ────────────────────────────────────────────────────
  hazardDrawerContent: {
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.xl,
    padding: Spacing.xl,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  drawerTitle: {
    fontSize: Typography.size.lg,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  drawerSubtitle: {
    fontSize: Typography.size.xs,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: Spacing.xl,
  },
  drawerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  drawerItem: {
    width: '48%',
    height: 72,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
    ...Shadows.sm,
  },
  drawerEmoji: {
    fontSize: 24,
    marginBottom: 4,
  },
  drawerItemText: {
    fontSize: Typography.size.xs,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textPrimary,
  },
  cancelDrawerButton: {
    height: TouchTargets.button,
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  cancelDrawerText: {
    fontSize: Typography.size.sm,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textSecondary,
  },
});

export default MapScreen;
