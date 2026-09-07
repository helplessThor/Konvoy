/**
 * Konvoy Sliding-Window Bloom Filter
 *
 * Used for epidemic routing deduplication. Drops packets we've already seen
 * to prevent broadcast storm loops in the mesh.
 *
 * Configuration:
 *   - Capacity: 10,000 entries
 *   - 3 independent hash functions (FNV-1a variants with different seeds)
 *   - False positive rate: ~1.4% at capacity
 *   - Memory: ~12KB (98,304 bits = 12,288 bytes)
 *   - Window rotation: every 60 seconds (configurable)
 *
 * Dual-buffer strategy: We maintain two Bloom filter generations.
 * On rotation, the "old" generation is discarded and replaced by the current
 * one, and a fresh generation becomes current. Lookups check both generations
 * to avoid false negatives at the boundary.
 */

const DEFAULT_CAPACITY = 10_000;
const DEFAULT_HASH_COUNT = 3;
// Optimal bit count: m = -(n * ln(p)) / (ln(2))^2
// For n=10000, p=0.01 => m ≈ 95850 → round to 98304 (12KB aligned)
const DEFAULT_BIT_COUNT = 98_304;
const DEFAULT_ROTATION_INTERVAL_MS = 60_000;

/**
 * FNV-1a hash with a seed offset, producing a 32-bit integer.
 * We use different seeds to create independent hash functions.
 */
function fnv1aSeeded(data: Uint8Array, seed: number): number {
  let hash = (0x811c9dc5 + seed) >>> 0;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i]!;
    // FNV prime: 0x01000193
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export class SlidingBloomFilter {
  private readonly bitCount: number;
  private readonly hashCount: number;
  private readonly rotationIntervalMs: number;

  // Dual-buffer: current and previous generation
  private current: Uint32Array;
  private previous: Uint32Array;
  private currentCount: number = 0;
  private lastRotationTime: number;

  // Hash seeds for independent hash functions
  private readonly seeds: number[];

  constructor(
    bitCount: number = DEFAULT_BIT_COUNT,
    hashCount: number = DEFAULT_HASH_COUNT,
    rotationIntervalMs: number = DEFAULT_ROTATION_INTERVAL_MS,
  ) {
    this.bitCount = bitCount;
    this.hashCount = hashCount;
    this.rotationIntervalMs = rotationIntervalMs;

    // Use Uint32Array for efficient bit manipulation
    const arraySize = Math.ceil(bitCount / 32);
    this.current = new Uint32Array(arraySize);
    this.previous = new Uint32Array(arraySize);
    this.lastRotationTime = Date.now();

    // Generate deterministic seeds
    this.seeds = [];
    for (let i = 0; i < hashCount; i++) {
      this.seeds.push(i * 0x9e3779b9); // Golden ratio multiples
    }
  }

  /**
   * Compute the bit positions for a given key using k hash functions.
   */
  private getBitPositions(key: Uint8Array): number[] {
    const positions: number[] = [];
    for (let i = 0; i < this.hashCount; i++) {
      const hash = fnv1aSeeded(key, this.seeds[i]!);
      positions.push(hash % this.bitCount);
    }
    return positions;
  }

  /**
   * Set a bit in the given filter array.
   */
  private setBit(filter: Uint32Array, position: number): void {
    const wordIndex = (position >>> 5); // position / 32
    const bitIndex = position & 0x1f;   // position % 32
    filter[wordIndex]! |= (1 << bitIndex);
  }

  /**
   * Check if a bit is set in the given filter array.
   */
  private testBit(filter: Uint32Array, position: number): boolean {
    const wordIndex = (position >>> 5);
    const bitIndex = position & 0x1f;
    return (filter[wordIndex]! & (1 << bitIndex)) !== 0;
  }

  /**
   * Check if it's time to rotate and do so if needed.
   */
  private maybeRotate(): void {
    const now = Date.now();
    if (now - this.lastRotationTime >= this.rotationIntervalMs) {
      this.rotate();
    }
  }

  /**
   * Rotate the filter: current becomes previous, new empty filter becomes current.
   */
  private rotate(): void {
    // Swap: previous = current, current = new empty
    this.previous = this.current;
    this.current = new Uint32Array(Math.ceil(this.bitCount / 32));
    this.currentCount = 0;
    this.lastRotationTime = Date.now();
  }

  /**
   * Insert a packet ID into the filter.
   * @param packetId - The 8-byte packet ID from the wire header.
   */
  insert(packetId: Uint8Array): void {
    this.maybeRotate();

    const positions = this.getBitPositions(packetId);
    for (const pos of positions) {
      this.setBit(this.current, pos);
    }
    this.currentCount++;

    // Force rotation if we exceed capacity to maintain FP rate
    if (this.currentCount >= DEFAULT_CAPACITY) {
      this.rotate();
    }
  }

  /**
   * Check if a packet ID might have been seen before.
   * Returns true if the packet is likely a duplicate (may have false positives).
   * Returns false if the packet is definitely new (no false negatives).
   */
  mightContain(packetId: Uint8Array): boolean {
    this.maybeRotate();

    const positions = this.getBitPositions(packetId);

    // Check current generation
    let inCurrent = true;
    for (const pos of positions) {
      if (!this.testBit(this.current, pos)) {
        inCurrent = false;
        break;
      }
    }
    if (inCurrent) return true;

    // Check previous generation
    let inPrevious = true;
    for (const pos of positions) {
      if (!this.testBit(this.previous, pos)) {
        inPrevious = false;
        break;
      }
    }
    return inPrevious;
  }

  /**
   * Reset both generations (full clear).
   */
  clear(): void {
    this.current.fill(0);
    this.previous.fill(0);
    this.currentCount = 0;
    this.lastRotationTime = Date.now();
  }

  /**
   * Get diagnostic info for debugging / tests.
   */
  getStats(): { currentCount: number; bitCount: number; memoryBytes: number } {
    const arraySize = Math.ceil(this.bitCount / 32);
    return {
      currentCount: this.currentCount,
      bitCount: this.bitCount,
      memoryBytes: arraySize * 4 * 2, // Two Uint32Arrays
    };
  }
}
