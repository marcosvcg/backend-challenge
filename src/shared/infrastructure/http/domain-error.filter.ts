import { ArgumentsHost, Catch, ConflictException, ExceptionFilter } from '@nestjs/common';
import { WalletAlreadyExistsError } from '../../../wallet/domain/wallet-already-exists.error';

/** Traduz erros de domínio/aplicação conhecidos para status HTTP — a mesma
 *  disciplina de KNOWN_REJECTION_ERRORS no domínio (ARCHITECTURE.md seção 22):
 *  captura apenas os tipos explicitamente listados em @Catch(); qualquer outro
 *  erro (incluindo HttpException nativas do Nest — validação, 404) nunca passa
 *  por aqui, segue o pipeline padrão do framework sem reinterpretação. */
@Catch(WalletAlreadyExistsError)
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: WalletAlreadyExistsError, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const mapped = new ConflictException(exception.message);
    response.status(mapped.getStatus()).json(mapped.getResponse());
  }
}
