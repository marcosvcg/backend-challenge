import { EntitySchema } from '@mikro-orm/postgresql';
import { InboxMessageRow } from './inbox-message.row';

export const InboxMessageSchema = new EntitySchema<InboxMessageRow>({
  class: InboxMessageRow,
  tableName: 'inbox_message',
  properties: {
    consumerName: { type: 'string', fieldName: 'consumer_name', primary: true, columnType: 'varchar(64)' },
    messageId: { type: 'string', fieldName: 'message_id', primary: true, columnType: 'varchar(191)' },
    payloadHash: { type: 'string', fieldName: 'payload_hash', columnType: 'varchar(64)' },
    receivedAt: { type: 'Date', fieldName: 'received_at', columnType: 'timestamptz' },
    processedAt: { type: 'Date', fieldName: 'processed_at', columnType: 'timestamptz', nullable: true },
  },
});
