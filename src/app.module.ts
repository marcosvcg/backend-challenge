import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from '../mikro-orm.config';
import { HealthModule } from './health/health.module';
import { SharedModule } from './shared/shared.module';
import { WalletModule } from './wallet/wallet.module';
import { DomainErrorFilter } from './shared/infrastructure/http/domain-error.filter';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    // Deliberadamente SEM MikroOrmModule.forMiddleware()/RequestContext: todo
    // repositório do projeto já é construído com um EntityManager
    // explicitamente forkado pelo caller (TransactionRunner.run() para
    // escrita; MikroOrmWalletQueryRepository.fork() por operação para
    // leitura HTTP) — nunca dependendo de contexto implícito de middleware.
    // Duas estratégias de isolamento (fork explícito + RequestContext
    // implícito) coexistindo seria uma fonte de bugs sutis, não uma proteção
    // extra (ARCHITECTURE.md seção 25).
    SharedModule,
    HealthModule,
    WalletModule,
  ],
  providers: [
    { provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }) },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
})
export class AppModule {}
