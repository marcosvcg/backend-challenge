import { createHash } from 'node:crypto';

/** JSON canônico (chaves ordenadas recursivamente) + SHA-256 — usado tanto
 *  para o payloadHash de idempotência de provedores externos (seção 9 do
 *  README, formalizado no incremento de idempotência HTTP) quanto para
 *  transações internas como OPENING (que não têm payload de provider a
 *  hashear, mas ainda precisam de um payloadHash determinístico e estável). */
export function canonicalPayloadHash(payload: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalize(payload)).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}
