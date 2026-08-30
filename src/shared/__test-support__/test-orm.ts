import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../../../mikro-orm.config';

/** Inicializa uma instância real de MikroORM apontando para o Postgres do
 *  docker-compose, assumindo que as migrations já foram aplicadas
 *  (`bun node_modules/@mikro-orm/cli/cli.js migration:up --config mikro-orm.config.ts`).
 *  Usado exclusivamente por testes de integração — nunca por código de produção. */
export async function createTestOrm(): Promise<MikroORM> {
  return MikroORM.init(mikroOrmConfig);
}

/** Reset de fixtures entre testes via TRUNCATE ... CASCADE. Diferente de um
 *  DELETE administrativo (que a trigger de imutabilidade do ledger bloqueia
 *  corretamente): TRUNCATE é o mecanismo padrão de reset de banco de teste
 *  descartável, e ignora triggers BEFORE DELETE por padrão no Postgres — isso
 *  é esperado e correto aqui, nunca deve ser usado em código de aplicação. */
export async function truncateAllTables(orm: MikroORM): Promise<void> {
  const connection = orm.em.getConnection();
  await connection.execute(`
    truncate table
      "wallet_ledger_entry",
      "wager_transaction",
      "wallet",
      "inbox_message",
      "outbox_message"
    cascade;
  `);
}
