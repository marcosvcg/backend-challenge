import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { PendingReferenceWorkerRepository } from '../../application/ports/pending-reference-worker.repository';
import { WagerTransaction } from '../../domain/wager-transaction';
import { WagerTransactionStatus } from '../../domain/wager-transaction-status';
import { WagerTransactionRow } from './wager-transaction.row';
import { wagerTransactionRowToDomain } from './wager-transaction.mapper';

/** Construído sempre com o EntityManager "forked" da transação corrente. A
 *  transação é controlada por RetryPendingReferencesUseCase, não por este
 *  repositório — claimBatch() nunca abre nem fecha transação própria (mesma
 *  disciplina de MikroOrmOutboxPublisherRepository, ARCHITECTURE.md seção 18). */
export class MikroOrmPendingReferenceWorkerRepository implements PendingReferenceWorkerRepository {
  constructor(private readonly em: EntityManager) {}

  async claimBatch(batchSize: number, now: Date): Promise<WagerTransaction[]> {
    const rows = await this.em
      .createQueryBuilder(WagerTransactionRow)
      .select('*')
      .where({ status: WagerTransactionStatus.PendingReference, nextReferenceRetryAt: { $lte: now } })
      .orderBy({ nextReferenceRetryAt: 'ASC' })
      .limit(batchSize)
      .setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE) // FOR UPDATE SKIP LOCKED
      .execute('all');

    return rows.map((row: WagerTransactionRow) => wagerTransactionRowToDomain(row));
  }
}
