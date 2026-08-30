import { EntityManager } from '@mikro-orm/postgresql';
import { CreateWalletTransactionRunner, CreateWalletUnitOfWork } from '../application/ports/create-wallet-unit-of-work';
import { MikroOrmWalletRepository } from './persistence/mikro-orm-wallet.repository';
import { MikroOrmWagerTransactionRepository } from '../../wagering/infrastructure/persistence/mikro-orm-wager-transaction.repository';
import { MikroOrmOutboxRepository } from '../../outbox/infrastructure/persistence/mikro-orm-outbox.repository';

/** Mesmo mecanismo transacional de MikroOrmTransactionRunner (em.transactional()
 *  por baixo) — shape de UoW menor, sem inbox, que CreateWalletUseCase nunca usa. */
export class MikroOrmCreateWalletTransactionRunner implements CreateWalletTransactionRunner {
  constructor(private readonly em: EntityManager) {}

  async run<T>(work: (uow: CreateWalletUnitOfWork) => Promise<T>): Promise<T> {
    return this.em.transactional(async (forkedEm) => {
      const uow: CreateWalletUnitOfWork = {
        wallet: new MikroOrmWalletRepository(forkedEm),
        wagerTransaction: new MikroOrmWagerTransactionRepository(forkedEm),
        outbox: new MikroOrmOutboxRepository(forkedEm),
      };
      return work(uow);
    });
  }
}
