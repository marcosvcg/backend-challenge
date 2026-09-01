/** Nomes das métricas de outbox — centralizados aqui, instrumentados só em
 *  OutboxPublisherRuntime, depois que PublishPendingOutboxMessagesUseCase.execute()
 *  já resolveu (a transação de publicação já comitou) — nunca dentro do use
 *  case (ARCHITECTURE.md seção 31). */
export const OUTBOX_MESSAGES_PUBLISHED_TOTAL = 'outbox_messages_published_total';
export const OUTBOX_PUBLISH_RETRIES_TOTAL = 'outbox_publish_retries_total';
export const OUTBOX_LAG_SECONDS = 'outbox_lag_seconds';
