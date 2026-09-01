import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { MetricsPort } from '../application/metrics';
import { MetricsExporter, MetricsExporterResult } from '../application/metrics-exporter';

/** Implementação concreta de MetricsPort E MetricsExporter sobre prom-client
 *  — única classe do projeto que importa prom-client diretamente
 *  (ARCHITECTURE.md seção 29/31). As duas portas são interfaces separadas
 *  (recording vs. scrape), mas uma única classe/instância singleton as
 *  implementa sobre o MESMO Registry — nunca um segundo Registry para o
 *  exporter, nunca uma segunda instância de PrometheusMetrics.
 *
 *  Um Counter/Gauge/Histogram por `name`, criado sob demanda na primeira
 *  chamada e reaproveitado nas seguintes — prom-client lança se duas
 *  métricas forem registradas com o mesmo nome no mesmo Registry, então o
 *  cache por nome é necessário, não só uma otimização. */
export class PrometheusMetrics implements MetricsPort, MetricsExporter {
  private readonly counters = new Map<string, Counter<string>>();
  private readonly gauges = new Map<string, Gauge<string>>();
  private readonly histograms = new Map<string, Histogram<string>>();

  constructor(private readonly registry: Registry = new Registry()) {}

  incrementCounter(name: string, labels: Record<string, string> = {}): void {
    const counter = this.getOrCreateCounter(name, Object.keys(labels));
    counter.inc(labels);
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const gauge = this.getOrCreateGauge(name, Object.keys(labels));
    gauge.set(labels, value);
  }

  observeHistogram(name: string, valueSeconds: number, labels: Record<string, string> = {}): void {
    const histogram = this.getOrCreateHistogram(name, Object.keys(labels));
    histogram.observe(labels, valueSeconds);
  }

  async export(): Promise<MetricsExporterResult> {
    return { text: await this.registry.metrics(), contentType: this.registry.contentType };
  }

  getRegistry(): Registry {
    return this.registry;
  }

  private getOrCreateCounter(name: string, labelNames: string[]): Counter<string> {
    const existing = this.counters.get(name);
    if (existing) {
      return existing;
    }

    const counter = new Counter({
      name,
      help: name, // help é obrigatório para prom-client; sem descrição de negócio própria por métrica neste incremento fundacional
      labelNames,
      registers: [this.registry],
    });
    this.counters.set(name, counter);
    return counter;
  }

  private getOrCreateGauge(name: string, labelNames: string[]): Gauge<string> {
    const existing = this.gauges.get(name);
    if (existing) {
      return existing;
    }

    const gauge = new Gauge({ name, help: name, labelNames, registers: [this.registry] });
    this.gauges.set(name, gauge);
    return gauge;
  }

  private getOrCreateHistogram(name: string, labelNames: string[]): Histogram<string> {
    const existing = this.histograms.get(name);
    if (existing) {
      return existing;
    }

    const histogram = new Histogram({ name, help: name, labelNames, registers: [this.registry] });
    this.histograms.set(name, histogram);
    return histogram;
  }
}
