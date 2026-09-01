import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { createTestOrm, truncateAllTables } from '../../../shared/__test-support__/test-orm';
import { createTestSqsClient, purgeTestQueue } from '../../../shared/__test-support__/sqs-test-client';
import { setupLocalstack } from '../../../../scripts/setup-localstack';
import { MikroOrmOutboxPublisherTransactionRunner } from '../mikro-orm-outbox-publisher-transaction-runner';
import { SqsPublisherAdapter } from '../sqs-publisher.adapter';
import { PublishPendingOutboxMessagesUseCase } from '../../application/publish-pending-outbox-messages.use-case';
import { FakeClock } from '../../../wagering/application/__fakes__/fake-clock';
import { OutboxMessageRow } from '../persistence/outbox-message.row';

const AT = new Date('2026-01-01T00:00:00.000Z');

/** Polling helper: SQS ReceiveMessage não garante devolver toda mensagem
 *  disponível numa única chamada (long polling tem short-poll fallback e
 *  visibility timing próprios). Tenta algumas vezes antes de desistir. */
async function findMessageByEventId(
  queueUrl: string,
  eventId: string,
  attempts = 5,
): Promise<Record<string, unknown> | undefined> {
  const client = createTestSqsClient();
  for (let i = 0; i < attempts; i += 1) {
    const received = await client.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }),
    );
    const bodies = (received.Messages ?? []).map((m) => JSON.parse(m.Body!));
    const found = bodies.find((b) => b.eventId === eventId);
    if (found) return found;
  }
  return undefined;
}

async function seedOutboxMessage(orm: MikroORM, overrides: Partial<OutboxMessageRow> = {}): Promise<string> {
  const id = overrides.id ?? randomUUID();
  await orm.em.getConnection().execute(
    `insert into outbox_message (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
     values ('${id}', '${overrides.aggregateId ?? randomUUID()}', 'TestEvent',
             '${JSON.stringify({ eventId: id, eventType: 'TestEvent', aggregateId: overrides.aggregateId ?? id, correlationId: 'corr-1', occurredAt: AT.toISOString(), version: 1, data: { foo: 'bar' } })}'::jsonb,
             '${AT.toISOString()}', ${overrides.attempts ?? 0}, now())`,
  );
  return id;
}

describe('PublishPendingOutboxMessagesUseCase — happy path (real Postgres + real LocalStack SQS)', () => {
  let orm: MikroORM;
  let queueUrl: string;

  beforeAll(async () => {
    orm = await createTestOrm();
    const { outbound } = await setupLocalstack();
    queueUrl = outbound.queueUrl;
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAllTables(orm);
    await purgeTestQueue(queueUrl);
  });

  function newUseCase(clock = new FakeClock(AT)) {
    const runner = new MikroOrmOutboxPublisherTransactionRunner(orm.em);
    const sqs = new SqsPublisherAdapter(createTestSqsClient(), queueUrl);
    return new PublishPendingOutboxMessagesUseCase(runner, sqs, clock);
  }

  it('publishes a pending message: published_at set, next_attempt_at cleared, message arrives on the real SQS queue', async () => {
    const messageId = await seedOutboxMessage(orm, { aggregateId: randomUUID() });

    const result = await newUseCase().execute();

    expect(result.claimed).toBe(1);
    expect(result.published).toBe(1);
    expect(result.failed).toBe(0);
    // FakeClock(AT) fixo + occurredAt do evento seedado também AT → lag zero.
    expect(result.publishedLagsSeconds).toEqual([0]);

    const row = await orm.em.fork().findOneOrFail(OutboxMessageRow, { id: messageId });
    expect(row.publishedAt).toEqual(AT);
    expect(row.nextAttemptAt).toBeNull();

    // Confirm the message is really on the SQS queue, not just marked published in Postgres.
    // Filters by this specific eventId (not "some message matches") because the
    // queue accumulates messages across tests within this describe block.
    const body = await findMessageByEventId(queueUrl, messageId);
    expect(body).toBeDefined();
  });

  it('claims nothing when there are no pending messages', async () => {
    const result = await newUseCase().execute();
    expect(result).toEqual({ claimed: 0, published: 0, failed: 0, publishedLagsSeconds: [] });
  });

  it('does not claim a message whose next_attempt_at is in the future', async () => {
    const id = randomUUID();
    await orm.em
      .getConnection()
      .execute(
        `insert into outbox_message (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
         values ('${id}', '${randomUUID()}', 'TestEvent', '{}'::jsonb, '${AT.toISOString()}', 0, '2099-01-01T00:00:00.000Z')`,
      );

    const result = await newUseCase().execute();
    expect(result.claimed).toBe(0);
  });

  it('two concurrent publishers never process the same row simultaneously (FOR UPDATE SKIP LOCKED, real connections)', async () => {
    // 20 pending messages, batch size small enough that two publishers running
    // concurrently would overlap if SKIP LOCKED weren't actually excluding
    // rows claimed by the other transaction.
    const messageIds = await Promise.all(
      Array.from({ length: 20 }, () => seedOutboxMessage(orm, { aggregateId: randomUUID() })),
    );

    const runnerA = new MikroOrmOutboxPublisherTransactionRunner(orm.em.fork());
    const runnerB = new MikroOrmOutboxPublisherTransactionRunner(orm.em.fork());
    const sqsA = new SqsPublisherAdapter(createTestSqsClient(), queueUrl);
    const sqsB = new SqsPublisherAdapter(createTestSqsClient(), queueUrl);
    const useCaseA = new PublishPendingOutboxMessagesUseCase(runnerA, sqsA, new FakeClock(AT), 5);
    const useCaseB = new PublishPendingOutboxMessagesUseCase(runnerB, sqsB, new FakeClock(AT), 5);

    // Run repeatedly in parallel until all 20 messages are published — proves
    // that across many overlapping claim attempts, no row is EVER claimed by
    // both publishers at the same time (SKIP LOCKED excludes it, it isn't
    // double-counted), and the sum of everything claimed equals the total.
    let totalClaimed = 0;
    let totalPublished = 0;
    for (let round = 0; round < 6; round += 1) {
      const [resultA, resultB] = await Promise.all([useCaseA.execute(), useCaseB.execute()]);
      totalClaimed += resultA.claimed + resultB.claimed;
      totalPublished += resultA.published + resultB.published;
    }

    expect(totalClaimed).toBe(20); // no row claimed twice, none skipped
    expect(totalPublished).toBe(20);

    const stillPending = await orm.em.fork().count(OutboxMessageRow, { publishedAt: null });
    expect(stillPending).toBe(0);

    const publishedRows = await orm.em.fork().find(OutboxMessageRow, { id: { $in: messageIds } });
    expect(publishedRows.every((r) => r.publishedAt !== undefined && r.publishedAt !== null)).toBe(true);
  });

  it('publish failure schedules a retry: attempts incremented, next_attempt_at moved to the future, published_at stays NULL', async () => {
    const messageId = await seedOutboxMessage(orm, { aggregateId: randomUUID() });

    const runner = new MikroOrmOutboxPublisherTransactionRunner(orm.em);
    const failingSqs = { publish: async () => { throw new Error('Simulated transient network failure.'); } };
    const useCase = new PublishPendingOutboxMessagesUseCase(runner, failingSqs, new FakeClock(AT));

    const result = await useCase.execute();

    expect(result.claimed).toBe(1);
    expect(result.published).toBe(0);
    expect(result.failed).toBe(1);

    const row = await orm.em.fork().findOneOrFail(OutboxMessageRow, { id: messageId });
    expect(row.attempts).toBe(1);
    expect(row.publishedAt).toBeNull();
    expect(row.nextAttemptAt).not.toBeNull();
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(AT.getTime());
  });

  it('event published uses outbox_message.id as eventId (identity is the row id, not regenerated)', async () => {
    const messageId = await seedOutboxMessage(orm, { aggregateId: randomUUID() });

    await newUseCase().execute();

    const body = await findMessageByEventId(queueUrl, messageId);
    expect(body).toBeDefined();
    expect(body!.eventId).toBe(messageId);
  });

  it('at-least-once semantics: crash after SQS send but before commit leaves the row pending and can duplicate on retry', async () => {
    const messageId = await seedOutboxMessage(orm, { aggregateId: randomUUID() });

    // SqsPublisher.publish() completa com SUCESSO real (mensagem chega de
    // fato ao SQS) — uma exceção retornada por essa porta representaria uma
    // falha de publicação de verdade, que corretamente cai em scheduleRetry(),
    // não é o cenário que queremos simular aqui. O intervalo que este teste
    // representa é entre "SQS confirmou" e "a transação do Postgres
    // conseguiu commitar" — simulado injetando a falha logo depois do envio
    // real, no passo de markPublished() (não dentro de publish()).
    const innerRunner = new MikroOrmOutboxPublisherTransactionRunner(orm.em);
    const crashingRunner = {
      run: async <T,>(work: (uow: { outboxPublisher: unknown }) => Promise<T>) =>
        innerRunner.run(async (uow) => {
          uow.outboxPublisher.markPublished = async () => {
            throw new Error('Simulated crash between SQS send succeeding and the commit that would follow markPublished().');
          };
          return work(uow);
        }),
    };

    const sqs = new SqsPublisherAdapter(createTestSqsClient(), queueUrl);
    const crashingUseCase = new PublishPendingOutboxMessagesUseCase(crashingRunner as never, sqs, new FakeClock(AT));

    // Confirm the message really reached SQS before asserting anything about
    // the crash/rollback.
    await expect(crashingUseCase.execute()).rejects.toThrow('Simulated crash between SQS send');
    const sentDuringCrash = await findMessageByEventId(queueUrl, messageId);
    expect(sentDuringCrash).toBeDefined();

    // The whole transaction rolled back: the row was never marked published,
    // and scheduleRetry() was never reached either (the error propagated
    // straight out of the try block that only wraps publish()).
    const row = await orm.em.fork().findOneOrFail(OutboxMessageRow, { id: messageId });
    expect(row.publishedAt).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.nextAttemptAt).not.toBeNull(); // still eligible — unchanged from the seed

    // Next cycle, with a working publisher, re-claims and re-sends the SAME
    // message — demonstrating the duplicate-send this scenario produces.
    const secondSendResult = await newUseCase().execute();
    expect(secondSendResult.published).toBe(1);

    const finalRow = await orm.em.fork().findOneOrFail(OutboxMessageRow, { id: messageId });
    expect(finalRow.publishedAt).not.toBeNull();

    // Two real deliveries of the same eventId now sit on the queue: one from
    // the "crashed" attempt (before rollback) and one from the successful
    // retry. This is the duplicate publication at-least-once semantics
    // accepts — the consumer, not this publisher, is responsible for
    // deduplicating by eventId (ARCHITECTURE.md seção 11).
  });

  it('never publishes before the financial transaction that created the outbox row committed', async () => {
    // This is provable structurally, not by racing a clock: OutboxRepository.enqueue()
    // (used by ProcessWagerTransactionUseCase/CreateWalletUseCase) only ever
    // inserts a row inside the SAME transaction as the financial write — the
    // row does not exist for the publisher to claim until that transaction
    // commits. Demonstrated here by confirming claimBatch(), running on a
    // genuinely separate connection, cannot see THIS SPECIFIC row while the
    // financial transaction is still open (uncommitted), and can see it (by
    // its own id, not just "something was claimable") only after it commits.
    const walletId = randomUUID();
    const outboxId = randomUUID();
    await orm.em.getConnection().execute(
      `insert into wallet (id, player_id, currency, balance_amount) values ('${walletId}', '${randomUUID()}', 'BRL', 100.00)`,
    );

    // A separate, dedicated connection for the concurrent publisher — never
    // shares a transaction context with the writer's fork below.
    const publisherEm = orm.em.fork();
    const publisherRunner = new MikroOrmOutboxPublisherTransactionRunner(publisherEm);
    const publisherSqs = new SqsPublisherAdapter(createTestSqsClient(), queueUrl);
    const concurrentUseCase = new PublishPendingOutboxMessagesUseCase(publisherRunner, publisherSqs, new FakeClock(AT));

    let sawThisRowMidTransaction: boolean | undefined;
    const writerEm = orm.em.fork();
    await writerEm.transactional(async (em) => {
      // Simulates the financial use case enqueuing this SPECIFIC outbox row
      // mid-transaction — not yet committed. Uses em.getConnection().execute()
      // WITH the transaction context explicitly (em.getTransactionContext()):
      // without it, raw SQL executed via getConnection() does not participate
      // in em.transactional()'s BEGIN/COMMIT/ROLLBACK at all (confirmed by
      // isolated investigation — pg_current_xact_id_if_assigned() came back
      // NULL, and the row survived a forced rollback, when the context wasn't
      // passed). Production code never hits this: it always writes through
      // em.create()/em.assign()/flush(), which already thread the context
      // internally.
      await em
        .getConnection('write')
        .execute(
          `insert into outbox_message (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
           values ('${outboxId}', '${walletId}', 'TestEvent', '{}'::jsonb, now(), 0, now())`,
          [],
          'run',
          em.getTransactionContext(),
        );

      // The concurrent publisher, on its own connection, claims whatever it
      // can right now and we check specifically whether THIS row's id is
      // among what got published — not merely whether claimed > 0 (which
      // could match an unrelated pending row from test pollution).
      await concurrentUseCase.execute();
      const midTxRow = await orm.em.fork({ disableContextResolution: true }).findOne(OutboxMessageRow, {
        id: outboxId,
        publishedAt: { $ne: null },
      });
      sawThisRowMidTransaction = midTxRow !== null;
    });

    expect(sawThisRowMidTransaction).toBe(false); // this row specifically was never claimable before its own commit

    const afterCommit = await concurrentUseCase.execute();
    const publishedRow = await orm.em.fork().findOneOrFail(OutboxMessageRow, { id: outboxId });
    expect(afterCommit.claimed).toBeGreaterThanOrEqual(1);
    expect(publishedRow.publishedAt).not.toBeNull(); // claimable and published immediately after commit
  });
});
