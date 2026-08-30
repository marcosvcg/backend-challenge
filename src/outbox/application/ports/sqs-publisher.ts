import { IntegrationEventEnvelope } from '../../../shared/domain/integration-event';

/** Abstrai o envio real ao SQS. `messageGroupId` é granular (aggregateId),
 *  não um grupo global — evita serializar publicação de agregados
 *  independentes numa fila FIFO (decisão registrada em ARCHITECTURE.md). */
export interface SqsPublisher {
  publish(envelope: IntegrationEventEnvelope<unknown>, messageGroupId: string): Promise<void>;
}
