import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { WalletRepository } from '../../application/ports/wallet.repository';
import { Wallet } from '../../domain/wallet';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { WalletRow } from './wallet.row';
import { WalletLedgerEntryRow } from './wallet-ledger-entry.row';
import { walletDomainToRow, walletRowToDomain } from './wallet.mapper';
import { walletLedgerEntryDomainToRow } from './wallet-ledger-entry.mapper';

/** Construído sempre com o EntityManager "forked" da transação corrente —
 *  nunca o EntityManager global do módulo Nest (ver ARCHITECTURE.md seção 3/4). */
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findByIdForUpdate(id: string): Promise<Wallet> {
    const row = await this.em.findOneOrFail(WalletRow, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return walletRowToDomain(row);
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletRow, { id });
    return row ? walletRowToDomain(row) : undefined;
  }

  async saveWithLedger(wallet: Wallet, entry: WalletLedgerEntry): Promise<void> {
    const walletRow = walletDomainToRow(wallet);
    const entryRow = walletLedgerEntryDomainToRow(entry);

    this.em.assign(this.em.getReference(WalletRow, wallet.id), walletRow);
    this.em.create(WalletLedgerEntryRow, entryRow);

    await this.em.flush();
  }
}
