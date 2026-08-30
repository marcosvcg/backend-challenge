import { EntitySchema } from '@mikro-orm/postgresql';
import { WagerTransactionRow } from './wager-transaction.row';

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRow>({
  class: WagerTransactionRow,
  tableName: 'wager_transaction',
  properties: {
    id: { type: 'string', primary: true, columnType: 'uuid' },
    providerId: { type: 'string', fieldName: 'provider_id', columnType: 'varchar(64)' },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id', columnType: 'varchar(128)' },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key', columnType: 'varchar(191)' },
    payloadHash: { type: 'string', fieldName: 'payload_hash', columnType: 'varchar(64)' },
    walletId: { type: 'string', fieldName: 'wallet_id', columnType: 'uuid' },
    playerId: { type: 'string', fieldName: 'player_id', columnType: 'uuid' },
    roundId: { type: 'string', fieldName: 'round_id', columnType: 'varchar(128)' },
    gameId: { type: 'string', fieldName: 'game_id', columnType: 'varchar(128)' },
    kind: { type: 'string', columnType: 'varchar(16)' },
    amount: { type: 'string', columnType: 'numeric(19,2)' },
    currency: { type: 'string', columnType: 'varchar(3)' },
    referenceExternalTransactionId: {
      type: 'string',
      fieldName: 'reference_external_transaction_id',
      columnType: 'varchar(128)',
      nullable: true,
    },
    referenceTransactionId: {
      type: 'string',
      fieldName: 'reference_transaction_id',
      columnType: 'uuid',
      nullable: true,
    },
    status: { type: 'string', columnType: 'varchar(20)' },
    failureCode: { type: 'string', fieldName: 'failure_code', columnType: 'varchar(64)', nullable: true },
    processedAt: { type: 'Date', fieldName: 'processed_at', columnType: 'timestamptz', nullable: true },
    resultBalanceAmount: {
      type: 'string',
      fieldName: 'result_balance_amount',
      columnType: 'numeric(19,2)',
      nullable: true,
    },
    resultBalanceCurrency: {
      type: 'string',
      fieldName: 'result_balance_currency',
      columnType: 'varchar(3)',
      nullable: true,
    },
    referenceRetryAttempts: { type: 'number', fieldName: 'reference_retry_attempts' },
    nextReferenceRetryAt: {
      type: 'Date',
      fieldName: 'next_reference_retry_at',
      columnType: 'timestamptz',
      nullable: true,
    },
    createdAt: { type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' },
  },
});
