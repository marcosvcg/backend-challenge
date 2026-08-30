import { EntityManager } from '@mikro-orm/postgresql';
import {
  OutboxPublisherTransactionRunner,
  OutboxPublisherUnitOfWork,
} from '../application/ports/outbox-publisher-unit-of-work';
import { MikroOrmOutboxPublisherRepository } from './persistence/mikro-orm-outbox-publisher.repository';

/** Mesmo mecanismo transacional dos demais runners (em.transactional() por
 *  baixo) — a diferença crítica é que aqui a transação permanece aberta
 *  durante o I/O de rede ao SQS (dentro do use case), não só durante
 *  operações de banco. É essa janela aberta que preserva a exclusão de
 *  FOR UPDATE SKIP LOCKED entre publishers concorrentes (ARCHITECTURE.md
 *  seção 11) — commitar cedo liberaria os locks antes da publicação terminar. */
export class MikroOrmOutboxPublisherTransactionRunner implements OutboxPublisherTransactionRunner {
  constructor(private readonly em: EntityManager) {}

  async run<T>(work: (uow: OutboxPublisherUnitOfWork) => Promise<T>): Promise<T> {
    return this.em.transactional(async (forkedEm) => {
      const uow: OutboxPublisherUnitOfWork = {
        outboxPublisher: new MikroOrmOutboxPublisherRepository(forkedEm),
      };
      return work(uow);
    });
  }
}
