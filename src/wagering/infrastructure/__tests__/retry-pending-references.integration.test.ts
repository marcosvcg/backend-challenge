import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, truncateAllTables } from '../../../shared/__test-support__/test-orm';
import { MikroOrmTransactionRunner } from '../mikro-orm-transaction-runner';
import { MikroOrmPendingReferenceWorkerTransactionRunner } from '../mikro-orm-pending-reference-worker-transaction-runner';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.use-case';
import { RetryPendingReferencesUseCase } from '../../application/retry-pending-references.use-case';
import { ProcessWagerTransactionCommand } from '../../application/process-wager-transaction.command';
import { ReferenceRetryPolicy } from '../../application/reference-retry-policy';
import { UuidIdGenerator } from '../../../shared/infrastructure/uuid-id-generator';
import { FakeClock } from '../../application/__fakes__/fake-clock';
import { Wallet } from '../../../wallet/domain/wallet';
import { Money } from '../../../wallet/domain/money';
import { WagerTransactionKind } from '../../domain/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wager-transaction-status';
import { WagerTransactionRow } from '../persistence/wager-transaction.row';
import { WalletRow } from '../../../wallet/infrastructure/persistence/wallet.row';

const AT = new Date('2026-01-01T00:00:00.000Z');
const WALLET_ID = '00000000-0000-0000-0000-000000000010';
const PLAYER_ID = '00000000-0000-0000-0000-000000000011';

const TEST_RETRY_POLICY: ReferenceRetryPolicy = { baseDelayMs: 1000, maxDelayMs: 5000, maxAttempts: 3 };

async function seedWallet(orm: MikroORM, balance = '100.00'): Promise<void> {
  await orm.em.transactional(async (em) => {
    const wallet = Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, currency: 'BRL', at: AT });
    if (balance !== '0.00') {
      wallet.credit(Money.from({ amount: balance, currency: 'BRL' }), 'tx-opening', 'entry-opening', AT);
    }
    em.create(WalletRow, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balanceAmount: wallet.balance.toJSON().amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
    await em.flush();
  });
}

function betCommand(overrides: Partial<ProcessWagerTransactionCommand> = {}): ProcessWagerTransactionCommand {
  return {
    origin: 'http',
    providerId: 'provider-a',
    externalTransactionId: 'ext-bet',
    idempotencyKey: 'provider-a:ext-bet',
    payloadHash: 'hash-bet',
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '30.00', currency: 'BRL' }),
    correlationId: 'corr-1',
    ...overrides,
  };
}

function refundCommand(overrides: Partial<ProcessWagerTransactionCommand> = {}): ProcessWagerTransactionCommand {
  return {
    origin: 'http',
    providerId: 'provider-a',
    externalTransactionId: 'ext-refund',
    idempotencyKey: 'provider-a:ext-refund',
    payloadHash: 'hash-refund',
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Refund,
    money: Money.from({ amount: '30.00', currency: 'BRL' }),
    referenceExternalTransactionId: 'ext-bet',
    correlationId: 'corr-2',
    ...overrides,
  };
}

describe('RetryPendingReferencesUseCase — integration (real Postgres)', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAllTables(orm);
  });

  function newProcessUseCase(clock = new FakeClock(AT)): ProcessWagerTransactionUseCase {
    // orm.em.fork() SEMPRE — nunca a instância raiz orm.em diretamente.
    // Compartilhar orm.em cru entre dois TransactionRunners diferentes no
    // mesmo teste causa uma leitura corrompida via Identity Map (o MikroORM
    // inclusive proíbe operações de contexto direto na instância global:
    // "Using global EntityManager instance methods for context specific
    // actions is disallowed... use fork() instead"). Cada runner precisa do
    // seu próprio fork, mesmo dentro do mesmo teste.
    const runner = new MikroOrmTransactionRunner(orm.em.fork());
    // Mesma TEST_RETRY_POLICY do worker — fonte única de verdade para o
    // cálculo de backoff (o primeiro agendamento, aqui, e os seguintes, no
    // worker, precisam usar a mesma política, senão os testes calculam
    // clocks incompatíveis com o next_reference_retry_at real).
    return new ProcessWagerTransactionUseCase(runner, new UuidIdGenerator(), clock, TEST_RETRY_POLICY);
  }

  function newWorker(
    clock = new FakeClock(AT),
    policy: ReferenceRetryPolicy = TEST_RETRY_POLICY,
    em = orm.em.fork(),
  ): RetryPendingReferencesUseCase {
    const runner = new MikroOrmPendingReferenceWorkerTransactionRunner(em);
    return new RetryPendingReferencesUseCase(runner, new UuidIdGenerator(), clock, policy);
  }

  it('REFUND arriving before the BET is persisted as PENDING_REFERENCE (not processed, not rejected)', async () => {
    await seedWallet(orm, '100.00');
    const processUseCase = newProcessUseCase();

    const result = await processUseCase.execute(refundCommand());

    expect(result.kind).toBe('pending-reference');
    expect(result.transaction?.status).toBe(WagerTransactionStatus.PendingReference);
    expect(result.transaction?.isTerminal()).toBe(false);

    const walletRow = await orm.em.fork().findOneOrFail(WalletRow, { id: WALLET_ID });
    expect(walletRow.balanceAmount).toBe('100.00'); // unchanged — nothing applied yet
  });

  it('once the BET is processed later, the worker resolves the pending REFUND', async () => {
    await seedWallet(orm, '100.00');
    const processUseCase = newProcessUseCase();

    await processUseCase.execute(refundCommand()); // PENDING_REFERENCE — BET doesn't exist yet
    await processUseCase.execute(betCommand()); // BET now exists, PROCESSED

    const clock = new FakeClock(new Date(AT.getTime() + TEST_RETRY_POLICY.baseDelayMs + 1)); // past the scheduled retry
    const worker = newWorker(clock);
    const result = await worker.execute();

    expect(result.claimed).toBe(1);
    expect(result.resolved).toBe(1);

    const refundRow = await orm.em.fork().findOneOrFail(WagerTransactionRow, { idempotencyKey: 'provider-a:ext-refund' });
    expect(refundRow.status).toBe('PROCESSED');
    expect(refundRow.nextReferenceRetryAt).toBeNull();

    const walletRow = await orm.em.fork().findOneOrFail(WalletRow, { id: WALLET_ID });
    expect(walletRow.balanceAmount).toBe('100.00'); // 100 - 30 (bet) + 30 (refund)

    const ledgerRows = (await orm.em
      .fork()
      .getConnection()
      .execute(
        `select direction, amount from wallet_ledger_entry where wallet_id = '${WALLET_ID}' order by created_at`,
      )) as { direction: string; amount: string }[];
    expect(ledgerRows.map((r) => `${r.direction}:${r.amount}`)).toEqual(['DEBIT:30.00', 'CREDIT:30.00']);
  });

  it('reference still missing: attempts increments and retry is rescheduled (not yet rejected)', async () => {
    await seedWallet(orm, '100.00');
    const processUseCase = newProcessUseCase();
    await processUseCase.execute(refundCommand()); // PENDING_REFERENCE — BET never arrives in this test

    const clock = new FakeClock(new Date(AT.getTime() + TEST_RETRY_POLICY.baseDelayMs + 1));
    const worker = newWorker(clock);
    const result = await worker.execute();

    expect(result.claimed).toBe(1);
    expect(result.rescheduled).toBe(1);

    const refundRow = await orm.em.fork().findOneOrFail(WagerTransactionRow, { idempotencyKey: 'provider-a:ext-refund' });
    expect(refundRow.status).toBe('PENDING_REFERENCE');
    expect(refundRow.referenceRetryAttempts).toBe(2); // 1 from markPendingReference on create, +1 from the worker
    expect(refundRow.nextReferenceRetryAt).not.toBeNull();
    expect(refundRow.nextReferenceRetryAt!.getTime()).toBeGreaterThan(clock.now().getTime());
  });

  it('maxAttempts exceeded: transitions to REJECTED with REFERENCE_NOT_FOUND, result balance reflects the real wallet balance', async () => {
    await seedWallet(orm, '250.00'); // deliberately different from the REFUND's own amount (30.00)
    const processUseCase = newProcessUseCase();
    await processUseCase.execute(refundCommand()); // 1st attempt already counted on create

    let clockTime = AT.getTime();
    const worker = () => newWorker(new FakeClock(new Date(clockTime)));

    // maxAttempts = 3: the transaction already has 1 attempt from create();
    // the worker needs 2 more failed resolutions to exceed the limit.
    for (let i = 0; i < 2; i += 1) {
      clockTime += TEST_RETRY_POLICY.maxDelayMs + 1000;
      const result = await worker().execute();
      expect(result.rescheduled).toBe(1);
    }

    clockTime += TEST_RETRY_POLICY.maxDelayMs + 1000;
    const finalResult = await worker().execute();
    expect(finalResult.rejected).toBe(1);

    const refundRow = await orm.em.fork().findOneOrFail(WagerTransactionRow, { idempotencyKey: 'provider-a:ext-refund' });
    expect(refundRow.status).toBe('REJECTED');
    expect(refundRow.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(refundRow.nextReferenceRetryAt).toBeNull();
    expect(refundRow.resultBalanceAmount).toBe('250.00'); // the REAL wallet balance, not transaction.money (30.00)

    const walletRow = await orm.em.fork().findOneOrFail(WalletRow, { id: WALLET_ID });
    expect(walletRow.balanceAmount).toBe('250.00'); // untouched by the rejection
  });

  it('two concurrent worker instances never resolve the same pending reference twice', async () => {
    await seedWallet(orm, '100.00');
    const processUseCase = newProcessUseCase();
    await processUseCase.execute(refundCommand());
    await processUseCase.execute(betCommand());

    const clock = new FakeClock(new Date(AT.getTime() + TEST_RETRY_POLICY.baseDelayMs + 1));
    const workerA = newWorker(clock, TEST_RETRY_POLICY, orm.em.fork());
    const workerB = newWorker(clock, TEST_RETRY_POLICY, orm.em.fork());

    const [resultA, resultB] = await Promise.all([workerA.execute(), workerB.execute()]);

    const totalResolved = resultA.resolved + resultB.resolved;
    expect(totalResolved).toBe(1); // exactly one of the two resolved it, never both

    const walletRow = await orm.em.fork().findOneOrFail(WalletRow, { id: WALLET_ID });
    expect(walletRow.balanceAmount).toBe('100.00'); // 100 - 30 (bet) + 30 (refund, credited exactly once, not twice)

    const ledgerCount = await orm.em
      .fork()
      .getConnection()
      .execute(
        `select count(*)::int as count from wallet_ledger_entry where wallet_id = '${WALLET_ID}' and direction = 'CREDIT'`,
      );
    expect(ledgerCount[0].count).toBe(1);
  });

  it('restart between attempts preserves attempts/next retry — recovery continues correctly', async () => {
    await seedWallet(orm, '100.00');
    const processUseCase = newProcessUseCase();
    await processUseCase.execute(refundCommand());

    // First worker "instance" (process) runs one cycle, reschedules, then "dies" (goes out of scope).
    const firstClock = new FakeClock(new Date(AT.getTime() + TEST_RETRY_POLICY.baseDelayMs + 1));
    await newWorker(firstClock).execute();

    const afterFirstAttempt = await orm.em.fork().findOneOrFail(WagerTransactionRow, {
      idempotencyKey: 'provider-a:ext-refund',
    });
    expect(afterFirstAttempt.referenceRetryAttempts).toBe(2);
    const scheduledRetryAt = afterFirstAttempt.nextReferenceRetryAt!;

    // "Restart": brand new worker instance, fresh EntityManager fork, resolves
    // the reference this time (BET now exists).
    await processUseCase.execute(betCommand());
    const secondClock = new FakeClock(new Date(scheduledRetryAt.getTime() + 1));
    const secondWorker = newWorker(secondClock, TEST_RETRY_POLICY, orm.em.fork());
    const result = await secondWorker.execute();

    expect(result.resolved).toBe(1);

    const finalRow = await orm.em.fork().findOneOrFail(WagerTransactionRow, { idempotencyKey: 'provider-a:ext-refund' });
    expect(finalRow.status).toBe('PROCESSED');

    const walletRow = await orm.em.fork().findOneOrFail(WalletRow, { id: WALLET_ID });
    expect(walletRow.balanceAmount).toBe('100.00'); // 100 - 30 (bet) + 30 (refund)
  });

  it('an incompatible reference found by the worker is rejected exactly like the normal flow (IncompatibleReferenceError)', async () => {
    await seedWallet(orm, '100.00');
    const processUseCase = newProcessUseCase();

    // REFUND arrives referencing a round that will NOT match the BET's round.
    await processUseCase.execute(refundCommand({ roundId: 'round-DIFFERENT' }));
    // BET processed under a different round — incompatible reference.
    await processUseCase.execute(betCommand({ roundId: 'round-1' }));

    const clock = new FakeClock(new Date(AT.getTime() + TEST_RETRY_POLICY.baseDelayMs + 1));
    const result = await newWorker(clock).execute();

    expect(result.claimed).toBe(1);
    expect(result.resolved).toBe(1); // "resolved" = ResolveAndApplyWagerTransaction ran to completion (REJECTED is a valid outcome of it)

    const refundRow = await orm.em.fork().findOneOrFail(WagerTransactionRow, { idempotencyKey: 'provider-a:ext-refund' });
    expect(refundRow.status).toBe('REJECTED');
    expect(refundRow.failureCode).toBe('IncompatibleReferenceError');

    const walletRow = await orm.em.fork().findOneOrFail(WalletRow, { id: WALLET_ID });
    expect(walletRow.balanceAmount).toBe('70.00'); // only the BET's debit applied — refund never credited
  });

  it('final balance always matches the ledger reconstruction after worker processing', async () => {
    await seedWallet(orm, '100.00');
    const processUseCase = newProcessUseCase();
    await processUseCase.execute(refundCommand());
    await processUseCase.execute(betCommand());

    const clock = new FakeClock(new Date(AT.getTime() + TEST_RETRY_POLICY.baseDelayMs + 1));
    await newWorker(clock).execute();

    const walletRow = await orm.em.fork().findOneOrFail(WalletRow, { id: WALLET_ID });

    const ledgerRows = (await orm.em
      .fork()
      .getConnection()
      .execute(
        `select direction, amount from wallet_ledger_entry where wallet_id = '${WALLET_ID}' order by created_at`,
      )) as { direction: string; amount: string }[];
    const reconstructed = ledgerRows.reduce(
      (balance: number, row) => (row.direction === 'DEBIT' ? balance - Number(row.amount) : balance + Number(row.amount)),
      100.0,
    );

    expect(Number(walletRow.balanceAmount)).toBe(reconstructed);
  });
});
