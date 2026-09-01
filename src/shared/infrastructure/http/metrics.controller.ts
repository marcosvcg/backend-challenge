import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { MetricsExporter } from '../../application/metrics-exporter';
import { METRICS_EXPORTER } from '../shared.tokens';

/** Único ponto de scrape — Prometheus (docker-compose, observability/prometheus.yml)
 *  aponta para app:3000/metrics. Sem autenticação (mesmo espírito de
 *  /health/live e /health/ready — README seção 9: health checks não exigem
 *  autenticação; /metrics é infraestrutura de mesma natureza, não um
 *  endpoint de negócio). */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS_EXPORTER) private readonly exporter: MetricsExporter) {}

  @Get()
  async get(@Res() res: Response): Promise<void> {
    const { text, contentType } = await this.exporter.export();
    res.set('Content-Type', contentType).set('Cache-Control', 'no-store').send(text);
  }
}
