import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../../app.module';
import { truncateAllTables } from '../../../shared/__test-support__/test-orm';
import { METRICS } from '../../../shared/infrastructure/shared.tokens';
import { FakeMetrics } from '../../../wallet/application/__fakes__/fake-metrics';
import {
  WAGER_TRANSACTIONS_TOTAL,
  WAGER_TRANSACTION_DUPLICATES_TOTAL,
  WAGER_TRANSACTION_PROCESSING_DURATION_SECONDS,
} from '../../application/wagering-metrics';
import { WALLET_LOCK_ACQUISITION_DURATION_SECONDS } from '../../../wallet/application/wallet-lock-metric';

/** Arquivo NOVO e dedicado — não altera wager-transaction.controller.integration.test.ts
 *  (regra explícita do usuário: testes HTTP existentes não devem ser
 *  alterados só para provar lifecycle/observabilidade). Mesma composition
 *  root real (AppModule, Postgres real), mas com METRICS override para
 *  FakeMetrics via .overrideProvider — prova o CONTRATO de instrumentação
 *  (o quê incrementa/observa e com quais labels), nunca a lógica de domínio
 *  já coberta pelos testes de process-wager-transaction.use-case e pelo
 *  arquivo de integração HTTP original (ARCHITECTURE.md seção 31). */
describe('WagerTransaction HTTP — metrics instrumentation (real Nest app, real Postgres, FakeMetrics)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let metrics: FakeMetrics;

  beforeAll(async () => {
    metrics = new FakeMetrics();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(METRICS)
      .useValue(metrics)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();

    orm = moduleRef.get(MikroORM);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAllTables(orm);
    metrics.reset();
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

  it('a PROCESSED bet increments wager_transactions_total{status:processed,origin:http} exactly once and observes the duration histogram', async () => {
    const ctx = await createWallet('100.00');
    const key = `provider-a:${randomUUID()}`;

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(betPayload({}, ctx))
      .expect(200);

    const totalIncrements = metrics
      .getIncrements()
      .filter((c) => c.name === WAGER_TRANSACTIONS_TOTAL);
    expect(totalIncrements).toEqual([{ name: WAGER_TRANSACTIONS_TOTAL, labels: { status: 'processed', origin: 'http' } }]);

    const durationObservations = metrics
      .getHistogramObservations()
      .filter((h) => h.name === WAGER_TRANSACTION_PROCESSING_DURATION_SECONDS);
    expect(durationObservations).toHaveLength(1);
    expect(durationObservations[0].labels).toEqual({ origin: 'http' });
    expect(durationObservations[0].valueSeconds).toBeGreaterThanOrEqual(0);
  });

  it('a REJECTED bet increments wager_transactions_total{status:rejected,origin:http}', async () => {
    const ctx = await createWallet('10.00');
    const key = `provider-a:${randomUUID()}`;

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(betPayload({ money: { amount: '999.00', currency: 'BRL' } }, ctx))
      .expect(200);

    const totalIncrements = metrics
      .getIncrements()
      .filter((c) => c.name === WAGER_TRANSACTIONS_TOTAL);
    expect(totalIncrements).toEqual([{ name: WAGER_TRANSACTIONS_TOTAL, labels: { status: 'rejected', origin: 'http' } }]);
  });

  it('replay of a PROCESSED transaction does NOT re-increment wager_transactions_total, but does increment wager_transaction_duplicates_total', async () => {
    const ctx = await createWallet('100.00');
    const key = `provider-a:${randomUUID()}`;
    const payload = betPayload({ externalTransactionId: 'bet-replay-metrics' }, ctx);

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(200);

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(200);

    const totalIncrements = metrics
      .getIncrements()
      .filter((c) => c.name === WAGER_TRANSACTIONS_TOTAL);
    expect(totalIncrements).toHaveLength(1); // only the original processing, never the replay

    const duplicateIncrements = metrics
      .getIncrements()
      .filter((c) => c.name === WAGER_TRANSACTION_DUPLICATES_TOTAL);
    expect(duplicateIncrements).toEqual([{ name: WAGER_TRANSACTION_DUPLICATES_TOTAL, labels: { origin: 'http' } }]);
  });

  it('a PROCESSED bet observes wallet_lock_acquisition_duration_seconds (the pessimistic lock was acquired)', async () => {
    const ctx = await createWallet('100.00');
    const key = `provider-a:${randomUUID()}`;

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(betPayload({}, ctx))
      .expect(200);

    const lockObservations = metrics
      .getHistogramObservations()
      .filter((h) => h.name === WALLET_LOCK_ACQUISITION_DURATION_SECONDS);
    expect(lockObservations.length).toBeGreaterThanOrEqual(1);
    for (const obs of lockObservations) {
      expect(obs.valueSeconds).toBeGreaterThanOrEqual(0);
    }
  });

  it('a 400 validation failure (rejected before reaching the use case) never touches wager_transactions_total', async () => {
    const ctx = await createWallet('100.00');

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-a:${randomUUID()}`)
      .send(betPayload({ kind: 'OPENING', money: { amount: '50.00', currency: 'BRL' } }, ctx))
      .expect(400);

    expect(metrics.getIncrements().filter((c) => c.name === WAGER_TRANSACTIONS_TOTAL)).toHaveLength(0);
  });
});
