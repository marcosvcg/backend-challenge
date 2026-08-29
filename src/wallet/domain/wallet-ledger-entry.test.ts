import { describe, expect, it } from 'bun:test';
import { WalletLedgerEntry } from './wallet-ledger-entry';
import { LedgerDirection } from './ledger-direction';
import { Money } from './money';
import { UnbalancedLedgerEntryError } from './wallet.errors';

const baseProps = {
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('WalletLedgerEntry.create — arithmetic validation', () => {
  it('accepts a balanced DEBIT entry', () => {
    const entry = WalletLedgerEntry.create({
      ...baseProps,
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '70.00', currency: 'BRL' }),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('accepts a balanced CREDIT entry', () => {
    const entry = WalletLedgerEntry.create({
      ...baseProps,
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '130.00', currency: 'BRL' }),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects a DEBIT entry with inconsistent arithmetic', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...baseProps,
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '30.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '80.00', currency: 'BRL' }), // should be 70.00
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('rejects a CREDIT entry with inconsistent arithmetic', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...baseProps,
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: '30.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '100.00', currency: 'BRL' }), // should be 130.00
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('rejects a direction/sign mismatch (DEBIT with CREDIT-shaped arithmetic)', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...baseProps,
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '30.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '130.00', currency: 'BRL' }), // that's a credit shape
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });
});

describe('WalletLedgerEntry — structural immutability', () => {
  it('exposes no mutation methods — only readonly fields and isBalanced()', () => {
    const entry = WalletLedgerEntry.create({
      ...baseProps,
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '50.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '40.00', currency: 'BRL' }),
    });

    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry)).filter(
      (name) => name !== 'constructor',
    );
    expect(methods).toEqual(['isBalanced']);
  });
});

describe('WalletLedgerEntry.rehydrate — no revalidation', () => {
  it('reconstructs state as-is, even if arithmetic were inconsistent (trusts persisted state)', () => {
    const entry = WalletLedgerEntry.rehydrate({
      ...baseProps,
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '999.00', currency: 'BRL' }), // deliberately inconsistent
    });

    expect(entry.balanceAfter.toJSON().amount).toBe('999.00'); // no throw — rehydrate trusts the DB
    expect(entry.isBalanced()).toBe(false); // but isBalanced() still reports the truth, for reconciliation
  });
});
