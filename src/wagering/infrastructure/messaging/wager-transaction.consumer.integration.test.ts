import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { createTestOrm, truncateAllTables } from '../../../shared/__test-support__/test-orm';
import { setupTestInboundQueue } from '../../../shared/__test-support__/test-inbound-queue';
import { WagerTransactionConsumer, WagerTransactionConsumerLogger } from './wager-transaction.consumer';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.use-case';
import { MikroOrmTransactionRunner } from '../mikro-orm-transaction-runner';
import { UuidIdGenerator } from '../../../shared/__test-support__/uuid-id-generator';
import { FakeClock } from '../../application/__fakes__/fake-clock';
import { DEFAULT_REFERENCE_RETRY_POLICY } from '../../application/reference-retry-policy';
import { Wallet } from '../../../wallet/domain/wallet';
import { Money } from '../../../wallet/domain/money';
import { WalletRow } from '../../../wallet/infrastructure/persistence/wallet.row';
import { WagerTransactionRow } from '../persistence/wager-transaction.row';

const AT = new Date('2026-01-01T00:00:00.000Z');

function silentLogger(): WagerTransactionConsumerLogger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

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

async function seedWallet(orm: MikroORM, balance = '100.00'): Promise<string> {
  const walletId = randomUUID();
  const wallet = Wallet.open({ id: walletId, playerId: randomUUID(), currency: 'BRL', at: AT });
  if (balance !== '0.00') {
    wallet.credit(Money.from({ amount: balance, currency: 'BRL' }), 'tx-opening', 'entry-opening', AT);
  }
  await orm.em.getConnection().execute(
    `insert into wallet (id, player_id, currency, balance_amount, version) values ('${wallet.id}', '${wallet.playerId}', 'BRL', ${wallet.balance.toJSON().amount}, ${wallet.version})`,
  );
  return walletId;
}

function betMessageBody(overrides: {
  walletId: string;
  playerId?: string;
  externalTransactionId?: string;
  amount?: string;
}): string {
  const externalTransactionId = overrides.externalTransactionId ?? randomUUID();
  return JSON.stringify({
    messageId: randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: AT.toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: overrides.playerId ?? randomUUID(),
      walletId: overrides.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: overrides.amount ?? '30.00', currency: 'BRL' },
    },
  });
}

/** Polling helper: queues used across this describe block accumulate
 *  messages from earlier test runs (never purged) — always filter by a
 *  specific field instead of assuming the first/only message is the one
 *  this test produced. */
async function findByExternalTransactionId(
  client: SQSClient,
  queueUrl: string,
  externalTransactionId: string,
  attempts = 5,
): Promise<Record<string, unknown> | undefined> {
  for (let i = 0; i < attempts; i += 1) {
    const received = await client.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }),
    );
    const bodies = (received.Messages ?? []).map((m) => JSON.parse(m.Body!));
    const found = bodies.find((b) => b.data?.externalTransactionId === externalTransactionId);
    if (found) return found;
  }
  return undefined;
}

describe('WagerTransactionConsumer — integration (real Postgres + real LocalStack SQS)', () => {
  let orm: MikroORM;
  let queueUrl: string;
  let dlqUrl: string;

  beforeAll(async () => {
    orm = await createTestOrm();
    const queues = await setupTestInboundQueue();
    queueUrl = queues.queueUrl;
    dlqUrl = queues.dlqUrl;
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAllTables(orm);
  });

  function newConsumer(): WagerTransactionConsumer {
    const runner = new MikroOrmTransactionRunner(orm.em);
    const useCase = new ProcessWagerTransactionUseCase(
      runner,
      new UuidIdGenerator(),
      new FakeClock(AT),
      DEFAULT_REFERENCE_RETRY_POLICY,
    );
    // waitTimeSeconds = 1: mantém stop() rápido e determinístico nos testes —
    // produção/dev usa o default de 10s (ver wager-transaction.consumer.ts).
    return new WagerTransactionConsumer(sqsClient(), queueUrl, useCase, silentLogger(), 1);
  }

  it('processes a valid BET message and ACKs it (debits wallet, message leaves the queue)', async () => {
    const walletId = await seedWallet(orm, '100.00');
    const client = sqsClient();
    const groupId = randomUUID();
    const externalTransactionId = randomUUID();
    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: betMessageBody({ walletId, externalTransactionId }),
        MessageGroupId: groupId,
        MessageDeduplicationId: randomUUID(),
      }),
    );

    const consumer = newConsumer();
    consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 800)); // let one poll cycle process the message
    await consumer.stop(); // returns quickly — waitTimeSeconds is 1 for this consumer

    const walletRow = await orm.em.fork().findOneOrFail(WalletRow, { id: walletId });
    expect(walletRow.balanceAmount).toBe('70.00');

    // This SPECIFIC message must be gone — the queue may still hold unrelated
    // messages from other tests in this describe block (never purged).
    const stillThere = await findByExternalTransactionId(client, queueUrl, externalTransactionId, 1);
    expect(stillThere).toBeUndefined(); // ACKed — no longer on the queue
  }, 10000);

  it('redelivers a message when the use case fails transiently (no ACK, visibility timeout expires)', async () => {
    // No wallet seeded — findByIdForUpdate throws (wallet not found), which is
    // NOT a known rejection error, so it propagates and the whole transaction
    // rolls back. The use case never returns a result; the consumer classifies
    // this as transient and never ACKs.
    const walletId = randomUUID(); // does not exist
    const client = sqsClient();
    const externalTransactionId = randomUUID();
    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: betMessageBody({ walletId, externalTransactionId }),
        MessageGroupId: randomUUID(),
        MessageDeduplicationId: randomUUID(),
      }),
    );

    const consumer = newConsumer();
    consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 800)); // let the failing attempt happen
    await consumer.stop();

    // Visibility timeout (2s, set on the test queue) expires — message becomes visible again.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const redelivered = await findByExternalTransactionId(client, queueUrl, externalTransactionId);
    expect(redelivered).toBeDefined();
  }, 10000);

  it('moves a message to the DLQ after maxReceiveCount failed attempts', async () => {
    const walletId = randomUUID(); // does not exist — every attempt fails transiently
    const client = sqsClient();
    const externalTransactionId = randomUUID();
    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: betMessageBody({ walletId, externalTransactionId }),
        MessageGroupId: randomUUID(),
        MessageDeduplicationId: randomUUID(),
      }),
    );

    const consumer = newConsumer();
    consumer.start();
    // maxReceiveCount = 3 (test queue), each needing the 2s visibility timeout
    // to expire before the next redelivery is even receivable.
    await new Promise((resolve) => setTimeout(resolve, 9000));
    await consumer.stop(); // returns quickly — waitTimeSeconds is 1 for this consumer

    // The DLQ accumulates messages across test runs (never purged, like the
    // real outbound queue) — poll and filter by THIS specific
    // externalTransactionId instead of assuming the first message is ours.
    const foundInDlq = await findByExternalTransactionId(client, dlqUrl, externalTransactionId);
    expect(foundInDlq).toBeDefined();

    const stillOnMainQueue = await findByExternalTransactionId(client, queueUrl, externalTransactionId, 1);
    expect(stillOnMainQueue).toBeUndefined();
  }, 20000);

  it('Inbox dedupe: redelivery of an already-processed message is ACKed without reprocessing (no double debit)', async () => {
    const walletId = await seedWallet(orm, '100.00');
    const client = sqsClient();
    const externalTransactionId = randomUUID();
    const body = betMessageBody({ walletId, externalTransactionId });

    const consumer = newConsumer();
    consumer.start();

    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: randomUUID(),
        MessageDeduplicationId: randomUUID(),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Simulate redelivery of the exact same message (same messageId inside
    // the body — as SQS would redeliver after a visibility timeout without
    // ACK, or an at-least-once duplicate from the producer).
    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: randomUUID(),
        MessageDeduplicationId: randomUUID(), // different SQS-level dedup id — the Inbox is what must catch this, not SQS content-based dedup
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 800));

    await consumer.stop();

    const walletRow = await orm.em.fork().findOneOrFail(WalletRow, { id: walletId });
    expect(walletRow.balanceAmount).toBe('70.00'); // debited only ONCE, not twice

    const txCount = await orm.em.fork().count(WagerTransactionRow, { walletId });
    expect(txCount).toBe(1); // only one WagerTransaction row exists
  }, 10000);

  it('graceful shutdown: stop() lets the in-flight message finish but never starts a new poll', async () => {
    const walletId = await seedWallet(orm, '100.00');
    const client = sqsClient();
    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: betMessageBody({ walletId }),
        MessageGroupId: randomUUID(),
        MessageDeduplicationId: randomUUID(),
      }),
    );

    const consumer = newConsumer();
    consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 500)); // let it pick up and start processing
    await consumer.stop(); // request shutdown while (at most) one message is in flight

    // The in-flight message still completed normally (ACKed, wallet debited) —
    // stop() does not abort processing, it only prevents new polls.
    const walletRow = await orm.em.fork().findOneOrFail(WalletRow, { id: walletId });
    expect(walletRow.balanceAmount).toBe('70.00');
  }, 10000);
});
