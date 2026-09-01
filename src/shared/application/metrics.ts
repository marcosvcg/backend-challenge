/** Porta de métricas — application nunca conhece Prometheus/prom-client
 *  diretamente (ARCHITECTURE.md seção 29/31). Labels devem ser sempre de
 *  baixa cardinalidade (ex.: `reason`, `status`, `origin`) — NUNCA
 *  walletId/transactionId/messageId/playerId/externalTransactionId/
 *  correlationId ou qualquer identificador de alta cardinalidade como label;
 *  esses pertencem exclusivamente aos logs estruturados (Logger), nunca a
 *  uma métrica Prometheus. */
export interface MetricsPort {
  incrementCounter(name: string, labels?: Record<string, string>): void;
  setGauge(name: string, value: number, labels?: Record<string, string>): void;
  observeHistogram(name: string, valueSeconds: number, labels?: Record<string, string>): void;
}
