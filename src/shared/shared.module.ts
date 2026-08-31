import { Global, Module } from '@nestjs/common';
import { UuidIdGenerator } from './infrastructure/uuid-id-generator';
import { SystemClock } from './infrastructure/system-clock';
import { ID_GENERATOR, CLOCK } from './infrastructure/shared.tokens';

/** @Global(): IdGenerator/Clock são usados por praticamente todo use case do
 *  projeto — evita reimportar este módulo em cada feature module. Nenhum
 *  outro provider deste tipo (específico de feature) deve virar global. */
@Global()
@Module({
  providers: [
    { provide: ID_GENERATOR, useClass: UuidIdGenerator },
    { provide: CLOCK, useClass: SystemClock },
  ],
  exports: [ID_GENERATOR, CLOCK],
})
export class SharedModule {}
