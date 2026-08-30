import { Wallet } from '../domain/wallet';

export type CreateWalletResultKind = 'created' | 'conflict';

export class CreateWalletResult {
  private constructor(
    public readonly kind: CreateWalletResultKind,
    public readonly wallet?: Wallet,
  ) {}

  static created(wallet: Wallet): CreateWalletResult {
    return new CreateWalletResult('created', wallet);
  }

  static conflict(): CreateWalletResult {
    return new CreateWalletResult('conflict');
  }
}
