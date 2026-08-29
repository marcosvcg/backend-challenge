import { IdGenerator } from '../../../shared/application/id-generator';

/** IDs sequenciais e previsíveis — cada chamada em um teste sabe exatamente
 *  qual ID vai receber, sem precisar mockar UUID. */
export class FakeIdGenerator implements IdGenerator {
  private counter = 0;

  newId(): string {
    this.counter += 1;
    return `id-${this.counter}`;
  }
}
