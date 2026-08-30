import { describe, expect, it } from 'bun:test';
import { parseWagerTransactionMessage, MalformedWagerTransactionMessageError } from './parse-wager-transaction-message';

function validBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    messageId: 'msg-123',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      idempotencyKey: 'provider-a:transaction-123',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...overrides,
    },
  });
}

describe('parseWagerTransactionMessage — valid message', () => {
  it('parses a well-formed BET message', () => {
    const parsed = parseWagerTransactionMessage(validBody());
    expect(parsed.data.kind).toBe('BET');
    expect(parsed.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('accepts an optional referenceExternalTransactionId', () => {
    const parsed = parseWagerTransactionMessage(
      validBody({ kind: 'REFUND', referenceExternalTransactionId: 'transaction-100' }),
    );
    expect(parsed.data.referenceExternalTransactionId).toBe('transaction-100');
  });
});

describe('parseWagerTransactionMessage — structural errors (permanent, never ACK)', () => {
  it('rejects invalid JSON', () => {
    expect(() => parseWagerTransactionMessage('not json{{{')).toThrow(MalformedWagerTransactionMessageError);
  });

  it('rejects a JSON array (not an object)', () => {
    expect(() => parseWagerTransactionMessage('[]')).toThrow(MalformedWagerTransactionMessageError);
  });

  it('rejects a missing messageId', () => {
    const body = JSON.stringify({ type: 'WagerTransactionRequested', data: {} });
    expect(() => parseWagerTransactionMessage(body)).toThrow(MalformedWagerTransactionMessageError);
  });

  it('rejects an unexpected type', () => {
    const body = JSON.stringify({ messageId: 'msg-1', type: 'SomethingElse', data: {} });
    expect(() => parseWagerTransactionMessage(body)).toThrow(MalformedWagerTransactionMessageError);
  });

  it('rejects missing data', () => {
    const body = JSON.stringify({ messageId: 'msg-1', type: 'WagerTransactionRequested' });
    expect(() => parseWagerTransactionMessage(body)).toThrow(MalformedWagerTransactionMessageError);
  });

  it('rejects a missing required field in data (e.g. gameId)', () => {
    const parsed = JSON.parse(validBody());
    delete parsed.data.gameId;
    expect(() => parseWagerTransactionMessage(JSON.stringify(parsed))).toThrow(MalformedWagerTransactionMessageError);
  });

  it('rejects an invalid kind', () => {
    expect(() => parseWagerTransactionMessage(validBody({ kind: 'NOT_A_REAL_KIND' }))).toThrow(
      MalformedWagerTransactionMessageError,
    );
  });

  it('rejects OPENING — internal kind, never accepted from the queue', () => {
    expect(() => parseWagerTransactionMessage(validBody({ kind: 'OPENING' }))).toThrow(
      MalformedWagerTransactionMessageError,
    );
  });

  it('rejects missing money', () => {
    const parsed = JSON.parse(validBody());
    delete parsed.data.money;
    expect(() => parseWagerTransactionMessage(JSON.stringify(parsed))).toThrow(MalformedWagerTransactionMessageError);
  });

  it('rejects money with a non-string amount', () => {
    expect(() => parseWagerTransactionMessage(validBody({ money: { amount: 25, currency: 'BRL' } }))).toThrow(
      MalformedWagerTransactionMessageError,
    );
  });
});
