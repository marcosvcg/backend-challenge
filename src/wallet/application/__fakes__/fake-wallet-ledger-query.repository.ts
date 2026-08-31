import { WalletLedgerQueryRepository } from '../ports/wallet-ledger-query.repository';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { LedgerCursor } from '../wallet-ledger-cursor';

export class FakeWalletLedgerQueryRepository implements WalletLedgerQueryRepository {
  private entries: WalletLedgerEntry[] = [];

  seed(entries: WalletLedgerEntry[]): void {
    this.entries = entries;
  }

  async fetchPage(_walletId: string, _cursor: LedgerCursor | undefined, limit: number): Promise<WalletLedgerEntry[]> {
    return this.entries.slice(0, limit + 1);
  }

  async fetchAll(_walletId: string): Promise<WalletLedgerEntry[]> {
    return this.entries;
  }
}
