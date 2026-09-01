import { EntityManager } from '@mikro-orm/postgresql';
import { CreateWalletTransactionRunner, CreateWalletUnitOfWork } from '../application/ports/create-wallet-unit-of-work';
import { MikroOrmWalletRepository } from './persistence/mikro-orm-wallet.repository';
import { MikroOrmWagerTransactionRepository } from '../../wagering/infrastructure/persistence/mikro-orm-wager-transaction.repository';
import { MikroOrmOutboxRepository } from '../../outbox/infrastructure/persistence/mikro-orm-outbox.repository';
import { MetricsPort } from '../../shared/application/metrics';

const noopMetrics: MetricsPort = {
  incrementCounter: () => {},
  setGauge: () => {},
  observeHistogram: () => {},
};

/** Mesmo mecanismo transacional de MikroOrmTransactionRunner (em.transactional()
 *  por baixo) — shape de UoW menor, sem inbox, que CreateWalletUseCase nunca usa.
 *
 *  metrics é opcional (default no-op) — mesma propagação de
 *  MikroOrmTransactionRunner, por consistência estrutural entre os 3 runners
 *  que constroem MikroOrmWalletRepository, mesmo que CreateWalletUseCase
 *  nunca chame findByIdForUpdate() hoje (ARCHITECTURE.md seção 31). */
export class MikroOrmCreateWalletTransactionRunner implements CreateWalletTransactionRunner {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsPort = noopMetrics,
  ) {}

  async run<T>(work: (uow: CreateWalletUnitOfWork) => Promise<T>): Promise<T> {
    return this.em.transactional(async (forkedEm) => {
      const uow: CreateWalletUnitOfWork = {
        wallet: new MikroOrmWalletRepository(forkedEm, this.metrics),
        wagerTransaction: new MikroOrmWagerTransactionRepository(forkedEm),
        outbox: new MikroOrmOutboxRepository(forkedEm),
      };
      return work(uow);
    });
  }
}
