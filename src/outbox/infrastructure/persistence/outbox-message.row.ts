/** Shape exato da tabela `outbox_message` (ARCHITECTURE.md seção 11). */
export class OutboxMessageRow {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}
