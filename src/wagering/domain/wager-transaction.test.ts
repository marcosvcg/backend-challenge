import { describe, expect, it } from 'bun:test';
import { WagerTransaction, type CreateWagerTransactionProps } from './wager-transaction';
import { WagerTransactionKind } from './wager-transaction-kind';
import { WagerTransactionStatus } from './wager-transaction-status';
import { WagerBalanceEffect } from './wager-balance-effect';
import {
  InvalidReferenceKindError,
  InvalidTransactionStateError,
  MissingReferenceError,
  UnexpectedReferenceError,
} from './wagering.errors';
import { Money } from '../../wallet/domain/money';

const AT = new Date('2026-01-01T00:00:00.000Z');
const MONEY = Money.from({ amount: '25.00', currency: 'BRL' });

function baseProps(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: MONEY,
    createdAt: AT,
    ...overrides,
  };
}

describe('WagerTransaction.create — reference requirement by kind', () => {
  it('BET without reference is accepted', () => {
    const tx = WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Bet }));
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
  });

  it('LOSS without reference is accepted', () => {
    expect(() => WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Loss }))).not.toThrow();
  });

  it('BET with a reference is rejected', () => {
    expect(() =>
      WagerTransaction.create(
        baseProps({ kind: WagerTransactionKind.Bet, referenceExternalTransactionId: 'ext-0' }),
      ),
    ).toThrow(UnexpectedReferenceError);
  });

  it('LOSS with a reference is rejected', () => {
    expect(() =>
      WagerTransaction.create(
        baseProps({ kind: WagerTransactionKind.Loss, referenceExternalTransactionId: 'ext-0' }),
      ),
    ).toThrow(UnexpectedReferenceError);
  });

  it('REFUND requires a reference', () => {
    expect(() => WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Refund }))).toThrow(
      MissingReferenceError,
    );
  });

  it('REFUND with a reference is accepted', () => {
    expect(() =>
      WagerTransaction.create(
        baseProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-0' }),
      ),
    ).not.toThrow();
  });

  it('ROLLBACK requires a reference', () => {
    expect(() => WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Rollback }))).toThrow(
      MissingReferenceError,
    );
  });

  it('WIN without a reference is accepted (optional)', () => {
    expect(() => WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Win }))).not.toThrow();
  });

  it('WIN with a reference is accepted (optional)', () => {
    expect(() =>
      WagerTransaction.create(
        baseProps({ kind: WagerTransactionKind.Win, referenceExternalTransactionId: 'ext-0' }),
      ),
    ).not.toThrow();
  });
});

describe('WagerTransaction — transitions', () => {
  it('markProcessed sets PROCESSED, resultBalance and processedAt', () => {
    const tx = WagerTransaction.create(baseProps());
    tx.markProcessed('ref-tx-1', Money.from({ amount: '75.00', currency: 'BRL' }), AT);

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe('ref-tx-1');
    expect(tx.resultBalance?.toJSON().amount).toBe('75.00');
    expect(tx.processedAt).toEqual(AT);
    expect(tx.isTerminal()).toBe(true);
  });

  it('markPendingReference sets PENDING_REFERENCE, increments attempts and sets next retry — non-terminal', () => {
    const tx = WagerTransaction.create(
      baseProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-0' }),
    );
    const nextRetry = new Date('2026-01-01T00:05:00.000Z');
    tx.markPendingReference(nextRetry);

    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.referenceRetryAttempts).toBe(1);
    expect(tx.nextReferenceRetryAt).toEqual(nextRetry);
    expect(tx.isTerminal()).toBe(false); // ackable at transport level, but NOT terminal in the domain
  });

  it('markPendingReference called again increments attempts further', () => {
    const tx = WagerTransaction.create(
      baseProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-0' }),
    );
    tx.markPendingReference(new Date('2026-01-01T00:05:00.000Z'));
    tx.markPendingReference(new Date('2026-01-01T00:15:00.000Z'));

    expect(tx.referenceRetryAttempts).toBe(2);
  });

  it('reject sets REJECTED, failureCode and resultBalance', () => {
    const tx = WagerTransaction.create(baseProps());
    tx.reject('INSUFFICIENT_BALANCE', Money.from({ amount: '20.00', currency: 'BRL' }));

    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(tx.resultBalance?.toJSON().amount).toBe('20.00');
    expect(tx.isTerminal()).toBe(true);
  });

  it('fail sets FAILED and failureCode, without resultBalance', () => {
    const tx = WagerTransaction.create(baseProps());
    tx.fail('INFRA_TIMEOUT');

    expect(tx.status).toBe(WagerTransactionStatus.Failed);
    expect(tx.failureCode).toBe('INFRA_TIMEOUT');
    expect(tx.resultBalance).toBeUndefined();
    expect(tx.isTerminal()).toBe(true);
  });
});

describe('WagerTransaction — terminal transitions are rejected (InvalidTransactionStateError)', () => {
  it('cannot markProcessed a PROCESSED transaction again', () => {
    const tx = WagerTransaction.create(baseProps());
    tx.markProcessed(undefined, Money.from({ amount: '75.00', currency: 'BRL' }), AT);

    expect(() => tx.markProcessed(undefined, MONEY, AT)).toThrow(InvalidTransactionStateError);
  });

  it('cannot reject a REJECTED transaction again', () => {
    const tx = WagerTransaction.create(baseProps());
    tx.reject('CODE_A', MONEY);

    expect(() => tx.reject('CODE_B', MONEY)).toThrow(InvalidTransactionStateError);
  });

  it('cannot fail a FAILED transaction again', () => {
    const tx = WagerTransaction.create(baseProps());
    tx.fail('CODE_A');

    expect(() => tx.fail('CODE_B')).toThrow(InvalidTransactionStateError);
  });

  it('cannot markProcessed a FAILED transaction', () => {
    const tx = WagerTransaction.create(baseProps());
    tx.fail('CODE_A');

    expect(() => tx.markProcessed(undefined, MONEY, AT)).toThrow(InvalidTransactionStateError);
  });

  it('PENDING_REFERENCE (non-terminal) CAN still transition to PROCESSED', () => {
    const tx = WagerTransaction.create(
      baseProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-0' }),
    );
    tx.markPendingReference(new Date('2026-01-01T00:05:00.000Z'));

    expect(() => tx.markProcessed('ref-tx-1', MONEY, AT)).not.toThrow();
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
  });
});

describe('WagerTransaction — domain queries', () => {
  it('affectsBalance() is false only for LOSS', () => {
    expect(WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Loss })).affectsBalance()).toBe(false);
    expect(WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Bet })).affectsBalance()).toBe(true);
    expect(WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Win })).affectsBalance()).toBe(true);
  });

  it('requiresReference() is true only for REFUND and ROLLBACK', () => {
    expect(WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Bet })).requiresReference()).toBe(false);
    expect(WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Win })).requiresReference()).toBe(false);
    expect(
      WagerTransaction.create(
        baseProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-0' }),
      ).requiresReference(),
    ).toBe(true);
    expect(
      WagerTransaction.create(
        baseProps({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'ext-0' }),
      ).requiresReference(),
    ).toBe(true);
  });

  it('matchesPayload() compares the stored payloadHash', () => {
    const tx = WagerTransaction.create(baseProps({ payloadHash: 'abc' }));
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('xyz')).toBe(false);
  });
});

describe('WagerTransaction.balanceEffectFor — balance effect by kind', () => {
  it('BET is Debit', () => {
    expect(WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Bet })).balanceEffectFor()).toBe(
      WagerBalanceEffect.Debit,
    );
  });

  it('WIN is Credit', () => {
    expect(WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Win })).balanceEffectFor()).toBe(
      WagerBalanceEffect.Credit,
    );
  });

  it('LOSS is None', () => {
    expect(WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Loss })).balanceEffectFor()).toBe(
      WagerBalanceEffect.None,
    );
  });

  it('REFUND is Credit', () => {
    const refund = WagerTransaction.create(
      baseProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-0' }),
    );
    expect(refund.balanceEffectFor()).toBe(WagerBalanceEffect.Credit);
  });

  it('ROLLBACK inverts the effect of a DEBIT reference (BET) into Credit', () => {
    const bet = WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Bet }));
    const rollback = WagerTransaction.create(
      baseProps({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'ext-0' }),
    );
    expect(rollback.balanceEffectFor(bet)).toBe(WagerBalanceEffect.Credit);
  });

  it('ROLLBACK inverts the effect of a CREDIT reference (WIN) into Debit', () => {
    const win = WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Win }));
    const rollback = WagerTransaction.create(
      baseProps({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'ext-0' }),
    );
    expect(rollback.balanceEffectFor(win)).toBe(WagerBalanceEffect.Debit);
  });

  it('ROLLBACK inverts the effect of a CREDIT reference (REFUND) into Debit', () => {
    const refund = WagerTransaction.create(
      baseProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-0' }),
    );
    const rollback = WagerTransaction.create(
      baseProps({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'ext-1' }),
    );
    expect(rollback.balanceEffectFor(refund)).toBe(WagerBalanceEffect.Debit);
  });

  it('ROLLBACK without a reference throws — it has no direction of its own', () => {
    const rollback = WagerTransaction.create(
      baseProps({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'ext-0' }),
    );
    expect(() => rollback.balanceEffectFor()).toThrow(MissingReferenceError);
  });

  it('ROLLBACK referencing another ROLLBACK throws InvalidReferenceKindError (not a valid reversal target)', () => {
    const otherRollback = WagerTransaction.create(
      baseProps({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'ext-0' }),
    );
    const rollback = WagerTransaction.create(
      baseProps({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'ext-1' }),
    );
    expect(() => rollback.balanceEffectFor(otherRollback)).toThrow(InvalidReferenceKindError);
  });

  it('ROLLBACK referencing a LOSS throws InvalidReferenceKindError (LOSS has no balance effect to reverse)', () => {
    const loss = WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Loss }));
    const rollback = WagerTransaction.create(
      baseProps({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'ext-0' }),
    );
    expect(() => rollback.balanceEffectFor(loss)).toThrow(InvalidReferenceKindError);
  });
});

describe('WagerTransaction.rehydrate', () => {
  it('reconstructs exact state, including non-default retry/result fields', () => {
    const tx = WagerTransaction.rehydrate({
      ...baseProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-0' }),
      status: WagerTransactionStatus.PendingReference,
      referenceRetryAttempts: 3,
      nextReferenceRetryAt: new Date('2026-01-01T01:00:00.000Z'),
    });

    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.referenceRetryAttempts).toBe(3);
    expect(tx.nextReferenceRetryAt).toEqual(new Date('2026-01-01T01:00:00.000Z'));
  });
});
