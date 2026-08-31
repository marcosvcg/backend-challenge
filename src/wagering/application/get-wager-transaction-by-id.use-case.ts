import { WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionQueryRepository } from './ports/wager-transaction-query.repository';

export class GetWagerTransactionByIdUseCase {
  constructor(private readonly repository: WagerTransactionQueryRepository) {}

  async execute(transactionId: string): Promise<WagerTransaction | undefined> {
    return this.repository.findById(transactionId);
  }
}
