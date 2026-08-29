import { Money } from './money';
import { WalletLedgerEntry } from './wallet-ledger-entry';
import { LedgerDirection } from './ledger-direction';
import { InsufficientBalanceError, NonPositiveAmountError } from './wallet.errors';
import { CurrencyMismatchError } from './money.errors';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** Nasce com saldo zero. O crédito de abertura (se houver) é responsabilidade
   *  do caller (CreateWalletUseCase), via credit(), não deste factory. */
  static open(props: { id: string; playerId: string; currency: string; at: Date }): Wallet {
    return new Wallet(
      props.id,
      props.playerId,
      props.currency,
      Money.zero(props.currency),
      1,
      props.at,
      props.at,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições (seção 6.0). */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(amount: Money, transactionId: string, ledgerEntryId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(amount);
    this.assertPositiveAmount(amount, 'debit');

    if (this._balance.isLessThan(amount)) {
      throw new InsufficientBalanceError(this.id);
    }

    return this.applyMovement(amount, LedgerDirection.Debit, transactionId, ledgerEntryId, at);
  }

  credit(amount: Money, transactionId: string, ledgerEntryId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(amount);
    this.assertPositiveAmount(amount, 'credit');

    return this.applyMovement(amount, LedgerDirection.Credit, transactionId, ledgerEntryId, at);
  }

  private applyMovement(
    amount: Money,
    direction: LedgerDirection,
    transactionId: string,
    ledgerEntryId: string,
    at: Date,
  ): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter = direction === LedgerDirection.Debit ? balanceBefore.subtract(amount) : balanceBefore.add(amount);

    const entry = WalletLedgerEntry.create({
      id: ledgerEntryId,
      walletId: this.id,
      transactionId,
      direction,
      money: amount,
      balanceBefore,
      balanceAfter,
      createdAt: at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;

    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }

  private assertPositiveAmount(amount: Money, operation: 'debit' | 'credit'): void {
    if (!amount.isPositive()) {
      throw new NonPositiveAmountError(operation);
    }
  }
}
