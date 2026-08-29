export class InvalidMoneyAmountError extends Error {
  constructor(amount: string) {
    super(`Invalid money amount: "${amount}". Expected a decimal string with exactly 2 fractional digits.`);
    this.name = 'InvalidMoneyAmountError';
  }
}

export class InvalidMoneyCurrencyError extends Error {
  constructor(currency: string) {
    super(`Invalid currency: "${currency}". Expected a 3-letter uppercase ISO-4217 code.`);
    this.name = 'InvalidMoneyCurrencyError';
  }
}

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Currency mismatch: cannot operate on "${a}" and "${b}".`);
    this.name = 'CurrencyMismatchError';
  }
}
