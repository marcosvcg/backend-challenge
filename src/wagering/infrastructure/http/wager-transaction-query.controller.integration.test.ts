import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../../app.module';
import { truncateAllTables } from '../../../shared/__test-support__/test-orm';

/** Mesmo padrão de wallet.controller.integration.test.ts e
 *  wager-transaction.controller.integration.test.ts: AppModule real,
 *  Postgres real, sem app.useGlobalPipes()/useGlobalFilters() manuais. Alvo:
 *  as duas rotas de consulta (WagerTransactionQueryController) — nunca
 *  duplica cobertura de regra de domínio/idempotência já existente. */
describe('WagerTransactionQueryController — integration (real Nest app, real Postgres)', () => {
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

  async function createWallet(balance = '100.00'): Promise<{ walletId: string; playerId: string }> {
    const playerId = randomUUID();
    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: balance, currency: 'BRL' } })
      .expect(201);
    return { walletId: response.body.id, playerId };
  }

  function submitBet(
    ctx: { walletId: string; playerId: string },
    externalTransactionId: string,
    overrides: Record<string, unknown> = {},
  ) {
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
        money: { amount: '30.00', currency: 'BRL' },
        ...overrides,
      });
  }

  it('GET /wagering/transactions/:transactionId returns 200 with the full shape for a PROCESSED transaction', async () => {
    const ctx = await createWallet('100.00');
    const submitted = await submitBet(ctx, 'bet-1').expect(200);

    const response = await request(app.getHttpServer())
      .get(`/wagering/transactions/${submitted.body.transactionId}`)
      .expect(200);

    expect(response.body).toEqual({
      id: submitted.body.transactionId,
      providerId: 'provider-a',
      externalTransactionId: 'bet-1',
      walletId: ctx.walletId,
      playerId: ctx.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      status: 'PROCESSED',
      money: { amount: '30.00', currency: 'BRL' },
      balance: { amount: '70.00', currency: 'BRL' },
      createdAt: expect.any(String),
      processedAt: expect.any(String),
    });
  });

  it('GET /wagering/transactions/:transactionId returns 404 for a well-formed id that does not exist', async () => {
    const response = await request(app.getHttpServer())
      .get(`/wagering/transactions/${randomUUID()}`)
      .expect(404);

    expect(response.body.statusCode).toBe(404);
  });

  it('GET /wagering/transactions/:transactionId returns 400 for a malformed id (not a UUID)', async () => {
    const response = await request(app.getHttpServer()).get('/wagering/transactions/not-a-uuid').expect(400);

    expect(response.body.statusCode).toBe(400);
  });

  it('GET /providers/:providerId/wagering/transactions/:externalTransactionId returns 200 for an existing transaction', async () => {
    const ctx = await createWallet('100.00');
    await submitBet(ctx, 'bet-2').expect(200);

    const response = await request(app.getHttpServer())
      .get('/providers/provider-a/wagering/transactions/bet-2')
      .expect(200);

    expect(response.body.providerId).toBe('provider-a');
    expect(response.body.externalTransactionId).toBe('bet-2');
    expect(response.body.status).toBe('PROCESSED');
  });

  it('GET /providers/:providerId/wagering/transactions/:externalTransactionId returns 404 when it does not exist — providerId/externalTransactionId are free-form, never 400', async () => {
    const response = await request(app.getHttpServer())
      .get('/providers/provider-a/wagering/transactions/does-not-exist')
      .expect(404);

    expect(response.body.statusCode).toBe(404);
  });

  it('a PENDING_REFERENCE transaction is queryable at 200, with balance/processedAt/failureCode absent from the body', async () => {
    const ctx = await createWallet('100.00');
    await submitBet(ctx, 'refund-1', {
      kind: 'REFUND',
      money: { amount: '5.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-missing',
    }).expect(202);

    const response = await request(app.getHttpServer())
      .get('/providers/provider-a/wagering/transactions/refund-1')
      .expect(200);

    expect(response.body.status).toBe('PENDING_REFERENCE');
    expect(response.body.balance).toBeUndefined();
    expect(response.body.processedAt).toBeUndefined();
    expect(response.body.failureCode).toBeUndefined();
    expect(response.body.referenceExternalTransactionId).toBe('bet-missing');
  });

  it('a REJECTED transaction is queryable at 200, with failureCode present', async () => {
    const ctx = await createWallet('10.00');
    const submitted = await submitBet(ctx, 'bet-overdraw', { money: { amount: '999.00', currency: 'BRL' } }).expect(
      200,
    );
    expect(submitted.body.status).toBe('REJECTED');

    const response = await request(app.getHttpServer())
      .get(`/wagering/transactions/${submitted.body.transactionId}`)
      .expect(200);

    expect(response.body.status).toBe('REJECTED');
    expect(response.body.failureCode).toBe('InsufficientBalanceError');
    expect(response.body.balance).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  it('the OPENING transaction generated by a wallet with a positive initial balance is queryable and returns kind: OPENING — blocked only at submission, never at query', async () => {
    const ctx = await createWallet('250.00');

    // OPENING nasce com providerId/externalTransactionId determinísticos a
    // partir do walletId (CreateWalletUseCase, ARCHITECTURE.md seção 19) —
    // nunca chega via API/fila, mas existe de fato no banco e é consultável.
    const byExternalId = await request(app.getHttpServer())
      .get(`/providers/internal/wagering/transactions/opening:${ctx.walletId}`)
      .expect(200);

    expect(byExternalId.body.kind).toBe('OPENING');
    expect(byExternalId.body.status).toBe('PROCESSED');
    expect(byExternalId.body.money).toEqual({ amount: '250.00', currency: 'BRL' });
    expect(byExternalId.body.balance).toEqual({ amount: '250.00', currency: 'BRL' });

    const byId = await request(app.getHttpServer())
      .get(`/wagering/transactions/${byExternalId.body.id}`)
      .expect(200);
    expect(byId.body.kind).toBe('OPENING');
  });
});
