import { DebuggerManager } from './debugger-manager';
import { logger } from '../utils/logger';
import {
  A4_DIMENSIONS,
  type PrintToPdfOptions,
  type PrintToPdfResponse
} from '../types/cdp';

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
   * Executes Page.printToPDF via CDP and returns both base64 string and Uint8Array buffer
   */
  async printCurrentPage(customOptions?: Partial<PrintToPdfOptions>): Promise<{
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

    logger.info(`Executing CDP Page.printToPDF with options (pageRanges: ${finalOptions.pageRanges || 'all'})...`);
    const startTime = Date.now();

    const response = await this.debuggerManager.sendCommand<PrintToPdfResponse>(
      'Page.printToPDF',
      finalOptions
    );

    if (!response || !response.data) {
      throw new Error('CDP Page.printToPDF returned an empty or invalid response.');
    }

    const elapsed = Date.now() - startTime;
    logger.info(`Page.printToPDF completed in ${elapsed}ms. Base64 length: ${response.data.length}`);

    const buffer = this.base64ToUint8Array(response.data);
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
