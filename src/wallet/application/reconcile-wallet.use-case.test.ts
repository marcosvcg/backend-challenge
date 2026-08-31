import { describe, expect, it } from 'bun:test';
import { ReconcileWalletUseCase } from './reconcile-wallet.use-case';
import { FakeWalletQueryRepository } from './__fakes__/fake-wallet-query.repository';
import { FakeWalletLedgerQueryRepository } from './__fakes__/fake-wallet-ledger-query.repository';
import { FakeMetrics } from './__fakes__/fake-metrics';
import { FakeLogger } from './__fakes__/fake-logger';
import { WALLET_RECONCILIATION_DIVERGENCES_TOTAL } from './wallet-reconciliation-metric';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { Money } from '../domain/money';
import { LedgerDirection } from '../domain/ledger-direction';

const AT = new Date('2026-01-01T00:00:00.000Z');
const WALLET_ID = 'wallet-1';
const PLAYER_ID = 'player-1';

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function rehydratedWallet(balance: string, version = 2): Wallet {
  return Wallet.rehydrate({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    currency: 'BRL',
    balance: brl(balance),
    version,
    createdAt: AT,
    updatedAt: AT,
  });
}

function entry(props: {
  id: string;
  direction: LedgerDirection;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
}): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: props.id,
    walletId: WALLET_ID,
    transactionId: `tx-${props.id}`,
    direction: props.direction,
    money: brl(props.amount),
    balanceBefore: brl(props.balanceBefore),
    balanceAfter: brl(props.balanceAfter),
    createdAt: AT,
  });
}

function setUp() {
  const walletRepository = new FakeWalletQueryRepository();
  const ledgerRepository = new FakeWalletLedgerQueryRepository();
  const metrics = new FakeMetrics();
  const logger = new FakeLogger();
  const useCase = new ReconcileWalletUseCase(walletRepository, ledgerRepository, metrics, logger);
  return { walletRepository, ledgerRepository, metrics, logger, useCase };
}

describe('ReconcileWalletUseCase — wallet not found', () => {
  it('returns kind: "wallet-not-found" without touching the ledger repository, metrics, or logger', async () => {
    const { ledgerRepository, metrics, logger, useCase } = setUp();
    ledgerRepository.seed([entry({ id: 'e1', direction: LedgerDirection.Credit, amount: '10.00', balanceBefore: '0.00', balanceAfter: '10.00' })]);

    const result = await useCase.execute('does-not-exist');

    expect(result.kind).toBe('wallet-not-found');
    expect(metrics.getIncrements()).toHaveLength(0);
    expect(logger.getEntries()).toHaveLength(0);
  });
});

describe('ReconcileWalletUseCase — empty ledger', () => {
  it('a wallet with zero balance and no entries is consistent', async () => {
    const { walletRepository, ledgerRepository, metrics, logger, useCase } = setUp();
    walletRepository.seed(rehydratedWallet('0.00', 1));
    ledgerRepository.seed([]);

    const result = await useCase.execute(WALLET_ID);

    expect(result.kind).toBe('reconciled');
    if (result.kind !== 'reconciled') throw new Error('unreachable');
    expect(result.reconciliation.consistent).toBe(true);
    expect(result.reconciliation.calculatedBalance.toJSON().amount).toBe('0.00');
    expect(result.reconciliation.storedBalance.toJSON().amount).toBe('0.00');
    expect(result.reconciliation.difference.toJSON().amount).toBe('0.00');
    expect(result.reconciliation.checkedEntries).toBe(0);
    expect(metrics.getIncrements()).toHaveLength(0);
    expect(logger.getEntries()).toHaveLength(0);
  });

  it('a wallet with a NON-zero stored balance but an empty ledger is inconsistent — divergence never masked', async () => {
    const { walletRepository, ledgerRepository, metrics, useCase } = setUp();
    walletRepository.seed(rehydratedWallet('50.00', 1));
    ledgerRepository.seed([]);

    const result = await useCase.execute(WALLET_ID);

    expect(result.kind).toBe('reconciled');
    if (result.kind !== 'reconciled') throw new Error('unreachable');
    expect(result.reconciliation.consistent).toBe(false);
    expect(result.reconciliation.calculatedBalance.toJSON().amount).toBe('0.00'); // empty ledger → zero, never inferred from storedBalance
    expect(result.reconciliation.storedBalance.toJSON().amount).toBe('50.00');
    expect(result.reconciliation.difference.toJSON().amount).toBe('50.00');
    expect(metrics.getIncrements()).toEqual([
      { name: WALLET_RECONCILIATION_DIVERGENCES_TOTAL, labels: { reason: 'balance_mismatch' } },
    ]);
  });
});

describe('ReconcileWalletUseCase — consistent ledger', () => {
  it('a well-formed chain matching storedBalance is consistent, no metric/log emitted', async () => {
    const { walletRepository, ledgerRepository, metrics, logger, useCase } = setUp();
    walletRepository.seed(rehydratedWallet('100.00'));
    ledgerRepository.seed([
      entry({ id: 'e1', direction: LedgerDirection.Credit, amount: '100.00', balanceBefore: '0.00', balanceAfter: '100.00' }),
    ]);

    const result = await useCase.execute(WALLET_ID);

    expect(result.kind).toBe('reconciled');
    if (result.kind !== 'reconciled') throw new Error('unreachable');
    expect(result.reconciliation.consistent).toBe(true);
    expect(result.reconciliation.calculatedBalance.toJSON().amount).toBe('100.00');
    expect(result.reconciliation.difference.toJSON().amount).toBe('0.00');
    expect(result.reconciliation.checkedEntries).toBe(1);
    expect(metrics.getIncrements()).toHaveLength(0);
    expect(logger.getEntries()).toHaveLength(0);
  });

  it('a multi-entry well-formed chain reconstructs correctly', async () => {
    const { walletRepository, ledgerRepository, useCase } = setUp();
    walletRepository.seed(rehydratedWallet('70.00')); // 100 credited, 30 debited
    ledgerRepository.seed([
      entry({ id: 'e1', direction: LedgerDirection.Credit, amount: '100.00', balanceBefore: '0.00', balanceAfter: '100.00' }),
      entry({ id: 'e2', direction: LedgerDirection.Debit, amount: '30.00', balanceBefore: '100.00', balanceAfter: '70.00' }),
    ]);

    const result = await useCase.execute(WALLET_ID);

    expect(result.kind).toBe('reconciled');
    if (result.kind !== 'reconciled') throw new Error('unreachable');
    expect(result.reconciliation.consistent).toBe(true);
    expect(result.reconciliation.calculatedBalance.toJSON().amount).toBe('70.00');
    expect(result.reconciliation.checkedEntries).toBe(2);
  });
});

describe('ReconcileWalletUseCase — balance_mismatch (sum diverges from storedBalance)', () => {
  it('detects a divergence when the reconstructed sum does not match storedBalance, even with a well-formed chain', async () => {
    const { walletRepository, ledgerRepository, metrics, logger, useCase } = setUp();
    // storedBalance says 999.00, but the (internally well-formed) chain only
    // accounts for 100.00 — simulates a corrupted wallet.balance_amount column.
    walletRepository.seed(rehydratedWallet('999.00'));
    ledgerRepository.seed([
      entry({ id: 'e1', direction: LedgerDirection.Credit, amount: '100.00', balanceBefore: '0.00', balanceAfter: '100.00' }),
    ]);

    const result = await useCase.execute(WALLET_ID);

    expect(result.kind).toBe('reconciled');
    if (result.kind !== 'reconciled') throw new Error('unreachable');
    expect(result.reconciliation.consistent).toBe(false);
    expect(result.reconciliation.calculatedBalance.toJSON().amount).toBe('100.00');
    expect(result.reconciliation.storedBalance.toJSON().amount).toBe('999.00');
    expect(result.reconciliation.difference.toJSON().amount).toBe('899.00'); // storedBalance - calculatedBalance, signed
    expect(metrics.getIncrements()).toEqual([
      { name: WALLET_RECONCILIATION_DIVERGENCES_TOTAL, labels: { reason: 'balance_mismatch' } },
    ]);
    expect(logger.getEntries()).toHaveLength(1);
    expect(logger.getEntries()[0]!.level).toBe('warn');
    expect(logger.getEntries()[0]!.meta).toMatchObject({
      event: 'wallet_reconciliation_divergence',
      walletId: WALLET_ID,
      reason: 'balance_mismatch',
      checkedEntries: 1,
    });
  });

  it('difference is negative when storedBalance is BELOW the reconstructed balance', async () => {
    const { walletRepository, ledgerRepository, useCase } = setUp();
    walletRepository.seed(rehydratedWallet('10.00'));
    ledgerRepository.seed([
      entry({ id: 'e1', direction: LedgerDirection.Credit, amount: '100.00', balanceBefore: '0.00', balanceAfter: '100.00' }),
    ]);

    const result = await useCase.execute(WALLET_ID);

    expect(result.kind).toBe('reconciled');
    if (result.kind !== 'reconciled') throw new Error('unreachable');
    expect(result.reconciliation.consistent).toBe(false);
    expect(result.reconciliation.difference.toJSON().amount).toBe('-90.00'); // 10 - 100, negative — stored is BELOW calculated
  });
});

describe('ReconcileWalletUseCase — invalid_anchor (first entry balanceBefore is not zero)', () => {
  it('detects a corrupted first-entry balanceBefore, uses the real persisted value in the calculation, never silently substitutes zero', async () => {
    const { walletRepository, ledgerRepository, metrics, logger, useCase } = setUp();
    // Simulates a first ledger entry that never should have existed with a
    // non-zero balanceBefore (Wallet.open() is the only Wallet creation path
    // in production code, and it always starts at zero).
    walletRepository.seed(rehydratedWallet('150.00'));
    ledgerRepository.seed([
      // Corrupted: balanceBefore is 50.00, not 0.00 — but the value IS used
      // in the reconstruction below (50 + 100 credit = 150), matching
      // storedBalance — yet still flagged inconsistent because the anchor
      // itself is wrong.
      entry({ id: 'e1', direction: LedgerDirection.Credit, amount: '100.00', balanceBefore: '50.00', balanceAfter: '150.00' }),
    ]);

    const result = await useCase.execute(WALLET_ID);

    expect(result.kind).toBe('reconciled');
    if (result.kind !== 'reconciled') throw new Error('unreachable');
    expect(result.reconciliation.consistent).toBe(false); // anchor invalid, even though the sum happens to match storedBalance
    expect(result.reconciliation.calculatedBalance.toJSON().amount).toBe('150.00'); // 50.00 (real persisted value) + 100.00, never replaced by zero
    expect(result.reconciliation.difference.toJSON().amount).toBe('0.00'); // sum matches storedBalance — the anchor check is what catches this
    expect(metrics.getIncrements()).toEqual([
      { name: WALLET_RECONCILIATION_DIVERGENCES_TOTAL, labels: { reason: 'invalid_anchor' } },
    ]);
    expect(logger.getEntries()[0]!.meta).toMatchObject({ reason: 'invalid_anchor' });
  });
});

describe('ReconcileWalletUseCase — invalid_entry (an entry\'s own arithmetic is internally inconsistent)', () => {
  it('detects a single entry whose balanceBefore ± amount != balanceAfter, even when the anchor, chain, and final sum are all otherwise fine', async () => {
    const { walletRepository, ledgerRepository, metrics, logger, useCase } = setUp();
    // Single entry: balanceBefore = 0.00 (valid anchor), direction = CREDIT,
    // amount = 100.00 — but balanceAfter is 999.00, not the 100.00 the
    // arithmetic actually produces. isBalanced() catches this.
    //
    // Deliberately designed so NO OTHER detector fires:
    //  - anchor: balanceBefore IS 0.00 → invalid_anchor does not fire.
    //  - chain: single entry, no `next` to compare balanceAfter against →
    //    broken_chain is never even evaluated.
    //  - sum: the reconstruction sums by direction/amount (0 + 100 = 100),
    //    NEVER by copying the entry's own (corrupted) balanceAfter — so
    //    storedBalance is set to match that independently-computed sum
    //    (100.00), keeping balance_mismatch from firing too.
    walletRepository.seed(rehydratedWallet('100.00'));
    ledgerRepository.seed([
      entry({ id: 'e1', direction: LedgerDirection.Credit, amount: '100.00', balanceBefore: '0.00', balanceAfter: '999.00' }),
    ]);

    const result = await useCase.execute(WALLET_ID);

    expect(result.kind).toBe('reconciled');
    if (result.kind !== 'reconciled') throw new Error('unreachable');
    expect(result.reconciliation.consistent).toBe(false);
    expect(result.reconciliation.calculatedBalance.toJSON().amount).toBe('100.00'); // independent sum, never balanceAfter
    expect(result.reconciliation.storedBalance.toJSON().amount).toBe('100.00');
    expect(result.reconciliation.difference.toJSON().amount).toBe('0.00'); // sum matches storedBalance — invalid_entry is what catches this
    expect(metrics.getIncrements()).toEqual([
      { name: WALLET_RECONCILIATION_DIVERGENCES_TOTAL, labels: { reason: 'invalid_entry' } },
    ]);
    expect(logger.getEntries()[0]!.meta).toMatchObject({ reason: 'invalid_entry' });
  });
});

describe('ReconcileWalletUseCase — broken_chain (balanceAfter[i] != balanceBefore[i+1])', () => {
  it('detects a gap in the chain even when both individual entries are internally well-formed', async () => {
    const { walletRepository, ledgerRepository, metrics, logger, useCase } = setUp();
    walletRepository.seed(rehydratedWallet('200.00', 3));
    ledgerRepository.seed([
      entry({ id: 'e1', direction: LedgerDirection.Credit, amount: '100.00', balanceBefore: '0.00', balanceAfter: '100.00' }),
      // Gap: this entry's balanceBefore is 500.00, not the 100.00 the
      // previous entry's balanceAfter actually left the wallet at — as if a
      // lançamento intermediário fosse perdido/inserido fora de ordem.
      entry({ id: 'e2', direction: LedgerDirection.Credit, amount: '100.00', balanceBefore: '500.00', balanceAfter: '600.00' }),
    ]);

    const result = await useCase.execute(WALLET_ID);

    expect(result.kind).toBe('reconciled');
    if (result.kind !== 'reconciled') throw new Error('unreachable');
    expect(result.reconciliation.consistent).toBe(false);
    expect(result.reconciliation.checkedEntries).toBe(2);
    expect(metrics.getIncrements()).toEqual([
      { name: WALLET_RECONCILIATION_DIVERGENCES_TOTAL, labels: { reason: 'broken_chain' } },
    ]);
    expect(logger.getEntries()[0]!.meta).toMatchObject({ reason: 'broken_chain' });
  });
});

describe('ReconcileWalletUseCase — one increment per inconsistent execution, deterministic reason priority', () => {
  it('increments the metric exactly once even when both the anchor AND the sum are wrong in the same execution', async () => {
    const { walletRepository, ledgerRepository, metrics, useCase } = setUp();
    walletRepository.seed(rehydratedWallet('999.00')); // wildly diverges from anything the chain could produce
    ledgerRepository.seed([
      // Anchor is ALSO invalid (50.00, not 0.00) — two independent problems
      // in the same execution.
      entry({ id: 'e1', direction: LedgerDirection.Credit, amount: '100.00', balanceBefore: '50.00', balanceAfter: '150.00' }),
    ]);

    const result = await useCase.execute(WALLET_ID);

    expect(result.kind).toBe('reconciled');
    if (result.kind !== 'reconciled') throw new Error('unreachable');
    expect(result.reconciliation.consistent).toBe(false);
    expect(metrics.getIncrements()).toHaveLength(1); // never one per detected reason
    expect(metrics.getIncrements()[0]!.labels.reason).toBe('invalid_anchor'); // first in the priority order
  });

  it('prioritizes invalid_entry over broken_chain when both are present in the same execution', async () => {
    const { walletRepository, ledgerRepository, metrics, useCase } = setUp();
    walletRepository.seed(rehydratedWallet('300.00', 3));
    ledgerRepository.seed([
      // e1: internally unbalanced (0 + 100 should be 100, not 999).
      entry({ id: 'e1', direction: LedgerDirection.Credit, amount: '100.00', balanceBefore: '0.00', balanceAfter: '999.00' }),
      // e2: chain gap against e1's (corrupted) balanceAfter — 999 != 500.
      entry({ id: 'e2', direction: LedgerDirection.Credit, amount: '100.00', balanceBefore: '500.00', balanceAfter: '600.00' }),
    ]);

    const result = await useCase.execute(WALLET_ID);

    expect(result.kind).toBe('reconciled');
    if (result.kind !== 'reconciled') throw new Error('unreachable');
    expect(metrics.getIncrements()).toHaveLength(1);
    expect(metrics.getIncrements()[0]!.labels.reason).toBe('invalid_entry'); // outranks broken_chain
  });
});
