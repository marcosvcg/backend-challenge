import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { WalletLedgerQueryRepository } from './ports/wallet-ledger-query.repository';
import { LedgerCursor, encodeLedgerCursor } from './wallet-ledger-cursor';

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

export interface GetWalletLedgerResult {
  entries: WalletLedgerEntry[];
  nextCursor: string | null;
}

/** Não decide sobre a existência da wallet — isso é responsabilidade do
 *  controller, reaproveitando GetWalletUseCase (mesma checagem de
 *  GET /wallets/:walletId, nunca duplicada aqui). Esta classe só sabe
 *  paginar o ledger de um walletId que o caller já confirmou existir. */
export class GetWalletLedgerUseCase {
  constructor(private readonly repository: WalletLedgerQueryRepository) {}

  async execute(walletId: string, cursor: LedgerCursor | undefined, limit: number): Promise<GetWalletLedgerResult> {
    const rows = await this.repository.fetchPage(walletId, cursor, limit);

    // Busca sempre limit+1 para detectar se há próxima página, SEM usar essa
    // linha extra para montar o cursor — o cursor precisa representar o
    // ÚLTIMO ITEM REALMENTE ENTREGUE. Usar a linha limit+1 como base do
    // cursor faria a próxima página pular exatamente essa linha (ela nunca
    // seria entregue, mas seria usada como ponto de corte "> cursor").
    const hasNextPage = rows.length > limit;
    const entries = rows.slice(0, limit);

    const nextCursor =
      hasNextPage && entries.length > 0
        ? encodeLedgerCursor({ createdAt: entries[entries.length - 1]!.createdAt, id: entries[entries.length - 1]!.id })
        : null;

    return { entries, nextCursor };
  }
}
