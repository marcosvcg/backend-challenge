import { DEFAULT_LEDGER_LIMIT, MAX_LEDGER_LIMIT } from './get-wallet-ledger.use-case';

export class InvalidLedgerLimitError extends Error {
  constructor(raw: string) {
    super(`Invalid ledger limit "${raw}": must be an integer between 1 and ${MAX_LEDGER_LIMIT}.`);
    this.name = 'InvalidLedgerLimitError';
  }
}

/** Contrato determinístico, sem clamp silencioso: ausente → DEFAULT_LEDGER_LIMIT;
 *  inteiro 1..MAX_LEDGER_LIMIT → válido; qualquer outro valor (zero, negativo,
 *  não inteiro, não numérico, acima do máximo) → InvalidLedgerLimitError. Um
 *  cliente pedindo uma quantidade fora do intervalo permitido descobre
 *  imediatamente, em vez de receber silenciosamente uma resposta diferente
 *  da solicitada. */
export function parseLedgerLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_LEDGER_LIMIT;
  }

  if (!/^\d+$/.test(raw)) {
    throw new InvalidLedgerLimitError(raw);
  }

  const value = Number(raw);
  if (value < 1 || value > MAX_LEDGER_LIMIT) {
    throw new InvalidLedgerLimitError(raw);
  }

  return value;
}
