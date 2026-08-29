/** Metadados de correlação/geração que a infraestrutura injeta ao construir um
 *  IntegrationEvent — o domínio nunca gera IDs nem lê o relógio sozinho. */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

/** Monta a base comum de IntegrationEventProps a partir de um EventContext,
 *  omitindo `causationId` quando ausente — sob `exactOptionalPropertyTypes`,
 *  atribuir `causationId: undefined` explicitamente é um erro de tipo distinto
 *  de simplesmente não ter a chave. Usado por toda subclasse de IntegrationEvent
 *  para não repetir essa regra em cada `from()`. */
export function baseEventProps(ctx: EventContext, aggregateId: string) {
  return {
    eventId: ctx.eventId,
    aggregateId,
    correlationId: ctx.correlationId,
    ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}),
    occurredAt: ctx.occurredAt,
  };
}
