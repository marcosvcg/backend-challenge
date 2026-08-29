import { Wallet } from '../../domain/wallet';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

export interface WalletRepository {
  /** Único ponto de leitura no write path — sempre adquire lock pessimista
   *  (SELECT ... FOR UPDATE / MikroORM PESSIMISTIC_WRITE, ver ARCHITECTURE.md seção 12). */
  findByIdForUpdate(id: string): Promise<Wallet>;

  /** Leitura simples, sem lock — reservada às consultas (GET), nunca usada antes de mutar. */
  findById(id: string): Promise<Wallet | undefined>;

  /** Operação atômica única: UPDATE wallet + INSERT ledger na mesma query/transação
   *  interna do repositório. Nunca duas chamadas separadas a partir do use case. */
  saveWithLedger(wallet: Wallet, entry: WalletLedgerEntry): Promise<void>;
}
