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

/** Achado real de auditoria (hardening SQS): '' é !== undefined, então sem
 *  este guard WagerTransaction.assertReferenceRequirement() a aceitaria como
 *  "presente" — mas o use case usa `if (cmd.referenceExternalTransactionId)`
 *  (truthy) para decidir se resolve a referência, e '' é falsy. Sem esta
 *  checagem no parser, um REFUND com referência '' criaria uma
 *  WagerTransaction válida sem NUNCA resolver/validar a referência,
 *  aplicando o efeito de saldo do REFUND (Credit) de qualquer forma —
 *  confirmado empiricamente antes desta correção (teste de integração do
 *  consumer: saldo movido, WagerTransaction criada). */
describe('parseWagerTransactionMessage — referenceExternalTransactionId, when present, must be non-blank', () => {
  it('rejects an empty string', () => {
    expect(() =>
      parseWagerTransactionMessage(validBody({ kind: 'REFUND', referenceExternalTransactionId: '' })),
    ).toThrow(MalformedWagerTransactionMessageError);
  });

  it('rejects a whitespace-only string', () => {
    expect(() =>
      parseWagerTransactionMessage(validBody({ kind: 'REFUND', referenceExternalTransactionId: '   ' })),
    ).toThrow(MalformedWagerTransactionMessageError);
  });

  it('rejects a non-string value', () => {
    expect(() =>
      parseWagerTransactionMessage(validBody({ kind: 'REFUND', referenceExternalTransactionId: 123 })),
    ).toThrow(MalformedWagerTransactionMessageError);
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

  it('rejects a required field with the wrong type (e.g. providerId as a number)', () => {
    const parsed = JSON.parse(validBody());
    parsed.data.providerId = 123;
    expect(() => parseWagerTransactionMessage(JSON.stringify(parsed))).toThrow(MalformedWagerTransactionMessageError);
  });

  it('rejects an empty string in a required field', () => {
    expect(() => parseWagerTransactionMessage(validBody({ gameId: '' }))).toThrow(
      MalformedWagerTransactionMessageError,
    );
  });
});

/** Notação científica/mais de 2 casas decimais/currency inválida: o parser só
 *  checa shape (money é um objeto com amount/currency string) — a validação
 *  lexical real do valor é responsabilidade de Money.from(), chamada no
 *  mapper (wagerTransactionMessageToCommand), não do parser. Estes casos
 *  passam pelo parser sem erro (comportamento correto — não é um erro de
 *  shape) e são cobertos como erros de domínio abaixo/no teste de integração
 *  do consumer, que prova o resultado observável fim-a-fim: permanent, sem
 *  mutação financeira, não importa em qual camada a rejeição de fato
 *  acontece. */
describe('parseWagerTransactionMessage — lexical amount/currency validity is NOT this parser\'s responsibility', () => {
  it('scientific notation in amount passes shape validation (Money.from() rejects it later)', () => {
    expect(() => parseWagerTransactionMessage(validBody({ money: { amount: '2.5e1', currency: 'BRL' } }))).not.toThrow();
  });

  it('more than 2 decimal places passes shape validation (Money.from() rejects it later)', () => {
    expect(() => parseWagerTransactionMessage(validBody({ money: { amount: '25.001', currency: 'BRL' } }))).not.toThrow();
  });

  it('an invalid currency code passes shape validation (Money.from() rejects it later)', () => {
    expect(() => parseWagerTransactionMessage(validBody({ money: { amount: '25.00', currency: 'brl' } }))).not.toThrow();
  });
});
