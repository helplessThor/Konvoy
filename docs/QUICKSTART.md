# Konvoy — Quickstart Guide 🚀

This guide walks you through setting up, building, installing, and using Konvoy on Android devices for group motorcycle rides.

---

## 1. Fast Track: Install Pre-Built APK

Every commit to the `main` branch automatically compiles and packages a release APK through GitHub Actions:

1. Navigate to the [Konvoy GitHub Actions Releases](https://github.com/helplessThor/Konvoy/actions/workflows/build-apk.yml).
2. Select the latest successful build.
3. Under **Artifacts**, download `konvoy-release-apk.zip`.
4. Extract the `.apk` file and transfer it to your Android device via USB, Google Drive, or local file sharing.
5. On your phone, tap the APK and select **Install** (allow *Install from unknown sources* if prompted).

---

## 2. Local Environment Setup

### Prerequisites

| Tool | Version | Notes |
| :--- | :--- | :--- |
| **Node.js** | `>= 22.11.0` | Recommended: LTS via `nvm` or `fnm` |
| **Java Development Kit (JDK)** | `JDK 17` | OpenJDK or Eclipse Temurin 17 |
| **Android SDK Command-Line Tools** | `API 34` | Android Studio is **optional**; command-line tools suffice |
| **Git** | Latest | For repository cloning and version control |

### Clone and Install Dependencies

```bash
# 1. Clone the repository
git clone https://github.com/helplessThor/Konvoy.git
cd Konvoy

# 2. Install JavaScript dependencies
npm install

# 3. Verify TypeScript type safety
npx tsc --noEmit

# 4. Run automated unit test suite (67 tests)
npm test
```

---

## 3. Building Without Android Studio (CLI Only)

You do **not** need Android Studio installed to build the APK. You can build directly using Gradle and Android Command-Line Tools:

### Set Up Android SDK Path
Ensure `local.properties` exists inside the `android/` directory:

```properties
# Windows example:
sdk.dir=C:\\Users\\<YourUsername>\\AppData\\Local\\Android\\Sdk

# macOS / Linux example:
sdk.dir=/Users/<YourUsername>/Library/Android/sdk
```

### Build APK via Gradle

```bash
# Navigate to the android directory
cd android

# Build Debug APK
./gradlew assembleDebug

# OR Build Release APK
./gradlew assembleRelease
```

The compiled APK will be located at:
- **Debug**: `android/app/build/outputs/apk/debug/app-debug.apk`
- **Release**: `android/app/build/outputs/apk/release/app-release.apk`

### Install to Connected Device via ADB

Connect your phone with USB debugging enabled:

```bash
# Check device is detected
adb devices

# Install APK to device
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

---

## 4. Running the Development Server

If you are developing or live-debugging with Fast Refresh:

```bash
# Terminal 1: Start Metro bundler
npm start

# Terminal 2: Launch Android application
npm run android
```

---

## 5. First-Time Phone Permissions

When launching Konvoy for the first time, Android will request the following runtime permissions:

1. **Location (Precise / Always Allow)**: Required for high-accuracy GPS telemetry, rider speedometer, and Wi-Fi Direct peer discovery.
2. **Microphone**: Required for voice capture during Push-to-Talk (PTT) and Hands-Free VOX intercom.
3. **Nearby Devices (Bluetooth)**: Required for BLE beacon discovery and Bluetooth handlebar media button remotes.
4. **Notifications**: Required for the Android foreground service so communication stays active when your screen is locked.
5. **Battery Optimization (Don't optimize)**: Whitelist Konvoy in your phone's battery settings so Android's Doze mode does not suspend radio listeners while riding.

---

## 6. How to Use on a Group Ride

### Connecting Two or More Riders (Off-Grid)
1. **Turn on Wi-Fi and Bluetooth** on all phones (you do **not** need to connect to any Wi-Fi hotspot or router).
2. Open **Konvoy** on all phones.
3. Both riders will automatically discover each other over BLE beacons and negotiate a direct Wi-Fi Direct high-throughput voice link within seconds.
4. The **Riders Counter** in the top HUD will increment (e.g. `2 IN GROUP`), and fellow riders appear on the map and radar.

### Voice Intercom Usage
- **Push to Talk (Default)**: Press and hold the massive orange center button on the **Intercom** tab while speaking. Release when finished.
- **Hands-Free (VOX) / Tap to Talk**:
  - Tap the **VOX / Hands-Free** pill in the top banner (or enable *PTT Button Mode: Toggle* in Settings).
  - The button turns to **`TAP TO TALK`**.
  - Tap once to talk hands-free; tap again when finished.

### Dropping Hazard Alerts
- When riding, tap the big **⚠️ REPORT HAZARD** button or one of the quick tiles:
  - 🚔 **POLICE**: Speed trap or checkpoint ahead.
  - 💥 **CRASH**: Collision blocking the road.
  - ⚠️ **ROAD DEBRIS**: Gravel, oil slick, potholes, or fallen debris.
  - 🚗 **TRAFFIC JAM**: Sudden highway or canyon stoppage.
- The pin is gossiped bike-to-bike across all riders within range and pinned to everyone's Google Map in real time.
- To clear a hazard when the obstacle is gone, tap the pin and select **Hazard Cleared**.

### Map Customization
- In the **Map** tab, tap the top style controls to toggle between:
  - **`ROAD`**: Crisp Google Maps road network.
  - **`SATELLITE`**: High-contrast Google Hybrid satellite view.
  - **`DARK`**: Tactical dark cockpit mode.

---

## 7. Handlebar Bluetooth Remote Setup

Konvoy natively listens for Bluetooth HID media buttons (such as Cardo/Sena handlebar remotes or standard Bluetooth volume/play buttons):

1. Pair your Bluetooth remote with your phone in Android Bluetooth Settings.
2. In Konvoy, go to **Settings** → **Handlebar PTT Remote**.
3. Press the button on your handlebar:
   - In Hold-to-Talk mode: Holding down transmits; releasing stops.
   - In Tap-to-Talk / VOX mode: Pressing toggles speech on and off.
   - A vibration confirms the button press in your glove.

---

## 8. Troubleshooting

- **GPS Not Centering**: If you are testing indoors, satellite reception may be weak. Konvoy has a balanced accuracy fallback, but for best results, test outdoors under open sky.
- **Map Appears Blank**: Verify your phone has internet connection when first loading tiles, or switch between **ROAD** and **SATELLITE** in the HUD controls. Once cached, tiles remain available offline.
- **Microphone Echo**: In **Settings**, ensure **Motorcycle Noise Gate** is turned ON. This suppresses wind noise and exhaust drone.
