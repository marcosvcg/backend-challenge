import { describe, expect, it } from 'bun:test';
import { decodeLedgerCursor, encodeLedgerCursor, InvalidLedgerCursorError } from './wallet-ledger-cursor';

describe('encodeLedgerCursor / decodeLedgerCursor', () => {
  it('round-trips a cursor: decode(encode(x)) === x', () => {
    const createdAt = new Date('2026-01-01T12:34:56.789Z');
    const id = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

    const encoded = encodeLedgerCursor({ createdAt, id });
    const decoded = decodeLedgerCursor(encoded);

    expect(decoded.createdAt.toISOString()).toBe(createdAt.toISOString());
    expect(decoded.id).toBe(id);
  });

  it('produces a base64url string (no "+", "/", or "=" padding)', () => {
    const encoded = encodeLedgerCursor({ createdAt: new Date(), id: 'x'.repeat(50) });

    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('rejects a non-base64url string', () => {
    expect(() => decodeLedgerCursor('not valid base64url!!! ###')).toThrow(InvalidLedgerCursorError);
  });

  it('rejects base64url that decodes to non-JSON', () => {
    const notJson = Buffer.from('this is not json', 'utf8').toString('base64url');
    expect(() => decodeLedgerCursor(notJson)).toThrow(InvalidLedgerCursorError);
  });

  it('rejects a JSON payload missing createdAt', () => {
    const payload = Buffer.from(JSON.stringify({ id: 'x' }), 'utf8').toString('base64url');
    expect(() => decodeLedgerCursor(payload)).toThrow(InvalidLedgerCursorError);
  });

  it('rejects a JSON payload with an invalid date string for createdAt', () => {
    const payload = Buffer.from(JSON.stringify({ createdAt: 'not-a-date', id: 'x' }), 'utf8').toString('base64url');
    expect(() => decodeLedgerCursor(payload)).toThrow(InvalidLedgerCursorError);
  });

  it('rejects a JSON payload missing id', () => {
    const payload = Buffer.from(JSON.stringify({ createdAt: new Date().toISOString() }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeLedgerCursor(payload)).toThrow(InvalidLedgerCursorError);
  });

  it('rejects a JSON payload with an empty string id', () => {
    const payload = Buffer.from(JSON.stringify({ createdAt: new Date().toISOString(), id: '' }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeLedgerCursor(payload)).toThrow(InvalidLedgerCursorError);
  });

  it('rejects a JSON array instead of an object (fails the createdAt/id field check, not the object-shape check)', () => {
    const payload = Buffer.from(JSON.stringify(['a', 'b']), 'utf8').toString('base64url');
    expect(() => decodeLedgerCursor(payload)).toThrow(InvalidLedgerCursorError);
  });
});
