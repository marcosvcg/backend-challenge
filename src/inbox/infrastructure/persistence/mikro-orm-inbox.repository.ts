import { EntityManager } from '@mikro-orm/postgresql';
import { InboxClaimResult, InboxRepository } from '../../application/ports/inbox.repository';
import { InboxMessageRow } from './inbox-message.row';

/** Construído sempre com o EntityManager "forked" da transação corrente. */
export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  /** INSERT ... ON CONFLICT (consumer_name, message_id) DO NOTHING — o próprio
   *  INSERT é o mecanismo de dedupe. Nunca um SELECT prévio (ARCHITECTURE.md
   *  seção 10): duas entregas concorrentes da mesma mensagem batem no mesmo
   *  INSERT, e só uma linha é de fato inserida — a garantia vem do conflito de
   *  UNIQUE constraint no banco, não de uma checagem em duas etapas na aplicação. */
  async tryClaim(consumerName: string, messageId: string, payloadHash: string): Promise<InboxClaimResult> {
    const now = new Date();

    // .returning(...) é obrigatório: sem ele, um INSERT bem-sucedido também
    // devolveria [] (Postgres só retorna linhas de um INSERT quando pedido
    // explicitamente via RETURNING), tornando impossível distinguir "inseriu"
    // de "ignorado por conflito" a partir do resultado de execute('all').
    const insertedRows = await this.em
      .createQueryBuilder(InboxMessageRow)
      .insert({ consumerName, messageId, payloadHash, receivedAt: now })
      .onConflict(['consumerName', 'messageId'])
      .ignore()
      .returning(['consumerName', 'messageId'])
      .execute('all');

    if (insertedRows.length > 0) {
      return { isNew: true, payloadHashMatches: true };
    }

    const existing = await this.em.findOneOrFail(InboxMessageRow, { consumerName, messageId });
    return { isNew: false, payloadHashMatches: existing.payloadHash === payloadHash };
  }

  async markProcessed(consumerName: string, messageId: string, at: Date): Promise<void> {
    const row = await this.em.findOneOrFail(InboxMessageRow, { consumerName, messageId });
    row.processedAt = at;
    await this.em.flush();
  }
}
