import { EntityManager } from '@mikro-orm/postgresql';
import {
  PendingReferenceWorkerTransactionRunner,
  PendingReferenceWorkerUnitOfWork,
} from '../application/ports/pending-reference-worker-unit-of-work';
import { MikroOrmPendingReferenceWorkerRepository } from './persistence/mikro-orm-pending-reference-worker.repository';
import { MikroOrmWagerTransactionRepository } from './persistence/mikro-orm-wager-transaction.repository';
import { MikroOrmWalletRepository } from '../../wallet/infrastructure/persistence/mikro-orm-wallet.repository';
import { MikroOrmOutboxRepository } from '../../outbox/infrastructure/persistence/mikro-orm-outbox.repository';
import { MetricsPort } from '../../shared/application/metrics';

const noopMetrics: MetricsPort = {
  incrementCounter: () => {},
  setGauge: () => {},
  observeHistogram: () => {},
};

/** Mesmo mecanismo transacional dos demais runners (em.transactional() por
 *  baixo) — claim + resolução da referência + wallet lock + ledger + outbox
 *  tudo na mesma transação, commitada só ao final de cada item do batch
 *  (ARCHITECTURE.md seção 22).
 *
 *  metrics é opcional (default no-op) — mesma propagação de
 *  MikroOrmTransactionRunner, para wallet_lock_acquisition_duration_seconds
 *  em MikroOrmWalletRepository.findByIdForUpdate(), chamado no branch de
 *  rejeição por limite esgotado (ARCHITECTURE.md seção 31). */
export class MikroOrmPendingReferenceWorkerTransactionRunner implements PendingReferenceWorkerTransactionRunner {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsPort = noopMetrics,
  ) {}

  async run<T>(work: (uow: PendingReferenceWorkerUnitOfWork) => Promise<T>): Promise<T> {
    return this.em.transactional(async (forkedEm) => {
      const uow: PendingReferenceWorkerUnitOfWork = {
        pendingReferenceWorker: new MikroOrmPendingReferenceWorkerRepository(forkedEm),
        wagerTransaction: new MikroOrmWagerTransactionRepository(forkedEm),
        wallet: new MikroOrmWalletRepository(forkedEm, this.metrics),
        outbox: new MikroOrmOutboxRepository(forkedEm),
      };
      return work(uow);
    });
  }
}
