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
 *  POST /wallets/:walletId/reconciliation — contrato HTTP, existência de
 *  wallet, e a garantia de que o endpoint nunca escreve nada. Os cenários de
 *  corrupção deliberada (invalid_anchor/broken_chain/balance_mismatch) já
 *  têm cobertura direta e determinística em reconcile-wallet.use-case.test.ts
 *  (com fakes) — não duplicados aqui via SQL bruto. */
describe('WalletController.reconcile — integration (real Nest app, real Postgres)', () => {
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

  it('a wallet with real, consistent history reports consistent: true with the exact README shape', async () => {
    const ctx = await createWallet('200.00'); // 1 entry: OPENING
    await submitBet(ctx, 'bet-1', '50.00').expect(200); // 1 entry: BET

    const response = await request(app.getHttpServer())
      .post(`/wallets/${ctx.walletId}/reconciliation`)
      .expect(200);

    expect(response.body).toEqual({
      walletId: ctx.walletId,
      storedBalance: { amount: '150.00', currency: 'BRL' },
      calculatedBalance: { amount: '150.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  it('a wallet with no ledger entries and zero balance reports consistent: true, checkedEntries: 0', async () => {
    const ctx = await createWallet('0.00');

    const response = await request(app.getHttpServer())
      .post(`/wallets/${ctx.walletId}/reconciliation`)
      .expect(200);

    expect(response.body).toEqual({
      walletId: ctx.walletId,
      storedBalance: { amount: '0.00', currency: 'BRL' },
      calculatedBalance: { amount: '0.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 0,
    });
  });

  it('a non-existent wallet returns 404', async () => {
    const response = await request(app.getHttpServer())
      .post(`/wallets/${randomUUID()}/reconciliation`)
      .expect(404);

    expect(response.body.statusCode).toBe(404);
  });

  it('a malformed walletId returns 400', async () => {
    const response = await request(app.getHttpServer()).post('/wallets/not-a-uuid/reconciliation').expect(400);

    expect(response.body.statusCode).toBe(400);
  });

  it('reconciliation never writes anything — wallet balance/version and ledger row count are unchanged before and after', async () => {
    const ctx = await createWallet('300.00');
    await submitBet(ctx, 'bet-2', '80.00').expect(200);

    const before = await request(app.getHttpServer()).get(`/wallets/${ctx.walletId}`).expect(200);
    const ledgerBefore = await request(app.getHttpServer()).get(`/wallets/${ctx.walletId}/ledger`).expect(200);

    await request(app.getHttpServer()).post(`/wallets/${ctx.walletId}/reconciliation`).expect(200);
    await request(app.getHttpServer()).post(`/wallets/${ctx.walletId}/reconciliation`).expect(200); // twice — still no side effect

    const after = await request(app.getHttpServer()).get(`/wallets/${ctx.walletId}`).expect(200);
    const ledgerAfter = await request(app.getHttpServer()).get(`/wallets/${ctx.walletId}/ledger`).expect(200);

    expect(after.body).toEqual(before.body); // balance AND version unchanged — no flush happened
    expect(ledgerAfter.body.entries).toEqual(ledgerBefore.body.entries); // no new ledger row inserted
  });
});
