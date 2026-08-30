/** Traduzido pelo repositório concreto a partir da violação da UNIQUE
 *  wallet_player_currency_unique — nunca detectado via SELECT prévio
 *  (ARCHITECTURE.md seção 7). Erro de aplicação/infra, não de regra de domínio
 *  em memória (por isso não vive em wallet.errors.ts, que é só invariantes
 *  verificáveis sem I/O). */
export class WalletAlreadyExistsError extends Error {
  constructor(playerId: string, currency: string) {
    super(`A wallet already exists for playerId="${playerId}" and currency="${currency}".`);
    this.name = 'WalletAlreadyExistsError';
  }
}
