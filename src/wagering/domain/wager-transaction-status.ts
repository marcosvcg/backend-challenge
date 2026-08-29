export enum WagerTransactionStatus {
  /** Aceita, ainda não aplicada. */
  Pending = 'PENDING',
  /** Aguardando a transação referenciada (não-terminal — ver ARCHITECTURE.md seção 13). */
  PendingReference = 'PENDING_REFERENCE',
  /** Terminal. */
  Processed = 'PROCESSED',
  /** Terminal — violação de regra de negócio. */
  Rejected = 'REJECTED',
  /** Terminal — erro permanente de infraestrutura, auditável. */
  Failed = 'FAILED',
}
