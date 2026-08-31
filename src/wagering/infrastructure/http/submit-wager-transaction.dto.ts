import { Type } from 'class-transformer';
import { IsIn, IsString, IsUUID, MinLength, Validate, ValidateNested } from 'class-validator';
import { PositiveMoneyDto } from '../../../shared/infrastructure/http/positive-money.dto';
import { ReferenceRequirementMatchesKindConstraint } from './reference-requirement.validator';

/** OPENING deliberadamente ausente desta lista — é interna, nasce apenas de
 *  CreateWalletUseCase, e "não pode ser submetida pela API nem pela fila"
 *  (README seção 6.3). Este enum é o único ponto de bloqueio hoje: o
 *  consumer SQS ainda não tem o mesmo guard — ver ARCHITECTURE.md seção 26
 *  para o registro dessa pendência, não reaberta neste incremento. */
const EXTERNALLY_SUBMITTABLE_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;

export class SubmitWagerTransactionDto {
  @IsString()
  @MinLength(1)
  providerId!: string;

  @IsString()
  @MinLength(1)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @MinLength(1)
  roundId!: string;

  @IsString()
  @MinLength(1)
  gameId!: string;

  @IsIn(EXTERNALLY_SUBMITTABLE_KINDS)
  kind!: (typeof EXTERNALLY_SUBMITTABLE_KINDS)[number];

  @ValidateNested()
  @Type(() => PositiveMoneyDto)
  money!: PositiveMoneyDto;

  // SEM @IsOptional() — ver o comentário em ReferenceRequirementMatchesKindConstraint.
  @Validate(ReferenceRequirementMatchesKindConstraint)
  referenceExternalTransactionId?: string;
}
