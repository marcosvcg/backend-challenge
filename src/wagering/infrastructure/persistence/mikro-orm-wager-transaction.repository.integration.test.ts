import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { createTestOrm, truncateAllTables } from '../../../shared/__test-support__/test-orm';
import { MikroOrmWagerTransactionRepository } from './mikro-orm-wager-transaction.repository';
import { WagerTransaction } from '../../domain/wager-transaction';
import { WagerTransactionKind } from '../../domain/wager-transaction-kind';
import { Money } from '../../../wallet/domain/money';
import { WagerTransactionRow } from './wager-transaction.row';

const AT = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2026-01-01T00:05:00.000Z');

/** Prova permanente, contra Postgres real, que WagerTransactionRepository.update()
 *  limpa colunas nullable (next_reference_retry_at) que o domínio deixou de
 *  preencher ao transicionar de estado, e persiste corretamente as que passam
 *  a ter valor (reference_transaction_id). A auditoria levantou como risco
 *  plausível que um payload de update construído por omissão condicional
 *  (`{...(x !== undefined ? {x} : {})}`, o padrão usado por
 *  wagerTransactionRowToDomain, embora nunca passado a em.assign()) deixaria
 *  colunas antigas sobreviverem — investigação confirmou que isso não ocorria
 *  na implementação vigente (wagerTransactionDomainToRow usa `new
 *  WagerTransactionRow()`, cujos campos de classe declarados existem como
 *  chaves próprias `undefined`, e o MikroORM já convertia isso para NULL no
 *  UPDATE). wagerTransactionDomainToUpdatePayload foi mantido mesmo assim,
 *  por clareza de intenção e para não depender dessa semântica incidental de
 *  class fields — ver ARCHITECTURE.md seção 20. */
describe('MikroOrmWagerTransactionRepository.update — nullable columns are actually cleared (real Postgres)', () => {
  let orm: MikroORM;
  let walletId: string;

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAllTables(orm);

    walletId = randomUUID();
    await orm.em.getConnection().execute(
      `insert into "wallet" (id, player_id, currency, balance_amount)
       values ('${walletId}', '${randomUUID()}', 'BRL', 100.00)`,
    );
  });

  it('PENDING_REFERENCE → PROCESSED: next_reference_retry_at goes from a real timestamp to NULL, reference_transaction_id goes from NULL to a real value', async () => {
    // The referenced BET must exist for real — wager_transaction_reference_fk
    // enforces this even mid-transaction.
    const referencedBet = WagerTransaction.create({
      id: randomUUID(),
      providerId: 'provider-a',
      externalTransactionId: 'ext-bet',
      idempotencyKey: 'provider-a:ext-bet',
      payloadHash: 'hash-bet',
      walletId,
      playerId: randomUUID(),
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      createdAt: AT,
    });
    referencedBet.markProcessed(undefined, Money.from({ amount: '70.00', currency: 'BRL' }), AT);
    await orm.em.fork().transactional(async (em) => {
      const repo = new MikroOrmWagerTransactionRepository(em);
      await repo.create(referencedBet);
    });
    const referencedTransactionId = referencedBet.id;

    // 1. create() a REFUND that starts PENDING_REFERENCE — next_reference_retry_at
    //    is set, reference_transaction_id is NULL (reference not resolved yet).
    const transaction = WagerTransaction.create({
      id: randomUUID(),
      providerId: 'provider-a',
      externalTransactionId: 'ext-refund',
      idempotencyKey: 'provider-a:ext-refund',
      payloadHash: 'hash-1',
      walletId,
      playerId: randomUUID(),
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'ext-bet',
      createdAt: AT,
    });
    transaction.markPendingReference(LATER);

    await orm.em.fork().transactional(async (em) => {
      const repo = new MikroOrmWagerTransactionRepository(em);
      await repo.create(transaction);
    });

    const afterCreate = await orm.em.fork().findOneOrFail(WagerTransactionRow, { id: transaction.id });
    expect(afterCreate.status).toBe('PENDING_REFERENCE');
    expect(afterCreate.nextReferenceRetryAt).toEqual(LATER);
    expect(afterCreate.referenceTransactionId).toBeNull();

    // 2. Reference resolved: transition PENDING_REFERENCE → PROCESSED.
    //    markProcessed() clears nextReferenceRetryAt in memory and sets
    //    referenceTransactionId — this test proves update() persists BOTH
    //    changes to Postgres, not just the domain object in memory.
    transaction.markProcessed(referencedTransactionId, Money.from({ amount: '130.00', currency: 'BRL' }), LATER);

    await orm.em.fork().transactional(async (em) => {
      const repo = new MikroOrmWagerTransactionRepository(em);
      await repo.update(transaction);
    });

    const afterUpdate = await orm.em.fork().findOneOrFail(WagerTransactionRow, { id: transaction.id });
    expect(afterUpdate.status).toBe('PROCESSED');
    expect(afterUpdate.nextReferenceRetryAt).toBeNull(); // <- the regression: must be NULL, not still LATER
    expect(afterUpdate.referenceTransactionId).toBe(referencedTransactionId); // <- newly set, persisted correctly

    // Direct SQL, bypassing the ORM's own hydration, as an independent check.
    const rows = await orm.em
      .fork()
      .getConnection()
      .execute(
        `select next_reference_retry_at, reference_transaction_id from wager_transaction where id = '${transaction.id}'`,
      );
    expect(rows[0].next_reference_retry_at).toBeNull();
    expect(rows[0].reference_transaction_id).toBe(referencedTransactionId);
  });

  it('failure_code and result_balance survive an update() that leaves them unchanged (no accidental clearing of untouched fields)', async () => {
    const transaction = WagerTransaction.create({
      id: randomUUID(),
      providerId: 'provider-a',
      externalTransactionId: 'ext-bet',
      idempotencyKey: 'provider-a:ext-bet',
      payloadHash: 'hash-1',
      walletId,
      playerId: randomUUID(),
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '999.00', currency: 'BRL' }),
      createdAt: AT,
    });
    transaction.reject('INSUFFICIENT_BALANCE', Money.from({ amount: '100.00', currency: 'BRL' }));

    await orm.em.fork().transactional(async (em) => {
      const repo = new MikroOrmWagerTransactionRepository(em);
      await repo.create(transaction);
    });

    const row = await orm.em.fork().findOneOrFail(WagerTransactionRow, { id: transaction.id });
    expect(row.status).toBe('REJECTED');
    expect(row.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(row.resultBalanceAmount).toBe('100.00');
  });
});
