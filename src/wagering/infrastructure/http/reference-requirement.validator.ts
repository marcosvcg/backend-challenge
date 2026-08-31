import { ValidationArguments, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { WagerTransactionKind } from '../../domain/wager-transaction-kind';

const KINDS_REQUIRING_REFERENCE = new Set<string>([WagerTransactionKind.Refund, WagerTransactionKind.Rollback]);
const KINDS_ALLOWING_OPTIONAL_REFERENCE = new Set<string>([WagerTransactionKind.Win]);

/** Validação estrutural de borda HTTP: kind exige/proíbe/permite
 *  referenceExternalTransactionId no shape do payload — nunca a autoridade
 *  de negócio. WagerTransaction.assertReferenceRequirement() continua sendo
 *  a checagem real (identidade do domínio, seção 6.0 do README); esta classe
 *  só barra em 400, antes do use case, o caso óbvio de payload
 *  estruturalmente incompatível com o kind declarado.
 *
 *  Deliberadamente um único @Validate, SEM @IsOptional()/@IsString() na
 *  mesma propriedade: @IsOptional() pula todos os demais decorators da
 *  propriedade quando o valor está ausente — exatamente o caso que este
 *  validador precisa capturar para REFUND/ROLLBACK (referência ausente é o
 *  payload inválido). Este constraint verifica tipo, tamanho e presença
 *  condicional num único lugar coeso, em vez de decorators com semânticas
 *  conflitantes na mesma propriedade. */
@ValidatorConstraint({ name: 'referenceRequirementMatchesKind', async: false })
export class ReferenceRequirementMatchesKindConstraint implements ValidatorConstraintInterface {
  validate(referenceExternalTransactionId: unknown, args: ValidationArguments): boolean {
    const kind = (args.object as { kind?: string }).kind;
    const isAbsent = referenceExternalTransactionId === undefined || referenceExternalTransactionId === null;
    const isWellFormedString = typeof referenceExternalTransactionId === 'string' && referenceExternalTransactionId.length > 0;

    if (KINDS_REQUIRING_REFERENCE.has(kind ?? '')) {
      return isWellFormedString;
    }
    if (KINDS_ALLOWING_OPTIONAL_REFERENCE.has(kind ?? '')) {
      return isAbsent || isWellFormedString; // WIN: ausente OU bem formada — nunca um tipo errado
    }
    return isAbsent; // BET/LOSS: referência não pode estar presente
  }

  defaultMessage(args: ValidationArguments): string {
    const kind = (args.object as { kind?: string }).kind;
    if (KINDS_REQUIRING_REFERENCE.has(kind ?? '')) {
      return `kind "${kind}" requires a non-empty referenceExternalTransactionId.`;
    }
    return `kind "${kind}" must not carry a referenceExternalTransactionId.`;
  }
}
