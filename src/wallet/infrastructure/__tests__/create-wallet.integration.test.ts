import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, truncateAllTables } from '../../../shared/__test-support__/test-orm';
import { UuidIdGenerator } from '../../../shared/__test-support__/uuid-id-generator';
import { MikroOrmCreateWalletTransactionRunner } from '../mikro-orm-create-wallet-transaction-runner';
import { CreateWalletUseCase } from '../../application/create-wallet.use-case';
import { CreateWalletCommand } from '../../application/create-wallet.command';
import { CreateWalletTransactionRunner, CreateWalletUnitOfWork } from '../../application/ports/create-wallet-unit-of-work';
import { FakeClock } from '../../../wagering/application/__fakes__/fake-clock';
import { Money } from '../../domain/money';
import { WalletRow } from '../persistence/wallet.row';
import { WagerTransactionRow } from '../../../wagering/infrastructure/persistence/wager-transaction.row';
import { OutboxMessageRow } from '../../../outbox/infrastructure/persistence/outbox-message.row';
import { randomUUID } from 'node:crypto';

const AT = new Date('2026-01-01T00:00:00.000Z');

function createWalletCommand(overrides: Partial<CreateWalletCommand> = {}): CreateWalletCommand {
  return {
    playerId: randomUUID(),
    currency: 'BRL',
    initialBalance: Money.zero('BRL'),
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('CreateWalletUseCase — integration (real Postgres, real MikroORM wiring)', () => {
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

  function newUseCase(): CreateWalletUseCase {
    const runner = new MikroOrmCreateWalletTransactionRunner(orm.em);
    return new CreateWalletUseCase(runner, new UuidIdGenerator(), new FakeClock(AT));
  }

  it('creates a wallet with zero balance: no OPENING transaction, no outbox events', async () => {
    const useCase = newUseCase();
    const playerId = randomUUID();

    const result = await useCase.execute(createWalletCommand({ playerId, initialBalance: Money.zero('BRL') }));

    expect(result.kind).toBe('created');

    const walletRow = await orm.em.fork().findOneOrFail(WalletRow, { id: result.wallet!.id });
    expect(walletRow.balanceAmount).toBe('0.00');
    expect(walletRow.version).toBe(1);

    const txCount = await orm.em.fork().count(WagerTransactionRow, { walletId: result.wallet!.id });
    expect(txCount).toBe(0); // no OPENING transaction for zero balance

    const outboxCount = await orm.em.fork().count(OutboxMessageRow, { aggregateId: result.wallet!.id });
    expect(outboxCount).toBe(0);
  });

  it('creates a wallet with a positive initial balance: OPENING transaction PROCESSED, ledger credit, 2 outbox events', async () => {
    const useCase = newUseCase();
    const playerId = randomUUID();

    const result = await useCase.execute(
      createWalletCommand({ playerId, initialBalance: Money.from({ amount: '1000.00', currency: 'BRL' }) }),
    );

    expect(result.kind).toBe('created');

    const walletRow = await orm.em.fork().findOneOrFail(WalletRow, { id: result.wallet!.id });
    expect(walletRow.balanceAmount).toBe('1000.00');
    expect(walletRow.version).toBe(2); // 1 (open) + 1 (credit)

    const txRow = await orm.em.fork().findOneOrFail(WagerTransactionRow, { walletId: result.wallet!.id });
    expect(txRow.kind).toBe('OPENING');
    expect(txRow.status).toBe('PROCESSED');
    expect(txRow.providerId).toBe('internal');
    expect(txRow.resultBalanceAmount).toBe('1000.00');

    const connection = orm.em.fork().getConnection();
    const ledgerRows = await connection.execute(
      `select direction, amount, balance_before, balance_after from wallet_ledger_entry where wallet_id = '${result.wallet!.id}'`,
    );
    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0].direction).toBe('CREDIT');
    expect(ledgerRows[0].amount).toBe('1000.00');
    expect(ledgerRows[0].balance_before).toBe('0.00');
    expect(ledgerRows[0].balance_after).toBe('1000.00');

    const outboxRows = await orm.em.fork().find(OutboxMessageRow, { aggregateId: result.wallet!.id });
    expect(outboxRows.map((r) => r.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  it('atomicity: a thrown error inside the transaction rolls back wallet, OPENING transaction, and outbox together', async () => {
    const innerRunner = new MikroOrmCreateWalletTransactionRunner(orm.em);
    const brokenRunner: CreateWalletTransactionRunner = {
      run: async <T,>(work: (uow: CreateWalletUnitOfWork) => Promise<T>) =>
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

    const useCase = new CreateWalletUseCase(brokenRunner, new UuidIdGenerator(), new FakeClock(AT));
    const playerId = randomUUID();

    await expect(
      useCase.execute(createWalletCommand({ playerId, initialBalance: Money.from({ amount: '500.00', currency: 'BRL' }) })),
    ).rejects.toThrow('Simulated crash');

    const walletCount = await orm.em.fork().count(WalletRow, { playerId });
    expect(walletCount).toBe(0); // wallet never committed

    const txCount = await orm.em.fork().count(WagerTransactionRow, {});
    expect(txCount).toBe(0); // OPENING transaction never committed

    const outboxCount = await orm.em.fork().count(OutboxMessageRow, {});
    expect(outboxCount).toBe(0); // no outbox row survived
  });

  it('real concurrency: two connections racing to create a wallet for the SAME playerId+currency — exactly one succeeds', async () => {
    const playerId = randomUUID();

    const runnerA = new MikroOrmCreateWalletTransactionRunner(orm.em.fork());
    const runnerB = new MikroOrmCreateWalletTransactionRunner(orm.em.fork());
    const useCaseA = new CreateWalletUseCase(runnerA, new UuidIdGenerator(), new FakeClock(AT));
    const useCaseB = new CreateWalletUseCase(runnerB, new UuidIdGenerator(), new FakeClock(AT));

    const [resultA, resultB] = await Promise.all([
      useCaseA.execute(createWalletCommand({ playerId, initialBalance: Money.zero('BRL') })),
      useCaseB.execute(createWalletCommand({ playerId, initialBalance: Money.zero('BRL') })),
    ]);

    const kinds = [resultA.kind, resultB.kind].sort();
    expect(kinds).toEqual(['conflict', 'created']); // exactly one created, one conflict — never both created

    const walletCount = await orm.em.fork().count(WalletRow, { playerId, currency: 'BRL' });
    expect(walletCount).toBe(1); // UNIQUE(player_id, currency) — never two rows
  });
});
