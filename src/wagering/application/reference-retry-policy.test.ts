import { describe, expect, it } from 'bun:test';
import { nextReferenceRetryDelayMs, type ReferenceRetryPolicy } from './reference-retry-policy';

const POLICY: ReferenceRetryPolicy = { baseDelayMs: 30_000, maxDelayMs: 15 * 60_000, maxAttempts: 5 };

describe('nextReferenceRetryDelayMs — exponential backoff with cap', () => {
  it('doubles the delay on each attempt', () => {
    expect(nextReferenceRetryDelayMs(POLICY, 1)).toBe(30_000);
    expect(nextReferenceRetryDelayMs(POLICY, 2)).toBe(60_000);
    expect(nextReferenceRetryDelayMs(POLICY, 3)).toBe(120_000);
    expect(nextReferenceRetryDelayMs(POLICY, 4)).toBe(240_000);
    expect(nextReferenceRetryDelayMs(POLICY, 5)).toBe(480_000);
  });

  it('caps at maxDelayMs once the exponential exceeds it', () => {
    expect(nextReferenceRetryDelayMs(POLICY, 6)).toBe(15 * 60_000); // would be 960_000, capped at 900_000
    expect(nextReferenceRetryDelayMs(POLICY, 10)).toBe(15 * 60_000);
  });
});
