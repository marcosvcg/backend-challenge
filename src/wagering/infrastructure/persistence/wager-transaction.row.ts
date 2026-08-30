/** Shape exato da tabela `wager_transaction` (ARCHITECTURE.md seção 9). */
export class WagerTransactionRow {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status!: string;
  failureCode?: string;
  processedAt?: Date;
  resultBalanceAmount?: string;
  resultBalanceCurrency?: string;
  referenceRetryAttempts!: number;
  nextReferenceRetryAt?: Date;
  createdAt!: Date;
}
