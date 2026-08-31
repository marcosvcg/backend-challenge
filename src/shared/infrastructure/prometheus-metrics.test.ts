import { describe, expect, it } from 'bun:test';
import { PrometheusMetrics } from './prometheus-metrics';

describe('PrometheusMetrics', () => {
  it('increments a counter and exposes it in Prometheus text format', async () => {
    const metrics = new PrometheusMetrics();

    metrics.incrementCounter('some_counter_total');
    metrics.incrementCounter('some_counter_total');

    const output = await metrics.getRegistry().metrics();
    expect(output).toContain('some_counter_total 2');
  });

  it('tracks separate values per label combination', async () => {
    const metrics = new PrometheusMetrics();

    metrics.incrementCounter('divergences_total', { reason: 'balance_mismatch' });
    metrics.incrementCounter('divergences_total', { reason: 'balance_mismatch' });
    metrics.incrementCounter('divergences_total', { reason: 'broken_chain' });

    const output = await metrics.getRegistry().metrics();
    expect(output).toContain('divergences_total{reason="balance_mismatch"} 2');
    expect(output).toContain('divergences_total{reason="broken_chain"} 1');
  });

  it('reuses the same Counter across calls with the same name — never re-registers', async () => {
    const metrics = new PrometheusMetrics();

    // Would throw if a second Counter with the same name were registered on
    // the same Registry — prom-client itself enforces this.
    expect(() => {
      metrics.incrementCounter('reused_counter_total');
      metrics.incrementCounter('reused_counter_total');
      metrics.incrementCounter('reused_counter_total');
    }).not.toThrow();
  });
});
