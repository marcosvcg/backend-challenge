import { randomUUID } from 'node:crypto';
import { IdGenerator } from '../application/id-generator';

export class UuidIdGenerator implements IdGenerator {
  newId(): string {
    return randomUUID();
  }
}
