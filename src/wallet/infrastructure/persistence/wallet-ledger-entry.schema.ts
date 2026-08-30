import { EntitySchema } from '@mikro-orm/postgresql';
import { WalletLedgerEntryRow } from './wallet-ledger-entry.row';

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRow>({
  class: WalletLedgerEntryRow,
  tableName: 'wallet_ledger_entry',
  properties: {
    id: { type: 'string', primary: true, columnType: 'uuid' },
    walletId: { type: 'string', fieldName: 'wallet_id', columnType: 'uuid' },
    transactionId: { type: 'string', fieldName: 'transaction_id', columnType: 'uuid' },
    direction: { type: 'string', columnType: 'varchar(6)' },
    amount: { type: 'string', columnType: 'numeric(19,2)' },
    currency: { type: 'string', columnType: 'varchar(3)' },
    balanceBefore: { type: 'string', fieldName: 'balance_before', columnType: 'numeric(19,2)' },
    balanceAfter: { type: 'string', fieldName: 'balance_after', columnType: 'numeric(19,2)' },
    createdAt: { type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' },
  },
});
