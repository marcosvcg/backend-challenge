import { DeleteMessageCommand, Message, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.use-case';
import { instrumentProcessResult } from '../../application/instrument-process-result';
import { parseWagerTransactionMessage, MalformedWagerTransactionMessageError } from './parse-wager-transaction-message';
import { wagerTransactionMessageToCommand } from './wager-transaction-message.mapper';
import { MetricsPort } from '../../../shared/application/metrics';
import { Clock } from '../../../shared/application/clock';
import { SQS_MESSAGE_REDELIVERIES_TOTAL } from '../../../shared/application/sqs-metrics';

export interface WagerTransactionConsumerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const consoleLogger: WagerTransactionConsumerLogger = {
  info: (message, meta) => console.log(JSON.stringify({ level: 'info', message, ...meta })),
  warn: (message, meta) => console.warn(JSON.stringify({ level: 'warn', message, ...meta })),
  error: (message, meta) => console.error(JSON.stringify({ level: 'error', message, ...meta })),
};

/** Consumer SQS para wager-transactions.fifo (README seção 10). Reutiliza o
 *  MESMO ProcessWagerTransactionUseCase da entrada HTTP — a única diferença
 *  é o que acontece antes (parsing/mapeamento da mensagem) e depois (decidir
 *  ACK) da chamada ao use case (ARCHITECTURE.md seção 13).
 *
 *  Processamento sequencial por poll (não paralelo dentro do mesmo processo):
 *  a concorrência relevante entre wallets vem de múltiplas INSTÂNCIAS deste
 *  consumer, não de paralelismo interno — mantém o raciocínio sobre graceful
 *  shutdown simples (no máximo uma mensagem em voo por vez).
 *
 *  metrics/clock são opcionais (default no-op/relógio real) — alteração
 *  mínima e aditiva para instrumentação (ARCHITECTURE.md seção 31), nenhuma
 *  mudança de ACK/retry/DLQ/visibility/parsing. */
const noopMetrics: MetricsPort = {
  incrementCounter: () => {},
  setGauge: () => {},
  observeHistogram: () => {},
};
const systemClock: Clock = { now: () => new Date() };

export class WagerTransactionConsumer {
  private stopping = false;
  private pollLoop?: Promise<void>;

  constructor(
    private readonly sqsClient: SQSClient,
    private readonly queueUrl: string,
    private readonly useCase: ProcessWagerTransactionUseCase,
    private readonly logger: WagerTransactionConsumerLogger = consoleLogger,
    /** Long polling — default 10s para produção/dev. stop() só retorna depois
     *  que o ReceiveMessageCommand em andamento resolve, então este valor é
     *  também o limite superior de quanto tempo um graceful shutdown pode
     *  levar. Testes de integração usam um valor baixo (ex.: 1s) para tornar
     *  stop() rápido e determinístico. */
    private readonly waitTimeSeconds: number = 10,
    private readonly metrics: MetricsPort = noopMetrics,
    private readonly clock: Clock = systemClock,
  ) {}

  start(): void {
    this.stopping = false;
    this.pollLoop = this.runLoop();
  }

  /** SIGTERM: para de iniciar novos polls; deixa a única mensagem em voo (se
   *  houver) terminar normalmente antes de retornar. Não usa
   *  ChangeMessageVisibility(0) — não há necessidade de interromper
   *  processamento em andamento para os requisitos deste incremento. */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.pollLoop;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      const messages = await this.receiveBatch();
      for (const message of messages) {
        if (this.stopping) break; // não inicia novas mensagens após sinal de parada
        await this.processOne(message);
      }
    }
  }

  private async receiveBatch(): Promise<Message[]> {
    try {
      const result = await this.sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: this.waitTimeSeconds, // long polling
          // Solicitado só para instrumentar sqs_message_redeliveries_total
          // (ARCHITECTURE.md seção 31) — não afeta ACK/retry/DLQ/visibility,
          // que continuam decididos exatamente como antes.
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }),
      );
      return result.Messages ?? [];
    } catch (err) {
      this.logger.error('Failed to receive messages from SQS', { error: String(err) });
      return [];
    }
  }

  private async processOne(message: Message): Promise<void> {
    const receiptHandle = message.ReceiptHandle;
    if (!receiptHandle || !message.Body) {
      this.logger.error('Received message without ReceiptHandle or Body — skipping', { messageId: message.MessageId });
      return;
    }

    // receiveCount > 1 → esta entrega não é a primeira tentativa (o SQS já
    // redeliverou pelo menos uma vez) — um incremento por ENTREGA, não por
    // mensagem única (ARCHITECTURE.md seção 31). Puramente informativo:
    // nunca influencia ACK/retry/DLQ, que continuam decididos abaixo
    // exatamente como antes.
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    if (receiveCount > 1) {
      this.metrics.incrementCounter(SQS_MESSAGE_REDELIVERIES_TOTAL);
    }

    try {
      const parsed = parseWagerTransactionMessage(message.Body);
      const command = wagerTransactionMessageToCommand(parsed);
      const startedAt = this.clock.now().getTime();
      const result = await this.useCase.execute(command);
      // Instrumentado AQUI, depois de execute() já ter resolvido — a
      // transação SQL já comitou; nunca dentro do use case
      // (ARCHITECTURE.md seção 31).
      const durationSeconds = (this.clock.now().getTime() - startedAt) / 1000;
      instrumentProcessResult(result, 'queue', durationSeconds, this.metrics, this.logger, {
        correlationId: command.correlationId,
        messageId: parsed.messageId,
        providerId: command.providerId,
      });

      if (result.ackable) {
        await this.ack(receiptHandle);
        this.logger.info('Message processed and ACKed', {
          messageId: parsed.messageId,
          resultKind: result.kind,
        });
      } else {
        // permanent-error do próprio use case (ex.: INBOX_PAYLOAD_MISMATCH) —
        // não faz ACK, segue o caminho padrão de redrive/DLQ.
        this.logger.warn('Message classified as non-ackable by the use case — leaving for redrive/DLQ', {
          messageId: parsed.messageId,
          resultKind: result.kind,
          permanentErrorCode: result.permanentErrorCode,
        });
      }
    } catch (err) {
      if (err instanceof MalformedWagerTransactionMessageError) {
        // permanent (estrutural) — nunca ACK; mesmo caminho operacional de
        // redrive/DLQ que qualquer resultado não-ackable (ARCHITECTURE.md
        // seção 13: um único mecanismo de DLQ, sem publish manual).
        this.logger.error('Permanent parsing/schema error — leaving for redrive/DLQ', {
          sqsMessageId: message.MessageId,
          error: err.message,
        });
        return;
      }

      // Exceção inesperada (infraestrutura: timeout de Postgres, erro de
      // conexão, bug) — classificada como transient. Não faz ACK; visibility
      // timeout expira e a mensagem é reentregue.
      this.logger.error('Transient error processing message — leaving for redelivery', {
        sqsMessageId: message.MessageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async ack(receiptHandle: string): Promise<void> {
    await this.sqsClient.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }));
  }
}
