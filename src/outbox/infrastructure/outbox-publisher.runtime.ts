import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { PublishPendingOutboxMessagesUseCase } from '../application/publish-pending-outbox-messages.use-case';
import { MikroOrmOutboxPublisherTransactionRunner } from './mikro-orm-outbox-publisher-transaction-runner';
import { SqsPublisherAdapter } from './sqs-publisher.adapter';
import { PollingLoopRunner } from '../../shared/infrastructure/polling-loop-runner';
import { SqsQueueUrlResolver } from '../../shared/infrastructure/messaging/sqs-queue-url-resolver';
import { createSqsClient } from '../../shared/infrastructure/messaging/sqs-client-factory';
import type { Clock } from '../../shared/application/clock';
import type { Logger } from '../../shared/application/logger';
import { CLOCK, LOGGER } from '../../shared/infrastructure/shared.tokens';

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_BATCH_SIZE = 10;

/** Envolve PublishPendingOutboxMessagesUseCase (single-shot, ARCHITECTURE.md
 *  seção 11) num PollingLoopRunner — nenhuma mudança na lógica de publicação,
 *  só decide QUANDO/com que cadência chamar execute(). Mesmo gate positivo
 *  explícito dos demais runtimes: START_BACKGROUND_WORKERS !== 'true' →
 *  no-op completo, nenhuma resolução de fila, nenhuma chamada AWS
 *  (ARCHITECTURE.md seção 30).
 *
 *  SqsQueueUrlResolver é injetado (não importado/construído diretamente) —
 *  torna este runtime testável com um resolver fake, sem depender de
 *  LocalStack real. O use case (PublishPendingOutboxMessagesUseCase) é
 *  montado AQUI DENTRO de onApplicationBootstrap(), não recebido pronto via
 *  injeção de construtor: depende de SqsPublisherAdapter, que por sua vez
 *  depende da URL da fila de saída, só disponível depois da resolução
 *  assíncrona e condicional ao gate — resolver isso numa provider factory
 *  síncrona de módulo (tempo de boot) violaria a exigência de nunca fazer
 *  chamada AWS fora do controle do gate. */
@Injectable()
export class OutboxPublisherRuntime implements OnApplicationBootstrap, OnApplicationShutdown {
  private runner?: PollingLoopRunner;

  constructor(
    private readonly em: EntityManager,
    private readonly queueUrlResolver: SqsQueueUrlResolver,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.START_BACKGROUND_WORKERS !== 'true') {
      return;
    }

    const queueName = process.env.SQS_OUTBOUND_QUEUE_NAME;
    if (!queueName) {
      throw new Error('SQS_OUTBOUND_QUEUE_NAME is required when START_BACKGROUND_WORKERS=true.');
    }

    // Falha rápido no bootstrap se a fila não existir/não for alcançável —
    // mesma disciplina de WagerConsumerRuntime.
    const queueUrl = await this.queueUrlResolver.resolve(queueName);

    const batchSize = Number(process.env.OUTBOX_PUBLISHER_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
    const intervalMs = Number(process.env.OUTBOX_PUBLISHER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);

    // SqsPublisherAdapter precisa de um SQSClient próprio para enviar
    // mensagens (SendMessageCommand) — reusa o mesmo client que o resolver já
    // usou para GetQueueUrlCommand, criado uma única vez aqui.
    const client = createSqsClient();
    const useCase = new PublishPendingOutboxMessagesUseCase(
      new MikroOrmOutboxPublisherTransactionRunner(this.em),
      new SqsPublisherAdapter(client, queueUrl),
      this.clock,
      batchSize,
    );

    this.runner = new PollingLoopRunner(
      () => useCase.execute(),
      intervalMs,
      (err) => this.logger.error('OutboxPublisherRuntime iteration failed', { error: String(err) }),
    );
    this.runner.start();
    this.logger.info('OutboxPublisherRuntime started', { queueUrl, intervalMs, batchSize });
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    if (!this.runner) {
      return;
    }
    this.logger.info('OutboxPublisherRuntime stopping', { signal });
    await this.runner.stop();
    this.logger.info('OutboxPublisherRuntime stopped', { signal });
  }
}
