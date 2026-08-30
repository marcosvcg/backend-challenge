import { EntityManager } from '@mikro-orm/postgresql';
import { WagerTransactionRepository } from '../../application/ports/wager-transaction.repository';
import { WagerTransaction } from '../../domain/wager-transaction';
import { WagerTransactionKind } from '../../domain/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wager-transaction-status';
import { WagerTransactionRow } from './wager-transaction.row';
import {
  wagerTransactionDomainToRow,
  wagerTransactionDomainToUpdatePayload,
  wagerTransactionRowToDomain,
} from './wager-transaction.mapper';

/** Construído sempre com o EntityManager "forked" da transação corrente. */
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionRow, { idempotencyKey });
    return row ? wagerTransactionRowToDomain(row) : undefined;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionRow, { providerId, externalTransactionId });
    return row ? wagerTransactionRowToDomain(row) : undefined;
  }

  /** Espelha o índice único parcial wt_reference_reversal_unique — checagem de
   *  aplicação, chamada pelo use case depois do lock pessimista da wallet e
   *  antes de qualquer debit/credit, dentro da mesma transação (ARCHITECTURE.md
   *  seção 16). A UNIQUE parcial no banco continua como defesa final contra race. */
  async hasProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRow, {
      referenceTransactionId,
      kind,
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async create(transaction: WagerTransaction): Promise<void> {
    this.em.create(WagerTransactionRow, wagerTransactionDomainToRow(transaction));
    await this.em.flush();
  }

  async update(transaction: WagerTransaction): Promise<void> {
    const existing = await this.em.findOneOrFail(WagerTransactionRow, { id: transaction.id });
    this.em.assign(existing, wagerTransactionDomainToUpdatePayload(transaction));
    await this.em.flush();
  }
}
