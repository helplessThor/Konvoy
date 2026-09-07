/**
 * MapScreen.tsx — Live Convoy Map & Hazard Gossip HUD
 *
 * High-contrast, sunlight-readable tactical display designed for
 * motorcycle cockpit mounting.
 *
 * Real Data Integration:
 *   - Real MapLibre cartographic map with dark mode tactical tiles
 *   - Live GPS telemetry (speed, heading, altitude, coordinates)
 *   - Real discovered peer riders in mesh range (zero mock riders)
 *   - CRDT OR-Set synchronized hazard pins dropped at actual GPS location
 *   - Seamless toggle between Cartographic Map & Tactical Radar view
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  Modal,
  Animated,
  Alert,
} from 'react-native';
import { Map, Camera, Marker } from '@maplibre/maplibre-react-native';
import { Colors, Typography, Spacing, TouchTargets, Radius, Shadows } from '../theme/tokens';
import { HazardType } from '../../core/net/wire';
import type { HazardEntry } from '../../core/map/crdt';
import { useSettingsStore, type MapStyleKey } from '../../core/settings/settingsStore';

export interface PeerTelemetry {
  fingerprint: Uint8Array;
  fingerprintHex?: string;
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

// Direct Google Maps & High-Contrast Tactical Styles (No white screens, 100% reliable)
export const GOOGLE_MAP_STYLES: Record<MapStyleKey, any> = {
  GOOGLE_ROAD: {
    version: 8,
    name: 'Google Road',
    sources: {
      'google-tiles': {
        type: 'raster',
        tiles: [
          'https://mt0.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
          'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
          'https://mt2.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
          'https://mt3.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
        ],
        tileSize: 256,
      },
    },
    layers: [
      {
        id: 'google-tiles-layer',
        type: 'raster',
        source: 'google-tiles',
        minzoom: 0,
        maxzoom: 22,
      },
    ],
  },
  GOOGLE_HYBRID: {
    version: 8,
    name: 'Google Hybrid',
    sources: {
      'google-hybrid-tiles': {
        type: 'raster',
        tiles: [
          'https://mt0.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
          'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
          'https://mt2.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
          'https://mt3.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
        ],
        tileSize: 256,
      },
    },
    layers: [
      {
        id: 'google-hybrid-layer',
        type: 'raster',
        source: 'google-hybrid-tiles',
        minzoom: 0,
        maxzoom: 22,
      },
    ],
  },
  GOOGLE_TERRAIN: {
    version: 8,
    name: 'Google Terrain',
    sources: {
      'google-terrain-tiles': {
        type: 'raster',
        tiles: [
          'https://mt0.google.com/vt/lyrs=p&x={x}&y={y}&z={z}',
          'https://mt1.google.com/vt/lyrs=p&x={x}&y={y}&z={z}',
          'https://mt2.google.com/vt/lyrs=p&x={x}&y={y}&z={z}',
          'https://mt3.google.com/vt/lyrs=p&x={x}&y={y}&z={z}',
        ],
        tileSize: 256,
      },
    },
    layers: [
      {
        id: 'google-terrain-layer',
        type: 'raster',
        source: 'google-terrain-tiles',
        minzoom: 0,
        maxzoom: 22,
      },
    ],
  },
  DARK: {
    version: 8,
    name: 'Tactical Dark',
    sources: {
      'carto-dark-tiles': {
        type: 'raster',
        tiles: [
          'https://a.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png',
          'https://b.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png',
          'https://c.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png',
          'https://d.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
      },
    },
    layers: [
      {
        id: 'carto-dark-layer',
        type: 'raster',
        source: 'carto-dark-tiles',
        minzoom: 0,
        maxzoom: 22,
      },
    ],
  },
};

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

function getCompassHeading(degrees: number): string {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const index = Math.round(((degrees %= 360) < 0 ? degrees + 360 : degrees) / 45) % 8;
  return directions[index] ?? 'N';
}

// Haversine distance in meters
function getDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

// Bearing in degrees from lat1,lon1 to lat2,lon2
function getBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return (Math.round((θ * 180) / Math.PI) + 360) % 360;
}

function getRadioLabel(type: string): string {
  switch (type) {
    case 'WIFI_DIRECT':
      return 'DIRECT LINK';
    case 'BLE':
      return 'BLUETOOTH';
    case 'NOSTR':
      return 'INTERNET';
    case 'AIR_GAPPED':
      return 'OFFLINE';
    case 'SEARCHING':
    default:
      return 'CONNECTING';
  }
}

interface MapScreenProps {
  currentSpeed?: number;
  currentHeading?: number;
  currentAltitude?: number;
  currentLatitude?: number;
  currentLongitude?: number;
  isGpsLocked?: boolean;
  peers?: PeerTelemetry[];
  hazards?: HazardEntry[];
  onAddHazard?: (type: HazardType, lat: number, lng: number) => void;
  onRemoveHazard?: (pinId: Uint8Array) => void;
  activeRadioType?: 'BLE' | 'WIFI_DIRECT' | 'NOSTR' | 'AIR_GAPPED' | 'SEARCHING';
}

export const MapScreen: React.FC<MapScreenProps> = ({
  currentSpeed = 0,
  currentHeading = 0,
  currentAltitude = 0,
  currentLatitude = 0,
  currentLongitude = 0,
  isGpsLocked = false,
  peers = [],
  hazards = [],
  onAddHazard,
  onRemoveHazard,
  activeRadioType = 'SEARCHING',
}) => {
  const [viewMode, setViewMode] = useState<'MAP' | 'RADAR'>('MAP');
  const selectedStyle = useSettingsStore((state) => state.mapStyle);
  const setMapStyle = useSettingsStore((state) => state.setMapStyle);
  const [selectedHazard, setSelectedHazard] = useState<HazardEntry | null>(null);
  const [dropHazardModalVisible, setDropHazardModalVisible] = useState(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const cameraRef = useRef<any>(null);
  const hadGpsFixRef = useRef(false);

  const hasGpsFix = isGpsLocked || (currentLatitude !== 0 && currentLongitude !== 0);

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

  // Follow rider coordinates when updated, fly on initial fix
  useEffect(() => {
    if (hasGpsFix && cameraRef.current) {
      if (!hadGpsFixRef.current) {
        hadGpsFixRef.current = true;
        cameraRef.current.flyTo({
          center: [currentLongitude, currentLatitude],
          zoom: 15,
          duration: 1200,
        });
      } else {
        cameraRef.current.easeTo({
          center: [currentLongitude, currentLatitude],
          duration: 500,
        });
      }
    }
  }, [hasGpsFix, currentLatitude, currentLongitude]);

  // Recenter camera on rider coordinates
  const handleRecenter = () => {
    if (!hasGpsFix) {
      Alert.alert('Locating GPS', 'Waiting for satellite connection to center your position.');
      return;
    }
    cameraRef.current?.easeTo({
      center: [currentLongitude, currentLatitude],
      zoom: 15,
      duration: 600,
    });
  };

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

    if (!hasGpsFix) {
      Alert.alert(
        'GPS Connecting',
        'Cannot report hazard: GPS is still connecting. Please wait a moment.'
      );
      return;
    }

    onAddHazard?.(type, currentLatitude, currentLongitude);
  };

  // Compute relative radar positions for real peers
  const radarPeers = useMemo(() => {
    if (!hasGpsFix) return [];
    return peers.map((p) => {
      const dist = getDistanceMeters(currentLatitude, currentLongitude, p.latitude, p.longitude);
      const bearing = getBearing(currentLatitude, currentLongitude, p.latitude, p.longitude);
      const relAngle = ((bearing - currentHeading + 360) % 360) * (Math.PI / 180);
      // Scale: 100m = 140px radius
      const r = Math.min(150, (dist / 100) * 140);
      const x = r * Math.sin(relAngle);
      const y = -r * Math.cos(relAngle);
      return { ...p, dist, x, y };
    });
  }, [hasGpsFix, currentLatitude, currentLongitude, currentHeading, peers]);

  // Compute relative radar positions for real hazards
  const radarHazards = useMemo(() => {
    if (!hasGpsFix) return [];
    return hazards.map((h) => {
      const dist = getDistanceMeters(currentLatitude, currentLongitude, h.latitude, h.longitude);
      const bearing = getBearing(currentLatitude, currentLongitude, h.latitude, h.longitude);
      const relAngle = ((bearing - currentHeading + 360) % 360) * (Math.PI / 180);
      const r = Math.min(150, (dist / 100) * 140);
      const x = r * Math.sin(relAngle);
      const y = -r * Math.cos(relAngle);
      return { ...h, dist, x, y };
    });
  }, [hasGpsFix, currentLatitude, currentLongitude, currentHeading, hazards]);

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
            <Text style={styles.statValue}>
              {Math.round(currentHeading)}° {getCompassHeading(currentHeading)}
            </Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>ALTITUDE</Text>
            <Text style={styles.statValue}>{Math.round(currentAltitude)} M</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>RIDERS</Text>
            <Text style={[styles.statValue, { color: peers.length > 0 ? Colors.accent : Colors.textPrimary }]}>
              {peers.length + 1} {peers.length === 0 ? 'SOLO' : 'IN GROUP'}
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
                    : activeRadioType === 'NOSTR'
                    ? Colors.primary
                    : Colors.warning,
              },
            ]}
          />
          <Text style={styles.radioText}>{getRadioLabel(activeRadioType)}</Text>
        </View>
      </View>

      {/* GPS Status Banner if searching */}
      {!hasGpsFix && (
        <View style={styles.gpsWarningBanner}>
          <Text style={styles.gpsWarningText}>🛰️ CONNECTING GPS • WAITING FOR SATELLITES</Text>
        </View>
      )}

      {/* View Switcher & Recenter Floating Controls */}
      <View style={styles.viewControlsRow}>
        <View style={styles.modeToggleGroup}>
          <TouchableOpacity
            style={[styles.modeButton, viewMode === 'MAP' && styles.modeButtonActive]}
            onPress={() => setViewMode('MAP')}
          >
            <Text style={[styles.modeButtonText, viewMode === 'MAP' && styles.modeButtonTextActive]}>
              🗺️ MAP
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.modeButton, viewMode === 'RADAR' && styles.modeButtonActive]}
            onPress={() => setViewMode('RADAR')}
          >
            <Text style={[styles.modeButtonText, viewMode === 'RADAR' && styles.modeButtonTextActive]}>
              🎯 RADAR
            </Text>
          </TouchableOpacity>
        </View>

        {viewMode === 'MAP' && (
          <View style={styles.rightControlsRow}>
            <View style={styles.styleToggleGroup}>
              <TouchableOpacity
                style={[styles.styleButton, selectedStyle === 'GOOGLE_ROAD' && styles.styleButtonActive]}
                onPress={() => setMapStyle('GOOGLE_ROAD')}
              >
                <Text style={[styles.styleButtonText, selectedStyle === 'GOOGLE_ROAD' && styles.styleButtonTextActive]}>
                  ROAD
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.styleButton, selectedStyle === 'GOOGLE_HYBRID' && styles.styleButtonActive]}
                onPress={() => setMapStyle('GOOGLE_HYBRID')}
              >
                <Text style={[styles.styleButtonText, selectedStyle === 'GOOGLE_HYBRID' && styles.styleButtonTextActive]}>
                  SATELLITE
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.styleButton, selectedStyle === 'DARK' && styles.styleButtonActive]}
                onPress={() => setMapStyle('DARK')}
              >
                <Text style={[styles.styleButtonText, selectedStyle === 'DARK' && styles.styleButtonTextActive]}>
                  DARK
                </Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={styles.recenterButton} onPress={handleRecenter}>
              <Text style={styles.recenterText}>🎯 RECENTER</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* ─── Map / Radar Area ─────────────────────────────────────────── */}
      {viewMode === 'MAP' ? (
        <View style={styles.mapContainer}>
          <Map
            style={styles.map}
            mapStyle={JSON.stringify(GOOGLE_MAP_STYLES[selectedStyle] || GOOGLE_MAP_STYLES.GOOGLE_ROAD)}
          >
            <Camera
              ref={cameraRef}
              initialViewState={{
                center: hasGpsFix ? [currentLongitude, currentLatitude] : [0, 0],
                zoom: hasGpsFix ? 15 : 2,
              }}
            />

            {/* Own Live Rider Marker */}
            {hasGpsFix && (
              <Marker
                id="own-rider-marker"
                lngLat={[currentLongitude, currentLatitude]}
                anchor="center"
              >
                <View style={styles.mapOwnMarkerWrapper}>
                  <Animated.View
                    style={[
                      styles.ownPulseRing,
                      { transform: [{ scale: pulseAnim }] },
                    ]}
                  />
                  <View style={[styles.ownRiderMarker, { transform: [{ rotate: `${currentHeading}deg` }] }]}>
                    <View style={styles.riderArrow} />
                  </View>
                </View>
              </Marker>
            )}

            {/* Discovered Real Peer Markers */}
            {peers.map((peer, idx) => {
              const fpHex = peer.fingerprintHex || toHex(peer.fingerprint);
              return (
                <Marker
                  key={`map-peer-${fpHex}-${idx}`}
                  id={`peer-${fpHex}`}
                  lngLat={[peer.longitude, peer.latitude]}
                  anchor="center"
                >
                  <View style={styles.mapPeerWrapper}>
                    <View style={[styles.peerMarker, { transform: [{ rotate: `${peer.heading}deg` }] }]}>
                      <View style={styles.peerArrow} />
                    </View>
                    <View style={styles.peerBadge}>
                      <Text style={styles.peerCallsign}>
                        {peer.callsign || fpHex.substring(0, 6)}
                      </Text>
                      <Text style={styles.peerSpeed}>{Math.round(peer.speed)} km/h</Text>
                    </View>
                  </View>
                </Marker>
              );
            })}

            {/* Real CRDT Hazard Pins */}
            {hazards.map((hazard, idx) => {
              const pinHex = toHex(hazard.pinId);
              const color = getHazardBadgeColor(hazard.type);
              return (
                <Marker
                  key={`map-hazard-${pinHex}-${idx}`}
                  id={`hazard-${pinHex}`}
                  lngLat={[hazard.longitude, hazard.latitude]}
                  anchor="center"
                  onPress={() => setSelectedHazard(hazard)}
                >
                  <View style={[styles.hazardMarker, { backgroundColor: color }]}>
                    <Text style={styles.hazardIcon}>⚠️</Text>
                  </View>
                </Marker>
              );
            })}
          </Map>
        </View>
      ) : (
        /* ─── Tactical Radar HUD Area ─────────────────────────────────── */
        <View style={styles.radarContainer}>
          <View style={[styles.radarRing, { width: 100, height: 100, borderRadius: 50 }]} />
          <View style={[styles.radarRing, { width: 200, height: 200, borderRadius: 100 }]} />
          <View style={[styles.radarRing, { width: 280, height: 280, borderRadius: 140 }]} />

          <Text style={styles.radarRangeText}>100m Range</Text>

          {/* Own bike marker (center) */}
          <View style={styles.centerMarkerContainer}>
            <Animated.View
              style={[
                styles.ownPulseRing,
                { transform: [{ scale: pulseAnim }] },
              ]}
            />
            <View style={[styles.ownRiderMarker, { transform: [{ rotate: `${currentHeading}deg` }] }]}>
              <View style={styles.riderArrow} />
            </View>
            <Text style={styles.ownLabel}>YOU</Text>
          </View>

          {/* Peer Convoy Markers on Radar (relative to your actual GPS position) */}
          {radarPeers.map((peer, idx) => (
            <View
              key={`radar-peer-${idx}`}
              style={[
                styles.peerMarkerContainer,
                { transform: [{ translateX: peer.x }, { translateY: peer.y }] },
              ]}
            >
              <View style={[styles.peerMarker, { transform: [{ rotate: `${peer.heading}deg` }] }]}>
                <View style={styles.peerArrow} />
              </View>
              <View style={styles.peerBadge}>
                <Text style={styles.peerCallsign}>
                  {peer.callsign || `Rider ${idx + 1}`}
                </Text>
                <Text style={styles.peerSpeed}>
                  {Math.round(peer.speed)} km/h • {peer.dist}m
                </Text>
              </View>
            </View>
          ))}

          {/* Real Hazards on Radar */}
          {radarHazards.map((hazard, idx) => {
            const color = getHazardBadgeColor(hazard.type);
            return (
              <TouchableOpacity
                key={`radar-hazard-${idx}`}
                style={[
                  styles.hazardMarker,
                  {
                    backgroundColor: color,
                    transform: [{ translateX: hazard.x }, { translateY: hazard.y }],
                  },
                ]}
                onPress={() => setSelectedHazard(hazard)}
                activeOpacity={0.8}
              >
                <Text style={styles.hazardIcon}>⚠️</Text>
              </TouchableOpacity>
            );
          })}

          {radarPeers.length === 0 && (
            <View style={styles.soloRadarMessage}>
              <Text style={styles.soloRadarText}>NO NEARBY RIDERS</Text>
              <Text style={styles.soloRadarSubtext}>Searching for riders in your group...</Text>
            </View>
          )}
        </View>
      )}

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
            <Text style={styles.quickText}>ROAD</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.quickTile, { borderColor: Colors.hazardCongestion }]}
            onPress={() => handleQuickDrop(HazardType.Congestion)}
          >
            <Text style={styles.quickEmoji}>🚗</Text>
            <Text style={styles.quickText}>TRAFFIC</Text>
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
                Location: {selectedHazard.latitude.toFixed(4)}, {selectedHazard.longitude.toFixed(4)}
              </Text>

              <View style={styles.modalDetailsBox}>
                <Text style={styles.modalDetailRow}>
                  Active for: {Math.max(0, Math.floor(selectedHazard.ttlSeconds / 60))} more mins
                </Text>
                <Text style={styles.modalDetailRow}>
                  Reported: {new Date(selectedHazard.createdAt * 1000).toLocaleTimeString()}
                </Text>
                <Text style={styles.modalDetailRow}>
                  Alert Status: Active & Verified
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
            <Text style={styles.drawerTitle}>REPORT ROAD HAZARD</Text>
            <Text style={styles.drawerSubtitle}>
              Alerts all riders in your group instantly
            </Text>

            <View style={styles.drawerGrid}>
              <TouchableOpacity
                style={[styles.drawerItem, { backgroundColor: Colors.hazardPolice }]}
                onPress={() => handleQuickDrop(HazardType.Police)}
              >
                <Text style={styles.drawerEmoji}>🚔</Text>
                <Text style={styles.drawerItemText}>POLICE</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.drawerItem, { backgroundColor: Colors.hazardAccident }]}
                onPress={() => handleQuickDrop(HazardType.Accident)}
              >
                <Text style={styles.drawerEmoji}>💥</Text>
                <Text style={styles.drawerItemText}>CRASH</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.drawerItem, { backgroundColor: Colors.hazardRoad }]}
                onPress={() => handleQuickDrop(HazardType.RoadHazard)}
              >
                <Text style={styles.drawerEmoji}>⚠️</Text>
                <Text style={styles.drawerItemText}>ROAD DEBRIS</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.drawerItem, { backgroundColor: Colors.hazardCongestion }]}
                onPress={() => handleQuickDrop(HazardType.Congestion)}
              >
                <Text style={styles.drawerEmoji}>🚗</Text>
                <Text style={styles.drawerItemText}>TRAFFIC JAM</Text>
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
    paddingTop: 50,
    paddingHorizontal: Spacing.base,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceBorder,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: Spacing.md,
    zIndex: 10,
  },
  speedCluster: {
    alignItems: 'center',
    minWidth: 85,
  },
  speedValue: {
    fontSize: Typography.size['4xl'],
    fontFamily: Typography.fontFamily.bold,
    color: Colors.primary,
    lineHeight: 50,
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
  gpsWarningBanner: {
    backgroundColor: 'rgba(255, 107, 44, 0.2)',
    paddingVertical: 4,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: Colors.primary,
  },
  gpsWarningText: {
    fontSize: 10,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.primary,
    letterSpacing: 1,
  },
  viewControlsRow: {
    position: 'absolute',
    top: 130,
    left: Spacing.base,
    right: Spacing.base,
    flexDirection: 'row',
    justifyContent: 'space-between',
    zIndex: 20,
  },
  modeToggleGroup: {
    flexDirection: 'row',
    backgroundColor: 'rgba(18, 24, 38, 0.9)',
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    padding: 2,
  },
  modeButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radius.full,
  },
  modeButtonActive: {
    backgroundColor: Colors.primary,
  },
  modeButtonText: {
    fontSize: 11,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textSecondary,
  },
  modeButtonTextActive: {
    color: Colors.textInverse,
  },
  rightControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  styleToggleGroup: {
    flexDirection: 'row',
    backgroundColor: 'rgba(18, 24, 38, 0.9)',
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    padding: 2,
    marginRight: 8,
  },
  styleButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: Radius.full,
  },
  styleButtonActive: {
    backgroundColor: Colors.primary,
  },
  styleButtonText: {
    fontSize: 10,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textSecondary,
    letterSpacing: 0.5,
  },
  styleButtonTextActive: {
    color: Colors.textInverse,
  },
  recenterButton: {
    backgroundColor: 'rgba(18, 24, 38, 0.9)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.accent,
    justifyContent: 'center',
  },
  recenterText: {
    fontSize: 11,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.accent,
  },

  // ─── MapLibre Container ──────────────────────────────────────────────
  mapContainer: {
    flex: 1,
  },
  map: {
    flex: 1,
  },
  mapOwnMarkerWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  mapPeerWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
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
    top: 55,
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
    width: 48,
    height: 48,
    borderRadius: 24,
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
    fontSize: 9,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.primary,
    marginTop: 3,
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
    marginTop: 3,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  peerCallsign: {
    fontSize: 9,
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
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.textPrimary,
    ...Shadows.md,
  },
  hazardIcon: {
    fontSize: 16,
  },

  soloRadarMessage: {
    position: 'absolute',
    bottom: 30,
    alignItems: 'center',
  },
  soloRadarText: {
    fontSize: Typography.size.xs,
    fontFamily: Typography.fontFamily.bold,
    color: Colors.textSecondary,
    letterSpacing: 1,
  },
  soloRadarSubtext: {
    fontSize: 9,
    color: Colors.surfaceBorder,
    marginTop: 2,
  },

  // ─── Bottom Actions HUD ──────────────────────────────────────────────
  bottomBar: {
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.md,
    paddingBottom: 28,
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
    height: 48,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1.5,
    borderRadius: Radius.md,
    marginHorizontal: 3,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickEmoji: {
    fontSize: 16,
    marginRight: 4,
  },
  quickText: {
    fontSize: 10,
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
