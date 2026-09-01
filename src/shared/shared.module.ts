import { Global, Module } from '@nestjs/common';
import { UuidIdGenerator } from './infrastructure/uuid-id-generator';
import { SystemClock } from './infrastructure/system-clock';
import { PrometheusMetrics } from './infrastructure/prometheus-metrics';
import { ConsoleLogger } from './infrastructure/console-logger';
import { SqsQueueUrlResolver } from './infrastructure/messaging/sqs-queue-url-resolver';
import { createSqsClient } from './infrastructure/messaging/sqs-client-factory';
import { DlqGaugeRuntime } from './infrastructure/messaging/dlq-gauge.runtime';
import { MetricsController } from './infrastructure/http/metrics.controller';
import { ID_GENERATOR, CLOCK, METRICS, METRICS_EXPORTER, LOGGER } from './infrastructure/shared.tokens';

/** @Global(): IdGenerator/Clock/MetricsPort/MetricsExporter/Logger/
 *  SqsQueueUrlResolver são usados por praticamente todo use case/runtime do
 *  projeto — evita reimportar este módulo em cada feature module. Nenhum
 *  outro provider deste tipo (específico de feature) deve virar global.
 *
 *  PrometheusMetrics registrado sem factory (Scope.DEFAULT, singleton padrão
 *  do Nest) — UMA única instância, UM único Registry, compartilhado por toda
 *  a aplicação. METRICS_EXPORTER usa useExisting: METRICS — é um ALIAS para
 *  a mesma instância já resolvida por METRICS, nunca uma segunda construção
 *  de PrometheusMetrics/um segundo Registry (ARCHITECTURE.md seção 31): é
 *  assim que o endpoint /metrics consegue expor exatamente os mesmos
 *  contadores/gauges/histogramas que qualquer use case/runtime já incrementa
 *  via MetricsPort em qualquer feature module.
 *
 *  SqsQueueUrlResolver é construído aqui (uma única vez, um único SQSClient
 *  reaproveitado) mas NUNCA chamado em tempo de módulo/boot — a chamada real
 *  a GetQueueUrlCommand só acontece dentro de onApplicationBootstrap() de
 *  cada runtime, e só quando START_BACKGROUND_WORKERS === 'true'. Injetável
 *  no construtor de cada runtime em vez de importado como função direta,
 *  para que os runtimes sejam testáveis com um resolver fake, sem depender
 *  de rede/LocalStack real (ARCHITECTURE.md seção 30). */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    { provide: ID_GENERATOR, useClass: UuidIdGenerator },
    { provide: CLOCK, useClass: SystemClock },
    { provide: METRICS, useClass: PrometheusMetrics },
    { provide: METRICS_EXPORTER, useExisting: METRICS },
    { provide: LOGGER, useClass: ConsoleLogger },
    { provide: SqsQueueUrlResolver, useFactory: () => new SqsQueueUrlResolver(createSqsClient()) },
    DlqGaugeRuntime,
  ],
  exports: [ID_GENERATOR, CLOCK, METRICS, METRICS_EXPORTER, LOGGER, SqsQueueUrlResolver],
})
export class SharedModule {}
