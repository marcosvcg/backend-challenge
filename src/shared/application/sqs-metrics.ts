/** Métricas transversais de SQS — não pertencem a um bounded context
 *  específico (wagering, outbox), são propriedades da infraestrutura de
 *  mensageria em si (ARCHITECTURE.md seção 31).
 *
 *  sqs_dlq_messages: Gauge, `queue` como label — snapshot observado
 *  periodicamente via GetQueueAttributesCommand(ApproximateNumberOfMessages)
 *  em cada fila DLQ, NUNCA inferido do fluxo do consumer — é o SQS quem
 *  decide redrive, não a aplicação.
 *
 *  sqs_message_redeliveries_total: Counter, sem labels — incrementado no
 *  WagerTransactionConsumer quando ApproximateReceiveCount > 1 no atributo
 *  da mensagem recebida, uma vez por entrega (não uma vez por mensagem
 *  única). */
export const SQS_DLQ_MESSAGES = 'sqs_dlq_messages';
export const SQS_MESSAGE_REDELIVERIES_TOTAL = 'sqs_message_redeliveries_total';

export type SqsQueueLabel = 'wager-transactions' | 'wager-events';
