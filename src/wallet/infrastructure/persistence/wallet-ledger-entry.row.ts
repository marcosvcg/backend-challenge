/** Shape exato da tabela `wallet_ledger_entry` (ARCHITECTURE.md seção 8). */
export class WalletLedgerEntryRow {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}
