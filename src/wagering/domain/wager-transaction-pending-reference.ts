import { IntegrationEvent } from '../../shared/domain/integration-event';
import { EventContext, baseEventProps } from '../../shared/domain/event-context';
import { WagerTransaction } from './wager-transaction';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  referenceExternalTransactionId: string;
  walletId: string;
  kind: string;
  referenceRetryAttempts: number;
  nextReferenceRetryAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (!transaction.referenceExternalTransactionId || !transaction.nextReferenceRetryAt) {
      throw new Error('Cannot build WagerTransactionPendingReference from a transaction without a pending reference.');
    }

    return new WagerTransactionPendingReference({
      ...baseEventProps(ctx, transaction.walletId),
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
        walletId: transaction.walletId,
        kind: transaction.kind,
        referenceRetryAttempts: transaction.referenceRetryAttempts,
        nextReferenceRetryAt: transaction.nextReferenceRetryAt.toISOString(),
      },
    });
  }
}
