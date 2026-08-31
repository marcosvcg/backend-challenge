import { Wallet } from '../domain/wallet';
import { WalletQueryRepository } from './ports/wallet-query.repository';

export class GetWalletUseCase {
  constructor(private readonly repository: WalletQueryRepository) {}

  async execute(walletId: string): Promise<Wallet | undefined> {
    return this.repository.findById(walletId);
  }
}
