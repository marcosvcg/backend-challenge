import { WagerTransaction, type WagerTransactionState } from '../../domain/wager-transaction';
import { WagerTransactionKind } from '../../domain/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wager-transaction-status';
import { Money } from '../../../wallet/domain/money';
import { WagerTransactionRow } from './wager-transaction.row';

export function wagerTransactionRowToDomain(row: WagerTransactionRow): WagerTransaction {
  const state: WagerTransactionState = {
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind as WagerTransactionKind,
    money: Money.from({ amount: row.amount, currency: row.currency }),
    createdAt: row.createdAt,
    status: row.status as WagerTransactionStatus,
    referenceRetryAttempts: row.referenceRetryAttempts,
    ...(row.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: row.referenceExternalTransactionId }
      : {}),
    ...(row.referenceTransactionId !== undefined ? { referenceTransactionId: row.referenceTransactionId } : {}),
    ...(row.failureCode !== undefined ? { failureCode: row.failureCode } : {}),
    ...(row.processedAt !== undefined ? { processedAt: row.processedAt } : {}),
    ...(row.resultBalanceAmount !== undefined && row.resultBalanceCurrency !== undefined
      ? { resultBalance: Money.from({ amount: row.resultBalanceAmount, currency: row.resultBalanceCurrency }) }
      : {}),
    ...(row.nextReferenceRetryAt !== undefined ? { nextReferenceRetryAt: row.nextReferenceRetryAt } : {}),
  };

  return WagerTransaction.rehydrate(state);
}

export function wagerTransactionDomainToRow(transaction: WagerTransaction): WagerTransactionRow {
  const row = new WagerTransactionRow();
  row.id = transaction.id;
  row.providerId = transaction.providerId;
  row.externalTransactionId = transaction.externalTransactionId;
  row.idempotencyKey = transaction.idempotencyKey;
  row.payloadHash = transaction.payloadHash;
  row.walletId = transaction.walletId;
  row.playerId = transaction.playerId;
  row.roundId = transaction.roundId;
  row.gameId = transaction.gameId;
  row.kind = transaction.kind;
  row.amount = transaction.money.toJSON().amount;
  row.currency = transaction.money.toJSON().currency;
  row.status = transaction.status;
  row.referenceRetryAttempts = transaction.referenceRetryAttempts;
  row.createdAt = transaction.createdAt;

  if (transaction.referenceExternalTransactionId !== undefined) {
    row.referenceExternalTransactionId = transaction.referenceExternalTransactionId;
  }
  if (transaction.referenceTransactionId !== undefined) {
    row.referenceTransactionId = transaction.referenceTransactionId;
  }
  if (transaction.failureCode !== undefined) {
    row.failureCode = transaction.failureCode;
  }
  if (transaction.processedAt !== undefined) {
    row.processedAt = transaction.processedAt;
  }
  if (transaction.resultBalance !== undefined) {
    const resultJson = transaction.resultBalance.toJSON();
    row.resultBalanceAmount = resultJson.amount;
    row.resultBalanceCurrency = resultJson.currency;
  }
  if (transaction.nextReferenceRetryAt !== undefined) {
    row.nextReferenceRetryAt = transaction.nextReferenceRetryAt;
  }

  return row;
}
