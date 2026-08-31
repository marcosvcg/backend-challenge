import { IsString, Matches } from 'class-validator';

/** Validação estrutural apenas (shape/tipo) — a validação real de valor
 *  monetário (2 casas decimais exatas, moeda ISO, etc.) é responsabilidade
 *  exclusiva de Money.from(), a única porta de entrada para essa invariante
 *  (ARCHITECTURE.md seção 2/14). A regex aqui só evita instanciar um use case
 *  com um payload obviamente malformado; nunca duplica a regra de negócio.
 *  SEM sinal negativo, deliberadamente: Money aceita negativo internamente
 *  (resultBalance de uma reversão pode ser negativo em cenários que a
 *  constraint do banco proíbe explicitamente — mas o valor em si, enquanto
 *  Money, não é inválido), mas nenhum endpoint HTTP tem um caso de uso
 *  legítimo para receber um valor monetário negativo do lado de fora. */
export class MoneyDto {
  @IsString()
  @Matches(/^\d+\.\d{2}$/)
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}
