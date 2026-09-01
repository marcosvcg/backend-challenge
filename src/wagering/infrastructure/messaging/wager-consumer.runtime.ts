import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { WagerTransactionConsumer } from './wager-transaction.consumer';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.use-case';
import { SqsQueueUrlResolver } from '../../../shared/infrastructure/messaging/sqs-queue-url-resolver';
import { createSqsClient } from '../../../shared/infrastructure/messaging/sqs-client-factory';
import type { Logger } from '../../../shared/application/logger';
import type { MetricsPort } from '../../../shared/application/metrics';
import type { Clock } from '../../../shared/application/clock';
import { LOGGER, METRICS, CLOCK } from '../../../shared/infrastructure/shared.tokens';

/** Liga/desliga WagerTransactionConsumer ao lifecycle real do processo Nest —
 *  o consumer em si (start()/stop(), loop de long-polling) já existia e não
 *  muda (ARCHITECTURE.md seção 21); esta classe só decide QUANDO chamá-los.
 *
 *  Gate positivo explícito: START_BACKGROUND_WORKERS !== 'true' → no-op
 *  completo, nenhuma chamada AWS, nenhuma resolução de fila. Necessário
 *  porque onApplicationBootstrap() dispara em app.init() incondicionalmente
 *  no Nest — mesmo sem app.listen() — e todo teste de integração HTTP faz
 *  exatamente isso (createNestApplication() + app.init()); sem o gate, todo
 *  teste HTTP existente passaria a tentar subir este consumer real
 *  (ARCHITECTURE.md seção 30).
 *
 *  SqsQueueUrlResolver é injetado (não importado/construído diretamente) —
 *  torna este runtime testável com um resolver fake, sem depender de
 *  LocalStack real. */
@Injectable()
export class WagerConsumerRuntime implements OnApplicationBootstrap, OnApplicationShutdown {
  private consumer?: WagerTransactionConsumer;

  constructor(
    private readonly useCase: ProcessWagerTransactionUseCase,
    private readonly queueUrlResolver: SqsQueueUrlResolver,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.START_BACKGROUND_WORKERS !== 'true') {
      return;
    }

    const queueName = process.env.SQS_INBOUND_QUEUE_NAME;
    if (!queueName) {
      throw new Error('SQS_INBOUND_QUEUE_NAME is required when START_BACKGROUND_WORKERS=true.');
    }

    // Falha rápido no bootstrap se a fila não existir/não for alcançável —
    // nunca sobe fingindo que o consumer está operacional (decisão explícita:
    // preferir a aplicação inteira falhar ao boot a rodar silenciosamente
    // sem consumir nada).
    const queueUrl = await this.queueUrlResolver.resolve(queueName);

    const waitTimeSeconds = Number(process.env.SQS_CONSUMER_WAIT_TIME_SECONDS ?? 10);

    // WagerTransactionConsumer precisa de um SQSClient próprio para
    // ReceiveMessage/DeleteMessage — client dedicado, criado uma única vez aqui.
    const client = createSqsClient();
    // this.logger (Logger compartilhado) satisfaz WagerTransactionConsumerLogger
    // estruturalmente (mesmos 3 métodos, mesma assinatura) — não migra o tipo
    // do consumer, só evita instanciar um segundo console.log duplicado.
    this.consumer = new WagerTransactionConsumer(
      client,
      queueUrl,
      this.useCase,
      this.logger,
      waitTimeSeconds,
      this.metrics,
      this.clock,
    );
    this.consumer.start();
    this.logger.info('WagerTransactionConsumer started', { queueUrl, waitTimeSeconds });
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    if (!this.consumer) {
      return;
    }
    this.logger.info('WagerTransactionConsumer stopping', { signal });
    await this.consumer.stop();
    this.logger.info('WagerTransactionConsumer stopped', { signal });
  }
}
