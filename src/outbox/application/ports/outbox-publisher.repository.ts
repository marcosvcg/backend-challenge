import { IntegrationEventEnvelope } from '../../../shared/domain/integration-event';

export interface ClaimedOutboxMessage {
  id: string;
  aggregateId: string;
  envelope: IntegrationEventEnvelope<unknown>;
}

/** Acesso a dados do publisher — deliberadamente separado de OutboxRepository
 *  (que só tem enqueue(), chamado de dentro da transação de negócio). O
 *  padrão de acesso aqui é fundamentalmente diferente: claim em lote com
 *  lock, não find/save de uma entidade.
 *
 *  claimBatch() NUNCA abre nem fecha transação — os row locks de
 *  FOR UPDATE SKIP LOCKED só existem enquanto a transação que os originou
 *  seguir aberta. É o TransactionRunner do publisher (não este repositório)
 *  quem controla quando a transação commita — depois que
 *  SqsPublisher.publish() já rodou para cada linha do batch, preservando a
 *  exclusão entre publishers durante o I/O de rede (ARCHITECTURE.md seção 11). */
export interface OutboxPublisherRepository {
  /** SELECT ... FOR UPDATE SKIP LOCKED — trava até `batchSize` linhas
   *  pendentes/devidas e as devolve. As linhas continuam travadas até a
   *  transação corrente commitar ou reverter. */
  claimBatch(batchSize: number): Promise<ClaimedOutboxMessage[]>;

  /** UPDATE published_at = now(), next_attempt_at = NULL. */
  markPublished(id: string, at: Date): Promise<void>;

  /** UPDATE attempts = attempts + 1, next_attempt_at = <calculado>. */
  scheduleRetry(id: string, nextAttemptAt: Date): Promise<void>;
}
