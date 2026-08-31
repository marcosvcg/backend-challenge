import { afterEach, describe, expect, it } from 'bun:test';
import { WagerConsumerRuntime } from './wager-consumer.runtime';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.use-case';
import { SqsQueueUrlResolver } from '../../../shared/infrastructure/messaging/sqs-queue-url-resolver';
import { Logger } from '../../../shared/application/logger';

function silentLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/** ProcessWagerTransactionUseCase é uma classe concreta — este stub nunca é
 *  realmente chamado nestes testes (WagerTransactionConsumer só invoca
 *  execute() ao receber uma mensagem SQS, e nenhum teste aqui chega a
 *  ReceiveMessage de verdade), mas precisa satisfazer o tipo do construtor. */
function stubUseCase(): ProcessWagerTransactionUseCase {
  return {} as unknown as ProcessWagerTransactionUseCase;
}

/** Fake resolver — nunca faz uma chamada de rede real. resolveCalls conta
 *  quantas vezes resolve() foi de fato chamado, provando que a resolução só
 *  acontece quando o gate está ligado. */
function fakeResolver(queueUrl = 'http://localhost:4566/000000000000/fake-queue.fifo') {
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

describe('WagerConsumerRuntime', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('gate off (START_BACKGROUND_WORKERS unset): onApplicationBootstrap() never resolves the queue URL', async () => {
    delete process.env.START_BACKGROUND_WORKERS;
    const { resolver, getResolveCalls } = fakeResolver();
    const runtime = new WagerConsumerRuntime(stubUseCase(), resolver, silentLogger());

    await runtime.onApplicationBootstrap();

    expect(getResolveCalls()).toBe(0);
    await runtime.onApplicationShutdown(); // safe no-op — nothing was ever started
  });

  it('gate off (START_BACKGROUND_WORKERS=false): still never resolves the queue URL', async () => {
    process.env.START_BACKGROUND_WORKERS = 'false';
    const { resolver, getResolveCalls } = fakeResolver();
    const runtime = new WagerConsumerRuntime(stubUseCase(), resolver, silentLogger());

    await runtime.onApplicationBootstrap();

    expect(getResolveCalls()).toBe(0);
  });

  it('gate on: onApplicationBootstrap() resolves the inbound queue URL exactly once', async () => {
    process.env.START_BACKGROUND_WORKERS = 'true';
    process.env.SQS_INBOUND_QUEUE_NAME = 'wager-transactions.fifo';
    const { resolver, getResolveCalls } = fakeResolver();
    const runtime = new WagerConsumerRuntime(stubUseCase(), resolver, silentLogger());

    await runtime.onApplicationBootstrap();
    await runtime.onApplicationShutdown();

    expect(getResolveCalls()).toBe(1);
  });

  it('gate on but SQS_INBOUND_QUEUE_NAME missing: fails fast, never calls the resolver', async () => {
    process.env.START_BACKGROUND_WORKERS = 'true';
    delete process.env.SQS_INBOUND_QUEUE_NAME;
    const { resolver, getResolveCalls } = fakeResolver();
    const runtime = new WagerConsumerRuntime(stubUseCase(), resolver, silentLogger());

    await expect(runtime.onApplicationBootstrap()).rejects.toThrow('SQS_INBOUND_QUEUE_NAME is required');
    expect(getResolveCalls()).toBe(0);
  });

  it('onApplicationShutdown() without a prior bootstrap (or with the gate off) is a safe no-op', async () => {
    const runtime = new WagerConsumerRuntime(stubUseCase(), fakeResolver().resolver, silentLogger());
    await expect(runtime.onApplicationShutdown()).resolves.toBeUndefined();
  });
});
