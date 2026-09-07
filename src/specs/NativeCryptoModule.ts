/**
 * NativeCryptoModule — TurboModule Spec
 *
 * Exposes real cryptographic operations (Ed25519, X25519, BLAKE3)
 * via JSI to the TypeScript layer. All operations are synchronous
 * for minimal latency.
 *
 * Implementation: C++ shared core linked via CMake (Android NDK)
 * and Xcode (iOS), backed by OpenSSL/libsodium.
 */

import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /**
   * Generate an ephemeral Ed25519 signing key pair.
   * Returns { publicKey: 32 bytes, secretKey: 64 bytes }.
   */
  generateEd25519KeyPair(): {
    publicKey: string; // base64-encoded
    secretKey: string; // base64-encoded
  };

  /**
   * Generate an ephemeral X25519 ECDH key pair.
   * Returns { publicKey: 32 bytes, secretKey: 32 bytes }.
   */
  generateX25519KeyPair(): {
    publicKey: string; // base64-encoded
    secretKey: string; // base64-encoded
  };

  /**
   * Sign a message with Ed25519.
   * @param messageBase64 - The message to sign (base64).
   * @param secretKeyBase64 - The 64-byte Ed25519 secret key (base64).
   * @returns 64-byte signature (base64).
   */
  sign(messageBase64: string, secretKeyBase64: string): string;

  /**
   * Verify an Ed25519 signature.
   * @returns true if the signature is valid.
   */
  verify(
    messageBase64: string,
    signatureBase64: string,
    publicKeyBase64: string,
  ): boolean;

  /**
   * Compute an X25519 shared secret.
   * @param mySecretKeyBase64 - Our X25519 secret key (base64).
   * @param theirPublicKeyBase64 - Peer's X25519 public key (base64).
   * @returns 32-byte shared secret (base64).
   */
  sharedSecret(
    mySecretKeyBase64: string,
    theirPublicKeyBase64: string,
  ): string;

  /**
   * Compute BLAKE3 hash.
   * @param dataBase64 - Input data (base64).
   * @param outputLen - Desired output length in bytes.
   * @returns Hash output (base64).
   */
  blake3(dataBase64: string, outputLen: number): string;

  /**
   * Encrypt with XSalsa20-Poly1305 (NaCl secretbox).
   * @param plaintextBase64 - Plaintext data (base64).
   * @param keyBase64 - 32-byte symmetric key (base64).
   * @returns { ciphertext, nonce } both base64-encoded.
   */
  encrypt(
    plaintextBase64: string,
    keyBase64: string,
  ): { ciphertext: string; nonce: string };

  /**
   * Decrypt with XSalsa20-Poly1305 (NaCl secretbox).
   * @returns Decrypted plaintext (base64), or empty string on failure.
   */
  decrypt(
    ciphertextBase64: string,
    nonceBase64: string,
    keyBase64: string,
  ): string;
}

export default TurboModuleRegistry.getEnforcing<Spec>('KonvoyCrypto');
