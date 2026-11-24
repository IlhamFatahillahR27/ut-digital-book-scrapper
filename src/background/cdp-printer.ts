import { DebuggerManager } from './debugger-manager';
import { logger } from '../utils/logger';
import {
  A4_DIMENSIONS,
  type PrintToPdfOptions,
  type PrintToPdfResponse
} from '../types/cdp';

export class CdpPrintTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(
      `Timeout (${Math.round(timeoutMs / 1000)} dtk) saat merender PDF melalui browser. Halaman terlalu berat atau frame tidak merespons.`
    );
    this.name = 'CdpPrintTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class CdpPrinter {
  private debuggerManager: DebuggerManager;

  constructor(debuggerManager: DebuggerManager) {
    this.debuggerManager = debuggerManager;
  }

  /**
   * Initializes required CDP domains before printing
   */
  async prepare(): Promise<void> {
    try {
      await this.debuggerManager.sendCommand('Page.enable');
      logger.debug('CDP Page domain enabled.');
    } catch (err) {
      logger.warn('Failed to enable Page domain, continuing anyway:', err);
    }
  }

  /**
   * Executes Page.printToPDF via CDP with a bounded timeout and PDF header validation,
   * returning both base64 string and Uint8Array buffer.
   */
  async printCurrentPage(
    customOptions?: Partial<PrintToPdfOptions>,
    timeoutMs = 35000
  ): Promise<{
    base64: string;
    buffer: Uint8Array;
  }> {
    if (!this.debuggerManager.isAttached()) {
      throw new Error('Debugger is not attached to target tab.');
    }

    const defaultOptions: PrintToPdfOptions = {
      landscape: false,
      displayHeaderFooter: false,
      printBackground: true,
      scale: 1,
      paperWidth: A4_DIMENSIONS.width,
      paperHeight: A4_DIMENSIONS.height,
      marginTop: 0,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
      preferCSSPageSize: true,
      generateTaggedPDF: true
    };

    const finalOptions = { ...defaultOptions, ...customOptions };

    logger.info(
      `Executing CDP Page.printToPDF (pageRanges: ${finalOptions.pageRanges || 'all'}, timeout: ${timeoutMs}ms)...`
    );
    const startTime = Date.now();

    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const response = await Promise.race([
      this.debuggerManager.sendCommand<PrintToPdfResponse>('Page.printToPDF', finalOptions),
      new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          reject(new CdpPrintTimeoutError(timeoutMs));
        }, Math.max(1000, timeoutMs));
      })
    ]).finally(() => {
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
      }
    });

    if (!response || !response.data) {
      throw new Error('CDP Page.printToPDF mengembalikan respons kosong atau tidak valid.');
    }

    const elapsed = Date.now() - startTime;
    logger.info(`Page.printToPDF completed in ${elapsed}ms. Base64 length: ${response.data.length}`);

    const buffer = this.base64ToUint8Array(response.data);
    if (
      buffer.byteLength <= 100 ||
      buffer[0] !== 0x25 ||
      buffer[1] !== 0x50 ||
      buffer[2] !== 0x44 ||
      buffer[3] !== 0x46 ||
      buffer[4] !== 0x2d
    ) {
      throw new Error(
        `Output PDF dari browser tidak valid (${buffer.byteLength} bytes, header %PDF- tidak ditemukan).`
      );
    }

    logger.info(`Converted PDF to binary buffer: ${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB`);

    return {
      base64: response.data,
      buffer
    };
  }

  /**
   * Converts base64 string directly to Uint8Array to minimize memory footprint
   */
  base64ToUint8Array(base64: string): Uint8Array {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }
}
