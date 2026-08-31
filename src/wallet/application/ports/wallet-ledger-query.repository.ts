import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { LedgerCursor } from '../wallet-ledger-cursor';

/** Porta dedicada à leitura HTTP do ledger — separada de
 *  WalletRepository.saveWithLedger() (escrita, dentro do UnitOfWork
 *  financeiro). fetchPage busca sempre limit+1 linhas internamente — o
 *  caller (GetWalletLedgerUseCase) decide, a partir disso, se há próxima
 *  página e o que entregar, nunca o repository. fetchAll lê o ledger inteiro
 *  de uma vez, sem paginação — usado por ReconcileWalletUseCase (seção 29),
 *  que precisa da wallet inteira para o cálculo ser correto; nunca usado por
 *  um endpoint de listagem voltado a um cliente externo, só por auditoria
 *  interna. Mesma ordenação (created_at ASC, id ASC) de fetchPage. */
export interface WalletLedgerQueryRepository {
  fetchPage(walletId: string, cursor: LedgerCursor | undefined, limit: number): Promise<WalletLedgerEntry[]>;
  fetchAll(walletId: string): Promise<WalletLedgerEntry[]>;
}
