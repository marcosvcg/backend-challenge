import { afterEach, describe, expect, it } from 'bun:test';
import { EntityManager } from '@mikro-orm/postgresql';
import { OutboxPublisherRuntime } from './outbox-publisher.runtime';
import { SqsQueueUrlResolver } from '../../shared/infrastructure/messaging/sqs-queue-url-resolver';
import { Clock } from '../../shared/application/clock';
import { Logger } from '../../shared/application/logger';
import { MetricsPort } from '../../shared/application/metrics';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function silentLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function fixedClock(): Clock {
  return { now: () => new Date('2026-01-01T00:00:00.000Z') };
}

function noopMetrics(): MetricsPort {
  return { incrementCounter: () => {}, setGauge: () => {}, observeHistogram: () => {} };
}

/** EntityManager nunca é exercitado nestes testes: o gate desligado nunca
 *  chega perto dele; o gate ligado só prova que a resolução/o start()
 *  acontecem, sem depender de uma iteração completa contra Postgres real
 *  (isso já é coberto pelos testes de integração do próprio
 *  PublishPendingOutboxMessagesUseCase). */
function stubEntityManager(): EntityManager {
  return {} as unknown as EntityManager;
}

function fakeResolver(queueUrl = 'http://localhost:4566/000000000000/fake-outbound.fifo') {
  let resolveCalls = 0;
  const resolver = {
    resolve: async (_queueName: string) => {
      resolveCalls += 1;
      return queueUrl;
    },
  } as unknown as SqsQueueUrlResolver;
  return { resolver, getResolveCalls: () => resolveCalls };
}

const ORIGINAL_ENV = { ...process.env };

describe('OutboxPublisherRuntime', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('gate off (START_BACKGROUND_WORKERS unset): onApplicationBootstrap() never resolves the queue URL', async () => {
    delete process.env.START_BACKGROUND_WORKERS;
    const { resolver, getResolveCalls } = fakeResolver();
    const runtime = new OutboxPublisherRuntime(stubEntityManager(), resolver, fixedClock(), silentLogger(), noopMetrics());

    await runtime.onApplicationBootstrap();

    expect(getResolveCalls()).toBe(0);
    await runtime.onApplicationShutdown(); // safe no-op — nothing was ever started
  });

  it('gate off (START_BACKGROUND_WORKERS=false): still never resolves the queue URL', async () => {
    process.env.START_BACKGROUND_WORKERS = 'false';
    const { resolver, getResolveCalls } = fakeResolver();
    const runtime = new OutboxPublisherRuntime(stubEntityManager(), resolver, fixedClock(), silentLogger(), noopMetrics());

    await runtime.onApplicationBootstrap();

    expect(getResolveCalls()).toBe(0);
  });

  it('gate on: onApplicationBootstrap() resolves the outbound queue URL exactly once and starts the loop', async () => {
    process.env.START_BACKGROUND_WORKERS = 'true';
    process.env.SQS_OUTBOUND_QUEUE_NAME = 'wager-events.fifo';
    process.env.OUTBOX_PUBLISHER_INTERVAL_MS = '10000'; // long enough that shutdown happens well before a 2nd iteration
    const { resolver, getResolveCalls } = fakeResolver();
    const runtime = new OutboxPublisherRuntime(stubEntityManager(), resolver, fixedClock(), silentLogger(), noopMetrics());

    await runtime.onApplicationBootstrap();
    await sleep(10); // let the first iteration attempt happen (it will fail against the stub EM — irrelevant here)
    await runtime.onApplicationShutdown();

    expect(getResolveCalls()).toBe(1);
  });

  it('gate on but SQS_OUTBOUND_QUEUE_NAME missing: fails fast, never calls the resolver', async () => {
    process.env.START_BACKGROUND_WORKERS = 'true';
    delete process.env.SQS_OUTBOUND_QUEUE_NAME;
    const { resolver, getResolveCalls } = fakeResolver();
    const runtime = new OutboxPublisherRuntime(stubEntityManager(), resolver, fixedClock(), silentLogger(), noopMetrics());

    await expect(runtime.onApplicationBootstrap()).rejects.toThrow('SQS_OUTBOUND_QUEUE_NAME is required');
    expect(getResolveCalls()).toBe(0);
  });

  it('onApplicationShutdown() without a prior bootstrap (or with the gate off) is a safe no-op', async () => {
    const runtime = new OutboxPublisherRuntime(
      stubEntityManager(),
      fakeResolver().resolver,
      fixedClock(),
      silentLogger(),
      noopMetrics(),
    );
    await expect(runtime.onApplicationShutdown()).resolves.toBeUndefined();
  });
});
