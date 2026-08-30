import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SqsPublisher } from '../application/ports/sqs-publisher';
import { IntegrationEventEnvelope } from '../../shared/domain/integration-event';

/** Envia ao SQS real (ou LocalStack). MessageGroupId = aggregateId (granular,
 *  não um grupo global) — evita serializar publicação de agregados
 *  independentes na mesma fila FIFO. FIFO/ContentBasedDeduplication NÃO é
 *  tratado como garantia de exactly-once: a responsabilidade de deduplicar
 *  por eventId é do consumidor (ARCHITECTURE.md seção 11). */
export class SqsPublisherAdapter implements SqsPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(envelope: IntegrationEventEnvelope<unknown>, messageGroupId: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: messageGroupId,
        MessageDeduplicationId: envelope.eventId,
      }),
    );
  }
}
