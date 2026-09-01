/** Nomes e labels das métricas de wagering — centralizados aqui, nunca uma
 *  string/número mágico duplicado entre os dois callers que instrumentam
 *  (WagerTransactionController, WagerTransactionConsumer) e os testes
 *  (ARCHITECTURE.md seção 31).
 *
 *  Instrumentadas SEMPRE depois de ProcessWagerTransactionUseCase.execute()
 *  já ter resolvido (a transação SQL já comitou) — nunca dentro do use case/
 *  ResolveAndApplyWagerTransaction, para nunca produzir uma contagem
 *  financeira falsa se algo falhasse entre o incremento e o commit real. */
export const WAGER_TRANSACTIONS_TOTAL = 'wager_transactions_total';
export const WAGER_TRANSACTION_DUPLICATES_TOTAL = 'wager_transaction_duplicates_total';
export const WAGER_TRANSACTION_PROCESSING_DURATION_SECONDS = 'wager_transaction_processing_duration_seconds';

export type WagerTransactionMetricStatus = 'processed' | 'rejected' | 'pending_reference';
export type WagerTransactionMetricOrigin = 'http' | 'queue';
