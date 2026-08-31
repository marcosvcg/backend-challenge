import { Module } from '@nestjs/common';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { GetWagerTransactionByIdUseCase } from './application/get-wager-transaction-by-id.use-case';
import { GetWagerTransactionByProviderAndExternalIdUseCase } from './application/get-wager-transaction-by-provider-and-external-id.use-case';
import { DEFAULT_REFERENCE_RETRY_POLICY } from './application/reference-retry-policy';
import { MikroOrmTransactionRunner } from './infrastructure/mikro-orm-transaction-runner';
import { MikroOrmWagerTransactionQueryRepository } from './infrastructure/persistence/mikro-orm-wager-transaction-query.repository';
import { WagerTransactionController } from './infrastructure/http/wager-transaction.controller';
import { WagerTransactionQueryController } from './infrastructure/http/wager-transaction-query.controller';
import { ID_GENERATOR, CLOCK } from '../shared/infrastructure/shared.tokens';
import type { IdGenerator } from '../shared/application/id-generator';
import type { Clock } from '../shared/application/clock';

/** Mesmo padrão de wallet.module.ts: EntityManager raiz do Nest injetado
 *  aqui é seguro porque MikroOrmTransactionRunner só o usa para chamar
 *  em.transactional() — nunca acessa o contexto global diretamente
 *  (ARCHITECTURE.md seção 25). ReferenceRetryPolicy é a mesma instância
 *  DEFAULT_REFERENCE_RETRY_POLICY usada pelo worker de PENDING_REFERENCE
 *  (RetryPendingReferencesUseCase, ainda não conectado ao Nest) — fonte
 *  única de verdade para o cálculo de backoff (ARCHITECTURE.md seção 23).
 *
 *  GetWagerTransactionBy*UseCase usam MikroOrmWagerTransactionQueryRepository
 *  (MikroORM, fork() por operação) — nunca MikroOrmWagerTransactionRepository
 *  (o de escrita, usado só dentro de MikroOrmTransactionRunner/WageringUnitOfWork),
 *  mesma separação write-path/read-path de WalletModule (ARCHITECTURE.md
 *  seção 25). */
@Module({
  controllers: [WagerTransactionController, WagerTransactionQueryController],
  providers: [
    {
      provide: ProcessWagerTransactionUseCase,
      useFactory: (em: EntityManager, ids: IdGenerator, clock: Clock) =>
        new ProcessWagerTransactionUseCase(new MikroOrmTransactionRunner(em), ids, clock, DEFAULT_REFERENCE_RETRY_POLICY),
      inject: [EntityManager, ID_GENERATOR, CLOCK],
    },
    {
      provide: GetWagerTransactionByIdUseCase,
      useFactory: (orm: MikroORM) => new GetWagerTransactionByIdUseCase(new MikroOrmWagerTransactionQueryRepository(orm)),
      inject: [MikroORM],
    },
    {
      provide: GetWagerTransactionByProviderAndExternalIdUseCase,
      useFactory: (orm: MikroORM) =>
        new GetWagerTransactionByProviderAndExternalIdUseCase(new MikroOrmWagerTransactionQueryRepository(orm)),
      inject: [MikroORM],
    },
  ],
})
export class WageringModule {}
