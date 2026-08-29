import { IntegrationEvent } from '../../shared/domain/integration-event';
import { EventContext, baseEventProps } from '../../shared/domain/event-context';
import { WagerTransaction } from './wager-transaction';
import { MoneyProps } from '../../wallet/domain/money';

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  money: MoneyProps;
  failureCode: string;
  resultBalance: MoneyProps;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!transaction.failureCode || !transaction.resultBalance) {
      throw new Error('Cannot build WagerTransactionRejected from a non-REJECTED transaction.');
    }

    return new WagerTransactionRejected({
      ...baseEventProps(ctx, transaction.walletId),
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        failureCode: transaction.failureCode,
        resultBalance: transaction.resultBalance.toJSON(),
      },
    });
  }
}
