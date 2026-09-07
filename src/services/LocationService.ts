/**
 * LocationService.ts — Real-time GPS Location & Android Permissions
 *
 * Manages runtime permission requests and streams high-accuracy GPS telemetry
 * into the Convoy store and TelemetryManager. Zero mock coordinates.
 */

import { Platform, PermissionsAndroid, Alert } from 'react-native';
import Geolocation, { GeoPosition, GeoError } from 'react-native-geolocation-service';
import { useConvoyStore, type OwnPosition } from '../core/map/telemetry';

export class LocationService {
  private static instance: LocationService | null = null;
  private watchId: number | null = null;
  private isRunning: boolean = false;
  private onPositionUpdate: ((pos: OwnPosition) => void) | null = null;

  static getInstance(): LocationService {
    if (!this.instance) {
      this.instance = new LocationService();
    }
    return this.instance;
  }

  /**
   * Request all critical Android runtime permissions for off-grid convoy operation.
   */
  async requestPermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') {
      return true;
    }

    try {
      const permissions: string[] = [
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      ];

      const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10);

      if (apiLevel >= 31) {
        permissions.push(
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        );
      }

      if (apiLevel >= 33) {
        permissions.push(
          PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES,
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        );
      }

      const results = await PermissionsAndroid.requestMultiple(permissions as any);

      const fineLocationGranted =
        results[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED;
      const coarseLocationGranted =
        results[PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED;

      if (!fineLocationGranted && !coarseLocationGranted) {
        console.warn('[LocationService] Location permission denied by user.');
        Alert.alert(
          'Location Permission Required',
          'Konvoy requires High Accuracy GPS location to track your position in the convoy and display hazard alerts.',
          [{ text: 'OK' }]
        );
        return false;
      }

      return true;
    } catch (err) {
      console.error('[LocationService] Permission request failed:', err);
      return false;
    }
  }

  /**
   * Register a listener for location updates (e.g. TelemetryManager).
   */
  setOnPositionUpdate(callback: (pos: OwnPosition) => void): void {
    this.onPositionUpdate = callback;
  }

  /**
   * Start live GPS tracking.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    const granted = await this.requestPermissions();
    if (!granted) {
      console.warn('[LocationService] Cannot start GPS: permission not granted');
      return;
    }

    this.isRunning = true;

    // Fetch initial immediate location fix
    Geolocation.getCurrentPosition(
      (position: GeoPosition) => {
        this.handlePosition(position);
      },
      (error: GeoError) => {
        console.warn('[LocationService] High accuracy initial fix failed, attempting balanced fix:', error.message);
        // Fallback to balanced accuracy (cell/WiFi) if satellite fix times out (e.g. indoors)
        Geolocation.getCurrentPosition(
          (pos: GeoPosition) => {
            this.handlePosition(pos);
          },
          (fallbackErr: GeoError) => {
            console.warn('[LocationService] Balanced location fallback failed:', fallbackErr.message);
          },
          {
            enableHighAccuracy: false,
            timeout: 10000,
            maximumAge: 10000,
            showLocationDialog: true,
            forceRequestLocation: true,
          }
        );
      },
      {
        enableHighAccuracy: true,
        timeout: 8000,
        maximumAge: 5000,
        showLocationDialog: true,
        forceRequestLocation: true,
      }
    );

    // Continuous high-precision location tracking
    this.watchId = Geolocation.watchPosition(
      (position: GeoPosition) => {
        this.handlePosition(position);
      },
      (error: GeoError) => {
        console.warn('[LocationService] watchPosition error:', error.message);
      },
      {
        enableHighAccuracy: true,
        distanceFilter: 0,
        interval: 1000,
        fastestInterval: 500,
        showsBackgroundLocationIndicator: true,
        useSignificantChanges: false,
        showLocationDialog: true,
        forceRequestLocation: true,
      }
    );
  }

  /**
   * Transform Geolocation fix into OwnPosition telemetry format and dispatch.
   */
  private handlePosition(position: GeoPosition): void {
    const { coords, timestamp } = position;

    // Convert speed from m/s to km/h (speed * 3.6). If stationary or negative, clamp to 0.
    const rawSpeed = coords.speed ?? 0;
    const speedKmH = Math.max(0, rawSpeed * 3.6);

    const ownPos: OwnPosition = {
      latitude: coords.latitude,
      longitude: coords.longitude,
      heading: coords.heading != null && coords.heading >= 0 ? coords.heading : 0,
      speed: Math.round(speedKmH * 10) / 10,
      altitude: Math.round(coords.altitude ?? 0),
      accuracy: coords.accuracy,
      timestamp: Math.floor(timestamp / 1000),
    };

    // Update the reactive Zustand store for UI
    useConvoyStore.getState().setOwnPosition(ownPos);

    // Notify registered manager for wire packet broadcasting
    this.onPositionUpdate?.(ownPos);
  }

  /**
   * Stop GPS tracking.
   */
  stop(): void {
    if (this.watchId !== null) {
      Geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.isRunning = false;
  }

  isTracking(): boolean {
    return this.isRunning;
  }
}

export const locationService = LocationService.getInstance();
