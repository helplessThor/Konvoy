/**
 * IntercomScreen.tsx — Full-Duplex Mesh Intercom & PTT HUD
 *
 * Glove-optimized interface with a massive 140dp Push-to-Talk button,
 * audio level VU meter, hands-free VAD toggle, channel switching,
 * and live convoy peer roster showing battery, signal strength, and active speaker state.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Animated,
  Vibration,
  Platform,
} from 'react-native';
import { Colors, Typography, Spacing, TouchTargets, Radius, Shadows } from '../theme/tokens';
import { IntercomMode } from '../../core/audio/intercom';

interface PeerVoiceState {
  peerId: string;
  callsign: string;
  role: 'LEAD' | 'TAIL' | 'MEMBER';
  batteryPercent?: number;
  rssi: number;
  isSpeaking: boolean;
  isMuted: boolean;
  transport: 'WIFI_P2P' | 'BLE' | 'NOSTR';
}

interface IntercomScreenProps {
  onStartTalk?: () => void;
  onStopTalk?: () => void;
  isTransmitting?: boolean;
  activeSpeakerName?: string | null;
  intercomMode?: IntercomMode;
  onModeChange?: (mode: IntercomMode) => void;
  currentAudioLevel?: number; // 0.0 to 1.0
  peers?: PeerVoiceState[];
  ownBatteryPercent?: number;
  pttToggleMode?: boolean;
}

export const IntercomScreen: React.FC<IntercomScreenProps> = ({
  onStartTalk,
  onStopTalk,
  isTransmitting = false,
  activeSpeakerName = null,
  intercomMode = IntercomMode.PushToTalk,
  onModeChange,
  currentAudioLevel = 0,
  peers = [],
  ownBatteryPercent,
  pttToggleMode = false,
}) => {
  const [selectedChannel, setSelectedChannel] = useState<'ALL' | 'LEAD' | 'TAIL'>('ALL');
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [isHoldingPTT, setIsHoldingPTT] = useState(false);

  const isToggleMode = pttToggleMode || intercomMode === IntercomMode.HandsFreeVAD;

  // Animation values
  const pulseRingAnim = useRef(new Animated.Value(1)).current;
  const vuMeterBars = useRef([
    new Animated.Value(0.2),
    new Animated.Value(0.4),
    new Animated.Value(0.7),
    new Animated.Value(0.3),
    new Animated.Value(0.8),
    new Animated.Value(0.5),
    new Animated.Value(0.2),
  ]).current;

  // Pulsing animation when speaking or transmitting
  useEffect(() => {
    let animation: Animated.CompositeAnimation | null = null;
    if (isTransmitting || isHoldingPTT) {
      animation = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseRingAnim, {
            toValue: 1.25,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(pulseRingAnim, {
            toValue: 1.0,
            duration: 600,
            useNativeDriver: true,
          }),
        ])
      );
      animation.start();
    } else {
      pulseRingAnim.setValue(1);
    }
    return () => animation?.stop();
  }, [isTransmitting, isHoldingPTT, pulseRingAnim]);

  // Dynamic VU meter bounce animation
  useEffect(() => {
    let mounted = true;
    const interval = setInterval(() => {
      if (!mounted || !Animated?.timing) return;
      const isAudioActive = isTransmitting || isHoldingPTT || !!activeSpeakerName || currentAudioLevel > 0.05;
      if (isAudioActive) {
        vuMeterBars.forEach((bar) => {
          if (mounted && Animated?.timing) {
            Animated.timing(bar, {
              toValue: Math.random() * 0.8 + 0.2,
              duration: 120,
              useNativeDriver: false,
            }).start();
          }
        });
      } else {
        vuMeterBars.forEach((bar) => {
          if (mounted && Animated?.timing) {
            Animated.timing(bar, {
              toValue: 0.05,
              duration: 150,
              useNativeDriver: false,
            }).start();
          }
        });
      }
    }, 120);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [isTransmitting, isHoldingPTT, activeSpeakerName, vuMeterBars]);

  const handlePressIn = () => {
    if (isMicMuted) return;
    setIsHoldingPTT(true);
    Vibration.vibrate(40);
    onStartTalk?.();
  };

  const handlePressOut = () => {
    if (isHoldingPTT) {
      setIsHoldingPTT(false);
      Vibration.vibrate(20);
      onStopTalk?.();
    }
  };

  const handleToggleTalk = () => {
    if (isMicMuted) return;
    if (isTransmitting || isHoldingPTT) {
      setIsHoldingPTT(false);
      Vibration.vibrate(20);
      onStopTalk?.();
    } else {
      setIsHoldingPTT(true);
      Vibration.vibrate(40);
      onStartTalk?.();
    }
  };

  const getButtonTitle = () => {
    if (isMicMuted) return 'MIC MUTED';
    if (isTransmitting || isHoldingPTT) return 'TRANSMITTING';
    if (isToggleMode) return 'TAP TO TALK';
    return 'HOLD TO TALK';
  };

  const getButtonSubtext = () => {
    if (isMicMuted) return 'Tap unmute below';
    if (isTransmitting || isHoldingPTT) {
      return isToggleMode ? 'Tap to stop' : 'Release to stop';
    }
    if (isToggleMode) {
      return intercomMode === IntercomMode.HandsFreeVAD
        ? 'Hands-Free (VOX) active'
        : 'Tap once to talk';
    }
    return 'Direct Member Link';
  };

  const toggleVAD = () => {
    const nextMode =
      intercomMode === IntercomMode.PushToTalk
        ? IntercomMode.HandsFreeVAD
        : IntercomMode.PushToTalk;
    onModeChange?.(nextMode);
    Vibration.vibrate(30);
  };

  const getRoleColor = (role: 'LEAD' | 'TAIL' | 'MEMBER'): string => {
    switch (role) {
      case 'LEAD':
        return Colors.primary;
      case 'TAIL':
        return Colors.accent;
      default:
        return Colors.textSecondary;
    }
  };

  return (
    <View style={styles.container}>
      {/* ─── Top Status Banner ────────────────────────────────────────── */}
      <View style={styles.topBanner}>
        <View style={styles.statusRow}>
          <View style={styles.channelBadge}>
            <Text style={styles.channelText} numberOfLines={1} adjustsFontSizeToFit>
              CHANNEL: {selectedChannel === 'ALL' ? 'ALL MEMBERS' : `${selectedChannel} MEMBER`}
            </Text>
          </View>

          <TouchableOpacity
            style={[
              styles.vadTogglePill,
              intercomMode === IntercomMode.HandsFreeVAD && styles.vadTogglePillActive,
            ]}
            onPress={toggleVAD}
            activeOpacity={0.8}
          >
            <View
              style={[
                styles.vadDot,
                intercomMode === IntercomMode.HandsFreeVAD && styles.vadDotActive,
              ]}
            />
            <Text
              style={[
                styles.vadText,
                intercomMode === IntercomMode.HandsFreeVAD && styles.vadTextActive,
              ]}
            >
              {intercomMode === IntercomMode.HandsFreeVAD ? 'HANDS-FREE (VOX)' : 'PUSH TO TALK'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Active Speaker Banner */}
        {activeSpeakerName ? (
          <View style={styles.activeSpeakerBox}>
            <Text style={styles.speakingWaveIcon}>🔊</Text>
            <Text style={styles.activeSpeakerText} numberOfLines={1}>
              {activeSpeakerName.toUpperCase()} SPEAKING
            </Text>
          </View>
        ) : (
          <View style={styles.idleSpeakerBox}>
            <Text style={styles.idleSpeakerText}>CHANNEL CLEAR • READY TO TALK</Text>
          </View>
        )}

        {/* Real-time VU Meter Bar */}
        <View style={styles.vuMeterRow}>
          {vuMeterBars.map((anim, idx) => (
            <Animated.View
              key={`vu-${idx}`}
              style={[
                styles.vuBar,
                {
                  height: anim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [4, 28],
                  }),
                  backgroundColor:
                    isTransmitting || isHoldingPTT
                      ? Colors.primary
                      : activeSpeakerName
                      ? Colors.accent
                      : Colors.surfaceBorder,
                },
              ]}
            />
          ))}
        </View>
      </View>

      {/* ─── Center Push-To-Talk Button ──────────────────────────────── */}
      <View style={styles.pttContainer}>
        {/* Animated Glow Halo */}
        <Animated.View
          style={[
            styles.pttHalo,
            {
              transform: [{ scale: pulseRingAnim }],
              borderColor:
                isTransmitting || isHoldingPTT ? Colors.primary : 'rgba(255, 107, 44, 0.1)',
            },
          ]}
        />

        <TouchableOpacity
          style={[
            styles.pttButton,
            (isTransmitting || isHoldingPTT) && styles.pttButtonActive,
            isMicMuted && styles.pttButtonDisabled,
          ]}
          onPress={isToggleMode ? handleToggleTalk : undefined}
          onPressIn={!isToggleMode ? handlePressIn : undefined}
          onPressOut={!isToggleMode ? handlePressOut : undefined}
          activeOpacity={0.85}
        >
          <Text style={styles.pttIcon}>
            {isMicMuted ? '🔇' : isTransmitting || isHoldingPTT ? '🎙️' : '🔘'}
          </Text>
          <Text
            style={[
              styles.pttButtonText,
              (isTransmitting || isHoldingPTT) && styles.pttButtonTextActive,
            ]}
          >
            {getButtonTitle()}
          </Text>
          <Text style={styles.pttSubText}>
            {getButtonSubtext()}
          </Text>
        </TouchableOpacity>
      </View>

      {/* ─── Hardware Quick Controls ─────────────────────────────────── */}
      <View style={styles.quickControlsRow}>
        <TouchableOpacity
          style={[styles.controlPill, isMicMuted && styles.controlPillActive]}
          onPress={() => {
            setIsMicMuted(!isMicMuted);
            Vibration.vibrate(25);
          }}
        >
          <Text style={styles.controlPillEmoji}>{isMicMuted ? '🔇' : '🎙️'}</Text>
          <Text style={styles.controlPillText}>{isMicMuted ? 'UNMUTE MIC' : 'MUTE MIC'}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.controlPill, isDeafened && styles.controlPillActive]}
          onPress={() => {
            setIsDeafened(!isDeafened);
            Vibration.vibrate(25);
          }}
        >
          <Text style={styles.controlPillEmoji}>{isDeafened ? '🔕' : '🎧'}</Text>
          <Text style={styles.controlPillText}>{isDeafened ? 'UNMUTE AUDIO' : 'MUTE AUDIO'}</Text>
        </TouchableOpacity>
      </View>

      {/* ─── Convoy Rider Roster ─────────────────────────────────────── */}
      <View style={styles.rosterHeader}>
        <Text style={styles.rosterTitle}>CONVOY MEMBERS ({peers.length + 1})</Text>
        <Text style={styles.rosterSubtitle}>DIRECT OFF-GRID</Text>
      </View>

      <ScrollView style={styles.rosterList} contentContainerStyle={styles.rosterContent}>
        {/* Own Rider Item */}
        <View style={styles.peerCard}>
          <View style={styles.peerAvatar}>
            <Text style={styles.avatarText}>YOU</Text>
          </View>
          <View style={styles.peerInfo}>
            <View style={styles.peerNameRow}>
              <Text style={styles.peerName}>You (Your Vehicle)</Text>
              <View style={[styles.roleBadge, { backgroundColor: Colors.primaryGlow }]}>
                <Text style={[styles.roleText, { color: Colors.primary }]}>YOU</Text>
              </View>
            </View>
            <Text style={styles.peerMeta}>Your Headset & Microphone</Text>
          </View>
          <View style={styles.peerStatusColumn}>
            {typeof ownBatteryPercent === 'number' && (
              <Text style={styles.peerBattery}>🔋 {ownBatteryPercent}%</Text>
            )}
            <Text style={[styles.peerLinkText, { color: Colors.success }]}>ACTIVE</Text>
          </View>
        </View>

        {/* Remote Group Peers */}
        {peers.length === 0 ? (
          <View style={styles.emptyMeshCard}>
            <Text style={styles.emptyMeshEmoji}>📡</Text>
            <Text style={styles.emptyMeshTitle}>LOOKING FOR NEARBY MEMBERS</Text>
            <Text style={styles.emptyMeshSubtext}>
              Searching for group members nearby. When members come within range, they connect automatically.
            </Text>
          </View>
        ) : (
          peers.map((peer) => (
            <View key={peer.peerId} style={styles.peerCard}>
              <View
                style={[
                  styles.peerAvatar,
                  peer.isSpeaking && { borderColor: Colors.accent, borderWidth: 2 },
                ]}
              >
                <Text style={styles.avatarText}>
                  {peer.callsign.substring(0, 2).toUpperCase()}
                </Text>
              </View>

              <View style={styles.peerInfo}>
                <View style={styles.peerNameRow}>
                  <Text style={styles.peerName}>{peer.callsign}</Text>
                  <View
                    style={[
                      styles.roleBadge,
                      { backgroundColor: `${getRoleColor(peer.role)}22` },
                    ]}
                  >
                    <Text style={[styles.roleText, { color: getRoleColor(peer.role) }]}>
                      {peer.role}
                    </Text>
                  </View>
                </View>

                <Text style={styles.peerMeta}>
                  {peer.rssi >= -65 ? 'Strong Signal' : peer.rssi >= -80 ? 'Good Signal' : 'Weak Signal'} • Direct Link
                </Text>
              </View>

              <View style={styles.peerStatusColumn}>
                {typeof peer.batteryPercent === 'number' && (
                  <Text style={styles.peerBattery}>🔋 {peer.batteryPercent}%</Text>
                )}
                <Text
                  style={[
                    styles.peerLinkText,
                    { color: peer.isSpeaking ? Colors.accent : Colors.textSecondary },
                  ]}
                >
                  {peer.isSpeaking ? 'TALKING' : peer.isMuted ? 'MUTED' : 'ONLINE'}
                </Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  topBanner: {
    paddingTop: 54,
    paddingHorizontal: Spacing.base,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceBorder,
    paddingBottom: Spacing.base,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.md,
    flexWrap: 'wrap',
    gap: 8,
  },
  channelBadge: {
    flex: 1,
    minWidth: 120,
    backgroundColor: Colors.surfaceElevated,
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  channelText: {
    fontSize: Typography.size.xs,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textPrimary,
    letterSpacing: 1,
  },
  vadTogglePill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceElevated,
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  vadTogglePillActive: {
    backgroundColor: 'rgba(74, 222, 128, 0.15)',
    borderColor: Colors.success,
  },
  vadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.textSecondary,
    marginRight: 6,
  },
  vadDotActive: {
    backgroundColor: Colors.success,
  },
  vadText: {
    fontSize: 10,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textSecondary,
  },
  vadTextActive: {
    color: Colors.success,
  },
  activeSpeakerBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.accentGlow,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.accent,
  },
  speakingWaveIcon: {
    fontSize: 18,
    marginRight: Spacing.sm,
  },
  activeSpeakerText: {
    fontSize: Typography.size.md,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.accent,
    letterSpacing: 1,
  },
  idleSpeakerBox: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surfaceElevated,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
  },
  idleSpeakerText: {
    fontSize: Typography.size.xs,
    fontFamily: Typography.fontFamily.mono,
    color: Colors.textSecondary,
    letterSpacing: 1,
  },
  vuMeterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.md,
    height: 32,
  },
  vuBar: {
    width: 6,
    marginHorizontal: 4,
    borderRadius: 3,
  },

  // ─── Center PTT Button ────────────────────────────────────────────────
  pttContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing['2xl'],
    position: 'relative',
  },
  pttHalo: {
    position: 'absolute',
    width: 176,
    height: 176,
    borderRadius: 88,
    borderWidth: 3,
    backgroundColor: 'rgba(255, 107, 44, 0.05)',
  },
  pttButton: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 4,
    borderColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadows.lg,
  },
  pttButtonActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primaryLight,
  },
  pttButtonDisabled: {
    borderColor: Colors.surfaceBorder,
    backgroundColor: Colors.surface,
  },
  pttIcon: {
    fontSize: 34,
    marginBottom: 4,
  },
  pttButtonText: {
    fontSize: Typography.size.xs,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.primary,
    letterSpacing: 1,
  },
  pttButtonTextActive: {
    color: Colors.textInverse,
  },
  pttSubText: {
    fontSize: 9,
    fontFamily: Typography.fontFamily.regular,
    color: Colors.textSecondary,
    marginTop: 2,
  },

  // ─── Quick Controls ──────────────────────────────────────────────────
  quickControlsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingHorizontal: Spacing.base,
    marginBottom: Spacing.base,
  },
  controlPill: {
    flex: 1,
    height: TouchTargets.minimum,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: Spacing.xs,
  },
  controlPillActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    borderColor: Colors.danger,
  },
  controlPillEmoji: {
    fontSize: 18,
    marginRight: Spacing.sm,
  },
  controlPillText: {
    fontSize: Typography.size.xs,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textPrimary,
  },

  // ─── Roster List ─────────────────────────────────────────────────────
  rosterHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
    backgroundColor: Colors.surface,
    borderTopWidth: 1,
    borderTopColor: Colors.surfaceBorder,
  },
  rosterTitle: {
    fontSize: Typography.size.xs,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textPrimary,
    letterSpacing: 1,
  },
  rosterSubtitle: {
    fontSize: 9,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textSecondary,
  },
  rosterList: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  rosterContent: {
    padding: Spacing.base,
  },
  peerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceElevated,
    padding: Spacing.md,
    borderRadius: Radius.md,
    marginBottom: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  peerAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  avatarText: {
    fontSize: Typography.size.sm,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textPrimary,
  },
  peerInfo: {
    flex: 1,
    marginLeft: Spacing.md,
  },
  peerNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  peerName: {
    fontSize: Typography.size.sm,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textPrimary,
  },
  roleBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: Radius.sm,
    marginLeft: Spacing.sm,
  },
  roleText: {
    fontSize: 9,
    fontFamily: Typography.fontFamily.bold,
  },
  peerMeta: {
    fontSize: Typography.size.xs,
    fontFamily: Typography.fontFamily.regular,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  peerStatusColumn: {
    alignItems: 'flex-end',
  },
  peerBattery: {
    fontSize: Typography.size.xs,
    fontFamily: Typography.fontFamily.mono,
    color: Colors.textPrimary,
  },
  peerLinkText: {
    fontSize: 9,
    fontFamily: Typography.fontFamily.bold,
    marginTop: 2,
  },
  emptyMeshCard: {
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.md,
    padding: Spacing.xl,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    marginTop: Spacing.sm,
  },
  emptyMeshEmoji: {
    fontSize: 32,
    marginBottom: Spacing.sm,
  },
  emptyMeshTitle: {
    fontSize: Typography.size.sm,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textPrimary,
    letterSpacing: 1,
    marginBottom: 6,
  },
  emptyMeshSubtext: {
    fontSize: Typography.size.xs,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 18,
  },
});

export default IntercomScreen;
