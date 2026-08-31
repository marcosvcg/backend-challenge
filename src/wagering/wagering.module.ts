import { Module } from '@nestjs/common';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { RetryPendingReferencesUseCase } from './application/retry-pending-references.use-case';
import { GetWagerTransactionByIdUseCase } from './application/get-wager-transaction-by-id.use-case';
import { GetWagerTransactionByProviderAndExternalIdUseCase } from './application/get-wager-transaction-by-provider-and-external-id.use-case';
import { DEFAULT_REFERENCE_RETRY_POLICY } from './application/reference-retry-policy';
import { MikroOrmTransactionRunner } from './infrastructure/mikro-orm-transaction-runner';
import { MikroOrmPendingReferenceWorkerTransactionRunner } from './infrastructure/mikro-orm-pending-reference-worker-transaction-runner';
import { MikroOrmWagerTransactionQueryRepository } from './infrastructure/persistence/mikro-orm-wager-transaction-query.repository';
import { WagerConsumerRuntime } from './infrastructure/messaging/wager-consumer.runtime';
import { PendingReferenceRuntime } from './infrastructure/pending-reference.runtime';
import { WagerTransactionController } from './infrastructure/http/wager-transaction.controller';
import { WagerTransactionQueryController } from './infrastructure/http/wager-transaction-query.controller';
import { ID_GENERATOR, CLOCK } from '../shared/infrastructure/shared.tokens';
import type { IdGenerator } from '../shared/application/id-generator';
import type { Clock } from '../shared/application/clock';

/** Mesmo padrão de wallet.module.ts: EntityManager raiz do Nest injetado
 *  aqui é seguro porque MikroOrmTransactionRunner/
 *  MikroOrmPendingReferenceWorkerTransactionRunner só o usam para chamar
 *  em.transactional() — nunca acessam o contexto global diretamente
 *  (ARCHITECTURE.md seção 25). ReferenceRetryPolicy é a mesma instância
 *  DEFAULT_REFERENCE_RETRY_POLICY usada por ProcessWagerTransactionUseCase E
 *  RetryPendingReferencesUseCase — fonte única de verdade para o cálculo de
 *  backoff (ARCHITECTURE.md seção 23).
 *
 *  GetWagerTransactionBy*UseCase usam MikroOrmWagerTransactionQueryRepository
 *  (MikroORM, fork() por operação) — nunca MikroOrmWagerTransactionRepository
 *  (o de escrita, usado só dentro dos TransactionRunners), mesma separação
 *  write-path/read-path de WalletModule (ARCHITECTURE.md seção 25).
 *
 *  WagerConsumerRuntime/PendingReferenceRuntime ficam neste módulo (não um
 *  módulo "async" separado): consumer e pending-reference worker pertencem
 *  ao mesmo bounded context de wagering, e nenhum dos dois inicia trabalho
 *  por si só — ambos protegidos pelo gate START_BACKGROUND_WORKERS === 'true'
 *  dentro de onApplicationBootstrap() (ARCHITECTURE.md seção 30).
 *  PendingReferenceRuntime recebe RetryPendingReferencesUseCase já pronto via
 *  DI (não depende de SQS/rede, só de Postgres) — diferente de
 *  WagerConsumerRuntime, que precisa da fila resolvida antes de poder montar
 *  o WagerTransactionConsumer, e por isso só recebe ProcessWagerTransactionUseCase
 *  pronto (reaproveitado, nunca uma segunda instância) e monta o consumer
 *  internamente dentro do bootstrap. */
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
      provide: RetryPendingReferencesUseCase,
      useFactory: (em: EntityManager, ids: IdGenerator, clock: Clock) =>
        new RetryPendingReferencesUseCase(
          new MikroOrmPendingReferenceWorkerTransactionRunner(em),
          ids,
          clock,
          DEFAULT_REFERENCE_RETRY_POLICY,
        ),
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
    WagerConsumerRuntime,
    PendingReferenceRuntime,
  ],
})
export class WageringModule {}
