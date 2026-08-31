import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../../app.module';
import { truncateAllTables } from '../../../shared/__test-support__/test-orm';

/** Sobe a AppModule real (mesma composition root de produção: MikroOrmModule,
 *  SharedModule, WagerTransactionController via WageringModule, ValidationPipe/
 *  DomainErrorFilter globais via APP_PIPE/APP_FILTER) contra o Postgres real
 *  do docker-compose — mesmo padrão de wallet.controller.integration.test.ts,
 *  deliberadamente sem reconfigurar pipe/filter manualmente aqui. Alvo:
 *  contrato HTTP → ValidationPipe → controller → DI/composition root →
 *  ProcessWagerTransactionUseCase (com origin: 'http') → Postgres — nunca as
 *  regras de domínio/idempotência/referência já cobertas em
 *  process-wager-transaction.use-case.test.ts e nos testes de integração
 *  existentes daquele use case. */
describe('WagerTransactionController — integration (real Nest app, real Postgres)', () => {
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

  function betPayload(overrides: Record<string, unknown> = {}, ctx: { walletId: string; playerId: string }) {
    return {
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      playerId: ctx.playerId,
      walletId: ctx.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
      ...overrides,
    };
  }

  it('processes a valid BET: 200, PROCESSED, balance reflects the debit', async () => {
    const ctx = await createWallet('100.00');
    const key = `provider-a:${randomUUID()}`;

    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(betPayload({}, ctx))
      .expect(200);

    expect(response.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '70.00', currency: 'BRL' },
      idempotentReplay: false,
    });
  });

  it('rejects a BET without enough balance: 200, REJECTED, with failureCode', async () => {
    const ctx = await createWallet('10.00');
    const key = `provider-a:${randomUUID()}`;

    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(betPayload({ money: { amount: '999.00', currency: 'BRL' } }, ctx))
      .expect(200);

    expect(response.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'InsufficientBalanceError',
      balance: { amount: '10.00', currency: 'BRL' }, // unchanged
    });
    expect(response.body.idempotentReplay).toBe(false);
  });

  it('a REFUND referencing a not-yet-existing BET returns 202 PENDING_REFERENCE, with no balance in the body', async () => {
    const ctx = await createWallet('100.00');
    const key = `provider-a:${randomUUID()}`;

    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(
        betPayload(
          {
            externalTransactionId: 'refund-1',
            kind: 'REFUND',
            money: { amount: '10.00', currency: 'BRL' },
            referenceExternalTransactionId: 'bet-does-not-exist-yet',
          },
          ctx,
        ),
      )
      .expect(202);

    expect(response.body.status).toBe('PENDING_REFERENCE');
    expect(response.body.balance).toBeUndefined();
    expect(response.body.idempotentReplay).toBe(false);
  });

  it('replay preserves the real transaction status in the HTTP status: PENDING_REFERENCE stays 202 across replays', async () => {
    const ctx = await createWallet('100.00');
    const key = `provider-a:${randomUUID()}`;
    const payload = betPayload(
      {
        externalTransactionId: 'refund-2',
        kind: 'REFUND',
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-still-missing',
      },
      ctx,
    );

    const first = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(202);
    expect(first.body.idempotentReplay).toBe(false);

    const replay = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(202); // still 202 — replay never hides that this is still pending

    expect(replay.body).toEqual({
      transactionId: first.body.transactionId,
      status: 'PENDING_REFERENCE',
      idempotentReplay: true,
    });
  });

  it('replay of a PROCESSED transaction returns 200 with idempotentReplay: true and the original result', async () => {
    const ctx = await createWallet('100.00');
    const key = `provider-a:${randomUUID()}`;
    const payload = betPayload({ externalTransactionId: 'bet-replay' }, ctx);

    const first = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(200);

    const replay = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(200);

    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  it('same Idempotency-Key with a different payload returns 409, not a replay', async () => {
    const ctx = await createWallet('100.00');
    const key = `provider-a:${randomUUID()}`;

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(betPayload({ externalTransactionId: 'bet-conflict' }, ctx))
      .expect(200);

    const conflict = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(betPayload({ externalTransactionId: 'bet-conflict', money: { amount: '99.00', currency: 'BRL' } }, ctx))
      .expect(409);

    expect(conflict.body.message).toContain(key);
  });

  it('rejects kind OPENING with 400 — OPENING can never be submitted externally', async () => {
    const ctx = await createWallet('100.00');

    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-a:${randomUUID()}`)
      .send(betPayload({ kind: 'OPENING', money: { amount: '50.00', currency: 'BRL' } }, ctx))
      .expect(400);

    expect(response.body.statusCode).toBe(400);
  });

  it('rejects a zero-amount money with 400 (wagering money must be strictly positive, unlike initialBalance)', async () => {
    const ctx = await createWallet('100.00');

    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-a:${randomUUID()}`)
      .send(betPayload({ money: { amount: '0.00', currency: 'BRL' } }, ctx))
      .expect(400);

    expect(response.body.statusCode).toBe(400);
  });

  it('rejects a negative money amount with 400', async () => {
    const ctx = await createWallet('100.00');

    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-a:${randomUUID()}`)
      .send(betPayload({ money: { amount: '-10.00', currency: 'BRL' } }, ctx))
      .expect(400);

    expect(response.body.statusCode).toBe(400);
  });

  it('rejects a BET carrying a referenceExternalTransactionId with 400 (BET must not reference anything)', async () => {
    const ctx = await createWallet('100.00');

    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-a:${randomUUID()}`)
      .send(betPayload({ referenceExternalTransactionId: 'whatever' }, ctx))
      .expect(400);

    expect(response.body.statusCode).toBe(400);
  });

  it('rejects a REFUND missing referenceExternalTransactionId with 400', async () => {
    const ctx = await createWallet('100.00');

    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-a:${randomUUID()}`)
      .send(betPayload({ kind: 'REFUND', money: { amount: '10.00', currency: 'BRL' } }, ctx))
      .expect(400);

    expect(response.body.statusCode).toBe(400);
  });

  it('rejects a request with no Idempotency-Key header with 400', async () => {
    const ctx = await createWallet('100.00');

    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .send(betPayload({}, ctx))
      .expect(400);

    expect(response.body.statusCode).toBe(400);
  });

  it('rejects an unknown extra field with 400 (forbidNonWhitelisted)', async () => {
    const ctx = await createWallet('100.00');

    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-a:${randomUUID()}`)
      .send({ ...betPayload({}, ctx), somethingUnexpected: 'nope' })
      .expect(400);

    expect(response.body.statusCode).toBe(400);
  });
});
