import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { RetryPendingReferencesUseCase } from '../application/retry-pending-references.use-case';
import { PollingLoopRunner } from '../../shared/infrastructure/polling-loop-runner';
import type { Logger } from '../../shared/application/logger';
import { LOGGER } from '../../shared/infrastructure/shared.tokens';

const DEFAULT_INTERVAL_MS = 5000;

/** Envolve RetryPendingReferencesUseCase (single-shot, ARCHITECTURE.md seção
 *  23) num PollingLoopRunner — nenhuma mudança na lógica de negócio do use
 *  case, só decide QUANDO/com que cadência chamar execute(). Mesmo gate
 *  positivo explícito de WagerConsumerRuntime: START_BACKGROUND_WORKERS !==
 *  'true' → no-op completo (ARCHITECTURE.md seção 30). Sem SQS envolvido
 *  aqui — nenhuma resolução de fila necessária, o worker opera inteiramente
 *  sobre Postgres (FOR UPDATE SKIP LOCKED). */
@Injectable()
export class PendingReferenceRuntime implements OnApplicationBootstrap, OnApplicationShutdown {
  private runner?: PollingLoopRunner;

  constructor(
    private readonly useCase: RetryPendingReferencesUseCase,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.START_BACKGROUND_WORKERS !== 'true') {
      return;
    }

    const intervalMs = Number(process.env.PENDING_REFERENCE_WORKER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);

    this.runner = new PollingLoopRunner(
      () => this.useCase.execute(),
      intervalMs,
      (err) => this.logger.error('PendingReferenceRuntime iteration failed', { error: String(err) }),
    );
    this.runner.start();
    this.logger.info('PendingReferenceRuntime started', { intervalMs });
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    if (!this.runner) {
      return;
    }
    this.logger.info('PendingReferenceRuntime stopping', { signal });
    await this.runner.stop();
    this.logger.info('PendingReferenceRuntime stopped', { signal });
  }
}
