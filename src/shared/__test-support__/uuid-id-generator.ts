import { randomUUID } from 'node:crypto';
import { IdGenerator } from '../application/id-generator';

/** IdGenerator real para testes de integração — as colunas `uuid` do Postgres
 *  rejeitam os IDs sequenciais do FakeIdGenerator (fakes em memória não
 *  validam formato, mas o banco real valida). */
export class UuidIdGenerator implements IdGenerator {
  newId(): string {
    return randomUUID();
  }
}
