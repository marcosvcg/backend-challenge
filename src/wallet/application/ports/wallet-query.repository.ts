import { Wallet } from '../../domain/wallet';

/** Porta dedicada à leitura HTTP (GET), separada de WalletRepository — que é
 *  usado dentro dos UnitOfWork financeiros e recebe sempre o EntityManager já
 *  forkado pela transação corrente (nunca deve fazer fork por conta própria).
 *  Esta porta é para consultas fora de qualquer transação de escrita: a
 *  implementação concreta é livre para fazer fork() por operação. */
export interface WalletQueryRepository {
  findById(id: string): Promise<Wallet | undefined>;
}
