/** Duração de aquisição do lock pessimista da wallet — Histogram, nunca um
 *  contador de "conflito" baseado em threshold arbitrário: findByIdForUpdate()
 *  usa PESSIMISTIC_WRITE, que ESPERA se outra transação já detém o lock, em
 *  vez de falhar; contenção real aparece como cauda longa na distribuição de
 *  duração, não como um evento discreto (ARCHITECTURE.md seção 31). */
export const WALLET_LOCK_ACQUISITION_DURATION_SECONDS = 'wallet_lock_acquisition_duration_seconds';
