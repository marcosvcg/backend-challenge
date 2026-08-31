/** Cursor opaco e estável de paginação do ledger — baseado em (createdAt, id),
 *  a mesma chave composta do índice ledger_wallet_id_created_at_id_idx
 *  (wallet_id, created_at, id). Opaco: o cliente nunca deve interpretar o
 *  conteúdo, só devolvê-lo como veio. Sem assinatura/HMAC — não precisa ser
 *  à prova de adulteração deliberada: a query sempre filtra por walletId do
 *  path param (nunca confia em nada do cursor para escopo de wallet), e é
 *  uma leitura pura, então um cursor adulterado no máximo produz uma página
 *  estranha/vazia para aquele walletId, nunca vaza outra wallet nem quebra
 *  invariante financeira. */
export interface LedgerCursor {
  createdAt: Date;
  id: string;
}

export class InvalidLedgerCursorError extends Error {
  constructor(reason: string) {
    super(`Invalid ledger cursor: ${reason}.`);
    this.name = 'InvalidLedgerCursorError';
  }
}

interface LedgerCursorPayload {
  createdAt: string;
  id: string;
}

export function encodeLedgerCursor(cursor: LedgerCursor): string {
  const payload: LedgerCursorPayload = { createdAt: cursor.createdAt.toISOString(), id: cursor.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** base64url — nunca base64 padrão: o cursor viaja como valor de query
 *  string, e base64 padrão pode conter '+'/'/' que exigiriam URL-encoding
 *  extra; base64url ('-'/'_' no lugar) é seguro em query string sem escaping. */
export function decodeLedgerCursor(raw: string): LedgerCursor {
  let payload: unknown;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    payload = JSON.parse(json);
  } catch {
    throw new InvalidLedgerCursorError('not a valid base64url-encoded JSON payload');
  }

  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidLedgerCursorError('decoded payload is not an object');
  }

  const { createdAt, id } = payload as Partial<LedgerCursorPayload>;

  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
    throw new InvalidLedgerCursorError('createdAt is missing or not a valid ISO date string');
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new InvalidLedgerCursorError('id is missing or empty');
  }

  return { createdAt: new Date(createdAt), id };
}
