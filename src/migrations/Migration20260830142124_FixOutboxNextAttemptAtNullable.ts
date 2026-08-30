import { Migration } from '@mikro-orm/migrations';

/** Correção: a migration CreateOutboxMessage declarou next_attempt_at como
 *  NOT NULL, contradizendo diretamente a constraint outbox_next_attempt_coherence
 *  (que exige next_attempt_at IS NULL quando published_at IS NOT NULL). Isso
 *  tornava impossível marcar qualquer mensagem como publicada — todo
 *  UPDATE ... SET next_attempt_at = NULL era rejeitado pela própria coluna,
 *  antes mesmo da CHECK ser avaliada. Nunca detectado até agora porque nenhum
 *  teste exercitava published_at sendo de fato preenchido (ARCHITECTURE.md,
 *  incremento do Outbox Publisher). */
export class Migration20260830142124_FixOutboxNextAttemptAtNullable extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "outbox_message" alter column "next_attempt_at" drop not null;`);
  }

  override async down(): Promise<void> {
    // O schema anterior não aceitava next_attempt_at IS NULL — antes de
    // restaurar NOT NULL, qualquer linha já publicada (next_attempt_at NULL
    // por design correto) precisaria de um valor não-nulo para não violar a
    // reversão. Não há valor "correto" a atribuir sem inventar semântica nova,
    // então o down() é deliberadamente conservador: falha se houver alguma
    // linha nesse estado, em vez de silenciosamente inventar um timestamp.
    const [{ count }] = await this.execute(
      `select count(*)::int as count from "outbox_message" where "next_attempt_at" is null`,
    );
    if (count > 0) {
      throw new Error(
        `Cannot revert: ${count} outbox_message row(s) have next_attempt_at IS NULL (published messages). ` +
          `Restoring NOT NULL would require inventing a value for them — resolve manually before reverting.`,
      );
    }
    this.addSql(`alter table "outbox_message" alter column "next_attempt_at" set not null;`);
  }

}
