# Konvoy — Technical Implementation Guide 📐

This document provides a deep technical specification of the algorithms, protocols, cryptographic systems, and native mobile architecture powering the Konvoy platform.

---

## 1. Cryptographic Identity & Ephemeral Security

Konvoy is designed with a **Zero-Knowledge, Air-Gapped** trust model. No user accounts, telephone numbers, emails, or hardware identifiers (IMEI/MAC) are ever transmitted over the air.

```
┌────────────────────────────────────────────────────────┐
│               Session Keypair Generation               │
│                                                        │
│  Ed25519 Keypair (Signing)   X25519 Keypair (ECDH)    │
│  [Pub: 32B | Priv: 32B]      [Pub: 32B | Priv: 32B]   │
│               │                                        │
│               ▼                                        │
│      BLAKE3(ed25519_pubkey)                           │
│               │                                        │
│               ▼                                        │
│     First 16 Bytes = Node Fingerprint (Mesh ID)        │
└────────────────────────────────────────────────────────┘
```

### Key Generation Pipeline
1. On session creation, `@noble/curves/ed25519` generates a cryptographically secure random 32-byte seed.
2. An **Ed25519** signature keypair is derived for packet authentication and tamper-proofing.
3. An **X25519** Diffie-Hellman keypair is generated for direct peer-to-peer payload encryption.
4. The 16-byte node fingerprint is derived:
   $$\text{Fingerprint} = \text{BLAKE3}(\text{Ed25519 PublicKey})[0..16]$$
5. Keys are held in volatile memory and backed by encrypted local MMKV (`konvoy.ephemeral.keys`).
6. **Burn Identity**: Triggering "Burn Session Identity" immediately purges all keys from RAM and MMKV, generating a new identity in $< 5\text{ms}$.

---

## 2. Wire Protocol Framing & Packet Structure

All peer-to-peer data packets conform to a compact binary framing format with strict alignment to minimize radio overhead on low-power links.

### Packet Header (32 Bytes Total)

| Offset (Bytes) | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0..1` | `magic` | `uint16_t` | Constant `0x4B56` (`"KV"`) |
| `2` | `version` | `uint8_t` | Protocol version (`0x01`) |
| `3` | `type` | `uint8_t` | Packet type enum (`0x01`–`0x06`) |
| `4` | `ttl` | `uint8_t` | Time-to-Live hop counter (default: 3) |
| `5` | `flags` | `uint8_t` | Bitflags (e.g. urgent, encrypted, ack-req) |
| `6..7` | `sequenceNumber` | `uint16_t` | Monotonic sender frame counter |
| `8..11` | `packetId` | `uint32_t` | Unique per-packet pseudorandom ID |
| `12..19` | `channelToken` | `uint8_t[8]` | 8-byte channel identifier (`ALL` / private) |
| `20..35` | `senderFingerprint`| `uint8_t[16]` | 16-byte sender BLAKE3 identity fingerprint |
| `36..37` | `payloadSize` | `uint16_t` | Length of payload in bytes |
| `38..41` | `checksum` | `uint32_t` | CRC32 checksum of header + payload |

### Packet Types
- `0x01 - DiscoveryAnnouncement`: Broadcast on BLE and Wi-Fi Direct with battery level, radio capabilities, and rider callsign.
- `0x02 - VoiceFrame`: 20ms Opus-compressed voice audio frame.
- `0x03 - TelemetryPosition`: GPS coordinates, speed, heading, altitude, and timestamp.
- `0x04 - HazardPinSync`: CRDT OR-Set hazard pin drop, clear, or anti-entropy sync.
- `0x05 - RouteVector`: Convoy breadcrumbs and waypoint routes.
- `0x06 - Ack`: Reliable delivery confirmation for critical hazard pins.

---

## 3. Dual-Radio Mesh Architecture

Konvoy employs a tiered radio strategy:

```
                  ┌──────────────────────┐
                  │    Konvoy App Node   │
                  └──────────┬───────────┘
                             │
            ┌────────────────┴────────────────┐
            ▼                                 ▼
   ┌─────────────────┐               ┌─────────────────┐
   │    BLE 5.0      │               │  Wi-Fi Direct   │
   │  Low-Power Mesh │               │ High-Throughput │
   │  (Beacon & Ping)│               │  (Voice & Map)  │
   └────────┬────────┘               └────────┬────────┘
            │ 0–50 meters                     │ 0–200 meters
            ▼                                 ▼
   ┌─────────────────┐               ┌─────────────────┐
   │ Nearby Rider B  │               │ Nearby Rider C  │
   └─────────────────┘               └─────────────────┘
```

### 1. BLE 5.0 (Discovery & Beacons)
- Periodically advertises encrypted 20-byte service data under UUID `6b6f6e76-6f79-4d65-7368-000000000001`.
- Fast background scan detects peer presence even when phones are pocketed and screens are locked.

### 2. Wi-Fi Direct (High-Throughput Transport)
- Uses Android `WifiP2pManager` with DNS-SD (`_konvoy._mesh._tcp`).
- Negotiates autonomous group formation with dynamic group owner (GO) election based on battery and signal strength.
- Opens persistent TCP socket pool on ports `18500..18600` for low-latency full-duplex voice streams.

### 3. Loop Prevention & Deduplication
- Every node maintains a rolling **Bloom Filter** with $k=3$ hash functions and 256-bit bitset to record recently observed `packetId` values.
- Duplicate packets are dropped in $O(1)$ time.
- Packets with $\text{TTL} > 1$ are decremented and re-broadcast across alternate radio interfaces.

---

## 4. CRDT OR-Set Hazard Gossip Engine

To ensure hazard pins (police traps, accidents, debris) converge across the group without a central server, Konvoy implements a **Conflict-Free Replicated Data Type (CRDT) Observed-Remove Set (OR-Set)**.

### Mathematical Invariants
An element $e$ (hazard pin) in an OR-Set is defined as:
$$e = (\text{PinID}, \text{Type}, \text{Lat}, \text{Lng}, \text{CreatedAt}, \text{TTL}, \text{VectorClock})$$

- **Add Set ($A$)**: Contains pairs $(e, t)$ where $t$ is a unique tag generated by the creator:
  $$t = \text{BLAKE3}(\text{Fingerprint} \parallel \text{Timestamp} \parallel \text{Nonce})$$
- **Remove Set ($R$)**: Contains tags $t$ that have been cleared by any group member.
- **Visible Hazards**:
  $$\text{Visible} = \{ e \mid \exists t : (e, t) \in A \land t \notin R \}$$

### Concurrency Resolution
If Rider A drops a hazard pin while Rider B clears it, the tombstone in $R$ takes precedence as long as $t \in R$, ensuring monotonic convergence across all bikes regardless of arrival order.

---

## 5. Audio DSP Pipeline & Intercom Ergonomics

```
[Phone Mic / Bluetooth Headset]
             │
             ▼ 16kHz PCM (16-bit Mono)
[Motorcycle Noise Gate] ─── Suppresses wind & exhaust roar (< -40 dB)
             │
             ▼
[Voice Activity Detector (VAD)] ─── Analyzes energy against threshold
             │
      ┌──────┴──────┐
      │ Mode Check  │
      └──────┬──────┘
             ├─ Push to Talk (Hold): Active while pressed
             └─ Hands-Free (VOX / Tap): Toggled on/off by tap or VAD
             │
             ▼
[libopus Encoder] ─── 20ms frames @ 12 kbps (or 8/16 kbps)
             │
             ▼
[Wire Protocol Packetizer] ─── Encapsulates in PacketType.Voice
             │
             ▼
[Wi-Fi Direct TCP Stream] ─── Transmitted to convoy peers
```

### Jitter Buffer & Playback
- Receiving peers buffer packets in an adaptive priority queue sorted by `sequenceNumber`.
- Min buffer depth: **40ms**; Max buffer depth: **100ms**.
- Missing frames are concealed using Opus packet loss concealment (PLC), avoiding audio clicks.

---

## 6. Cartography & Google Maps Integration

### Why Google Maps Raster Tiles?
OpenStreetMap vector styles require downloading remote PBF geometries and font glyphs (`.pbf`). When network connectivity is intermittent on a motorcycle, vector parsers frequently stall, leading to white/blank screens.

Konvoy directly sources official Google Maps raster tiles:
- **`GOOGLE_ROAD`**: `https://mt{0-3}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}`
- **`GOOGLE_HYBRID`**: `https://mt{0-3}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}`
- **`GOOGLE_TERRAIN`**: `https://mt{0-3}.google.com/vt/lyrs=p&x={x}&y={y}&z={z}`
- **`DARK`**: High-contrast Carto Dark tiles for tactical night cockpits.

### Tactical Radar Coordinate Projection
The 100m cockpit radar projects peer coordinates relative to your bike's GPS heading:

1. **Haversine Distance**:
   $$d = 2R \arcsin\left(\sqrt{\sin^2\left(\frac{\Delta\phi}{2}\right) + \cos\phi_1\cos\phi_2\sin^2\left(\frac{\Delta\lambda}{2}\right)}\right)$$
2. **True Bearing**:
   $$\theta = \operatorname{atan2}\left(\sin\Delta\lambda\cos\phi_2, \; \cos\phi_1\sin\phi_2 - \sin\phi_1\cos\phi_2\cos\Delta\lambda\right)$$
3. **Radar Transformation**:
   $$\text{Relative Angle} = (\theta - \text{Heading} + 360) \pmod{360}$$
   $$x = r \sin(\text{Relative Angle}), \quad y = -r \cos(\text{Relative Angle})$$

---

## 7. Android Foreground Service & Native Battery Telemetry

### Persistent Background Execution
- `KonvoyForegroundService.kt` launches as an Android `startForegroundService` with dual types:
  - `FOREGROUND_SERVICE_MICROPHONE`: Keeps audio input capture active while riding.
  - `FOREGROUND_SERVICE_LOCATION`: Maintains GPS satellite acquisition with screen locked.
- Holds a `PARTIAL_WAKE_LOCK` with `PowerManager` to prevent Android Doze mode from halting the radio thread.

### Battery Telemetry
- Queried natively via `BatteryManager`:
  ```kotlin
  val bm = reactApplicationContext.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
  val level = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
  ```
- Propagated through `BatteryService.ts` to update your bike's HUD with actual percentage.
- Broadcast in `DiscoveryAnnouncement` packets so fellow riders can monitor convoy battery levels without mock data.
