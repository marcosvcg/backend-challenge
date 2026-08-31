import { MikroORM } from '@mikro-orm/postgresql';
import { WalletQueryRepository } from '../../application/ports/wallet-query.repository';
import { Wallet } from '../../domain/wallet';
import { WalletRow } from './wallet.row';
import { walletRowToDomain } from './wallet.mapper';

/** Recebe MikroORM (não um EntityManager já forkado) porque esta é a única
 *  peça do projeto que faz fork() por sua própria conta — fora de qualquer
 *  TransactionRunner, para uma leitura HTTP isolada. MikroOrmWalletRepository
 *  (usado dentro dos UnitOfWork financeiros) nunca deve fazer isso: recebe
 *  sempre o EntityManager já forkado pela transação corrente. */
export class MikroOrmWalletQueryRepository implements WalletQueryRepository {
  constructor(private readonly orm: MikroORM) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const em = this.orm.em.fork();
    const row = await em.findOne(WalletRow, { id });
    return row ? walletRowToDomain(row) : undefined;
  }
}
