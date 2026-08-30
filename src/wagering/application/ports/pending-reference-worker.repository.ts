import { WagerTransaction } from '../../domain/wager-transaction';

/** Acesso a dados do worker de PENDING_REFERENCE — deliberadamente separado
 *  de WagerTransactionRepository (find/create/update de uma entidade). O
 *  padrão de acesso aqui é fundamentalmente diferente: claim em lote com
 *  lock, mesmo espírito de OutboxPublisherRepository.claimBatch()
 *  (ARCHITECTURE.md seção 18).
 *
 *  claimBatch() NUNCA abre nem fecha transação — os row locks de
 *  FOR UPDATE SKIP LOCKED só existem enquanto a transação que os originou
 *  seguir aberta. É o TransactionRunner do worker (não este repositório)
 *  quem controla quando a transação commita — depois que a pendência já foi
 *  totalmente resolvida (referência + wallet lock + ledger + outbox) ou
 *  reagendada/rejeitada. */
export interface PendingReferenceWorkerRepository {
  /** SELECT ... FOR UPDATE SKIP LOCKED — trava até `batchSize` linhas com
   *  status = PENDING_REFERENCE e next_reference_retry_at <= now, e as
   *  devolve já reidratadas como WagerTransaction. */
  claimBatch(batchSize: number, now: Date): Promise<WagerTransaction[]>;
}
