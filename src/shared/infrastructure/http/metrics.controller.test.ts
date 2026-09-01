import { describe, expect, it } from 'bun:test';
import type { Response } from 'express';
import { MetricsController } from './metrics.controller';
import { MetricsExporter, MetricsExporterResult } from '../../application/metrics-exporter';

function fakeExporter(result: MetricsExporterResult): MetricsExporter {
  return { export: async () => result };
}

/** Response fake — coleta as chamadas encadeadas .set(...).set(...).send(...)
 *  sem depender de um servidor HTTP real (mesma filosofia de dependências
 *  controláveis usada nos testes de runtime). */
function fakeResponse() {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  const res = {
    set: (name: string, value: string) => {
      headers[name] = value;
      return res;
    },
    send: (value: string) => {
      body = value;
      return res;
    },
  } as unknown as Response;
  return { res, getHeaders: () => headers, getBody: () => body };
}

describe('MetricsController', () => {
  it('writes the exporter text as the body, with Content-Type set from the exporter result', async () => {
    const exporter = fakeExporter({
      text: 'wager_transactions_total{status="processed",origin="http"} 3\n',
      contentType: 'text/plain; version=0.0.4; charset=utf-8',
    });
    const controller = new MetricsController(exporter);
    const { res, getHeaders, getBody } = fakeResponse();

    await controller.get(res);

    expect(getBody()).toBe('wager_transactions_total{status="processed",origin="http"} 3\n');
    expect(getHeaders()['Content-Type']).toBe('text/plain; version=0.0.4; charset=utf-8');
  });

  it('always sets Cache-Control: no-store — Prometheus must always scrape fresh state, never a cached response', async () => {
    const exporter = fakeExporter({ text: '', contentType: 'text/plain; version=0.0.4; charset=utf-8' });
    const controller = new MetricsController(exporter);
    const { res, getHeaders } = fakeResponse();

    await controller.get(res);

    expect(getHeaders()['Cache-Control']).toBe('no-store');
  });
});
