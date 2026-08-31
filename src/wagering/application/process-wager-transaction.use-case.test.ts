import { describe, expect, it } from 'bun:test';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case';
import { ProcessWagerTransactionCommand } from './process-wager-transaction.command';
import { FakeWalletRepository } from './__fakes__/fake-wallet.repository';
import { FakeWagerTransactionRepository } from './__fakes__/fake-wager-transaction.repository';
import { FakeInboxRepository } from './__fakes__/fake-inbox.repository';
import { FakeOutboxRepository } from './__fakes__/fake-outbox.repository';
import { FakeTransactionRunner } from './__fakes__/fake-transaction-runner';
import { FakeIdGenerator } from './__fakes__/fake-id-generator';
import { FakeClock } from './__fakes__/fake-clock';
import { DEFAULT_REFERENCE_RETRY_POLICY } from './reference-retry-policy';
import { Wallet } from '../../wallet/domain/wallet';
import { Money } from '../../wallet/domain/money';
import { WagerTransactionKind } from '../domain/wager-transaction-kind';
import { WagerTransactionStatus } from '../domain/wager-transaction-status';

const AT = new Date('2026-01-01T00:00:00.000Z');
const WALLET_ID = 'wallet-1';
const PLAYER_ID = 'player-1';

function setUp(initialBalance = '100.00') {
  const walletRepo = new FakeWalletRepository();
  const wagerRepo = new FakeWagerTransactionRepository();
  const inboxRepo = new FakeInboxRepository();
  const outboxRepo = new FakeOutboxRepository();
  const runner = new FakeTransactionRunner(walletRepo, wagerRepo, inboxRepo, outboxRepo);
  const ids = new FakeIdGenerator();
  const clock = new FakeClock(AT);

  const wallet = Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, currency: 'BRL', at: AT });
  if (initialBalance !== '0.00') {
    wallet.credit(Money.from({ amount: initialBalance, currency: 'BRL' }), 'tx-opening', 'entry-opening', AT);
  }
  walletRepo.seed(wallet);

  const useCase = new ProcessWagerTransactionUseCase(runner, ids, clock, DEFAULT_REFERENCE_RETRY_POLICY);

  return { walletRepo, wagerRepo, inboxRepo, outboxRepo, runner, ids, clock, useCase };
}

function betCommand(overrides: Partial<ProcessWagerTransactionCommand> = {}): ProcessWagerTransactionCommand {
  return {
    origin: 'http',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-1',
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '80.00', currency: 'BRL' }),
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('ProcessWagerTransactionUseCase — BET happy path', () => {
  it('debits the wallet, creates a balanced ledger entry, and enqueues 2 events', async () => {
    const { useCase, walletRepo, wagerRepo, outboxRepo } = setUp();

    const result = await useCase.execute(betCommand());

    expect(result.kind).toBe('processed');
    expect(result.ackable).toBe(true);

    const wallet = walletRepo.getCommitted(WALLET_ID)!;
    expect(wallet.balance.toJSON().amount).toBe('20.00');

    const tx = wagerRepo.getCommitted(result.transaction!.id)!;
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.resultBalance?.toJSON().amount).toBe('20.00');

    const events = outboxRepo.getCommitted();
    expect(events.map((e) => e.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });
});

describe('ProcessWagerTransactionUseCase — insufficient balance', () => {
  it('rejects without moving balance, no WalletBalanceChanged event', async () => {
    const { useCase, walletRepo, outboxRepo } = setUp('50.00');

    const result = await useCase.execute(betCommand({ money: Money.from({ amount: '80.00', currency: 'BRL' }) }));

    expect(result.kind).toBe('rejected');
    expect(result.transaction?.failureCode).toBe('InsufficientBalanceError');
    expect(result.transaction?.resultBalance?.toJSON().amount).toBe('50.00');

    const wallet = walletRepo.getCommitted(WALLET_ID)!;
    expect(wallet.balance.toJSON().amount).toBe('50.00'); // unchanged

    const events = outboxRepo.getCommitted();
    expect(events.map((e) => e.eventType)).toEqual(['WagerTransactionRejected']);
  });
});

describe('ProcessWagerTransactionUseCase — reversal would overdraw (README section 7 rule 9)', () => {
  it('rejects a ROLLBACK of a WIN with a failureCode distinct from plain insufficient balance', async () => {
    const { useCase, walletRepo } = setUp('100.00');

    await useCase.execute(
      betCommand({ externalTransactionId: 'ext-bet', idempotencyKey: 'p:ext-bet' }),
    ); // 100 - 80 = 20

    const win = await useCase.execute(
      betCommand({
        kind: WagerTransactionKind.Win,
        externalTransactionId: 'ext-win',
        idempotencyKey: 'p:ext-win',
        referenceExternalTransactionId: 'ext-bet',
        money: Money.from({ amount: '150.00', currency: 'BRL' }),
      }),
    ); // 20 + 150 = 170
    expect(win.kind).toBe('processed');

    await useCase.execute(
      betCommand({ externalTransactionId: 'ext-bet-2', idempotencyKey: 'p:ext-bet-2', money: Money.from({ amount: '165.00', currency: 'BRL' }) }),
    ); // 170 - 165 = 5 — most of the WIN's credit is already spent

    const rollback = await useCase.execute(
      betCommand({
        kind: WagerTransactionKind.Rollback,
        externalTransactionId: 'ext-rollback',
        idempotencyKey: 'p:ext-rollback',
        referenceExternalTransactionId: 'ext-win',
        money: Money.from({ amount: '150.00', currency: 'BRL' }), // must equal the WIN's own amount
      }),
    );

    // Reverting the WIN means debiting 150 from a wallet that only has 5 —
    // same underlying Wallet.debit() failure as a plain BET without balance,
    // but this is a reversal overdrawing the wallet, not a fresh bet without
    // funds: the two situations are operationally different (README seção 7
    // regra 9) and must carry different failureCodes even though both trace
    // back to InsufficientBalanceError inside Wallet.
    expect(rollback.kind).toBe('rejected');
    expect(rollback.transaction?.failureCode).toBe('ReversalWouldOverdrawError');
    expect(rollback.transaction?.failureCode).not.toBe('InsufficientBalanceError');

    const wallet = walletRepo.getCommitted(WALLET_ID)!;
    expect(wallet.balance.toJSON().amount).toBe('5.00'); // unchanged by the rejected rollback
  });
});

describe('ProcessWagerTransactionUseCase — mandatory scenario (README section 8)', () => {
  it('two sequential 80.00 bets against 100.00 balance: exactly one PROCESSED, one REJECTED, final balance 20.00', async () => {
    const { useCase } = setUp('100.00');

    const first = await useCase.execute(
      betCommand({ externalTransactionId: 'ext-1', idempotencyKey: 'provider-a:ext-1' }),
    );
    const second = await useCase.execute(
      betCommand({ externalTransactionId: 'ext-2', idempotencyKey: 'provider-a:ext-2' }),
    );

    expect(first.kind).toBe('processed');
    expect(second.kind).toBe('rejected');
    expect(second.transaction?.resultBalance?.toJSON().amount).toBe('20.00');
  });
});

describe('ProcessWagerTransactionUseCase — LOSS', () => {
  it('processes without moving balance and without a ledger entry', async () => {
    const { useCase, walletRepo, outboxRepo } = setUp('100.00');

    const result = await useCase.execute(
      betCommand({ kind: WagerTransactionKind.Loss, money: Money.from({ amount: '10.00', currency: 'BRL' }) }),
    );

    expect(result.kind).toBe('processed');
    const wallet = walletRepo.getCommitted(WALLET_ID)!;
    expect(wallet.balance.toJSON().amount).toBe('100.00'); // unchanged

    const events = outboxRepo.getCommitted();
    expect(events.map((e) => e.eventType)).toEqual(['WagerTransactionProcessed']); // no WalletBalanceChanged
  });
});

describe('ProcessWagerTransactionUseCase — REFUND with no matching reference', () => {
  it('persists PENDING_REFERENCE, ackable but non-terminal, schedules a retry', async () => {
    const { useCase, wagerRepo, outboxRepo } = setUp('100.00');

    const result = await useCase.execute(
      betCommand({
        kind: WagerTransactionKind.Refund,
        externalTransactionId: 'ext-refund',
        idempotencyKey: 'provider-a:ext-refund',
        referenceExternalTransactionId: 'ext-missing',
        money: Money.from({ amount: '30.00', currency: 'BRL' }),
      }),
    );

    expect(result.kind).toBe('pending-reference');
    expect(result.ackable).toBe(true);

    const tx = wagerRepo.getCommitted(result.transaction!.id)!;
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.isTerminal()).toBe(false); // ackable at transport, NOT terminal in domain
    expect(tx.nextReferenceRetryAt).toBeDefined();

    const events = outboxRepo.getCommitted();
    expect(events.map((e) => e.eventType)).toEqual(['WagerTransactionPendingReference']);
  });
});

describe('ProcessWagerTransactionUseCase — WIN referencing a processed BET', () => {
  it('credits the wallet and links referenceTransactionId', async () => {
    const { useCase, walletRepo } = setUp('100.00');

    const bet = await useCase.execute(
      betCommand({ externalTransactionId: 'ext-bet', idempotencyKey: 'provider-a:ext-bet' }),
    );

    const win = await useCase.execute(
      betCommand({
        kind: WagerTransactionKind.Win,
        externalTransactionId: 'ext-win',
        idempotencyKey: 'provider-a:ext-win',
        referenceExternalTransactionId: 'ext-bet',
        money: Money.from({ amount: '150.00', currency: 'BRL' }),
      }),
    );

    expect(win.kind).toBe('processed');
    expect(win.transaction?.referenceTransactionId).toBe(bet.transaction!.id);

    const wallet = walletRepo.getCommitted(WALLET_ID)!;
    expect(wallet.balance.toJSON().amount).toBe('170.00'); // 100 - 80 (bet) + 150 (win)
  });
});

describe('ProcessWagerTransactionUseCase — idempotency', () => {
  it('replays the original result for the same idempotencyKey + same payload, without reprocessing', async () => {
    const { useCase, walletRepo } = setUp('100.00');
    const cmd = betCommand();

    const first = await useCase.execute(cmd);
    const second = await useCase.execute(cmd);

    expect(second.kind).toBe('replay');
    expect(second.transaction?.id).toBe(first.transaction!.id);

    const wallet = walletRepo.getCommitted(WALLET_ID)!;
    expect(wallet.balance.toJSON().amount).toBe('20.00'); // debited only once
  });

  it('rejects as idempotency-conflict when the same key carries a different payload', async () => {
    const { useCase } = setUp('100.00');

    await useCase.execute(betCommand({ payloadHash: 'hash-A' }));
    const conflict = await useCase.execute(betCommand({ payloadHash: 'hash-B' }));

    expect(conflict.kind).toBe('idempotency-conflict');
    expect(conflict.ackable).toBe(true); // terminal from a protocol standpoint
    expect(conflict.transaction).toBeUndefined(); // no new WagerTransaction was created
  });
});

describe('ProcessWagerTransactionUseCase — Inbox dedupe (SQS origin)', () => {
  it('processes once, then ACKs a legitimate redelivery without reprocessing', async () => {
    const { useCase, walletRepo } = setUp('100.00');
    const cmd = betCommand({ origin: 'queue', consumerName: 'wagering-consumer', messageId: 'msg-1' });

    const first = await useCase.execute(cmd);
    const redelivery = await useCase.execute(cmd);

    expect(first.kind).toBe('processed');
    expect(redelivery.kind).toBe('already-acked');
    expect(redelivery.ackable).toBe(true);

    const wallet = walletRepo.getCommitted(WALLET_ID)!;
    expect(wallet.balance.toJSON().amount).toBe('20.00'); // debited only once
  });

  it('flags a permanent error when the same messageId carries a different payload', async () => {
    const { useCase } = setUp('100.00');

    await useCase.execute(
      betCommand({ origin: 'queue', consumerName: 'c', messageId: 'msg-1', payloadHash: 'hash-A' }),
    );
    const mismatch = await useCase.execute(
      betCommand({ origin: 'queue', consumerName: 'c', messageId: 'msg-1', payloadHash: 'hash-B' }),
    );

    expect(mismatch.kind).toBe('permanent-error');
    expect(mismatch.ackable).toBe(false); // not ACKed — goes through retry/DLQ path
    expect(mismatch.permanentErrorCode).toBe('INBOX_PAYLOAD_MISMATCH');
  });
});

describe('ProcessWagerTransactionUseCase — duplicate reversal (README section 7 rule 4)', () => {
  it('rejects a second REFUND for the same reference, without moving balance', async () => {
    const { useCase, walletRepo } = setUp('100.00');

    await useCase.execute(betCommand({ externalTransactionId: 'ext-bet', idempotencyKey: 'p:ext-bet' }));
    const firstRefund = await useCase.execute(
      betCommand({
        kind: WagerTransactionKind.Refund,
        externalTransactionId: 'ext-refund-1',
        idempotencyKey: 'p:ext-refund-1',
        referenceExternalTransactionId: 'ext-bet',
      }),
    );
    const secondRefund = await useCase.execute(
      betCommand({
        kind: WagerTransactionKind.Refund,
        externalTransactionId: 'ext-refund-2',
        idempotencyKey: 'p:ext-refund-2',
        referenceExternalTransactionId: 'ext-bet',
      }),
    );

    expect(firstRefund.kind).toBe('processed');
    expect(secondRefund.kind).toBe('rejected');
    expect(secondRefund.transaction?.failureCode).toBe('DuplicateReversalError');

    const wallet = walletRepo.getCommitted(WALLET_ID)!;
    expect(wallet.balance.toJSON().amount).toBe('100.00'); // 100 - 80 (bet) + 80 (1st refund), 2nd refund had no effect
  });
});

describe('ProcessWagerTransactionUseCase — atomicity proof (rollback)', () => {
  it('a failure in outbox.enqueue rolls back wallet, ledger, and wager transaction together', async () => {
    const walletRepo = new FakeWalletRepository();
    const wagerRepo = new FakeWagerTransactionRepository();
    const inboxRepo = new FakeInboxRepository();
    const outboxRepo = new FakeOutboxRepository();

    // Força falha exatamente no ponto onde a outbox seria gravada.
    const originalEnqueue = outboxRepo.enqueue.bind(outboxRepo);
    let callCount = 0;
    outboxRepo.enqueue = async (event) => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error('Simulated crash right after wager_transaction.save(), before outbox.enqueue() completes.');
      }
      return originalEnqueue(event);
    };

    const runner = new FakeTransactionRunner(walletRepo, wagerRepo, inboxRepo, outboxRepo);
    const useCase = new ProcessWagerTransactionUseCase(
      runner,
      new FakeIdGenerator(),
      new FakeClock(AT),
      DEFAULT_REFERENCE_RETRY_POLICY,
    );

    const wallet = Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, currency: 'BRL', at: AT });
    wallet.credit(Money.from({ amount: '100.00', currency: 'BRL' }), 'tx-opening', 'entry-opening', AT);
    walletRepo.seed(wallet);

    await expect(useCase.execute(betCommand())).rejects.toThrow('Simulated crash');

    // Nada foi commitado: nem wallet, nem ledger (implícito no saldo), nem wager_transaction.
    const freshWallet = walletRepo.getCommitted(WALLET_ID)!;
    expect(freshWallet.balance.toJSON().amount).toBe('100.00'); // unchanged — debit was rolled back
    expect(wagerRepo.getCommitted('id-1')).toBeUndefined(); // wager_transaction never committed
    expect(outboxRepo.getCommitted().length).toBe(0); // no event survived
  });
});
