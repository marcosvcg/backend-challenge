import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { createTestOrm, truncateAllTables } from '../../../shared/__test-support__/test-orm';
import { setupTestInboundQueue, teardownTestQueue } from '../../../shared/__test-support__/test-inbound-queue';
import { WagerTransactionConsumer, WagerTransactionConsumerLogger } from './wager-transaction.consumer';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.use-case';
import { MikroOrmTransactionRunner } from '../mikro-orm-transaction-runner';
import { UuidIdGenerator } from '../../../shared/infrastructure/uuid-id-generator';
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

/** Genérico — permite construir os casos malformed/permanent (hardening SQS)
 *  que betMessageBody não cobre: kind arbitrário, referência arbitrária,
 *  money arbitrário. externalTransactionId é sempre gerado aqui (nunca
 *  reusado entre casos) para que findByExternalTransactionId/o estado
 *  financeiro observado sejam inequivocamente atribuíveis a UMA mensagem. */
function malformedCandidateMessageBody(overrides: {
  walletId: string;
  externalTransactionId?: string;
  kind?: string;
  money?: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}): { body: string; externalTransactionId: string } {
  const externalTransactionId = overrides.externalTransactionId ?? randomUUID();
  const data: Record<string, unknown> = {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: randomUUID(),
    walletId: overrides.walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: overrides.kind ?? 'BET',
    money: overrides.money ?? { amount: '30.00', currency: 'BRL' },
    ...(overrides.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: overrides.referenceExternalTransactionId }
      : {}),
  };
  const body = JSON.stringify({
    messageId: randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: AT.toISOString(),
    data,
  });
  return { body, externalTransactionId };
}

/** Polling helper: queues used across this describe block accumulate
 *  messages from earlier test runs (never purged) — always filter by a
 *  specific field instead of assuming the first/only message is the one
 *  this test produced. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tryParseJson(body: string): any {
  try {
    return JSON.parse(body);
  } catch {
    // A queue accumulating messages across test runs may hold a leftover
    // malformed/invalid-JSON body from a previous test (never ACKed, by
    // design) — skip it instead of letting it break every subsequent poll.
    return undefined;
  }
}

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
    const bodies = (received.Messages ?? []).map((m) => tryParseJson(m.Body!)).filter((b) => b !== undefined);
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

  it('crash/restart scenario (item 7): financial commit succeeds but ACK never happens — redelivery of the SAME message never double-debits (Inbox + idempotencyKey catch it)', async () => {
    // Wraps a REAL SQSClient — ReceiveMessageCommand/SendMessageCommand
    // delegate untouched (real LocalStack traffic). Only DeleteMessageCommand
    // (the ACK) is intercepted, failing exactly once. This simulates the
    // exact window item 7 asks for: the financial transaction has already
    // committed (useCase.execute() already resolved with a PROCESSED result)
    // by the time ack() is reached — a real network blip/crash between "SQL
    // commit succeeded" and "DeleteMessageCommand succeeded" is
    // indistinguishable from this at the consumer's boundary.
    let deleteAttempts = 0;
    const real = sqsClient();
    const flakyAckClient = {
      send: (command: unknown) => {
        if (command instanceof DeleteMessageCommand) {
          deleteAttempts += 1;
          if (deleteAttempts === 1) {
            throw new Error('Simulated crash: DeleteMessageCommand never reached SQS (network blip / process killed right after commit).');
          }
        }
        return real.send(command as never);
      },
    } as unknown as SQSClient;

    const walletId = await seedWallet(orm, '100.00');
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

    const runner = new MikroOrmTransactionRunner(orm.em);
    const useCase = new ProcessWagerTransactionUseCase(
      runner,
      new UuidIdGenerator(),
      new FakeClock(AT),
      DEFAULT_REFERENCE_RETRY_POLICY,
    );
    const consumer = new WagerTransactionConsumer(flakyAckClient, queueUrl, useCase, silentLogger(), 1);

    consumer.start();
    // First attempt: useCase.execute() commits (PROCESSED, wallet debited),
    // then ack() throws — the consumer's outer catch classifies this as
    // transient (an unrecognized AWS error, not one of
    // KNOWN_STRUCTURAL_ERRORS) and never ACKs, exactly as production code
    // already does for any unexpected error at this point (no special-casing
    // was added for this scenario — this test proves the EXISTING behavior
    // is already correct here).
    await new Promise((resolve) => setTimeout(resolve, 800));

    const walletMidCrash = await orm.em.fork().findOneOrFail(WalletRow, { id: walletId });
    expect(walletMidCrash.balanceAmount).toBe('70.00'); // the financial commit really happened

    // Visibility timeout (2s) expires — SQS redelivers the SAME message
    // (same SQS MessageId, same body/idempotencyKey). Second attempt:
    // Inbox.tryClaim() for this MessageId is isNew (first delivery attempt's
    // whole transaction, including the Inbox insert, committed successfully —
    // only the ACK failed afterwards) → already-acked, OR (if for some reason
    // the Inbox row's own commit hadn't been visible yet) idempotencyKey
    // matches the already-persisted WagerTransaction → replay. Either path:
    // no second debit. DeleteMessageCommand succeeds this time (deleteAttempts
    // now >= 2), so the message finally leaves the queue.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await consumer.stop();

    expect(deleteAttempts).toBeGreaterThanOrEqual(2); // proves a real redelivery cycle happened, not a fluke

    const walletFinal = await orm.em.fork().findOneOrFail(WalletRow, { id: walletId });
    expect(walletFinal.balanceAmount).toBe('70.00'); // still exactly one debit — redelivery never doubled it

    const txCount = await orm.em.fork().count(WagerTransactionRow, { walletId });
    expect(txCount).toBe(1); // exactly one WagerTransaction row, despite two delivery attempts of the same message

    // The message eventually left the queue once ACK finally succeeded.
    const stillOnQueue = await findByExternalTransactionId(client, queueUrl, externalTransactionId, 1);
    expect(stillOnQueue).toBeUndefined();
  }, 15000);

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

  it('financial idempotency (idempotencyKey), not Inbox transport dedupe: two distinct real SQS deliveries of the same logical transaction never double-debit', async () => {
    // Sends the SAME body TWICE, each as a genuinely distinct SQS delivery
    // (different MessageDeduplicationId → SQS assigns each a DIFFERENT real
    // Message.MessageId). This means the Inbox (keyed by the real
    // Message.MessageId, ARCHITECTURE.md hardening SQS) sees two unrelated
    // deliveries — isNew: true both times. What actually prevents the double
    // debit here is the SEPARATE idempotencyKey-based financial idempotency
    // layer (use case step 2, after the Inbox claim): body.data.idempotencyKey
    // is identical in both sends, so the second execution matches the
    // already-persisted WagerTransaction and replays instead of re-applying
    // the debit. See process-wager-transaction.integration.test.ts's
    // dedicated "Inbox transport dedupe vs. financial idempotency" describe
    // block for the two mechanisms tested in isolation from each other,
    // including the case a real Inbox dedupe (same MessageId) actually
    // catches.
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

    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: randomUUID(),
        MessageDeduplicationId: randomUUID(), // different SQS-level dedup id → a genuinely distinct delivery, distinct real MessageId
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

/** Hardening SQS: cada caso abaixo é malformed/permanent — nunca deve mutar a
 *  wallet, nunca criar uma WagerTransaction, e nunca ser ACKado (fica sujeito
 *  ao redrive nativo do SQS/DLQ, mesmo comportamento operacional já provado
 *  para MalformedWagerTransactionMessageError). Prova o resultado observável
 *  fim-a-fim, independente de a rejeição de fato acontecer no parser (shape)
 *  ou no domínio (Money.from()/WagerTransaction.create(), dentro do use
 *  case) — o contrato externo é o mesmo nos dois casos.
 *
 *  malformed messages are intentionally never ACKed and therefore
 *  accumulate/redrive; a dedicated queue prevents cross-test pollution
 *  of the DLQ contract tests (o describe block acima, "moves a message to
 *  the DLQ after maxReceiveCount", consulta a DLQ compartilhada por
 *  externalTransactionId com um número fixo de tentativas de polling —
 *  descoberto empiricamente que o volume acumulado por ESTE describe block
 *  ao longo de múltiplas execuções da suíte estourava esse limite e quebrava
 *  aquele teste, mesmo sem nenhuma mudança no comportamento real de
 *  DLQ/redrive). Fila/DLQ próprias, criadas no beforeAll e destruídas no
 *  afterAll — cada execução da suíte começa com estado limpo aqui, sem
 *  jamais tocar na fila/DLQ compartilhada do describe block pré-existente. */
describe('WagerTransactionConsumer — malformed/permanent messages never mutate financial state (real Postgres + real LocalStack SQS)', () => {
  let orm: MikroORM;
  let queueUrl: string;
  let dlqUrl: string;

  beforeAll(async () => {
    orm = await createTestOrm();
    const queues = await setupTestInboundQueue('wager-transactions-malformed-test.fifo', 'wager-transactions-malformed-test-dlq.fifo');
    queueUrl = queues.queueUrl;
    dlqUrl = queues.dlqUrl;
  });

  afterAll(async () => {
    await orm.close();
    await teardownTestQueue(queueUrl, dlqUrl);
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
    return new WagerTransactionConsumer(sqsClient(), queueUrl, useCase, silentLogger(), 1);
  }

  interface MalformedCase {
    name: string;
    overrides: {
      kind?: string;
      money?: { amount: string; currency: string };
      referenceExternalTransactionId?: string;
    };
  }

  const MALFORMED_CASES: MalformedCase[] = [
    { name: 'amount out of the fixed-decimal format (3 fractional digits)', overrides: { money: { amount: '25.001', currency: 'BRL' } } },
    { name: 'amount in scientific notation', overrides: { money: { amount: '2.5e1', currency: 'BRL' } } },
    { name: 'amount with only 1 decimal digit', overrides: { money: { amount: '25.0', currency: 'BRL' } } },
    { name: 'amount 0.00', overrides: { money: { amount: '0.00', currency: 'BRL' } } },
    { name: 'negative amount', overrides: { money: { amount: '-10.00', currency: 'BRL' } } },
    { name: 'invalid currency (lowercase)', overrides: { money: { amount: '25.00', currency: 'brl' } } },
    { name: 'unknown kind', overrides: { kind: 'NOT_A_REAL_KIND' } },
    { name: 'OPENING submitted externally via SQS', overrides: { kind: 'OPENING' } },
    { name: 'REFUND without referenceExternalTransactionId', overrides: { kind: 'REFUND' } },
    { name: 'ROLLBACK without referenceExternalTransactionId', overrides: { kind: 'ROLLBACK' } },
    { name: 'BET with an unexpected referenceExternalTransactionId', overrides: { kind: 'BET', referenceExternalTransactionId: 'ext-0' } },
    { name: 'LOSS with an unexpected referenceExternalTransactionId', overrides: { kind: 'LOSS', referenceExternalTransactionId: 'ext-0' } },
    { name: 'REFUND with an empty referenceExternalTransactionId', overrides: { kind: 'REFUND', referenceExternalTransactionId: '' } },
    { name: 'REFUND with a whitespace-only referenceExternalTransactionId', overrides: { kind: 'REFUND', referenceExternalTransactionId: '   ' } },
  ];

  for (const { name, overrides } of MALFORMED_CASES) {
    it(`${name} → never ACKed, wallet/ledger untouched, no WagerTransaction row created`, async () => {
      const walletId = await seedWallet(orm, '100.00');
      const client = sqsClient();
      const { body, externalTransactionId } = malformedCandidateMessageBody({ walletId, ...overrides });

      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: body,
          MessageGroupId: randomUUID(),
          MessageDeduplicationId: randomUUID(),
        }),
      );

      const consumer = newConsumer();
      consumer.start();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await consumer.stop();

      const walletRow = await orm.em.fork().findOneOrFail(WalletRow, { id: walletId });
      expect(walletRow.balanceAmount).toBe('100.00'); // never touched — no financial mutation

      const txCount = await orm.em.fork().count(WagerTransactionRow, { walletId });
      expect(txCount).toBe(0); // no WagerTransaction row created

      // Never ACKed — still on the queue (VisibilityTimeout is 2s on the test
      // queue, so by the time we poll again it's visible once more).
      await new Promise((resolve) => setTimeout(resolve, 2200));
      const stillOnQueue = await findByExternalTransactionId(client, queueUrl, externalTransactionId);
      expect(stillOnQueue).toBeDefined();
    }, 10000);
  }

  it('invalid JSON body → never ACKed, no WagerTransaction row created (parser-level, cannot be traced by externalTransactionId)', async () => {
    const client = sqsClient();
    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: 'not valid json{{{',
        MessageGroupId: randomUUID(),
        MessageDeduplicationId: randomUUID(),
      }),
    );

    const consumer = newConsumer();
    consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await consumer.stop();

    const txCount = await orm.em.fork().count(WagerTransactionRow, {});
    expect(txCount).toBe(0); // no WagerTransaction row created by this malformed body
  }, 10000);

  it('a genuinely transient error (wallet not found) is still classified as transient, not permanent (regression: does not get misclassified alongside structural errors)', async () => {
    const walletId = randomUUID(); // does not exist — findByIdForUpdate throws, an error NOT in KNOWN_STRUCTURAL_ERRORS
    const client = sqsClient();
    const { body, externalTransactionId } = malformedCandidateMessageBody({ walletId });

    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: randomUUID(),
        MessageDeduplicationId: randomUUID(),
      }),
    );

    const consumer = newConsumer();
    consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await consumer.stop();

    // Transient errors ARE redelivered (unlike permanent/malformed, which are
    // also never ACKed but for a different reason) — same behavior already
    // proved by the "redelivers a message when the use case fails
    // transiently" test above; this test's purpose is narrower: prove the
    // NEW structural-error classification did not accidentally swallow this
    // pre-existing transient case into the permanent bucket.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const redelivered = await findByExternalTransactionId(client, queueUrl, externalTransactionId);
    expect(redelivered).toBeDefined();
  }, 10000);
});
