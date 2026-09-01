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

  it('setGauge sets (not accumulates) the value for a label combination', async () => {
    const metrics = new PrometheusMetrics();

    metrics.setGauge('sqs_dlq_messages', 3, { queue: 'wager-transactions' });
    metrics.setGauge('sqs_dlq_messages', 5, { queue: 'wager-transactions' }); // overwrites, does not add to 3

    const output = await metrics.getRegistry().metrics();
    expect(output).toContain('sqs_dlq_messages{queue="wager-transactions"} 5');
  });

  it('setGauge tracks separate values per label combination', async () => {
    const metrics = new PrometheusMetrics();

    metrics.setGauge('sqs_dlq_messages', 3, { queue: 'wager-transactions' });
    metrics.setGauge('sqs_dlq_messages', 7, { queue: 'wager-events' });

    const output = await metrics.getRegistry().metrics();
    expect(output).toContain('sqs_dlq_messages{queue="wager-transactions"} 3');
    expect(output).toContain('sqs_dlq_messages{queue="wager-events"} 7');
  });

  it('observeHistogram records an observation exposed with the standard histogram suffixes', async () => {
    const metrics = new PrometheusMetrics();

    metrics.observeHistogram('wallet_lock_acquisition_duration_seconds', 0.05);
    metrics.observeHistogram('wallet_lock_acquisition_duration_seconds', 0.2);

    const output = await metrics.getRegistry().metrics();
    expect(output).toContain('wallet_lock_acquisition_duration_seconds_count 2');
    expect(output).toContain('wallet_lock_acquisition_duration_seconds_sum');
  });

  it('reuses the same Gauge/Histogram across calls with the same name — never re-registers', async () => {
    const metrics = new PrometheusMetrics();

    expect(() => {
      metrics.setGauge('reused_gauge', 1);
      metrics.setGauge('reused_gauge', 2);
      metrics.observeHistogram('reused_histogram_seconds', 0.1);
      metrics.observeHistogram('reused_histogram_seconds', 0.2);
    }).not.toThrow();
  });

  it('export() (MetricsExporter) returns the exact same accumulated state that MetricsPort recorded — same Registry, never a second one', async () => {
    const metrics = new PrometheusMetrics();

    metrics.incrementCounter('exported_counter_total');
    metrics.setGauge('exported_gauge', 42);
    metrics.observeHistogram('exported_histogram_seconds', 0.3);

    const { text, contentType } = await metrics.export();

    expect(text).toContain('exported_counter_total 1');
    expect(text).toContain('exported_gauge 42');
    expect(text).toContain('exported_histogram_seconds_count 1');
    expect(contentType).toBe(metrics.getRegistry().contentType);
  });
});
