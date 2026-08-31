import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { LedgerCursor } from '../wallet-ledger-cursor';

/** Porta dedicada à leitura HTTP paginada do ledger — separada de
 *  WalletRepository.saveWithLedger() (escrita, dentro do UnitOfWork
 *  financeiro). fetchPage busca sempre limit+1 linhas internamente — o
 *  caller (GetWalletLedgerUseCase) decide, a partir disso, se há próxima
 *  página e o que entregar, nunca o repository. */
export interface WalletLedgerQueryRepository {
  fetchPage(walletId: string, cursor: LedgerCursor | undefined, limit: number): Promise<WalletLedgerEntry[]>;
}
