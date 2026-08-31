import { Logger } from '../application/logger';

/** JSON estruturado via console — mesmo shape já usado por
 *  WagerTransactionConsumerLogger (extraído aqui como implementação
 *  compartilhada, ARCHITECTURE.md seção 29). Loki/Grafana Alloy coletam esta
 *  saída em produção; nenhuma integração direta com eles no código — a
 *  fundação aqui é só emitir JSON estruturado em stdout/stderr. */
export class ConsoleLogger implements Logger {
  info(message: string, meta?: Record<string, unknown>): void {
    console.log(JSON.stringify({ level: 'info', message, ...meta }));
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(JSON.stringify({ level: 'warn', message, ...meta }));
  }

  error(message: string, meta?: Record<string, unknown>): void {
    console.error(JSON.stringify({ level: 'error', message, ...meta }));
  }
}
