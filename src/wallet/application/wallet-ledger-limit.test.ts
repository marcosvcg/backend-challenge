import { describe, expect, it } from 'bun:test';
import { parseLedgerLimit, InvalidLedgerLimitError } from './wallet-ledger-limit';
import { DEFAULT_LEDGER_LIMIT, MAX_LEDGER_LIMIT } from './get-wallet-ledger.use-case';

describe('parseLedgerLimit', () => {
  it('returns DEFAULT_LEDGER_LIMIT when raw is undefined', () => {
    expect(parseLedgerLimit(undefined)).toBe(DEFAULT_LEDGER_LIMIT);
  });

  it('accepts integers within [1, MAX_LEDGER_LIMIT]', () => {
    expect(parseLedgerLimit('1')).toBe(1);
    expect(parseLedgerLimit('50')).toBe(50);
    expect(parseLedgerLimit(String(MAX_LEDGER_LIMIT))).toBe(MAX_LEDGER_LIMIT);
  });

  it('rejects "0"', () => {
    expect(() => parseLedgerLimit('0')).toThrow(InvalidLedgerLimitError);
  });

  it('rejects a negative value', () => {
    expect(() => parseLedgerLimit('-5')).toThrow(InvalidLedgerLimitError);
  });

  it('rejects a non-integer value', () => {
    expect(() => parseLedgerLimit('1.5')).toThrow(InvalidLedgerLimitError);
  });

  it('rejects a non-numeric value', () => {
    expect(() => parseLedgerLimit('abc')).toThrow(InvalidLedgerLimitError);
  });

  it('rejects a value above MAX_LEDGER_LIMIT — no silent clamping', () => {
    expect(() => parseLedgerLimit(String(MAX_LEDGER_LIMIT + 1))).toThrow(InvalidLedgerLimitError);
  });

  it('rejects an empty string', () => {
    expect(() => parseLedgerLimit('')).toThrow(InvalidLedgerLimitError);
  });
});
