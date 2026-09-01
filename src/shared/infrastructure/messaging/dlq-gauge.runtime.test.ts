import { afterEach, describe, expect, it } from 'bun:test';
import { DlqGaugeRuntime } from './dlq-gauge.runtime';
import { SqsQueueUrlResolver } from './sqs-queue-url-resolver';
import { Logger } from '../../application/logger';
import { MetricsPort } from '../../application/metrics';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function silentLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function noopMetrics(): MetricsPort {
  return { incrementCounter: () => {}, setGauge: () => {}, observeHistogram: () => {} };
}

/** Fake resolver — nunca faz uma chamada de rede real. resolveCalls conta
 *  quantas vezes resolve() foi de fato chamado (uma por fila DLQ), e
 *  resolvedNames registra COM QUE nome cada chamada aconteceu, provando que
 *  as duas filas DLQ (inbound e outbound) são de fato resolvidas. */
function fakeResolver(queueUrl = 'http://localhost:4566/000000000000/fake-dlq.fifo') {
  const resolvedNames: string[] = [];
  const resolver = {
    resolve: async (queueName: string) => {
      resolvedNames.push(queueName);
      return queueUrl;
    },
  } as unknown as SqsQueueUrlResolver;
  return { resolver, getResolveCalls: () => resolvedNames.length, getResolvedNames: () => resolvedNames };
}

const ORIGINAL_ENV = { ...process.env };

describe('DlqGaugeRuntime', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('gate off (START_BACKGROUND_WORKERS unset): onApplicationBootstrap() never resolves a queue URL', async () => {
    delete process.env.START_BACKGROUND_WORKERS;
    const { resolver, getResolveCalls } = fakeResolver();
    const runtime = new DlqGaugeRuntime(resolver, silentLogger(), noopMetrics());

    await runtime.onApplicationBootstrap();

    expect(getResolveCalls()).toBe(0);
    await runtime.onApplicationShutdown(); // safe no-op — nothing was ever started
  });

  it('gate off (START_BACKGROUND_WORKERS=false): still never resolves a queue URL', async () => {
    process.env.START_BACKGROUND_WORKERS = 'false';
    const { resolver, getResolveCalls } = fakeResolver();
    const runtime = new DlqGaugeRuntime(resolver, silentLogger(), noopMetrics());

    await runtime.onApplicationBootstrap();

    expect(getResolveCalls()).toBe(0);
  });

  it('gate on: onApplicationBootstrap() resolves both DLQ URLs (inbound and outbound) exactly once each', async () => {
    process.env.START_BACKGROUND_WORKERS = 'true';
    process.env.DLQ_GAUGE_INTERVAL_MS = '10000'; // long enough that shutdown happens well before a 2nd iteration
    const { resolver, getResolveCalls, getResolvedNames } = fakeResolver();
    const runtime = new DlqGaugeRuntime(resolver, silentLogger(), noopMetrics());

    await runtime.onApplicationBootstrap();
    await sleep(10); // let the first iteration attempt happen (it will fail against the real AWS SDK — irrelevant here)
    await runtime.onApplicationShutdown();

    expect(getResolveCalls()).toBe(2);
    expect(getResolvedNames()).toEqual(['wager-transactions-dlq.fifo', 'wager-events-dlq.fifo']);
  });

  it('onApplicationShutdown() without a prior bootstrap (or with the gate off) is a safe no-op', async () => {
    const runtime = new DlqGaugeRuntime(fakeResolver().resolver, silentLogger(), noopMetrics());
    await expect(runtime.onApplicationShutdown()).resolves.toBeUndefined();
  });
});
