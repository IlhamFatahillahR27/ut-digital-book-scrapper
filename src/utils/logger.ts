type LogLevel = 'info' | 'warn' | 'error' | 'debug';

class Logger {
  private prefix = '[RBV-Exporter]';

  private format(level: LogLevel, message: string): string {
    const time = new Date().toLocaleTimeString();
    return `${this.prefix} [${time}] [${level.toUpperCase()}] ${message}`;
  }

  info(message: string, ...args: unknown[]): void {
    console.log(this.format('info', message), ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    console.warn(this.format('warn', message), ...args);
  }

  error(message: string, ...args: unknown[]): void {
    console.error(this.format('error', message), ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    console.debug(this.format('debug', message), ...args);
  }
}

export const logger = new Logger();
