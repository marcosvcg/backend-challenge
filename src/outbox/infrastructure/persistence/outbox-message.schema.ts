import { EntitySchema } from '@mikro-orm/postgresql';
import { OutboxMessageRow } from './outbox-message.row';

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRow>({
  class: OutboxMessageRow,
  tableName: 'outbox_message',
  properties: {
    id: { type: 'string', primary: true, columnType: 'uuid' },
    aggregateId: { type: 'string', fieldName: 'aggregate_id', columnType: 'uuid' },
    eventType: { type: 'string', fieldName: 'event_type', columnType: 'varchar(64)' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: 'Date', fieldName: 'occurred_at', columnType: 'timestamptz' },
    attempts: { type: 'number' },
    nextAttemptAt: { type: 'Date', fieldName: 'next_attempt_at', columnType: 'timestamptz', nullable: true },
    publishedAt: { type: 'Date', fieldName: 'published_at', columnType: 'timestamptz', nullable: true },
  },
});
