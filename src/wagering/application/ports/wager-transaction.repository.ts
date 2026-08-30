import { WagerTransaction } from '../../domain/wager-transaction';
import { WagerTransactionKind } from '../../domain/wager-transaction-kind';

export interface WagerTransactionRepository {
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;

  /** true se já existe uma reversão PROCESSED do mesmo `kind` (REFUND ou ROLLBACK)
   *  apontando para `referenceTransactionId` — espelha o índice único parcial
   *  wt_reference_reversal_unique (ARCHITECTURE.md seção 9). A checagem aqui
   *  produz o failureCode de negócio correto (DUPLICATE_REVERSAL); a constraint
   *  do banco continua sendo a defesa final contra race. */
  hasProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean>;

  /** INSERT — a transação ainda não existe no banco. Nunca faz SELECT prévio;
   *  o único caller que chama isto sabe que está criando (nunca atualizando). */
  create(transaction: WagerTransaction): Promise<void>;

  /** UPDATE de uma transação já persistida (ex.: PENDING → PENDING_REFERENCE,
   *  PENDING_REFERENCE → PROCESSED/REJECTED). Mapeia todo campo opcional
   *  explicitamente para `null` quando ausente no domínio — nunca omite,
   *  para não deixar resíduo de um estado anterior sobreviver à transição. */
  update(transaction: WagerTransaction): Promise<void>;
}
