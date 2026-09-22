import { describe, test, expect } from 'vitest';
import { placeholderMerkleRoot } from '../src/api/contract.js';

describe('placeholderMerkleRoot', () => {
  test('produces a deterministic 32-byte hash for the same input', () => {
    const a = placeholderMerkleRoot('water damage in kitchen');
    const b = placeholderMerkleRoot('water damage in kitchen');
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('produces different hashes for different descriptions', () => {
    const a = placeholderMerkleRoot('water damage');
    const b = placeholderMerkleRoot('fire damage');
    expect(a).not.toBe(b);
  });

  test('falls back to a fixed placeholder string when description is empty', () => {
    const empty = placeholderMerkleRoot('');
    const undefinedInput = placeholderMerkleRoot(undefined);
    expect(empty).toBe(undefinedInput);
  });
});
