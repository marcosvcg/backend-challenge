/** Porta de log estruturado — application nunca conhece console/Loki/Grafana
 *  Alloy diretamente (ARCHITECTURE.md seção 29). meta nunca deve conter
 *  payload financeiro completo nem dado sensível (README seção 12) — só os
 *  identificadores/valores agregados necessários para diagnóstico. */
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
