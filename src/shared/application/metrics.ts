/** Porta de métricas — application nunca conhece Prometheus/prom-client
 *  diretamente (ARCHITECTURE.md seção 29). Labels devem ser sempre de baixa
 *  cardinalidade (ex.: `reason`, `status`) — NUNCA walletId/transactionId/
 *  playerId ou qualquer identificador de alta cardinalidade como label; esses
 *  pertencem aos logs estruturados, nunca a uma métrica Prometheus. */
export interface MetricsPort {
  incrementCounter(name: string, labels?: Record<string, string>): void;
}
