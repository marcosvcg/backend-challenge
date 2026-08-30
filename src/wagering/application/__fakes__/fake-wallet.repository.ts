import { Wallet } from '../../../wallet/domain/wallet';
import { WalletLedgerEntry } from '../../../wallet/domain/wallet-ledger-entry';
import { WalletRepository } from '../../../wallet/application/ports/wallet.repository';
import { WalletAlreadyExistsError } from '../../../wallet/domain/wallet-already-exists.error';

/** Repositório em memória para testar o use case sem Postgres. Simula "commit"
 *  via snapshot: mudanças só ficam visíveis fora da transação quando o
 *  FakeTransactionRunner chama commit() explicitamente (ver esse arquivo). */
export class FakeWalletRepository implements WalletRepository {
  private committed = new Map<string, Wallet>();
  private staged = new Map<string, Wallet>();

  seed(wallet: Wallet): void {
    this.committed.set(wallet.id, wallet);
  }

  async findByIdForUpdate(id: string): Promise<Wallet> {
    const wallet = this.staged.get(id) ?? this.committed.get(id);
    if (!wallet) {
      throw new Error(`Wallet "${id}" not found.`);
    }
    // Devolve uma cópia rehydratada, NUNCA a referência viva de committed/staged —
    // Wallet.debit()/credit() mutam a instância recebida; se devolvêssemos a
    // referência original, um rollback não desfaria a mutação (o "banco" já
    // teria sido alterado por efeito colateral antes do commit acontecer).
    // Espelha o que Postgres real faria: um SELECT FOR UPDATE sempre materializa
    // um objeto de domínio novo em memória, nunca a mesma instância que outra
    // transação enxerga.
    return Wallet.rehydrate({
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
  }

  async findById(id: string): Promise<Wallet | undefined> {
    return this.committed.get(id);
  }

  async create(wallet: Wallet): Promise<void> {
    this.assertNoConflict(wallet);
    this.staged.set(wallet.id, wallet);
  }

  async saveWithLedger(wallet: Wallet, _entry: WalletLedgerEntry): Promise<void> {
    this.staged.set(wallet.id, wallet);
  }

  /** Simula a UNIQUE(player_id, currency) real do banco — fidelidade ao
   *  comportamento real, para que testes com fakes também exerçam o caminho
   *  de conflito sem precisar de Postgres. */
  private assertNoConflict(wallet: Wallet): void {
    const clash = [...this.committed.values(), ...this.staged.values()].find(
      (existing) => existing.playerId === wallet.playerId && existing.currency === wallet.currency,
    );
    if (clash) {
      throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
    }
  }

  commit(): void {
    for (const [id, wallet] of this.staged) {
      this.committed.set(id, wallet);
    }
    this.staged.clear();
  }

  rollback(): void {
    this.staged.clear();
  }

  getCommitted(id: string): Wallet | undefined {
    return this.committed.get(id);
  }
}
