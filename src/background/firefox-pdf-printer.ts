import { getBrowserApi } from '../utils/browser-api';
import { logger } from '../utils/logger';
import type { VectorSaveStatus } from '../types/capture';

export class FirefoxSavePdfTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(
      `Timeout (${Math.round(timeoutMs / 1000)} dtk) saat menunggu dialog simpan PDF Firefox selesai.`
    );
    this.name = 'FirefoxSavePdfTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Firefox Native Vector PDF Printer powered by `browser.tabs.saveAsPDF()`.
 * Prints the consolidated isolated `@media print` stage directly through Gecko's native
 * vector PDF engine (crisp selectable text, equations, tables, and compact file size)
 * with a graceful `window.print()` fallback on platforms without `tabs.saveAsPDF`.
 */
export class FirefoxPdfPrinter {
  async saveConsolidatedVectorPdf(
    tabId: number,
    filename: string,
    timeoutMs = 180000
  ): Promise<VectorSaveStatus> {
    const api = getBrowserApi();

    if (typeof api.tabs?.saveAsPDF !== 'function') {
      logger.warn('FirefoxPdfPrinter: browser.tabs.saveAsPDF is unavailable; falling back to window.print().');
      await api.tabs.sendMessage(tabId, { type: 'TRIGGER_WINDOW_PRINT' });
      return 'fallback-print';
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const status = await Promise.race([
        api.tabs.saveAsPDF({
          toFileName: filename,
          showBackgroundColors: true,
          showBackgroundImages: true,
          headerLeft: '',
          headerCenter: '',
          headerRight: '',
          footerLeft: '',
          footerCenter: '',
          footerRight: '',
          marginTop: 0,
          marginBottom: 0,
          marginLeft: 0,
          marginRight: 0,
          shrinkToFit: true
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new FirefoxSavePdfTimeoutError(timeoutMs)),
            Math.max(5000, timeoutMs)
          );
        })
      ]);

      logger.info(`FirefoxPdfPrinter: browser.tabs.saveAsPDF resolved with status="${status}" for ${filename}`);
      if (status === 'saved' || status === 'replaced' || status === 'canceled') {
        return status;
      }
      return 'saved';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('not supported on macos')) {
        logger.warn('FirefoxPdfPrinter: tabs.saveAsPDF unsupported on macOS; falling back to window.print().');
        await api.tabs.sendMessage(tabId, { type: 'TRIGGER_WINDOW_PRINT' }).catch(() => {});
        return 'fallback-print';
      }
      throw err;
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }
}
