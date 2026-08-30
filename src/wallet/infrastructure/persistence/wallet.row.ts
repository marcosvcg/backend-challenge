/** Shape exato da tabela `wallet` (ARCHITECTURE.md seção 7) — classe "burra" de
 *  dados, mapeada via EntitySchema. Nunca usada diretamente pelo domínio. */
export class WalletRow {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
