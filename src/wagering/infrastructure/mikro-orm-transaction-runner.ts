import { EntityManager } from '@mikro-orm/postgresql';
import { TransactionRunner, WageringUnitOfWork } from '../application/ports/unit-of-work';
import { MikroOrmWalletRepository } from '../../wallet/infrastructure/persistence/mikro-orm-wallet.repository';
import { MikroOrmWagerTransactionRepository } from './persistence/mikro-orm-wager-transaction.repository';
import { MikroOrmInboxRepository } from '../../inbox/infrastructure/persistence/mikro-orm-inbox.repository';
import { MikroOrmOutboxRepository } from '../../outbox/infrastructure/persistence/mikro-orm-outbox.repository';

/** Único lugar que sabe abrir uma transação Postgres real. `em.transactional()`
 *  faz fork do EntityManager, abre BEGIN, e comita/reverte automaticamente
 *  conforme `work` resolve ou rejeita. Os 4 repositórios são instanciados aqui,
 *  amarrados ao MESMO EntityManager forked — nunca ao EntityManager global do
 *  módulo Nest (ARCHITECTURE.md seção 3). */
export class MikroOrmTransactionRunner implements TransactionRunner {
  constructor(private readonly em: EntityManager) {}

  async run<T>(work: (uow: WageringUnitOfWork) => Promise<T>): Promise<T> {
    return this.em.transactional(async (forkedEm) => {
      const uow: WageringUnitOfWork = {
        wallet: new MikroOrmWalletRepository(forkedEm),
        wagerTransaction: new MikroOrmWagerTransactionRepository(forkedEm),
        inbox: new MikroOrmInboxRepository(forkedEm),
        outbox: new MikroOrmOutboxRepository(forkedEm),
      };
      return work(uow);
    });
  }
}
