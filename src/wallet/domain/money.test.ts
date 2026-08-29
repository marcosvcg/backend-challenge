import { describe, expect, it } from 'bun:test';
import { Money } from './money';
import { CurrencyMismatchError, InvalidMoneyAmountError, InvalidMoneyCurrencyError } from './money.errors';

describe('Money.from — valid construction', () => {
  it('accepts a well-formed positive amount', () => {
    const money = Money.from({ amount: '25.00', currency: 'BRL' });
    expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('accepts zero', () => {
    const money = Money.from({ amount: '0.00', currency: 'BRL' });
    expect(money.isZero()).toBe(true);
  });

  it('accepts a negative amount when the caller allows it (e.g. internal computation)', () => {
    const money = Money.from({ amount: '-10.00', currency: 'BRL' });
    expect(money.isNegative()).toBe(true);
  });
});

describe('Money.from — lexical rejection (before any Decimal is constructed)', () => {
  it('rejects an empty string', () => {
    expect(() => Money.from({ amount: '', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
  });

  it('rejects NaN as text', () => {
    expect(() => Money.from({ amount: 'NaN', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
  });

  it('rejects Infinity as text', () => {
    expect(() => Money.from({ amount: 'Infinity', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
  });

  it('rejects scientific notation', () => {
    expect(() => Money.from({ amount: '2.5e1', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
  });

  it('rejects more than 2 decimal places', () => {
    expect(() => Money.from({ amount: '25.001', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
  });

  it('rejects fewer than 2 decimal places', () => {
    expect(() => Money.from({ amount: '25.0', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
  });

  it('rejects missing decimal point entirely', () => {
    expect(() => Money.from({ amount: '25', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
  });

  it('never rounds silently — a 3-decimal string is an error, not 25.00', () => {
    expect(() => Money.from({ amount: '25.005', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
  });

  it('rejects surrounding whitespace', () => {
    expect(() => Money.from({ amount: ' 25.00 ', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
  });
});

describe('Money.from — currency validation', () => {
  it('rejects lowercase currency', () => {
    expect(() => Money.from({ amount: '25.00', currency: 'brl' })).toThrow(InvalidMoneyCurrencyError);
  });

  it('rejects a currency with the wrong length', () => {
    expect(() => Money.from({ amount: '25.00', currency: 'BR' })).toThrow(InvalidMoneyCurrencyError);
  });
});

describe('Money — arithmetic', () => {
  it('add() returns a new instance and does not mutate operands', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '5.00', currency: 'BRL' });
    const result = a.add(b);

    expect(result.toJSON().amount).toBe('15.00');
    expect(a.toJSON().amount).toBe('10.00'); // a is untouched
    expect(b.toJSON().amount).toBe('5.00'); // b is untouched
  });

  it('subtract() returns a new instance', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '3.00', currency: 'BRL' });
    expect(a.subtract(b).toJSON().amount).toBe('7.00');
  });

  it('subtract() can produce a negative result (caller decides if that is valid)', () => {
    const a = Money.from({ amount: '3.00', currency: 'BRL' });
    const b = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(a.subtract(b).toJSON().amount).toBe('-7.00');
  });

  it('negate() flips the sign without mutating the original', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const negated = a.negate();
    expect(negated.toJSON().amount).toBe('-10.00');
    expect(a.toJSON().amount).toBe('10.00');
  });
});

describe('Money — currency conflict', () => {
  it('add() throws when currencies differ', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
  });

  it('subtract() throws when currencies differ', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
  });

  it('isLessThan() throws when currencies differ', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  it('equals() returns false for different currencies rather than throwing', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(brl.equals(usd)).toBe(false);
  });
});

describe('Money — comparison and predicates', () => {
  it('isLessThan() compares magnitude correctly', () => {
    const a = Money.from({ amount: '5.00', currency: 'BRL' });
    const b = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(a.isLessThan(b)).toBe(true);
    expect(b.isLessThan(a)).toBe(false);
  });

  it('equals() compares value and currency', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(a.equals(b)).toBe(true);
  });

  it('isZero() is true only for exactly zero', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.from({ amount: '0.01', currency: 'BRL' }).isZero()).toBe(false);
  });

  it('isPositive() excludes zero (strictly positive)', () => {
    expect(Money.from({ amount: '0.01', currency: 'BRL' }).isPositive()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
  });

  it('isNegative() excludes zero (strictly negative)', () => {
    expect(Money.from({ amount: '-0.01', currency: 'BRL' }).isNegative()).toBe(true);
    expect(Money.zero('BRL').isNegative()).toBe(false);
  });
});

describe('Money — serialization', () => {
  it('toJSON() always returns a 2-decimal string', () => {
    expect(Money.zero('BRL').toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  it('toString() includes amount and currency', () => {
    expect(Money.from({ amount: '25.00', currency: 'BRL' }).toString()).toBe('25.00 BRL');
  });
});
