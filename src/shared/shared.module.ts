import { Global, Module } from '@nestjs/common';
import { UuidIdGenerator } from './infrastructure/uuid-id-generator';
import { SystemClock } from './infrastructure/system-clock';
import { PrometheusMetrics } from './infrastructure/prometheus-metrics';
import { ConsoleLogger } from './infrastructure/console-logger';
import { ID_GENERATOR, CLOCK, METRICS, LOGGER } from './infrastructure/shared.tokens';

/** @Global(): IdGenerator/Clock/MetricsPort/Logger são usados por
 *  praticamente todo use case do projeto — evita reimportar este módulo em
 *  cada feature module. Nenhum outro provider deste tipo (específico de
 *  feature) deve virar global.
 *
 *  PrometheusMetrics registrado sem factory (Scope.DEFAULT, singleton padrão
 *  do Nest) — UMA única instância, UM único Registry, compartilhado por toda
 *  a aplicação: é assim que um futuro endpoint /metrics (Grupo H) conseguiria
 *  expor todos os contadores registrados por qualquer feature module juntos
 *  (ARCHITECTURE.md seção 29). */
@Global()
@Module({
  providers: [
    { provide: ID_GENERATOR, useClass: UuidIdGenerator },
    { provide: CLOCK, useClass: SystemClock },
    { provide: METRICS, useClass: PrometheusMetrics },
    { provide: LOGGER, useClass: ConsoleLogger },
  ],
  exports: [ID_GENERATOR, CLOCK, METRICS, LOGGER],
})
export class SharedModule {}
