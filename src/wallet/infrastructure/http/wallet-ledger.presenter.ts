import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { GetWalletLedgerResult } from '../../application/get-wallet-ledger.use-case';

export interface WalletLedgerEntryResponse {
  id: string;
  transactionId: string;
  direction: string;
  money: { amount: string; currency: string };
  balanceBefore: { amount: string; currency: string };
  balanceAfter: { amount: string; currency: string };
  createdAt: string;
}

export interface WalletLedgerResponse {
  entries: WalletLedgerEntryResponse[];
  nextCursor: string | null;
}

function toEntryResponse(entry: WalletLedgerEntry): WalletLedgerEntryResponse {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

export function toWalletLedgerResponse(result: GetWalletLedgerResult): WalletLedgerResponse {
  return {
    entries: result.entries.map(toEntryResponse),
    nextCursor: result.nextCursor,
  };
}
