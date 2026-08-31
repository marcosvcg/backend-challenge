import { MikroORM } from '@mikro-orm/postgresql';
import { WalletLedgerQueryRepository } from '../../application/ports/wallet-ledger-query.repository';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { LedgerCursor } from '../../application/wallet-ledger-cursor';
import { WalletLedgerEntryRow } from './wallet-ledger-entry.row';
import { walletLedgerEntryRowToDomain } from './wallet-ledger-entry.mapper';

/** Recebe MikroORM (não um EntityManager já forkado) — mesma razão de
 *  MikroOrmWalletQueryRepository/MikroOrmWagerTransactionQueryRepository
 *  (ARCHITECTURE.md seção 25): leitura HTTP isolada, fora de qualquer
 *  TransactionRunner, fork() por sua própria conta a cada operação. */
export class MikroOrmWalletLedgerQueryRepository implements WalletLedgerQueryRepository {
  constructor(private readonly orm: MikroORM) {}

  /** Busca sempre limit+1 linhas — a decisão de cortar a linha extra e
   *  montar nextCursor é do use case, não deste repository.
   *
   *  Paginação keyset por (created_at, id) — a mesma chave composta do
   *  índice ledger_wallet_id_created_at_id_idx (wallet_id, created_at, id),
   *  reaproveitado sem migration nova. `(created_at, id) > (cursor.createdAt,
   *  cursor.id)` é expresso via $or porque é logicamente equivalente:
   *  created_at > X OR (created_at = X AND id > Y) — nunca inclui o próprio
   *  item do cursor de novo. ORDER BY created_at ASC, id ASC: mais antigo
   *  primeiro (histórico financeiro cronológico); id é desempate
   *  determinístico sem significado temporal, nunca a chave primária de
   *  ordenação. */
  async fetchPage(walletId: string, cursor: LedgerCursor | undefined, limit: number): Promise<WalletLedgerEntry[]> {
    const em = this.orm.em.fork();
    const qb = em
      .createQueryBuilder(WalletLedgerEntryRow)
      .select('*')
      .where({ walletId })
      .orderBy({ createdAt: 'ASC', id: 'ASC' })
      .limit(limit + 1);

    if (cursor) {
      qb.andWhere({
        $or: [{ createdAt: { $gt: cursor.createdAt } }, { createdAt: { $eq: cursor.createdAt }, id: { $gt: cursor.id } }],
      });
    }

    const rows = await qb.execute('all');
    return rows.map((row: WalletLedgerEntryRow) => walletLedgerEntryRowToDomain(row));
  }

  /** Sem paginação — usado por ReconcileWalletUseCase, que precisa do ledger
   *  inteiro para o cálculo ser correto (ARCHITECTURE.md seção 29). Mesma
   *  ordenação de fetchPage, mesmo índice reaproveitado. */
  async fetchAll(walletId: string): Promise<WalletLedgerEntry[]> {
    const em = this.orm.em.fork();
    const rows = await em
      .createQueryBuilder(WalletLedgerEntryRow)
      .select('*')
      .where({ walletId })
      .orderBy({ createdAt: 'ASC', id: 'ASC' })
      .execute('all');

    return rows.map((row: WalletLedgerEntryRow) => walletLedgerEntryRowToDomain(row));
  }
}
