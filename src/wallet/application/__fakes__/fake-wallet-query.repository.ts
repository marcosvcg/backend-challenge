import { WalletQueryRepository } from '../ports/wallet-query.repository';
import { Wallet } from '../../domain/wallet';

export class FakeWalletQueryRepository implements WalletQueryRepository {
  private wallets = new Map<string, Wallet>();

  seed(wallet: Wallet): void {
    this.wallets.set(wallet.id, wallet);
  }

  async findById(id: string): Promise<Wallet | undefined> {
    return this.wallets.get(id);
  }
}
