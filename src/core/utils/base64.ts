/**
 * Base64 Utilities
 *
 * Fast, pure-JavaScript Base64 encoder/decoder for Uint8Array and ArrayBuffer.
 * Safe across all JS engines (Hermes, V8, JavaScriptCore, Node.js).
 */

const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const lookup = new Uint8Array(256);
for (let i = 0; i < chars.length; i++) {
  lookup[chars.charCodeAt(i)] = i;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let base64 = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < len ? bytes[i + 1]! : 0;
    const b2 = i + 2 < len ? bytes[i + 2]! : 0;

    base64 += chars[b0 >> 2];
    base64 += chars[((b0 & 3) << 4) | (b1 >> 4)];
    base64 += i + 1 < len ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    base64 += i + 2 < len ? chars[b2 & 63] : '=';
  }
  return base64;
}

export function base64ToUint8Array(base64: string): Uint8Array {
  let bufferLength = base64.length * 0.75;
  const len = base64.length;
  if (base64[len - 1] === '=') {
    bufferLength--;
    if (base64[len - 2] === '=') {
      bufferLength--;
    }
  }

  const bytes = new Uint8Array(bufferLength);
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const encoded1 = lookup[base64.charCodeAt(i)]!;
    const encoded2 = lookup[base64.charCodeAt(i + 1)]!;
    const encoded3 = lookup[base64.charCodeAt(i + 2)]!;
    const encoded4 = lookup[base64.charCodeAt(i + 3)]!;

    bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
    if (base64[i + 2] !== '=') {
      bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
    }
    if (base64[i + 3] !== '=') {
      bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
    }
  }

  return bytes;
}
