/** Tokens de DI do Nest para as portas compartilhadas de application
 *  (IdGenerator, Clock, MetricsPort, MetricsExporter, Logger) — interfaces
 *  puras, o Nest não resolve por tipo estrutural, então cada uma precisa de
 *  um token concreto para ser injetável. METRICS/METRICS_EXPORTER apontam
 *  para a MESMA instância singleton de PrometheusMetrics (um único Registry,
 *  ARCHITECTURE.md seção 31) — dois tokens porque são duas portas/
 *  responsabilidades distintas (recording vs. scrape), não duas instâncias. */
export const ID_GENERATOR = Symbol('IdGenerator');
export const CLOCK = Symbol('Clock');
export const METRICS = Symbol('MetricsPort');
export const METRICS_EXPORTER = Symbol('MetricsExporter');
export const LOGGER = Symbol('Logger');
