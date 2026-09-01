import { ProcessWagerTransactionResult } from './process-wager-transaction.result';
import { MetricsPort } from '../../shared/application/metrics';
import { Logger } from '../../shared/application/logger';
import {
  WAGER_TRANSACTIONS_TOTAL,
  WAGER_TRANSACTION_DUPLICATES_TOTAL,
  WAGER_TRANSACTION_PROCESSING_DURATION_SECONDS,
  WagerTransactionMetricOrigin,
} from './wagering-metrics';

/** Único ponto de instrumentação de métricas/log para um
 *  ProcessWagerTransactionResult — usado pelos DOIS callers
 *  (WagerTransactionController, WagerTransactionConsumer) para nunca
 *  divergir a semântica entre origem HTTP e SQS. SEMPRE chamado depois que
 *  ProcessWagerTransactionUseCase.execute() já resolveu (a transação SQL já
 *  comitou) — nunca dentro do use case (ARCHITECTURE.md seção 31).
 *
 *  wager_transactions_total conta só desfechos de PROCESSAMENTO real
 *  (processed/rejected/pending_reference) — replay NUNCA incrementa essa
 *  métrica (a transação já tinha sido contada na primeira submissão);
 *  replay incrementa wager_transaction_duplicates_total. idempotency-conflict
 *  não incrementa nenhuma das duas — é rejeição de payload (409), não um
 *  desfecho de processamento nem uma duplicata legítima detectada. */
export function instrumentProcessResult(
  result: ProcessWagerTransactionResult,
  origin: WagerTransactionMetricOrigin,
  durationSeconds: number,
  metrics: MetricsPort,
  logger: Logger,
  context: { correlationId: string; messageId?: string; providerId?: string },
): void {
  if (result.kind === 'processed' || result.kind === 'rejected' || result.kind === 'pending-reference') {
    const status = result.kind === 'pending-reference' ? 'pending_reference' : result.kind;
    metrics.incrementCounter(WAGER_TRANSACTIONS_TOTAL, { status, origin });
    metrics.observeHistogram(WAGER_TRANSACTION_PROCESSING_DURATION_SECONDS, durationSeconds, { origin });
  } else if (result.kind === 'replay') {
    metrics.incrementCounter(WAGER_TRANSACTION_DUPLICATES_TOTAL, { origin });
  }

  logger.info('WagerTransaction processed', {
    event: 'wager_transaction_processed',
    resultKind: result.kind,
    correlationId: context.correlationId,
    ...(context.messageId !== undefined ? { messageId: context.messageId } : {}),
    ...(context.providerId !== undefined ? { providerId: context.providerId } : {}),
    ...(result.transaction !== undefined
      ? { transactionId: result.transaction.id, walletId: result.transaction.walletId }
      : {}),
  });
}
