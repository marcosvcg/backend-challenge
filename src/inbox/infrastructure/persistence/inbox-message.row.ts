/** Shape exato da tabela `inbox_message` (ARCHITECTURE.md seção 10).
 *  Chave primária composta (consumerName, messageId) — sem coluna `id` própria. */
export class InboxMessageRow {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date;
}
