import { Wallet } from '../../domain/wallet';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

export interface WalletRepository {
  /** Único ponto de leitura no write path — sempre adquire lock pessimista
   *  (SELECT ... FOR UPDATE / MikroORM PESSIMISTIC_WRITE, ver ARCHITECTURE.md seção 12). */
  findByIdForUpdate(id: string): Promise<Wallet>;

  /** Leitura simples, sem lock — reservada às consultas (GET), nunca usada antes de mutar. */
  findById(id: string): Promise<Wallet | undefined>;

  /** INSERT único — usado apenas por CreateWalletUseCase. A wallet nasce com
   *  saldo zero/version 1 (Wallet.open()); se houver saldo inicial > 0, o
   *  crédito é aplicado depois via saveWithLedger, nunca aqui (a wager_transaction
   *  OPENING precisa existir antes do ledger entry, que tem FK para ela — ver
   *  ARCHITECTURE.md seção 18/19). UNIQUE(player_id, currency) é a proteção de
   *  concorrência real contra criação duplicada, não um SELECT prévio. */
  create(wallet: Wallet): Promise<void>;

  /** Operação atômica única: UPDATE wallet + INSERT ledger no mesmo flush/transação
   *  interna do repositório. Nunca duas chamadas separadas a partir do use case. */
  saveWithLedger(wallet: Wallet, entry: WalletLedgerEntry): Promise<void>;
}
