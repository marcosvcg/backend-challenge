import { WagerTransaction } from '../../domain/wager-transaction';

/** Porta dedicada à leitura HTTP (GET), separada de WagerTransactionRepository
 *  — que é usado dentro dos UnitOfWork financeiros e recebe sempre o
 *  EntityManager já forkado pela transação corrente (nunca deve fazer fork
 *  por conta própria). Mesma razão de existir de WalletQueryRepository
 *  (ARCHITECTURE.md seção 25): implementação concreta é livre para fazer
 *  fork() por operação, fora de qualquer transação de escrita. Duas
 *  operações de leitura numa única porta — as duas rotas de consulta leem o
 *  mesmo agregado por chaves diferentes, não dois propósitos distintos. */
export interface WagerTransactionQueryRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
}
