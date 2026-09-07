/**
 * HIDButtonListener — BLE HID / Bluetooth Media Button Integration
 *
 * Listens for hardware button events from BLE HID remotes (handlebar PTT)
 * or standard Bluetooth media buttons. Maps to Push-to-Talk toggle
 * with haptic confirmation feedback.
 */

import React, { useEffect, useRef } from 'react';
import { DeviceEventEmitter, Platform } from 'react-native';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';

// ─── Types ───────────────────────────────────────────────────────────────

interface HIDButtonListenerProps {
  /** Called when PTT button is pressed */
  onPTTPress: () => void;
  /** Called when PTT button is released */
  onPTTRelease: () => void;
  /** Whether to provide haptic feedback on press/release */
  hapticEnabled?: boolean;
}

// ─── Haptic Options ──────────────────────────────────────────────────────

const hapticOptions = {
  enableVibrateFallback: true,
  ignoreAndroidSystemSettings: true,
};

// ─── Component ───────────────────────────────────────────────────────────

/**
 * Invisible component that listens for BLE HID / media button events
 * and maps them to PTT actions. Mount this at the app root.
 *
 * Supported triggers:
 *   - Android: KEYCODE_MEDIA_PLAY_PAUSE, KEYCODE_HEADSETHOOK
 *   - iOS: AVAudioSession remote command center (play/pause)
 *   - BLE HID: Custom HID usage page buttons via native event
 */
export const HIDButtonListener: React.FC<HIDButtonListenerProps> = ({
  onPTTPress,
  onPTTRelease,
  hapticEnabled = true,
}) => {
  const isPressedRef = useRef(false);

  useEffect(() => {
    // Listen for native HID/media button events
    const pressSub = DeviceEventEmitter.addListener(
      'KonvoyHIDButtonDown',
      () => {
        if (!isPressedRef.current) {
          isPressedRef.current = true;

          if (hapticEnabled) {
            ReactNativeHapticFeedback.trigger('impactHeavy', hapticOptions);
          }

          onPTTPress();
        }
      },
    );

    const releaseSub = DeviceEventEmitter.addListener(
      'KonvoyHIDButtonUp',
      () => {
        if (isPressedRef.current) {
          isPressedRef.current = false;

          if (hapticEnabled) {
            ReactNativeHapticFeedback.trigger('impactLight', hapticOptions);
          }

          onPTTRelease();
        }
      },
    );

    // For media button toggle (single press = toggle)
    const toggleSub = DeviceEventEmitter.addListener(
      'KonvoyMediaButtonToggle',
      () => {
        isPressedRef.current = !isPressedRef.current;

        if (hapticEnabled) {
          ReactNativeHapticFeedback.trigger(
            isPressedRef.current ? 'impactHeavy' : 'impactLight',
            hapticOptions,
          );
        }

        if (isPressedRef.current) {
          onPTTPress();
        } else {
          onPTTRelease();
        }
      },
    );

    return () => {
      pressSub.remove();
      releaseSub.remove();
      toggleSub.remove();
    };
  }, [onPTTPress, onPTTRelease, hapticEnabled]);

  // This component renders nothing — it's purely a listener
  return null;
};

export default HIDButtonListener;
