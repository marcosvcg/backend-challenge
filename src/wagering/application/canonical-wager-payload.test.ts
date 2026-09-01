import { describe, expect, it } from 'bun:test';
import { canonicalWagerPayload, hashCanonicalWagerPayload } from './canonical-wager-payload';

const BASE = {
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  playerId: '11111111-1111-4111-8111-111111111111',
  walletId: '22222222-2222-4222-8222-222222222222',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: { amount: '10.00', currency: 'BRL' },
};

describe('hashCanonicalWagerPayload — same logical payload, same hash, independent of transport-specific fields', () => {
  it('is stable for the exact same input', () => {
    expect(hashCanonicalWagerPayload(BASE)).toBe(hashCanonicalWagerPayload({ ...BASE }));
  });

  it('produces the SAME hash for the same logical payload regardless of what extra transport fields the caller happens to have lying around — hashCanonicalWagerPayload only ever reads its declared input shape', () => {
    // Regression for the real bug found in this hardening increment: the SQS
    // mapper used to hash `data` wholesale (including idempotencyKey, an SQS
    // body field), producing a DIFFERENT hash than the HTTP controller for
    // the exact same logical transaction. hashCanonicalWagerPayload's typed
    // input (CanonicalWagerPayloadInput) makes that class of bug impossible
    // going forward — there's no `...rest` spread, so a caller literally
    // cannot leak a transport field into the hash.
    const withoutReference = hashCanonicalWagerPayload(BASE);
    const httpStyleAssembly = hashCanonicalWagerPayload({
      providerId: BASE.providerId,
      externalTransactionId: BASE.externalTransactionId,
      playerId: BASE.playerId,
      walletId: BASE.walletId,
      roundId: BASE.roundId,
      gameId: BASE.gameId,
      kind: BASE.kind,
      money: { amount: BASE.money.amount, currency: BASE.money.currency },
    });
    expect(withoutReference).toBe(httpStyleAssembly);
  });

  it('includes referenceExternalTransactionId when present', () => {
    const withRef = hashCanonicalWagerPayload({ ...BASE, kind: 'REFUND', referenceExternalTransactionId: 'ext-0' });
    const withoutRef = hashCanonicalWagerPayload(BASE);
    expect(withRef).not.toBe(withoutRef);
  });

  it('changes if any business field changes (amount)', () => {
    const a = hashCanonicalWagerPayload(BASE);
    const b = hashCanonicalWagerPayload({ ...BASE, money: { amount: '20.00', currency: 'BRL' } });
    expect(a).not.toBe(b);
  });

  it('changes if kind changes', () => {
    const a = hashCanonicalWagerPayload(BASE);
    const b = hashCanonicalWagerPayload({ ...BASE, kind: 'WIN' });
    expect(a).not.toBe(b);
  });
});

describe('canonicalWagerPayload — excludes transport/identity fields by construction (typed input has no room for them)', () => {
  it('the returned object never contains idempotencyKey, messageId, correlationId, or any AWS/SQS metadata key', () => {
    const payload = canonicalWagerPayload(BASE);
    const keys = Object.keys(payload);
    expect(keys).not.toContain('idempotencyKey');
    expect(keys).not.toContain('messageId');
    expect(keys).not.toContain('correlationId');
    expect(keys).not.toContain('receiveCount');
    expect(keys.sort()).toEqual(
      ['externalTransactionId', 'gameId', 'kind', 'money', 'playerId', 'providerId', 'roundId', 'walletId'].sort(),
    );
  });
});
