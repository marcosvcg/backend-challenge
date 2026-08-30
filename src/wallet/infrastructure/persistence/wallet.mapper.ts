import { Wallet } from '../../domain/wallet';
import { Money } from '../../domain/money';
import { WalletRow } from './wallet.row';

export function walletRowToDomain(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: Money.from({ amount: row.balanceAmount, currency: row.currency }),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function walletDomainToRow(wallet: Wallet): WalletRow {
  const row = new WalletRow();
  row.id = wallet.id;
  row.playerId = wallet.playerId;
  row.currency = wallet.currency;
  row.balanceAmount = wallet.balance.toJSON().amount;
  row.version = wallet.version;
  row.createdAt = wallet.createdAt;
  row.updatedAt = wallet.updatedAt;
  return row;
}
