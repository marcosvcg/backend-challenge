import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { LedgerDirection } from '../../domain/ledger-direction';
import { Money } from '../../domain/money';
import { WalletLedgerEntryRow } from './wallet-ledger-entry.row';

export function walletLedgerEntryRowToDomain(row: WalletLedgerEntryRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction: row.direction as LedgerDirection,
    money: Money.from({ amount: row.amount, currency: row.currency }),
    balanceBefore: Money.from({ amount: row.balanceBefore, currency: row.currency }),
    balanceAfter: Money.from({ amount: row.balanceAfter, currency: row.currency }),
    createdAt: row.createdAt,
  });
}

export function walletLedgerEntryDomainToRow(entry: WalletLedgerEntry): WalletLedgerEntryRow {
  const row = new WalletLedgerEntryRow();
  row.id = entry.id;
  row.walletId = entry.walletId;
  row.transactionId = entry.transactionId;
  row.direction = entry.direction;
  row.amount = entry.money.toJSON().amount;
  row.currency = entry.money.toJSON().currency;
  row.balanceBefore = entry.balanceBefore.toJSON().amount;
  row.balanceAfter = entry.balanceAfter.toJSON().amount;
  row.createdAt = entry.createdAt;
  return row;
}
