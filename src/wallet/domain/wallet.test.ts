import { describe, expect, it } from 'bun:test';
import { Wallet } from './wallet';
import { LedgerDirection } from './ledger-direction';
import { Money } from './money';
import { InsufficientBalanceError, NonPositiveAmountError } from './wallet.errors';
import { CurrencyMismatchError } from './money.errors';

const AT = new Date('2026-01-01T00:00:00.000Z');

function openWallet(): Wallet {
  return Wallet.open({ id: 'wallet-1', playerId: 'player-1', currency: 'BRL', at: AT });
}

describe('Wallet.open', () => {
  it('opens with zero balance and version 1', () => {
    const wallet = openWallet();
    expect(wallet.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
  });

  it('is deterministic: uses the given `at`, never the system clock', () => {
    const wallet = openWallet();
    expect(wallet.updatedAt).toEqual(AT);
  });
});

describe('Wallet.credit', () => {
  it('increases balance and returns a balanced CREDIT ledger entry', () => {
    const wallet = openWallet();
    const entry = wallet.credit(Money.from({ amount: '100.00', currency: 'BRL' }), 'tx-1', 'entry-1', AT);

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toJSON().amount).toBe('0.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('100.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('increments version by exactly 1', () => {
    const wallet = openWallet();
    wallet.credit(Money.from({ amount: '100.00', currency: 'BRL' }), 'tx-1', 'entry-1', AT);
    expect(wallet.version).toBe(2);
  });

  it('rejects zero amount — version and balance must not change when nothing moves', () => {
    const wallet = openWallet();
    expect(() => wallet.credit(Money.zero('BRL'), 'tx-1', 'entry-1', AT)).toThrow(NonPositiveAmountError);
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount).toBe('0.00');
  });

  it('rejects negative amount', () => {
    const wallet = openWallet();
    expect(() =>
      wallet.credit(Money.from({ amount: '-10.00', currency: 'BRL' }), 'tx-1', 'entry-1', AT),
    ).toThrow(NonPositiveAmountError);
  });

  it('rejects currency mismatch', () => {
    const wallet = openWallet();
    expect(() =>
      wallet.credit(Money.from({ amount: '10.00', currency: 'USD' }), 'tx-1', 'entry-1', AT),
    ).toThrow(CurrencyMismatchError);
  });
});

describe('Wallet.debit', () => {
  it('decreases balance and returns a balanced DEBIT ledger entry', () => {
    const wallet = openWallet();
    wallet.credit(Money.from({ amount: '100.00', currency: 'BRL' }), 'tx-1', 'entry-1', AT);

    const entry = wallet.debit(Money.from({ amount: '30.00', currency: 'BRL' }), 'tx-2', 'entry-2', AT);

    expect(wallet.balance.toJSON().amount).toBe('70.00');
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('70.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('increments version by exactly 1', () => {
    const wallet = openWallet();
    wallet.credit(Money.from({ amount: '100.00', currency: 'BRL' }), 'tx-1', 'entry-1', AT);
    const versionAfterCredit = wallet.version;

    wallet.debit(Money.from({ amount: '30.00', currency: 'BRL' }), 'tx-2', 'entry-2', AT);
    expect(wallet.version).toBe(versionAfterCredit + 1);
  });

  it('rejects debit when balance is insufficient — balance and version stay untouched', () => {
    const wallet = openWallet();
    wallet.credit(Money.from({ amount: '50.00', currency: 'BRL' }), 'tx-1', 'entry-1', AT);
    const versionBefore = wallet.version;

    expect(() =>
      wallet.debit(Money.from({ amount: '80.00', currency: 'BRL' }), 'tx-2', 'entry-2', AT),
    ).toThrow(InsufficientBalanceError);

    expect(wallet.balance.toJSON().amount).toBe('50.00');
    expect(wallet.version).toBe(versionBefore);
  });

  it('allows debiting the exact full balance down to zero', () => {
    const wallet = openWallet();
    wallet.credit(Money.from({ amount: '50.00', currency: 'BRL' }), 'tx-1', 'entry-1', AT);

    const entry = wallet.debit(Money.from({ amount: '50.00', currency: 'BRL' }), 'tx-2', 'entry-2', AT);
    expect(wallet.balance.isZero()).toBe(true);
    expect(entry.balanceAfter.isZero()).toBe(true);
  });

  it('rejects zero amount', () => {
    const wallet = openWallet();
    wallet.credit(Money.from({ amount: '10.00', currency: 'BRL' }), 'tx-1', 'entry-1', AT);
    expect(() => wallet.debit(Money.zero('BRL'), 'tx-2', 'entry-2', AT)).toThrow(NonPositiveAmountError);
  });

  it('rejects negative amount', () => {
    const wallet = openWallet();
    expect(() =>
      wallet.debit(Money.from({ amount: '-10.00', currency: 'BRL' }), 'tx-1', 'entry-1', AT),
    ).toThrow(NonPositiveAmountError);
  });

  it('rejects currency mismatch', () => {
    const wallet = openWallet();
    expect(() =>
      wallet.debit(Money.from({ amount: '10.00', currency: 'USD' }), 'tx-1', 'entry-1', AT),
    ).toThrow(CurrencyMismatchError);
  });
});

describe('Wallet.rehydrate', () => {
  it('reconstructs exact state without regenerating anything', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: Money.from({ amount: '250.00', currency: 'BRL' }),
      version: 7,
      createdAt: AT,
      updatedAt: AT,
    });

    expect(wallet.balance.toJSON().amount).toBe('250.00');
    expect(wallet.version).toBe(7);
  });
});

describe('Wallet — mandatory scenario (README section 8): two concurrent 80.00 bets against 100.00 balance', () => {
  it('sequential application of the same rule set: first succeeds, second is rejected', () => {
    // This test proves the DOMAIN rule in isolation (no locking involved yet —
    // concurrency itself is proven at the integration level once findByIdForUpdate exists).
    const wallet = openWallet();
    wallet.credit(Money.from({ amount: '100.00', currency: 'BRL' }), 'tx-open', 'entry-open', AT);

    const firstBet = Money.from({ amount: '80.00', currency: 'BRL' });
    const firstEntry = wallet.debit(firstBet, 'tx-bet-1', 'entry-bet-1', AT);
    expect(firstEntry.isBalanced()).toBe(true);
    expect(wallet.balance.toJSON().amount).toBe('20.00');

    const secondBet = Money.from({ amount: '80.00', currency: 'BRL' });
    expect(() => wallet.debit(secondBet, 'tx-bet-2', 'entry-bet-2', AT)).toThrow(InsufficientBalanceError);
    expect(wallet.balance.toJSON().amount).toBe('20.00'); // unchanged by the rejected attempt
  });
});
