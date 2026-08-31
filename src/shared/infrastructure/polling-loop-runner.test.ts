import { describe, expect, it } from 'bun:test';
import { PollingLoopRunner } from './polling-loop-runner';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('PollingLoopRunner', () => {
  it('calls step() repeatedly with the configured interval between calls', async () => {
    const calls: number[] = [];
    const runner = new PollingLoopRunner(
      async () => {
        calls.push(Date.now());
      },
      20,
    );

    runner.start();
    await sleep(70); // enough time for a handful of iterations at 20ms apart
    await runner.stop();

    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('stop() prevents any new iteration from starting', async () => {
    let callCount = 0;
    const runner = new PollingLoopRunner(async () => {
      callCount += 1;
    }, 10);

    runner.start();
    await sleep(15); // let at least one iteration run
    await runner.stop();
    const countAtStop = callCount;

    await sleep(50); // if a new iteration started after stop(), this would catch it
    expect(callCount).toBe(countAtStop);
  });

  it('shutdown (stop()) waits for the iteration currently in flight to finish before resolving', async () => {
    let inFlight = false;
    let overlapDetected = false;
    const runner = new PollingLoopRunner(async () => {
      if (inFlight) overlapDetected = true; // would only happen if stop() didn't wait properly
      inFlight = true;
      await sleep(40); // slow iteration
      inFlight = false;
    }, 5);

    runner.start();
    await sleep(10); // let the slow iteration begin
    await runner.stop(); // must wait for the in-flight 40ms iteration to finish

    expect(inFlight).toBe(false); // stop() only resolved after the iteration completed
    expect(overlapDetected).toBe(false);
  });

  it('stop() is idempotent — calling it twice, or without a prior start(), never throws', async () => {
    const runner = new PollingLoopRunner(async () => {}, 10);

    await expect(runner.stop()).resolves.toBeUndefined(); // no prior start()

    runner.start();
    await sleep(5);
    await runner.stop();
    await expect(runner.stop()).resolves.toBeUndefined(); // second stop()
  });

  it('stop() called while the loop is sleeping between iterations returns quickly — never waits for the full intervalMs (regression)', async () => {
    // Bug real encontrado durante este incremento: stop() chamado durante o
    // sleep() entre iterações bloqueava até intervalMs inteiro decorrer,
    // mesmo com stopping já marcado — porque o setTimeout do sleep não era
    // cancelável. Com um intervalMs de produção (segundos), isso violaria o
    // requisito de shutdown gracioso rápido.
    const runner = new PollingLoopRunner(async () => {}, 10_000); // 10s — se o bug reaparecer, este teste trava/estoura o timeout do próprio bun test

    runner.start();
    await sleep(15); // let the first (instant) iteration finish, loop is now sleeping for up to 10s
    const stoppedAt = Date.now();
    await runner.stop();
    const elapsedMs = Date.now() - stoppedAt;

    expect(elapsedMs).toBeLessThan(500); // stop() interrupted the 10s sleep almost immediately
  });

  it('an unexpected error in one iteration is reported via onError and never creates concurrent/overlapping loops', async () => {
    let callCount = 0;
    const errors: unknown[] = [];
    const runner = new PollingLoopRunner(
      async () => {
        callCount += 1;
        if (callCount === 1) throw new Error('boom');
      },
      10,
      (err) => errors.push(err),
    );

    runner.start();
    await sleep(45); // enough time for several iterations to have run despite the first failing
    await runner.stop();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');
    expect(callCount).toBeGreaterThan(1); // the loop kept going after the error, sequentially, not concurrently
  });

  it('never overlaps two iterations even when step() takes longer than intervalMs', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;
    const runner = new PollingLoopRunner(async () => {
      concurrentCount += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await sleep(30); // much longer than the 5ms interval below
      concurrentCount -= 1;
    }, 5);

    runner.start();
    await sleep(80);
    await runner.stop();

    expect(maxConcurrent).toBe(1); // setInterval-style overlap would show 2+
  });
});
