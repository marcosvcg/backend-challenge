import { ArgumentsHost, BadRequestException, Catch, ConflictException, ExceptionFilter, HttpException } from '@nestjs/common';
import { WalletAlreadyExistsError } from '../../../wallet/domain/wallet-already-exists.error';
import { InvalidLedgerCursorError } from '../../../wallet/application/wallet-ledger-cursor';
import { InvalidLedgerLimitError } from '../../../wallet/application/wallet-ledger-limit';

type KnownDomainError = WalletAlreadyExistsError | InvalidLedgerCursorError | InvalidLedgerLimitError;

/** Traduz erros de domínio/aplicação conhecidos para status HTTP — a mesma
 *  disciplina de KNOWN_REJECTION_ERRORS no domínio (ARCHITECTURE.md seção 22):
 *  captura apenas os tipos explicitamente listados em @Catch(); qualquer outro
 *  erro (incluindo HttpException nativas do Nest — validação, 404) nunca passa
 *  por aqui, segue o pipeline padrão do framework sem reinterpretação. */
@Catch(WalletAlreadyExistsError, InvalidLedgerCursorError, InvalidLedgerLimitError)
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: KnownDomainError, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const mapped = this.mapToHttpException(exception);
    response.status(mapped.getStatus()).json(mapped.getResponse());
  }

  private mapToHttpException(exception: KnownDomainError): HttpException {
    if (exception instanceof WalletAlreadyExistsError) {
      return new ConflictException(exception.message);
    }
    return new BadRequestException(exception.message);
  }
}
