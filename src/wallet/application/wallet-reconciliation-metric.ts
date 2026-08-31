/** Nome e labels da métrica de reconciliação — únicos, centralizados aqui,
 *  reusados pelo use case e pelos testes (nenhum número/string mágica
 *  duplicada). Sem walletId/transactionId/playerId como label — alta
 *  cardinalidade nunca vira label Prometheus (README seção 12,
 *  ARCHITECTURE.md seção 29); esses identificadores só aparecem nos logs
 *  estruturados. */
export const WALLET_RECONCILIATION_DIVERGENCES_TOTAL = 'wallet_reconciliation_divergences_total';

/** Um dos quatro tipos de inconsistência que o algoritmo de reconciliação
 *  pode detectar (ARCHITECTURE.md seção 29) — baixa cardinalidade, valor
 *  fixo. Ordem de prioridade determinística quando múltiplos problemas
 *  coexistem na mesma execução: invalid_anchor → invalid_entry →
 *  broken_chain → balance_mismatch. */
export type ReconciliationDivergenceReason = 'invalid_anchor' | 'invalid_entry' | 'broken_chain' | 'balance_mismatch';
