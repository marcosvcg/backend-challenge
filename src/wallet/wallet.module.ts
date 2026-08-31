import { Module } from '@nestjs/common';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from './application/create-wallet.use-case';
import { GetWalletUseCase } from './application/get-wallet.use-case';
import { GetWalletLedgerUseCase } from './application/get-wallet-ledger.use-case';
import { MikroOrmCreateWalletTransactionRunner } from './infrastructure/mikro-orm-create-wallet-transaction-runner';
import { MikroOrmWalletQueryRepository } from './infrastructure/persistence/mikro-orm-wallet-query.repository';
import { MikroOrmWalletLedgerQueryRepository } from './infrastructure/persistence/mikro-orm-wallet-ledger-query.repository';
import { WalletController } from './infrastructure/http/wallet.controller';
import { ID_GENERATOR, CLOCK } from '../shared/infrastructure/shared.tokens';
import type { IdGenerator } from '../shared/application/id-generator';
import type { Clock } from '../shared/application/clock';

/** EntityManager/MikroORM injetados aqui são as instâncias raiz do módulo
 *  Nest (Scope.DEFAULT — resolvidas uma única vez, no boot). Isso é seguro
 *  para CreateWalletUseCase porque MikroOrmCreateWalletTransactionRunner só
 *  usa esse EntityManager para chamar em.transactional() — que nunca acessa
 *  o contexto global diretamente (getContext(false), sem o guard) e sempre
 *  gerencia seu próprio fork/transação por chamada, não por instância. Já
 *  GetWalletUseCase usa MikroOrmWalletQueryRepository, que recebe o MikroORM
 *  (não um EntityManager) e faz fork() explicitamente a cada operação de
 *  leitura — nunca reusa um fork entre requests. Nenhum dos dois depende de
 *  RequestContext/middleware (ARCHITECTURE.md seção 25). */
@Module({
  controllers: [WalletController],
  providers: [
    {
      provide: CreateWalletUseCase,
      useFactory: (em: EntityManager, ids: IdGenerator, clock: Clock) =>
        new CreateWalletUseCase(new MikroOrmCreateWalletTransactionRunner(em), ids, clock),
      inject: [EntityManager, ID_GENERATOR, CLOCK],
    },
    {
      provide: GetWalletUseCase,
      useFactory: (orm: MikroORM) => new GetWalletUseCase(new MikroOrmWalletQueryRepository(orm)),
      inject: [MikroORM],
    },
    {
      provide: GetWalletLedgerUseCase,
      useFactory: (orm: MikroORM) => new GetWalletLedgerUseCase(new MikroOrmWalletLedgerQueryRepository(orm)),
      inject: [MikroORM],
    },
  ],
})
export class WalletModule {}
