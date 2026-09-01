import { MetricsPort } from '../../../shared/application/metrics';

interface RecordedCounter {
  name: string;
  labels: Record<string, string>;
}

interface RecordedGauge {
  name: string;
  value: number;
  labels: Record<string, string>;
}

interface RecordedHistogram {
  name: string;
  valueSeconds: number;
  labels: Record<string, string>;
}

/** Prova, nos testes que a usam, que o use case/runtime depende apenas de
 *  MetricsPort (a abstração), nunca de prom-client diretamente — nenhum
 *  import de Prometheus aparece neste arquivo (ARCHITECTURE.md seção 29/31). */
export class FakeMetrics implements MetricsPort {
  private counters: RecordedCounter[] = [];
  private gauges: RecordedGauge[] = [];
  private histograms: RecordedHistogram[] = [];

  incrementCounter(name: string, labels: Record<string, string> = {}): void {
    this.counters.push({ name, labels });
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    this.gauges.push({ name, value, labels });
  }

  observeHistogram(name: string, valueSeconds: number, labels: Record<string, string> = {}): void {
    this.histograms.push({ name, valueSeconds, labels });
  }

  getIncrements(): readonly RecordedCounter[] {
    return this.counters;
  }

  getGauges(): readonly RecordedGauge[] {
    return this.gauges;
  }

  getHistogramObservations(): readonly RecordedHistogram[] {
    return this.histograms;
  }

  reset(): void {
    this.counters = [];
    this.gauges = [];
    this.histograms = [];
  }
}
