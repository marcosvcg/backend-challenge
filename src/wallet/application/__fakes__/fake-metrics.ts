import { MetricsPort } from '../../../shared/application/metrics';

/** Prova, nos testes de ReconcileWalletUseCase, que o use case depende
 *  apenas de MetricsPort (a abstração), nunca de prom-client diretamente —
 *  nenhum import de Prometheus aparece neste arquivo nem no use case
 *  (ARCHITECTURE.md seção 29). */
export class FakeMetrics implements MetricsPort {
  private increments: { name: string; labels: Record<string, string> }[] = [];

  incrementCounter(name: string, labels: Record<string, string> = {}): void {
    this.increments.push({ name, labels });
  }

  getIncrements(): readonly { name: string; labels: Record<string, string> }[] {
    return this.increments;
  }
}
