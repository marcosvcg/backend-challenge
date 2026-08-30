import { describe, expect, it } from 'bun:test';
import { canonicalPayloadHash } from './canonical-payload-hash';

describe('canonicalPayloadHash', () => {
  it('produces the same hash regardless of key order', () => {
    const a = canonicalPayloadHash({ kind: 'BET', amount: '10.00', walletId: 'w1' });
    const b = canonicalPayloadHash({ walletId: 'w1', kind: 'BET', amount: '10.00' });
    expect(a).toBe(b);
  });

  it('produces different hashes for different values', () => {
    const a = canonicalPayloadHash({ amount: '10.00' });
    const b = canonicalPayloadHash({ amount: '20.00' });
    expect(a).not.toBe(b);
  });

  it('is stable across nested objects regardless of key order', () => {
    const a = canonicalPayloadHash({ outer: { z: 1, a: 2 } });
    const b = canonicalPayloadHash({ outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it('produces a 64-character hex string (SHA-256)', () => {
    const hash = canonicalPayloadHash({ x: 1 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('distinguishes arrays from objects with equivalent-looking content', () => {
    const a = canonicalPayloadHash({ list: [1, 2, 3] });
    const b = canonicalPayloadHash({ list: { '0': 1, '1': 2, '2': 3 } });
    expect(a).not.toBe(b);
  });
});
