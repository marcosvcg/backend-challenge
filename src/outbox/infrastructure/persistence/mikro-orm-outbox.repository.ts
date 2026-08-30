import { EntityManager } from '@mikro-orm/postgresql';
import { OutboxRepository } from '../../application/ports/outbox.repository';
import { IntegrationEvent } from '../../../shared/domain/integration-event';
import { OutboxMessageRow } from './outbox-message.row';

/** Construído sempre com o EntityManager "forked" da transação corrente. */
export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(event: IntegrationEvent<unknown>): Promise<void> {
    const envelope = event.toJSON();

    this.em.create(OutboxMessageRow, {
      id: envelope.eventId, // id da linha == eventId (ARCHITECTURE.md seção 11/17)
      aggregateId: envelope.aggregateId,
      eventType: envelope.eventType,
      payload: envelope,
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: new Date(),
    });

    await this.em.flush();
  }
}
