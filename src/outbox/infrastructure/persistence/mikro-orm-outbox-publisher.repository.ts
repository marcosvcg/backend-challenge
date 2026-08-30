import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { ClaimedOutboxMessage, OutboxPublisherRepository } from '../../application/ports/outbox-publisher.repository';
import { IntegrationEventEnvelope } from '../../../shared/domain/integration-event';
import { OutboxMessageRow } from './outbox-message.row';

/** Construído sempre com o EntityManager "forked" da transação corrente,
 *  igual aos demais repositórios concretos. A diferença aqui é que quem
 *  controla quando essa transação commita é o
 *  PublishPendingOutboxMessagesUseCase, não este repositório — claimBatch()
 *  nunca abre nem fecha transação própria (ARCHITECTURE.md seção 11). */
export class MikroOrmOutboxPublisherRepository implements OutboxPublisherRepository {
  constructor(private readonly em: EntityManager) {}

  async claimBatch(batchSize: number): Promise<ClaimedOutboxMessage[]> {
    const rows = await this.em
      .createQueryBuilder(OutboxMessageRow)
      .select('*')
      .where({ publishedAt: null, nextAttemptAt: { $lte: new Date() } })
      .orderBy({ nextAttemptAt: 'ASC' })
      .limit(batchSize)
      .setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE) // FOR UPDATE SKIP LOCKED
      .execute('all');

    return rows.map((row: OutboxMessageRow) => ({
      id: row.id,
      aggregateId: row.aggregateId,
      envelope: row.payload as unknown as IntegrationEventEnvelope<unknown>,
    }));
  }

  async markPublished(id: string, at: Date): Promise<void> {
    const row = this.em.getReference(OutboxMessageRow, id);
    this.em.assign(row, { publishedAt: at, nextAttemptAt: null });
    await this.em.flush();
  }

  async scheduleRetry(id: string, nextAttemptAt: Date): Promise<void> {
    const row = await this.em.findOneOrFail(OutboxMessageRow, { id });
    this.em.assign(row, { attempts: row.attempts + 1, nextAttemptAt });
    await this.em.flush();
  }
}
