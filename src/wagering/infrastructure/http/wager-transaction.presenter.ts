import { WagerTransaction } from '../../domain/wager-transaction';

export interface WagerTransactionResponse {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: string;
  balance?: { amount: string; currency: string };
  createdAt: string;
  processedAt?: string;
}

/** Campos deliberadamente ausentes: idempotencyKey/payloadHash (redundantes
 *  — o provider é quem os enviou) e referenceRetryAttempts/nextReferenceRetryAt
 *  (detalhes internos do worker de recovery, ARCHITECTURE.md seção 23 — não
 *  são informação que a API pública deveria vazar).
 *
 *  `kind` inclui OPENING quando aplicável — bloqueado apenas na SUBMISSÃO
 *  (SubmitWagerTransactionDto, seção 26), nunca na consulta: uma wallet
 *  criada com saldo inicial > 0 tem uma WagerTransaction OPENING real,
 *  persistida e auditável, e a consulta reflete fielmente o que existe no
 *  banco. */
export function toWagerTransactionResponse(transaction: WagerTransaction): WagerTransactionResponse {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    status: transaction.status,
    money: transaction.money.toJSON(),
    ...(transaction.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: transaction.referenceExternalTransactionId }
      : {}),
    ...(transaction.referenceTransactionId !== undefined
      ? { referenceTransactionId: transaction.referenceTransactionId }
      : {}),
    ...(transaction.failureCode !== undefined ? { failureCode: transaction.failureCode } : {}),
    ...(transaction.resultBalance !== undefined ? { balance: transaction.resultBalance.toJSON() } : {}),
    createdAt: transaction.createdAt.toISOString(),
    ...(transaction.processedAt !== undefined ? { processedAt: transaction.processedAt.toISOString() } : {}),
  };
}
