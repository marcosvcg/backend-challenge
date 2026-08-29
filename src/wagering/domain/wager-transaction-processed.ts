import { IntegrationEvent } from '../../shared/domain/integration-event';
import { EventContext, baseEventProps } from '../../shared/domain/event-context';
import { WagerTransaction } from './wager-transaction';
import { MoneyProps } from '../../wallet/domain/money';

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  money: MoneyProps;
  resultBalance: MoneyProps;
  processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS (seção 11 do README). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (!transaction.resultBalance || !transaction.processedAt) {
      throw new Error('Cannot build WagerTransactionProcessed from a non-PROCESSED transaction.');
    }

    return new WagerTransactionProcessed({
      ...baseEventProps(ctx, transaction.walletId),
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        resultBalance: transaction.resultBalance.toJSON(),
        processedAt: transaction.processedAt.toISOString(),
      },
    });
  }
}
