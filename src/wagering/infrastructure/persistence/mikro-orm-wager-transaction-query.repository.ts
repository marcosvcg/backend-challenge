import { MikroORM } from '@mikro-orm/postgresql';
import { WagerTransactionQueryRepository } from '../../application/ports/wager-transaction-query.repository';
import { WagerTransaction } from '../../domain/wager-transaction';
import { WagerTransactionRow } from './wager-transaction.row';
import { wagerTransactionRowToDomain } from './wager-transaction.mapper';

/** Recebe MikroORM (não um EntityManager já forkado) — mesma razão de
 *  MikroOrmWalletQueryRepository (ARCHITECTURE.md seção 25): esta é leitura
 *  HTTP isolada, fora de qualquer TransactionRunner, então faz fork() por
 *  sua própria conta a cada operação. MikroOrmWagerTransactionRepository
 *  (usado dentro do WageringUnitOfWork financeiro) nunca deve fazer isso —
 *  recebe sempre o EntityManager já forkado pela transação corrente. */
export class MikroOrmWagerTransactionQueryRepository implements WagerTransactionQueryRepository {
  constructor(private readonly orm: MikroORM) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const em = this.orm.em.fork();
    const row = await em.findOne(WagerTransactionRow, { id });
    return row ? wagerTransactionRowToDomain(row) : undefined;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const em = this.orm.em.fork();
    const row = await em.findOne(WagerTransactionRow, { providerId, externalTransactionId });
    return row ? wagerTransactionRowToDomain(row) : undefined;
  }
}
