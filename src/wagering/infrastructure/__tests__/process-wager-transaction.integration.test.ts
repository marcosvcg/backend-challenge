import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, truncateAllTables } from '../../../shared/__test-support__/test-orm';
import { MikroOrmTransactionRunner } from '../mikro-orm-transaction-runner';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.use-case';
import { WageringTransactionRunner, WageringUnitOfWork } from '../../application/ports/unit-of-work';
import { ProcessWagerTransactionCommand } from '../../application/process-wager-transaction.command';
import { UuidIdGenerator } from '../../../shared/infrastructure/uuid-id-generator';
import { FakeClock } from '../../application/__fakes__/fake-clock';
import { DEFAULT_REFERENCE_RETRY_POLICY } from '../../application/reference-retry-policy';
import { Wallet } from '../../../wallet/domain/wallet';
import { Money } from '../../../wallet/domain/money';
import { WagerTransactionKind } from '../../domain/wager-transaction-kind';
import { WagerTransactionRow } from '../persistence/wager-transaction.row';
import { WalletRow } from '../../../wallet/infrastructure/persistence/wallet.row';
import { OutboxMessageRow } from '../../../outbox/infrastructure/persistence/outbox-message.row';

const AT = new Date('2026-01-01T00:00:00.000Z');
const WALLET_ID = '00000000-0000-0000-0000-000000000001';
const PLAYER_ID = '00000000-0000-0000-0000-000000000002';

/** Semeia uma wallet diretamente na tabela, sem passar por saveWithLedger —
 *  a orquestração completa de abertura (OPENING + WagerTransaction + ledger)
 *  fica para o CreateWalletUseCase, ainda não implementado. Este seed existe
 *  só para dar às integrações deste arquivo uma wallet pronta para debitar. */
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

describe('ProcessWagerTransactionUseCase — integration (real Postgres, real MikroORM wiring)', () => {
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

  function newUseCase(): ProcessWagerTransactionUseCase {
    const runner = new MikroOrmTransactionRunner(orm.em);
    return new ProcessWagerTransactionUseCase(runner, new UuidIdGenerator(), new FakeClock(AT), DEFAULT_REFERENCE_RETRY_POLICY);
  }

  it('processes a BET end-to-end: debits wallet, creates ledger, persists wager_transaction, enqueues 2 outbox rows', async () => {
    await seedWallet(orm, '100.00');
    const useCase = newUseCase();

    const result = await useCase.execute(betCommand());
    expect(result.kind).toBe('processed');

    const walletRow = await orm.em.fork().findOneOrFail(WalletRow, { id: WALLET_ID });
    expect(walletRow.balanceAmount).toBe('20.00');

    const txRow = await orm.em.fork().findOneOrFail(WagerTransactionRow, { idempotencyKey: 'provider-a:ext-1' });
    expect(txRow.status).toBe('PROCESSED');

    const outboxRows = await orm.em.fork().find(OutboxMessageRow, {});
    expect(outboxRows.map((r) => r.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  it('atomicity: a thrown error inside the transaction rolls back wallet, wager_transaction, AND outbox together', async () => {
    await seedWallet(orm, '100.00');

    const innerRunner = new MikroOrmTransactionRunner(orm.em);
    const brokenRunner: WageringTransactionRunner = {
      run: async <T,>(work: (uow: WageringUnitOfWork) => Promise<T>) =>
        innerRunner.run(async (uow) => {
          const originalEnqueue = uow.outbox.enqueue.bind(uow.outbox);
          let calls = 0;
          uow.outbox.enqueue = async (event) => {
            calls += 1;
            if (calls === 1) {
              throw new Error('Simulated crash right after wagerTransaction.create(), before outbox fully persists.');
            }
            return originalEnqueue(event);
          };
          return work(uow);
        }),
    };

    const useCase = new ProcessWagerTransactionUseCase(brokenRunner, new UuidIdGenerator(), new FakeClock(AT), DEFAULT_REFERENCE_RETRY_POLICY);

    await expect(useCase.execute(betCommand())).rejects.toThrow('Simulated crash');

    const walletRow = await orm.em.fork().findOneOrFail(WalletRow, { id: WALLET_ID });
    expect(walletRow.balanceAmount).toBe('100.00'); // unchanged — debit rolled back

    const txCount = await orm.em.fork().count(WagerTransactionRow, {});
    expect(txCount).toBe(0); // wager_transaction never committed

    const outboxCount = await orm.em.fork().count(OutboxMessageRow, {});
    expect(outboxCount).toBe(0); // no outbox row survived
  });

  it('real pessimistic lock under real concurrency: two connections racing 80.00 bets against 100.00 balance — exactly one succeeds', async () => {
    await seedWallet(orm, '100.00');

    const runnerA = new MikroOrmTransactionRunner(orm.em.fork());
    const runnerB = new MikroOrmTransactionRunner(orm.em.fork());
    const useCaseA = new ProcessWagerTransactionUseCase(runnerA, new UuidIdGenerator(), new FakeClock(AT), DEFAULT_REFERENCE_RETRY_POLICY);
    const useCaseB = new ProcessWagerTransactionUseCase(runnerB, new UuidIdGenerator(), new FakeClock(AT), DEFAULT_REFERENCE_RETRY_POLICY);

    const [resultA, resultB] = await Promise.all([
      useCaseA.execute(betCommand({ externalTransactionId: 'ext-A', idempotencyKey: 'provider-a:ext-A' })),
      useCaseB.execute(betCommand({ externalTransactionId: 'ext-B', idempotencyKey: 'provider-a:ext-B' })),
    ]);

    const kinds = [resultA.kind, resultB.kind].sort();
    expect(kinds).toEqual(['processed', 'rejected']); // exactly one PROCESSED, one REJECTED

    const walletRow = await orm.em.fork().findOneOrFail(WalletRow, { id: WALLET_ID });
    expect(walletRow.balanceAmount).toBe('20.00'); // final balance — only ONE debit applied

    const ledgerCount = await orm.em
      .fork()
      .getConnection()
      .execute(`select count(*)::int as count from wallet_ledger_entry where wallet_id = '${WALLET_ID}' and direction = 'DEBIT'`);
    expect(ledgerCount[0].count).toBe(1); // exactly one debit ledger entry — no retry duplicated it
  });

  it('rejects a REFUND whose reference is incompatible (different roundId) even when resolved on the first attempt', async () => {
    await seedWallet(orm, '100.00');
    const useCase = newUseCase();

    const bet = await useCase.execute(
      betCommand({ externalTransactionId: 'ext-bet', idempotencyKey: 'provider-a:ext-bet', roundId: 'round-1' }),
    );
    expect(bet.kind).toBe('processed');

    const refund = await useCase.execute(
      betCommand({
        kind: WagerTransactionKind.Refund,
        externalTransactionId: 'ext-refund',
        idempotencyKey: 'provider-a:ext-refund',
        referenceExternalTransactionId: 'ext-bet',
        roundId: 'round-DIFFERENT', // incompatible with the referenced BET's round
      }),
    );

    expect(refund.kind).toBe('rejected');
    expect(refund.transaction?.failureCode).toBe('IncompatibleReferenceError');

    const walletRow = await orm.em.fork().findOneOrFail(WalletRow, { id: WALLET_ID });
    expect(walletRow.balanceAmount).toBe('20.00'); // unchanged by the rejected refund — only the BET's debit applied
  });
});
