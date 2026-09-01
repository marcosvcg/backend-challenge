import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../app.module';
import { truncateAllTables } from '../../shared/__test-support__/test-orm';
import { setupTestInboundQueue } from '../../shared/__test-support__/test-inbound-queue';
import { WagerTransactionConsumer } from './messaging/wager-transaction.consumer';
import { ProcessWagerTransactionUseCase } from '../application/process-wager-transaction.use-case';
import { MikroOrmTransactionRunner } from './mikro-orm-transaction-runner';
import { UuidIdGenerator } from '../../shared/infrastructure/uuid-id-generator';
import { SystemClock } from '../../shared/infrastructure/system-clock';
import { DEFAULT_REFERENCE_RETRY_POLICY } from '../application/reference-retry-policy';
import { WagerTransactionRow } from './persistence/wager-transaction.row';

function sqsClient(): SQSClient {
  return new SQSClient({
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    region: process.env.SQS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
}

/** Mensagem SQS carregando exatamente o mesmo payload lógico de negócio de um
 *  betPayload() HTTP (mesma providerId/externalTransactionId/playerId/
 *  walletId/roundId/gameId/kind/money) — a prova de cross-transport
 *  idempotency depende de os dois payloads serem logicamente idênticos, só
 *  representados no shape de cada transporte. */
function betMessageBodyMatching(payload: {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
}, idempotencyKey: string): string {
  return JSON.stringify({
    messageId: randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...payload, idempotencyKey },
  });
}

/** Prova o requisito central do hardening SQS (ponto 3): a mesma transação
 *  lógica, com a mesma Idempotency-Key, enviada uma vez por HTTP e depois por
 *  SQS (ou vice-versa) deve ser tratada como UM único efeito financeiro
 *  (replay), nunca dois débitos/créditos nem um conflito falso — e payload
 *  logicamente diferente sob a mesma key deve ser conflict, cross-transport,
 *  exatamente como já é dentro de um único transporte. Antes da correção
 *  (mapper SQS hasheando `data` inteiro, incluindo idempotencyKey), o mesmo
 *  payload lógico produzia hashes diferentes por transporte — confirmado
 *  empiricamente durante a auditoria deste incremento — o que faria o
 *  segundo envio (SQS) colidir como idempotencyConflict em vez de replay. */
describe('Cross-transport idempotency — HTTP and SQS share the same canonical payload hash (real Postgres + real LocalStack SQS + real Nest app)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let queueUrl: string;
  let consumer: WagerTransactionConsumer;
  const client = sqsClient();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    orm = moduleRef.get(MikroORM);

    const queues = await setupTestInboundQueue();
    queueUrl = queues.queueUrl;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAllTables(orm);
    const runner = new MikroOrmTransactionRunner(orm.em);
    const useCase = new ProcessWagerTransactionUseCase(
      runner,
      new UuidIdGenerator(),
      new SystemClock(),
      DEFAULT_REFERENCE_RETRY_POLICY,
    );
    // waitTimeSeconds = 1: mesmo padrão de wager-transaction.consumer.integration.test.ts —
    // mantém stop() rápido e determinístico.
    consumer = new WagerTransactionConsumer(sqsClient(), queueUrl, useCase, undefined, 1);
  });

  afterEach(async () => {
    await consumer.stop();
  });

  async function createWallet(balance = '100.00'): Promise<{ walletId: string; playerId: string }> {
    const playerId = randomUUID();
    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: balance, currency: 'BRL' } })
      .expect(201);
    return { walletId: response.body.id, playerId };
  }

  it('HTTP first, then SQS with the same key and the same logical payload: SQS delivery replays — single debit, single WagerTransaction row', async () => {
    const ctx = await createWallet('100.00');
    const externalTransactionId = randomUUID();
    const idempotencyKey = `provider-a:${externalTransactionId}`;
    const payload = {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: ctx.playerId,
      walletId: ctx.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    };

    const httpResponse = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', idempotencyKey)
      .send(payload)
      .expect(200);
    expect(httpResponse.body.status).toBe('PROCESSED');
    expect(httpResponse.body.balance).toEqual({ amount: '70.00', currency: 'BRL' });

    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: betMessageBodyMatching(payload, idempotencyKey),
        MessageGroupId: randomUUID(),
        MessageDeduplicationId: randomUUID(),
      }),
    );
    consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await consumer.stop();

    const txRows = await orm.em.fork().find(WagerTransactionRow, { idempotencyKey });
    expect(txRows).toHaveLength(1); // the SQS delivery replayed — never created a second row

    const walletAfter = await request(app.getHttpServer()).get(`/wallets/${ctx.walletId}`).expect(200);
    expect(walletAfter.body.balance).toEqual({ amount: '70.00', currency: 'BRL' }); // debited exactly once, not twice
  }, 15000);

  it('SQS first, then HTTP with the same key and the same logical payload: HTTP replays — single debit, single WagerTransaction row', async () => {
    const ctx = await createWallet('100.00');
    const externalTransactionId = randomUUID();
    const idempotencyKey = `provider-a:${externalTransactionId}`;
    const payload = {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: ctx.playerId,
      walletId: ctx.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    };

    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: betMessageBodyMatching(payload, idempotencyKey),
        MessageGroupId: randomUUID(),
        MessageDeduplicationId: randomUUID(),
      }),
    );
    consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await consumer.stop();

    const afterSqs = await orm.em.fork().find(WagerTransactionRow, { idempotencyKey });
    expect(afterSqs).toHaveLength(1);

    const httpResponse = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', idempotencyKey)
      .send(payload)
      .expect(200);
    expect(httpResponse.body.status).toBe('PROCESSED');
    expect(httpResponse.body.idempotentReplay).toBe(true); // HTTP recognized the SQS-created transaction as a replay

    const txRows = await orm.em.fork().find(WagerTransactionRow, { idempotencyKey });
    expect(txRows).toHaveLength(1); // still exactly one row

    const walletAfter = await request(app.getHttpServer()).get(`/wallets/${ctx.walletId}`).expect(200);
    expect(walletAfter.body.balance).toEqual({ amount: '70.00', currency: 'BRL' });
  }, 15000);

  it('HTTP first, then SQS with the same key but a DIFFERENT logical payload: cross-transport conflict, never applied as a second transaction', async () => {
    const ctx = await createWallet('100.00');
    const externalTransactionId = randomUUID();
    const idempotencyKey = `provider-a:${externalTransactionId}`;
    const httpPayload = {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: ctx.playerId,
      walletId: ctx.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    };
    const conflictingPayload = { ...httpPayload, money: { amount: '99.00', currency: 'BRL' } }; // same key, different amount

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', idempotencyKey)
      .send(httpPayload)
      .expect(200);

    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: betMessageBodyMatching(conflictingPayload, idempotencyKey),
        MessageGroupId: randomUUID(),
        MessageDeduplicationId: randomUUID(),
      }),
    );
    consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await consumer.stop();

    // idempotency-conflict is ackable (README/ARCHITECTURE: a producer error,
    // not a transient one — retrying the exact same conflicting payload would
    // never succeed) but never creates a second WagerTransaction row nor
    // moves any balance.
    const txRows = await orm.em.fork().find(WagerTransactionRow, { idempotencyKey });
    expect(txRows).toHaveLength(1); // still only the original HTTP transaction

    const walletAfter = await request(app.getHttpServer()).get(`/wallets/${ctx.walletId}`).expect(200);
    expect(walletAfter.body.balance).toEqual({ amount: '70.00', currency: 'BRL' }); // only the original 30.00 debit applied
  }, 15000);
});
