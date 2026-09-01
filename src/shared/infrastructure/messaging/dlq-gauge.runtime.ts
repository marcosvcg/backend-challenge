import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { PollingLoopRunner } from '../polling-loop-runner';
import { SqsQueueUrlResolver } from './sqs-queue-url-resolver';
import { createSqsClient } from './sqs-client-factory';
import { SQS_DLQ_MESSAGES, SqsQueueLabel } from '../../application/sqs-metrics';
import type { Logger } from '../../application/logger';
import type { MetricsPort } from '../../application/metrics';
import { LOGGER, METRICS } from '../shared.tokens';

const DEFAULT_INTERVAL_MS = 30_000;
const INBOUND_DLQ_NAME = 'wager-transactions-dlq.fifo';
const OUTBOUND_DLQ_NAME = 'wager-events-dlq.fifo';
const INBOUND_QUEUE_LABEL: SqsQueueLabel = 'wager-transactions';
const OUTBOUND_QUEUE_LABEL: SqsQueueLabel = 'wager-events';

/** Observa sqs_dlq_messages (Gauge) periodicamente via GetQueueAttributesCommand
 *  — NUNCA inferido do fluxo do consumer: é o SQS quem decide redrive/DLQ,
 *  não a aplicação (ARCHITECTURE.md seção 31). Mesmo gate positivo explícito
 *  dos demais runtimes: START_BACKGROUND_WORKERS !== 'true' → no-op
 *  completo, nenhuma chamada AWS. Mesmo padrão de PollingLoopRunner dos
 *  outros dois "readers" (Outbox Publisher, PendingReference Worker), embora
 *  aqui o `step` seja uma consulta read-only externa, não um use case de
 *  aplicação. */
@Injectable()
export class DlqGaugeRuntime implements OnApplicationBootstrap, OnApplicationShutdown {
  private runner?: PollingLoopRunner;

  constructor(
    private readonly queueUrlResolver: SqsQueueUrlResolver,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.START_BACKGROUND_WORKERS !== 'true') {
      return;
    }

    const inboundDlqUrl = await this.queueUrlResolver.resolve(INBOUND_DLQ_NAME);
    const outboundDlqUrl = await this.queueUrlResolver.resolve(OUTBOUND_DLQ_NAME);
    const client = createSqsClient();
    const intervalMs = Number(process.env.DLQ_GAUGE_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);

    const observeQueue = async (queueUrl: string, label: SqsQueueLabel): Promise<void> => {
      const result = await client.send(
        new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }),
      );
      const count = Number(result.Attributes?.ApproximateNumberOfMessages ?? '0');
      this.metrics.setGauge(SQS_DLQ_MESSAGES, count, { queue: label });
    };

    this.runner = new PollingLoopRunner(
      async () => {
        await observeQueue(inboundDlqUrl, INBOUND_QUEUE_LABEL);
        await observeQueue(outboundDlqUrl, OUTBOUND_QUEUE_LABEL);
      },
      intervalMs,
      (err) => this.logger.error('DlqGaugeRuntime iteration failed', { error: String(err) }),
    );
    this.runner.start();
    this.logger.info('DlqGaugeRuntime started', { inboundDlqUrl, outboundDlqUrl, intervalMs });
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    if (!this.runner) {
      return;
    }
    this.logger.info('DlqGaugeRuntime stopping', { signal });
    await this.runner.stop();
    this.logger.info('DlqGaugeRuntime stopped', { signal });
  }
}
