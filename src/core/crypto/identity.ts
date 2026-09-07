/**
 * Konvoy Session Identity Manager
 *
 * Generates and manages ephemeral Ed25519 + X25519 key pairs per session.
 * Keys are stored in encrypted MMKV and purged on session reset or app
 * termination.
 *
 * All cryptographic operations delegate to the native TurboModule
 * (NativeCryptoModule) for real hardware-backed key generation.
 *
 * Identity flow:
 *   1. App launch → check MMKV for existing session keys
 *   2. If none → generate new Ed25519 + X25519 key pairs
 *   3. Derive 16-byte fingerprint: BLAKE3(ed25519_pk)[:16]
 *   4. Expose via Zustand store for UI and core subsystems
 */

import { create } from 'zustand';

// ─── Types ───────────────────────────────────────────────────────────────

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface SessionIdentity {
  /** Ed25519 signing key pair */
  signingKeyPair: KeyPair;
  /** X25519 ECDH key pair for key agreement */
  encryptionKeyPair: KeyPair;
  /** 16-byte BLAKE3(ed25519_pk)[:16] — our mesh identity */
  fingerprint: Uint8Array;
  /** Hex-encoded fingerprint for display / map keys */
  fingerprintHex: string;
  /** Session creation timestamp (Unix ms) */
  createdAt: number;
}

export interface IdentityState {
  /** Current session identity, null until initialized */
  identity: SessionIdentity | null;
  /** Whether identity generation is in progress */
  isInitializing: boolean;
  /** Last error during initialization */
  error: string | null;

  /** Initialize identity — loads from storage or generates new */
  initialize: () => Promise<void>;
  /** Force reset — purges keys and generates new identity */
  resetIdentity: () => Promise<void>;
  /** Get the fingerprint as Uint8Array (convenience) */
  getFingerprint: () => Uint8Array | null;
}

// ─── Utilities ───────────────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

// ─── Native Crypto Interface ─────────────────────────────────────────────

/**
 * Interface for the native crypto TurboModule.
 * This will be satisfied by the actual NativeCryptoModule at runtime.
 * During tests, a conforming implementation must be injected.
 */
export interface ICryptoModule {
  generateEd25519KeyPair(): { publicKey: ArrayBuffer; secretKey: ArrayBuffer };
  generateX25519KeyPair(): { publicKey: ArrayBuffer; secretKey: ArrayBuffer };
  blake3(data: ArrayBuffer, outputLen: number): ArrayBuffer;
  sign(message: ArrayBuffer, secretKey: ArrayBuffer): ArrayBuffer;
  verify(message: ArrayBuffer, signature: ArrayBuffer, publicKey: ArrayBuffer): boolean;
  sharedSecret(mySecretKey: ArrayBuffer, theirPublicKey: ArrayBuffer): ArrayBuffer;
}

/**
 * Interface for encrypted key storage.
 * Backed by MMKV at runtime.
 */
export interface IKeyStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  contains(key: string): boolean;
}

// Storage keys
const STORAGE_KEYS = {
  ED25519_PK: 'konvoy.identity.ed25519.pk',
  ED25519_SK: 'konvoy.identity.ed25519.sk',
  X25519_PK: 'konvoy.identity.x25519.pk',
  X25519_SK: 'konvoy.identity.x25519.sk',
  FINGERPRINT: 'konvoy.identity.fingerprint',
  CREATED_AT: 'konvoy.identity.createdAt',
} as const;

// ─── Module References (set at app startup) ──────────────────────────────

let _cryptoModule: ICryptoModule | null = null;
let _keyStorage: IKeyStorage | null = null;

/**
 * Inject the native crypto module and storage implementation.
 * Must be called before `useIdentityStore.getState().initialize()`.
 */
export function configureCryptoBackend(
  cryptoModule: ICryptoModule,
  keyStorage: IKeyStorage,
): void {
  _cryptoModule = cryptoModule;
  _keyStorage = keyStorage;
}

// ─── Core Identity Logic ─────────────────────────────────────────────────

function loadFromStorage(): SessionIdentity | null {
  if (!_keyStorage) throw new Error('Key storage not configured');

  if (!_keyStorage.contains(STORAGE_KEYS.ED25519_PK)) {
    return null;
  }

  try {
    const ed25519Pk = fromHex(_keyStorage.getString(STORAGE_KEYS.ED25519_PK)!);
    const ed25519Sk = fromHex(_keyStorage.getString(STORAGE_KEYS.ED25519_SK)!);
    const x25519Pk = fromHex(_keyStorage.getString(STORAGE_KEYS.X25519_PK)!);
    const x25519Sk = fromHex(_keyStorage.getString(STORAGE_KEYS.X25519_SK)!);
    const fingerprintHex = _keyStorage.getString(STORAGE_KEYS.FINGERPRINT)!;
    const createdAt = parseInt(_keyStorage.getString(STORAGE_KEYS.CREATED_AT)!, 10);

    return {
      signingKeyPair: { publicKey: ed25519Pk, secretKey: ed25519Sk },
      encryptionKeyPair: { publicKey: x25519Pk, secretKey: x25519Sk },
      fingerprint: fromHex(fingerprintHex),
      fingerprintHex,
      createdAt,
    };
  } catch {
    // Corrupted storage — will regenerate
    return null;
  }
}

function generateNewIdentity(): SessionIdentity {
  if (!_cryptoModule) throw new Error('Crypto module not configured');

  // Generate key pairs via native module
  const ed25519 = _cryptoModule.generateEd25519KeyPair();
  const x25519 = _cryptoModule.generateX25519KeyPair();

  // Derive fingerprint: BLAKE3(ed25519_pk)[:16]
  const fullHash = _cryptoModule.blake3(ed25519.publicKey, 16);
  const fingerprint = new Uint8Array(fullHash);

  const identity: SessionIdentity = {
    signingKeyPair: {
      publicKey: new Uint8Array(ed25519.publicKey),
      secretKey: new Uint8Array(ed25519.secretKey),
    },
    encryptionKeyPair: {
      publicKey: new Uint8Array(x25519.publicKey),
      secretKey: new Uint8Array(x25519.secretKey),
    },
    fingerprint,
    fingerprintHex: toHex(fingerprint),
    createdAt: Date.now(),
  };

  return identity;
}

function saveToStorage(identity: SessionIdentity): void {
  if (!_keyStorage) throw new Error('Key storage not configured');

  _keyStorage.set(STORAGE_KEYS.ED25519_PK, toHex(identity.signingKeyPair.publicKey));
  _keyStorage.set(STORAGE_KEYS.ED25519_SK, toHex(identity.signingKeyPair.secretKey));
  _keyStorage.set(STORAGE_KEYS.X25519_PK, toHex(identity.encryptionKeyPair.publicKey));
  _keyStorage.set(STORAGE_KEYS.X25519_SK, toHex(identity.encryptionKeyPair.secretKey));
  _keyStorage.set(STORAGE_KEYS.FINGERPRINT, identity.fingerprintHex);
  _keyStorage.set(STORAGE_KEYS.CREATED_AT, identity.createdAt.toString());
}

function purgeStorage(): void {
  if (!_keyStorage) return;
  Object.values(STORAGE_KEYS).forEach((key) => _keyStorage!.delete(key));
}

// ─── Zustand Store ───────────────────────────────────────────────────────

export const useIdentityStore = create<IdentityState>((set, get) => ({
  identity: null,
  isInitializing: false,
  error: null,

  initialize: async () => {
    if (get().identity || get().isInitializing) return;

    set({ isInitializing: true, error: null });

    try {
      // Try loading existing session
      let identity = loadFromStorage();

      if (!identity) {
        // Generate fresh identity
        identity = generateNewIdentity();
        saveToStorage(identity);
      }

      set({ identity, isInitializing: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error during identity init';
      set({ error: message, isInitializing: false });
    }
  },

  resetIdentity: async () => {
    set({ isInitializing: true, error: null });

    try {
      purgeStorage();
      const identity = generateNewIdentity();
      saveToStorage(identity);
      set({ identity, isInitializing: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error during identity reset';
      set({ error: message, isInitializing: false });
    }
  },

  getFingerprint: () => {
    return get().identity?.fingerprint ?? null;
  },
}));
