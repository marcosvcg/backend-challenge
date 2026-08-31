import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../../app.module';
import { truncateAllTables } from '../../../shared/__test-support__/test-orm';

/** Mesmo padrão de wallet.controller.integration.test.ts: AppModule real,
 *  Postgres real, sem app.useGlobalPipes()/useGlobalFilters() manuais. Alvo:
 *  GET /wallets/:walletId/ledger — paginação por cursor, ordenação
 *  (created_at, id), comportamento de borda. Nunca duplica cobertura de
 *  regra financeira já existente (wallet.test.ts, process-wager-transaction
 *  integration tests). */
describe('WalletController.getLedger — integration (real Nest app, real Postgres)', () => {
  let app: INestApplication;
  let orm: MikroORM;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    orm = moduleRef.get(MikroORM);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAllTables(orm);
  });

  async function createWallet(balance = '0.00'): Promise<{ walletId: string; playerId: string }> {
    const playerId = randomUUID();
    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: balance, currency: 'BRL' } })
      .expect(201);
    return { walletId: response.body.id, playerId };
  }

  function submitBet(ctx: { walletId: string; playerId: string }, externalTransactionId: string, amount: string) {
    return request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-a:${externalTransactionId}`)
      .send({
        providerId: 'provider-a',
        externalTransactionId,
        playerId: ctx.playerId,
        walletId: ctx.walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount, currency: 'BRL' },
      });
  }

  /** 5 lançamentos: OPENING (créditodo saldo inicial) + 4 BETs sequenciais —
   *  suficiente saldo inicial para não rejeitar nenhum por saldo insuficiente. */
  async function seedFiveLedgerEntries(): Promise<{ walletId: string; playerId: string }> {
    const ctx = await createWallet('1000.00'); // gera o lançamento 1 (OPENING)
    await submitBet(ctx, 'bet-1', '10.00').expect(200); // lançamento 2
    await submitBet(ctx, 'bet-2', '20.00').expect(200); // lançamento 3
    await submitBet(ctx, 'bet-3', '30.00').expect(200); // lançamento 4
    await submitBet(ctx, 'bet-4', '40.00').expect(200); // lançamento 5
    return ctx;
  }

  it('returns the first page in chronological order with a nextCursor when more entries exist', async () => {
    const ctx = await seedFiveLedgerEntries();

    const response = await request(app.getHttpServer()).get(`/wallets/${ctx.walletId}/ledger?limit=3`).expect(200);

    expect(response.body.entries).toHaveLength(3);
    expect(response.body.entries[0].direction).toBe('CREDIT'); // OPENING first — chronological order
    expect(response.body.nextCursor).toEqual(expect.any(String));

    // createdAt strictly non-decreasing across the page — ASC order held.
    const timestamps = response.body.entries.map((e: { createdAt: string }) => new Date(e.createdAt).getTime());
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });

  it('following nextCursor continues exactly where the previous page stopped — no gap, no repeat', async () => {
    const ctx = await seedFiveLedgerEntries();

    const page1 = await request(app.getHttpServer()).get(`/wallets/${ctx.walletId}/ledger?limit=3`).expect(200);
    expect(page1.body.entries).toHaveLength(3);
    expect(page1.body.nextCursor).not.toBeNull();

    const page2 = await request(app.getHttpServer())
      .get(`/wallets/${ctx.walletId}/ledger?limit=3&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
      .expect(200);
    expect(page2.body.entries).toHaveLength(2); // remaining 2 of the 5 total
    expect(page2.body.nextCursor).toBeNull();

    const page1Ids = page1.body.entries.map((e: { id: string }) => e.id);
    const page2Ids = page2.body.entries.map((e: { id: string }) => e.id);
    expect(new Set([...page1Ids, ...page2Ids]).size).toBe(5); // no duplicate across pages
  });

  it('the final page returns nextCursor: null', async () => {
    const ctx = await seedFiveLedgerEntries();

    const response = await request(app.getHttpServer()).get(`/wallets/${ctx.walletId}/ledger?limit=50`).expect(200);

    expect(response.body.entries).toHaveLength(5);
    expect(response.body.nextCursor).toBeNull();
  });

  it('a wallet with no ledger entries returns 200 with an empty list', async () => {
    const ctx = await createWallet('0.00'); // no OPENING generated for zero initial balance

    const response = await request(app.getHttpServer()).get(`/wallets/${ctx.walletId}/ledger`).expect(200);

    expect(response.body).toEqual({ entries: [], nextCursor: null });
  });

  it('a non-existent wallet returns 404', async () => {
    const response = await request(app.getHttpServer()).get(`/wallets/${randomUUID()}/ledger`).expect(404);

    expect(response.body.statusCode).toBe(404);
  });

  it('a malformed walletId returns 400', async () => {
    const response = await request(app.getHttpServer()).get('/wallets/not-a-uuid/ledger').expect(400);

    expect(response.body.statusCode).toBe(400);
  });

  it('a malformed cursor returns 400', async () => {
    const ctx = await createWallet('100.00');

    const response = await request(app.getHttpServer())
      .get(`/wallets/${ctx.walletId}/ledger?cursor=not-a-valid-cursor`)
      .expect(400);

    expect(response.body.statusCode).toBe(400);
  });

  it('an invalid limit (zero, negative, non-integer, non-numeric, or above the maximum) returns 400', async () => {
    const ctx = await createWallet('100.00');

    for (const invalidLimit of ['0', '-5', '1.5', 'abc', '201']) {
      const response = await request(app.getHttpServer())
        .get(`/wallets/${ctx.walletId}/ledger?limit=${invalidLimit}`)
        .expect(400);
      expect(response.body.statusCode).toBe(400);
    }
  });

  it('limit=200 (the maximum) is accepted', async () => {
    const ctx = await createWallet('100.00');

    await request(app.getHttpServer()).get(`/wallets/${ctx.walletId}/ledger?limit=200`).expect(200);
  });

  it('no cursor/limit in the query uses the defaults correctly', async () => {
    const ctx = await seedFiveLedgerEntries();

    const response = await request(app.getHttpServer()).get(`/wallets/${ctx.walletId}/ledger`).expect(200);

    expect(response.body.entries).toHaveLength(5); // all 5 fit under DEFAULT_LEDGER_LIMIT (50)
    expect(response.body.nextCursor).toBeNull();
  });

  /** Regressão específica para o off-by-one já corrigido durante a proposta
   *  deste incremento: se o nextCursor fosse montado a partir da linha
   *  limit+1 (buscada só para detectar se há próxima página, nunca
   *  entregue), a página seguinte pularia exatamente essa linha — ela seria
   *  usada como ponto de corte "> cursor" sem nunca ter aparecido em nenhuma
   *  resposta. 5 entradas, limit=2: página 1 → itens 1,2; página 2 →
   *  itens 3,4; página 3 → item 5 — a concatenação das 3 páginas precisa
   *  conter exatamente os 5 IDs, na ordem, sem duplicação nem ausência. */
  it('paginating 5 entries with limit=2 across 3 pages yields exactly the 5 ids, in order, with no gap or duplicate (off-by-one regression)', async () => {
    const ctx = await seedFiveLedgerEntries();

    const page1 = await request(app.getHttpServer()).get(`/wallets/${ctx.walletId}/ledger?limit=2`).expect(200);
    expect(page1.body.entries).toHaveLength(2);
    expect(page1.body.nextCursor).not.toBeNull();

    const page2 = await request(app.getHttpServer())
      .get(`/wallets/${ctx.walletId}/ledger?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
      .expect(200);
    expect(page2.body.entries).toHaveLength(2);
    expect(page2.body.nextCursor).not.toBeNull();

    const page3 = await request(app.getHttpServer())
      .get(`/wallets/${ctx.walletId}/ledger?limit=2&cursor=${encodeURIComponent(page2.body.nextCursor)}`)
      .expect(200);
    expect(page3.body.entries).toHaveLength(1);
    expect(page3.body.nextCursor).toBeNull();

    const allIds = [...page1.body.entries, ...page2.body.entries, ...page3.body.entries].map(
      (e: { id: string }) => e.id,
    );
    expect(allIds).toHaveLength(5);
    expect(new Set(allIds).size).toBe(5); // no duplicates

    // The full, unpaginated read (limit=50) must match the same 5 ids in the
    // same order — the concatenation of pages is not just "5 unique ids",
    // it is exactly the same sequence a single unpaginated read would give.
    const full = await request(app.getHttpServer()).get(`/wallets/${ctx.walletId}/ledger?limit=50`).expect(200);
    const fullIds = full.body.entries.map((e: { id: string }) => e.id);
    expect(allIds).toEqual(fullIds);
  });
});
