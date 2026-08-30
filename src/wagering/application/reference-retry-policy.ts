/** Política de backoff exponencial com cap para PENDING_REFERENCE (seção 7.1
 *  do README). Formaliza o que antes era um valor provisório único
 *  (INITIAL_REFERENCE_RETRY_DELAY_MS) em ProcessWagerTransactionUseCase —
 *  aquele valor continua sendo só o PRIMEIRO agendamento (transição
 *  PENDING → PENDING_REFERENCE); esta política governa os agendamentos
 *  SEGUINTES, calculados pelo worker.
 *
 *  delay(attempt) = min(baseDelayMs * 2^(attempt - 1), maxDelayMs)
 *
 *  maxAttempts é política de aplicação, nunca um limite em CHECK do banco —
 *  reference_retry_attempts na migration permanece apenas >= 0
 *  (ARCHITECTURE.md seção 9). */
export interface ReferenceRetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

/** MVP: baseDelay 30s, maxDelay 15min, maxAttempts 5. Configurável — não
 *  hardcoded dentro do worker, injetado no construtor. */
export const DEFAULT_REFERENCE_RETRY_POLICY: ReferenceRetryPolicy = {
  baseDelayMs: 30_000,
  maxDelayMs: 15 * 60_000,
  maxAttempts: 5,
};

export function nextReferenceRetryDelayMs(policy: ReferenceRetryPolicy, attemptNumber: number): number {
  const exponential = policy.baseDelayMs * 2 ** (attemptNumber - 1);
  return Math.min(exponential, policy.maxDelayMs);
}
