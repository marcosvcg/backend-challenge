import { afterEach, describe, expect, it } from 'bun:test';
import { PendingReferenceRuntime } from './pending-reference.runtime';
import { RetryPendingReferencesUseCase } from '../application/retry-pending-references.use-case';
import { Logger } from '../../shared/application/logger';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function silentLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/** RetryPendingReferencesUseCase é uma classe concreta, não uma interface —
 *  este spy satisfaz o shape que PendingReferenceRuntime realmente chama
 *  (execute()), sem precisar de um TransactionRunner/Postgres reais. */
function spyUseCase(onExecute: () => void): RetryPendingReferencesUseCase {
  return {
    execute: async () => {
      onExecute();
      return { claimed: 0, resolved: 0, rescheduled: 0, rejected: 0 };
    },
  } as unknown as RetryPendingReferencesUseCase;
}

const ORIGINAL_ENV = { ...process.env };

describe('PendingReferenceRuntime', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('gate off (START_BACKGROUND_WORKERS unset): onApplicationBootstrap() never calls execute()', async () => {
    delete process.env.START_BACKGROUND_WORKERS;
    let executeCalls = 0;
    const runtime = new PendingReferenceRuntime(spyUseCase(() => (executeCalls += 1)), silentLogger());

    runtime.onApplicationBootstrap();
    await sleep(30); // give a hypothetical loop time to fire, if it wrongly started

    expect(executeCalls).toBe(0);

    await runtime.onApplicationShutdown(); // must also be a safe no-op — nothing was ever started
  });

  it('gate off (START_BACKGROUND_WORKERS=false): still never starts', async () => {
    process.env.START_BACKGROUND_WORKERS = 'false';
    let executeCalls = 0;
    const runtime = new PendingReferenceRuntime(spyUseCase(() => (executeCalls += 1)), silentLogger());

    runtime.onApplicationBootstrap();
    await sleep(30);

    expect(executeCalls).toBe(0);
  });

  it('gate on: onApplicationBootstrap() starts the loop and execute() is called', async () => {
    process.env.START_BACKGROUND_WORKERS = 'true';
    process.env.PENDING_REFERENCE_WORKER_INTERVAL_MS = '10';
    let executeCalls = 0;
    const runtime = new PendingReferenceRuntime(spyUseCase(() => (executeCalls += 1)), silentLogger());

    runtime.onApplicationBootstrap();
    await sleep(35);
    await runtime.onApplicationShutdown();

    expect(executeCalls).toBeGreaterThanOrEqual(1);
  });

  it('onApplicationShutdown() waits for the current iteration and stops further polling', async () => {
    process.env.START_BACKGROUND_WORKERS = 'true';
    process.env.PENDING_REFERENCE_WORKER_INTERVAL_MS = '5';
    let executeCalls = 0;
    let inFlight = false;
    const useCase = {
      execute: async () => {
        inFlight = true;
        await sleep(30);
        executeCalls += 1;
        inFlight = false;
        return { claimed: 0, resolved: 0, rescheduled: 0, rejected: 0 };
      },
    } as unknown as RetryPendingReferencesUseCase;
    const runtime = new PendingReferenceRuntime(useCase, silentLogger());

    runtime.onApplicationBootstrap();
    await sleep(10); // let the slow iteration begin
    await runtime.onApplicationShutdown(); // must wait for it

    expect(inFlight).toBe(false);
    const countAtShutdown = executeCalls;
    await sleep(40); // if polling continued after shutdown, this would catch it
    expect(executeCalls).toBe(countAtShutdown);
  });
});
