/** Porta separada de MetricsPort — recording (incrementar/observar) e scrape
 *  (exportar o estado acumulado para o Prometheus) são responsabilidades
 *  diferentes: quase todo use case/runtime do projeto precisa de
 *  MetricsPort; só o endpoint HTTP /metrics precisa de MetricsExporter.
 *  Mesma disciplina de application nunca conhecer Prometheus diretamente —
 *  o retorno é texto genérico + content type, nunca um tipo de prom-client
 *  (ARCHITECTURE.md seção 31). */
export interface MetricsExporterResult {
  text: string;
  contentType: string;
}

export interface MetricsExporter {
  export(): Promise<MetricsExporterResult>;
}
