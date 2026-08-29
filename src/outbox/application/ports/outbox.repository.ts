import { IntegrationEvent } from '../../../shared/domain/integration-event';

export interface OutboxRepository {
  /** id da linha == IntegrationEvent.eventId — identificador estável entre
   *  tentativas de republicação (ver ARCHITECTURE.md seção 11). */
  enqueue(event: IntegrationEvent<unknown>): Promise<void>;
}
