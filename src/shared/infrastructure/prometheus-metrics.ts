import { Counter, Registry } from 'prom-client';
import { MetricsPort } from '../application/metrics';

/** Implementação concreta de MetricsPort sobre prom-client — única classe do
 *  projeto que importa prom-client diretamente (ARCHITECTURE.md seção 29).
 *  Um único Registry por instância: cada Counter é criado sob demanda na
 *  primeira chamada com um `name` novo e reaproveitado nas seguintes —
 *  prom-client lança se dois Counters forem registrados com o mesmo nome no
 *  mesmo Registry, então o cache por nome é necessário, não só uma otimização. */
export class PrometheusMetrics implements MetricsPort {
  private readonly counters = new Map<string, Counter<string>>();

  constructor(private readonly registry: Registry = new Registry()) {}

  incrementCounter(name: string, labels: Record<string, string> = {}): void {
    const counter = this.getOrCreateCounter(name, Object.keys(labels));
    counter.inc(labels);
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
}
