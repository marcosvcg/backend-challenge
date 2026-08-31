import { Logger } from '../../../shared/application/logger';

interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
}

export class FakeLogger implements Logger {
  private entries: LogEntry[] = [];

  info(message: string, meta?: Record<string, unknown>): void {
    this.entries.push({ level: 'info', message, ...(meta !== undefined ? { meta } : {}) });
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.entries.push({ level: 'warn', message, ...(meta !== undefined ? { meta } : {}) });
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.entries.push({ level: 'error', message, ...(meta !== undefined ? { meta } : {}) });
  }

  getEntries(): readonly LogEntry[] {
    return this.entries;
  }
}
