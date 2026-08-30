import { WagerTransactionRequestedMessage } from './wager-transaction-requested.message';
import { WagerTransactionKind } from '../../domain/wager-transaction-kind';

/** Erro estrutural — a mensagem não chega a formar um comando de wagering
 *  válido (JSON malformado, campo obrigatório ausente, kind desconhecido).
 *  Classificado como permanent (README seção 10), mas nunca dá ACK — segue o
 *  mesmo caminho operacional de redrive/DLQ que qualquer resultado
 *  não-ackable (ARCHITECTURE.md seção 13: um único mecanismo de DLQ). Nunca
 *  vira uma WagerTransaction REJECTED: a mensagem nem formou um comando
 *  válido para o domínio decidir sobre. */
export class MalformedWagerTransactionMessageError extends Error {
  constructor(reason: string) {
    super(`Malformed WagerTransactionRequested message: ${reason}`);
    this.name = 'MalformedWagerTransactionMessageError';
  }
}

const VALID_KINDS = new Set<string>(Object.values(WagerTransactionKind));

/** Parsing estrutural do body da mensagem SQS — não confunde com
 *  payloadHash/idempotência (calculado depois, sobre o resultado deste
 *  parse). OPENING nunca é aceito aqui: é interno, nunca chega via fila
 *  (seção 6.3 do README). */
export function parseWagerTransactionMessage(rawBody: string): WagerTransactionRequestedMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new MalformedWagerTransactionMessageError('body is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new MalformedWagerTransactionMessageError('body is not a JSON object');
  }

  const msg = parsed as Partial<WagerTransactionRequestedMessage>;

  if (typeof msg.messageId !== 'string' || msg.messageId.length === 0) {
    throw new MalformedWagerTransactionMessageError('missing or invalid messageId');
  }
  if (msg.type !== 'WagerTransactionRequested') {
    throw new MalformedWagerTransactionMessageError(`unexpected type "${String(msg.type)}"`);
  }
  if (typeof msg.data !== 'object' || msg.data === null) {
    throw new MalformedWagerTransactionMessageError('missing data');
  }

  const data = msg.data as Partial<WagerTransactionRequestedMessage['data']>;
  const requiredStringFields: (keyof typeof data)[] = [
    'providerId',
    'externalTransactionId',
    'idempotencyKey',
    'playerId',
    'walletId',
    'roundId',
    'gameId',
    'kind',
  ];
  for (const field of requiredStringFields) {
    if (typeof data[field] !== 'string' || (data[field] as string).length === 0) {
      throw new MalformedWagerTransactionMessageError(`missing or invalid data.${field}`);
    }
  }

  if (data.kind === WagerTransactionKind.Opening || !VALID_KINDS.has(data.kind as string)) {
    throw new MalformedWagerTransactionMessageError(`invalid or disallowed kind "${String(data.kind)}"`);
  }

  if (
    typeof data.money !== 'object' ||
    data.money === null ||
    typeof data.money.amount !== 'string' ||
    typeof data.money.currency !== 'string'
  ) {
    throw new MalformedWagerTransactionMessageError('missing or invalid data.money');
  }

  return parsed as WagerTransactionRequestedMessage;
}
