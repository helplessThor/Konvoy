/**
 * Konvoy Background Service Orchestrator
 *
 * Bridges native platform foreground services with the TypeScript
 * mesh stack. Manages the lifecycle of all subsystems through
 * app state transitions (foreground/background/terminated).
 */

import { AppState, Platform, NativeModules } from 'react-native';

// ─── Types ───────────────────────────────────────────────────────────────

export type AppLifecycleState = 'active' | 'background' | 'inactive';

export interface ServiceOrchestrator {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}

// ─── Background Service ──────────────────────────────────────────────────

export class BackgroundService implements ServiceOrchestrator {
  private static instance: BackgroundService | null = null;
  private running = false;
  private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;

  // Lifecycle callbacks
  private onEnterBackground: (() => void) | null = null;
  private onEnterForeground: (() => void) | null = null;

  static getInstance(): BackgroundService {
    if (!this.instance) {
      this.instance = new BackgroundService();
    }
    return this.instance;
  }

  static async start(): Promise<void> {
    return this.getInstance().start();
  }

  static async stop(): Promise<void> {
    return this.getInstance().stop();
  }

  constructor(opts?: {
    onEnterBackground?: () => void;
    onEnterForeground?: () => void;
  }) {
    this.onEnterBackground = opts?.onEnterBackground ?? null;
    this.onEnterForeground = opts?.onEnterForeground ?? null;
  }

  /**
   * Start background services on the current platform.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Start platform-specific foreground service
    if (Platform.OS === 'android') {
      await this.startAndroidForegroundService();
    }
    // iOS background modes are configured declaratively in Info.plist
    // and activated by the native managers (CoreBluetooth, CLLocationManager)

    // Listen for app state changes
    this.appStateSubscription = AppState.addEventListener('change', (state) => {
      this.handleAppStateChange(state as AppLifecycleState);
    });
  }

  /**
   * Stop background services.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Stop platform service
    if (Platform.OS === 'android') {
      this.stopAndroidForegroundService();
    }

    // Remove app state listener
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Update the Android foreground notification.
   */
  updateNotification(title: string, body: string): void {
    if (Platform.OS !== 'android') return;

    try {
      NativeModules.KonvoyForegroundService?.updateNotification(title, body);
    } catch {
      // Module may not be available during initialization
    }
  }

  // ─── Platform-Specific ─────────────────────────────────────────

  private async startAndroidForegroundService(): Promise<void> {
    try {
      const { KonvoyForegroundService } = NativeModules;
      if (KonvoyForegroundService) {
        KonvoyForegroundService.start();
      }
    } catch (err) {
      console.error('[BackgroundService] Failed to start Android foreground service:', err);
    }
  }

  private stopAndroidForegroundService(): void {
    try {
      const { KonvoyForegroundService } = NativeModules;
      if (KonvoyForegroundService) {
        KonvoyForegroundService.stop();
      }
    } catch {
      // Ignore
    }
  }

  // ─── App State Management ──────────────────────────────────────

  private handleAppStateChange(state: AppLifecycleState): void {
    switch (state) {
      case 'background':
        this.onEnterBackground?.();
        break;

      case 'active':
        this.onEnterForeground?.();
        break;

      case 'inactive':
        // Transitional state — no action needed
        break;
    }
  }
}
