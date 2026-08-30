import { EntitySchema } from '@mikro-orm/postgresql';
import { WalletRow } from './wallet.row';

/** Mapeamento declarativo — nenhum decorator toca a classe de domínio Wallet.
 *  Constraints (CHECK, UNIQUE) vivem nas migrations (ARCHITECTURE.md seção 7),
 *  não aqui: o EntitySchema descreve apenas o shape de colunas para o MikroORM
 *  gerar SQL, mas as invariantes críticas são revisadas/escritas manualmente
 *  na migration correspondente. */
export const WalletSchema = new EntitySchema<WalletRow>({
  class: WalletRow,
  tableName: 'wallet',
  properties: {
    id: { type: 'string', primary: true, columnType: 'uuid' },
    playerId: { type: 'string', fieldName: 'player_id', columnType: 'uuid' },
    currency: { type: 'string', columnType: 'varchar(3)' },
    balanceAmount: { type: 'string', fieldName: 'balance_amount', columnType: 'numeric(19,2)' },
    version: { type: 'number' },
    createdAt: { type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' },
    updatedAt: { type: 'Date', fieldName: 'updated_at', columnType: 'timestamptz' },
  },
});
