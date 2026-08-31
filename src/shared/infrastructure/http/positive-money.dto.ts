import { IsString, Matches } from 'class-validator';
import { MoneyDto } from './money.dto';

/** Especialização de MoneyDto para endpoints onde o valor monetário é o
 *  montante de uma operação (não um saldo) — sempre estritamente positivo.
 *  "0.00" é válido para MoneyDto.amount (ex.: initialBalance de uma wallet
 *  recém-criada, seção 9 do README), mas nunca para o `money` de uma
 *  WagerTransaction submetida via API: uma BET/WIN/REFUND/ROLLBACK de valor
 *  zero não tem sentido de negócio. A propriedade `amount` é redeclarada com
 *  seus próprios decorators, que substituem — não acumulam com — os de
 *  MoneyDto para esta subclasse. `currency` é herdado sem alteração. */
export class PositiveMoneyDto extends MoneyDto {
  @IsString()
  @Matches(/^(?!0\.00$)\d+\.\d{2}$/)
  declare amount: string;
}
