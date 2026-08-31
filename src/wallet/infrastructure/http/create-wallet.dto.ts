import { Type } from 'class-transformer';
import { IsUUID, ValidateNested } from 'class-validator';
import { MoneyDto } from '../../../shared/infrastructure/http/money.dto';

/** initialBalance é sempre obrigatório (mesmo "0.00") — evita um segundo
 *  formato de request onde a currency da wallet viria de um campo solto
 *  quando não há saldo inicial (decisão registrada em ARCHITECTURE.md). */
export class CreateWalletDto {
  @IsUUID()
  playerId!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}
