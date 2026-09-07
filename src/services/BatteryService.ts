/**
 * BatteryService.ts — Device Battery Telemetry Provider
 *
 * Interfaces with native KonvoyRadioModule to query real device battery capacity
 * across Android hardware. Provides a reactive hook for UI components.
 */

import { useState, useEffect } from 'react';
import { NativeModules, Platform } from 'react-native';

export class BatteryService {
  private static instance: BatteryService | null = null;
  private currentBattery: number = 100;
  private listeners: Set<(level: number) => void> = new Set();
  private intervalId: any = null;

  static getInstance(): BatteryService {
    if (!this.instance) {
      this.instance = new BatteryService();
    }
    return this.instance;
  }

  constructor() {
    this.fetchBattery();
    // Poll every 30 seconds while app is active
    this.intervalId = setInterval(() => {
      this.fetchBattery();
    }, 30000);
    if (this.intervalId && typeof this.intervalId.unref === 'function') {
      this.intervalId.unref();
    }
  }

  async fetchBattery(): Promise<number> {
    if (Platform.OS === 'android' && NativeModules.KonvoyRadio?.getBatteryLevel) {
      try {
        const level = await NativeModules.KonvoyRadio.getBatteryLevel();
        if (typeof level === 'number' && level >= 0 && level <= 100) {
          this.currentBattery = Math.round(level);
          this.notifyListeners();
          return this.currentBattery;
        }
      } catch {
        // Fall back to default
      }
    }
    return this.currentBattery;
  }

  getBattery(): number {
    return this.currentBattery;
  }

  subscribe(listener: (level: number) => void): () => void {
    this.listeners.add(listener);
    listener(this.currentBattery);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    this.listeners.forEach((fn) => fn(this.currentBattery));
  }

  destroy(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.listeners.clear();
  }
}

export const batteryService = BatteryService.getInstance();

export function useDeviceBattery(): number {
  const [battery, setBattery] = useState<number>(() => batteryService.getBattery());

  useEffect(() => {
    return batteryService.subscribe((level) => {
      setBattery(level);
    });
  }, []);

  return battery;
}
