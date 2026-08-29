import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyAmountError, InvalidMoneyCurrencyError } from './money.errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

// Exatamente 2 casas decimais, sinal opcional, sem notação científica, sem espaços.
// Esta regex é a ÚNICA porta de entrada — decimal.js nunca vê uma string que não
// tenha passado por aqui primeiro, e nunca é usado para "corrigir" ou arredondar.
const AMOUNT_PATTERN = /^-?\d+\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    Money.assertValidAmountLexically(props.amount);
    Money.assertValidCurrency(props.currency);

    return new Money(new Decimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    Money.assertValidCurrency(currency);
    return new Money(new Decimal(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertValidAmountLexically(amount: string): void {
    if (typeof amount !== 'string' || amount.length === 0 || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyAmountError(amount);
    }
  }

  private static assertValidCurrency(currency: string): void {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyCurrencyError(currency);
    }
  }
}
