import { EntityManager } from '@mikro-orm/postgresql';
import { WageringTransactionRunner, WageringUnitOfWork } from '../application/ports/unit-of-work';
import { MikroOrmWalletRepository } from '../../wallet/infrastructure/persistence/mikro-orm-wallet.repository';
import { MikroOrmWagerTransactionRepository } from './persistence/mikro-orm-wager-transaction.repository';
import { MikroOrmInboxRepository } from '../../inbox/infrastructure/persistence/mikro-orm-inbox.repository';
import { MikroOrmOutboxRepository } from '../../outbox/infrastructure/persistence/mikro-orm-outbox.repository';
import { MetricsPort } from '../../shared/application/metrics';

const noopMetrics: MetricsPort = {
  incrementCounter: () => {},
  setGauge: () => {},
  observeHistogram: () => {},
};

/** Único lugar que sabe abrir uma transação Postgres real. `em.transactional()`
 *  faz fork do EntityManager, abre BEGIN, e comita/reverte automaticamente
 *  conforme `work` resolve ou rejeita. Os 4 repositórios são instanciados aqui,
 *  amarrados ao MESMO EntityManager forked — nunca ao EntityManager global do
 *  módulo Nest (ARCHITECTURE.md seção 3).
 *
 *  metrics é opcional (default no-op) — alteração mínima e aditiva,
 *  propagada só para MikroOrmWalletRepository (wallet_lock_acquisition_duration_seconds,
 *  ARCHITECTURE.md seção 31). */
export class MikroOrmTransactionRunner implements WageringTransactionRunner {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsPort = noopMetrics,
  ) {}

  async run<T>(work: (uow: WageringUnitOfWork) => Promise<T>): Promise<T> {
    return this.em.transactional(async (forkedEm) => {
      const uow: WageringUnitOfWork = {
        wallet: new MikroOrmWalletRepository(forkedEm, this.metrics),
        wagerTransaction: new MikroOrmWagerTransactionRepository(forkedEm),
        inbox: new MikroOrmInboxRepository(forkedEm),
        outbox: new MikroOrmOutboxRepository(forkedEm),
      };
      return work(uow);
    });
  }
}
