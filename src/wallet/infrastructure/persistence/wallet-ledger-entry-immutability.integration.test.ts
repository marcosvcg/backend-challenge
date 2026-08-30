import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { createTestOrm, truncateAllTables } from '../../../shared/__test-support__/test-orm';

/** Prova, contra Postgres real, que a imutabilidade de wallet_ledger_entry é
 *  garantida pelo BANCO (trigger BEFORE UPDATE/DELETE), não apenas pela
 *  ausência de métodos de mutação na classe de domínio (isso já é coberto por
 *  wallet-ledger-entry.test.ts). UPDATE e DELETE são emitidos via SQL direto,
 *  contornando qualquer repositório — exatamente o cenário que a seção 5.9 do
 *  README exige (garantia no schema, não apenas em código de aplicação).
 *  ARCHITECTURE.md seção 8: constraint "wallet_ledger_entry_no_update"/"_no_delete". */
describe('wallet_ledger_entry immutability trigger — integration (real Postgres)', () => {
  let orm: MikroORM;
  let walletId: string;
  let transactionId: string;
  let entryId: string;

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    // TRUNCATE é apenas reset de fixtures entre testes — não faz parte da
    // invariante sendo testada aqui (essa é a asserção de UPDATE/DELETE abaixo).
    await truncateAllTables(orm);

    walletId = randomUUID();
    transactionId = randomUUID();
    entryId = randomUUID();

    const connection = orm.em.getConnection();
    await connection.execute(
      `insert into "wallet" (id, player_id, currency, balance_amount)
       values ('${walletId}', '${randomUUID()}', 'BRL', 80.00)`,
    );
    await connection.execute(
      `insert into "wager_transaction"
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount, currency, status,
          processed_at, result_balance_amount, result_balance_currency)
       values ('${transactionId}', 'p', 'e1', 'p:e1', 'h1', '${walletId}', '${randomUUID()}',
               'r1', 'g1', 'BET', 20.00, 'BRL', 'PROCESSED', now(), 80.00, 'BRL')`,
    );
    await connection.execute(
      `insert into "wallet_ledger_entry"
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       values ('${entryId}', '${walletId}', '${transactionId}', 'DEBIT', 20.00, 'BRL', 100.00, 80.00)`,
    );
  });

  it('rejects UPDATE via direct SQL, with an error raised by the immutability trigger', async () => {
    const connection = orm.em.getConnection();

    await expect(
      connection.execute(`update "wallet_ledger_entry" set amount = 999.00 where id = '${entryId}'`),
    ).rejects.toThrow(/wallet_ledger_entry is immutable/);
  });

  it('rejects DELETE via direct SQL, with an error raised by the immutability trigger', async () => {
    const connection = orm.em.getConnection();

    await expect(
      connection.execute(`delete from "wallet_ledger_entry" where id = '${entryId}'`),
    ).rejects.toThrow(/wallet_ledger_entry is immutable/);
  });

  it('the row survives untouched after a rejected UPDATE attempt', async () => {
    const connection = orm.em.getConnection();

    try {
      await connection.execute(`update "wallet_ledger_entry" set amount = 999.00 where id = '${entryId}'`);
    } catch {
      // esperado — a asserção real é sobre o estado da linha, não sobre o erro em si
    }

    const rows = await connection.execute(`select amount from "wallet_ledger_entry" where id = '${entryId}'`);
    expect(rows[0].amount).toBe('20.00'); // unchanged
  });

  it('the row survives untouched after a rejected DELETE attempt', async () => {
    const connection = orm.em.getConnection();

    try {
      await connection.execute(`delete from "wallet_ledger_entry" where id = '${entryId}'`);
    } catch {
      // esperado
    }

    const rows = await connection.execute(`select id from "wallet_ledger_entry" where id = '${entryId}'`);
    expect(rows.length).toBe(1); // still there
  });
});
