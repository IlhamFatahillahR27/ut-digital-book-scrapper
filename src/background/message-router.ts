import type {
  ExtensionMessage,
  ExportProgress,
  PrepareForPrintResponse
} from '../types/messages';
import { logger } from '../utils/logger';
import { DebuggerManager } from './debugger-manager';
import { CdpPrinter } from './cdp-printer';
import { sanitizeFilename } from '../utils/sanitize';

export class MessageRouter {
  private debuggerManager: DebuggerManager;
  private cdpPrinter: CdpPrinter;
  private currentProgress: ExportProgress = {
    status: 'IDLE',
    currentChapter: 0,
    chapterTitle: 'Siap',
    message: 'Ekstensi siap digunakan.'
  };

  constructor(debuggerManager: DebuggerManager, cdpPrinter: CdpPrinter) {
    this.debuggerManager = debuggerManager;
    this.cdpPrinter = cdpPrinter;
  }

  handleMessage(
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ): boolean {
    logger.debug(`Received message [${message.type}] from tab ${sender.tab?.id ?? 'unknown'}`);

    switch (message.type) {
      case 'PING':
        sendResponse({ type: 'PONG', timestamp: Date.now() });
        return false;

      case 'GET_STATUS':
        sendResponse({
          type: 'STATUS_RESPONSE',
          payload: this.currentProgress
        });
        return false;

      case 'START_TEST_PRINT':
        this.handleStartTestPrint(message, sender, sendResponse);
        return true; // Keep channel open for async

      case 'START_EXPORT':
        this.handleStartExport(message, sender, sendResponse);
        return true;

      case 'STOP_EXPORT':
        this.handleStopExport(message, sender, sendResponse);
        return true;

      default:
        return false;
    }
  }

  /**
   * Phase 2: Single active chapter clean test print
   */
  private async handleStartTestPrint(
    message: Extract<ExtensionMessage, { type: 'START_TEST_PRINT' }>,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ): Promise<void> {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: 'Tidak ditemukan tab aktif pada pengirim.' });
      return;
    }

    try {
      this.updateProgress({
        status: 'INITIALIZING',
        currentChapter: 1,
        chapterTitle: message.payload?.chapterTitle || 'Bab Aktif',
        message: 'Menghubungkan debugger ke tab Kotobee...'
      });

      // 1. Attach debugger
      await this.debuggerManager.attach(tabId);
      await this.cdpPrinter.prepare();

      // 2. Prepare page (auto-scroll & style overrides)
      this.updateProgress({
        status: 'CAPTURING_PAGE',
        currentChapter: 1,
        chapterTitle: message.payload?.chapterTitle || 'Bab Aktif',
        message: 'Auto-scroll & memuat gambar blob / rumus...'
      });

      let prepResult: PrepareForPrintResponse = { success: false, chapterTitle: 'Bab_Aktif' };
      try {
        prepResult = await chrome.tabs.sendMessage(tabId, {
          type: 'PREPARE_FOR_PRINT'
        }) as PrepareForPrintResponse;
      } catch (prepErr) {
        logger.warn('Failed to communicate PREPARE_FOR_PRINT with tab:', prepErr);
      }

      if (!prepResult.success) {
        throw new Error(prepResult.error || 'Gagal menyiapkan isolated print stage pada halaman Kotobee.');
      }

      const chapterTitle = prepResult.chapterTitle || message.payload?.chapterTitle || 'Bab_Aktif';
      const bookTitle = message.payload?.bookTitle || 'BMP_UT';

      // 3. Print to PDF via CDP
      this.updateProgress({
        status: 'CAPTURING_PAGE',
        currentChapter: 1,
        chapterTitle,
        message: 'Mengeksekusi CDP Page.printToPDF (A4)...'
      });

      const { base64, buffer } = await this.cdpPrinter.printCurrentPage({
        printBackground: true,
        generateTaggedPDF: true,
        ...(prepResult.isFixedLayout ? { pageRanges: '1' } : {})
      });

      // 4. Restore original page styles
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'RESTORE_AFTER_PRINT' });
      } catch (restoreErr) {
        logger.warn('Failed to send RESTORE_AFTER_PRINT:', restoreErr);
      }

      // 5. Detach debugger immediately
      await this.debuggerManager.detach();

      // 6. Download test PDF file
      this.updateProgress({
        status: 'COMPLETED',
        currentChapter: 1,
        chapterTitle,
        message: 'Menyimpan file PDF hasil uji coba...'
      });

      const filename = sanitizeFilename(`[Uji_Fase2]_${bookTitle}_${chapterTitle}`);
      await this.savePdfFile(tabId, base64, filename);

      this.updateProgress({
        status: 'COMPLETED',
        currentChapter: 1,
        chapterTitle,
        message: `Berhasil! File ${filename} telah diunduh. Silakan buka & periksa.`
      });

      sendResponse({
        success: true,
        message: `File berhasil diunduh: ${filename}`,
        filename,
        fileSizeMb: (buffer.byteLength / 1024 / 1024).toFixed(2)
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Error during handleStartTestPrint:', err);

      // Guarantee cleanup
      try {
        if (tabId) {
          await chrome.tabs.sendMessage(tabId, { type: 'RESTORE_AFTER_PRINT' }).catch(() => {});
        }
      } catch {
        // Ignore secondary error
      }
      await this.debuggerManager.detach().catch(() => {});

      this.updateProgress({
        status: 'ERROR',
        currentChapter: 0,
        chapterTitle: 'Error',
        message: `Gagal uji cetak: ${errorMsg}`
      });

      sendResponse({ success: false, error: errorMsg });
    }
  }

  /**
   * Initiates full book export session
   */
  private async handleStartExport(
    message: Extract<ExtensionMessage, { type: 'START_EXPORT' }>,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ): Promise<void> {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: 'No active tab found in sender context.' });
      return;
    }

    try {
      this.updateProgress({
        status: 'INITIALIZING',
        currentChapter: 1,
        chapterTitle: message.payload?.bookTitle || 'Menginisialisasi...',
        message: 'Menghubungkan debugger ke tab Kotobee...'
      });

      await this.debuggerManager.attach(tabId);

      sendResponse({
        success: true,
        message: 'Export session initialized. Debugger attached.'
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.updateProgress({
        status: 'ERROR',
        currentChapter: 0,
        chapterTitle: 'Error',
        message: `Gagal inisialisasi: ${errorMsg}`
      });
      await this.debuggerManager.detach();
      sendResponse({ success: false, error: errorMsg });
    }
  }

  private async handleStopExport(
    _message: Extract<ExtensionMessage, { type: 'STOP_EXPORT' }>,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ): Promise<void> {
    logger.info('Stopping export session by user request.');
    await this.debuggerManager.detach();
    this.updateProgress({
      status: 'STOPPED',
      currentChapter: 0,
      chapterTitle: 'Dihentikan',
      message: 'Proses ekspor dihentikan oleh pengguna.'
    });
    sendResponse({ success: true, message: 'Export stopped.' });
  }

  /**
   * Saves the generated PDF using chrome.downloads or falls back to in-page blob download
   */
  private async savePdfFile(tabId: number, base64: string, filename: string): Promise<void> {
    try {
      // First try standard chrome.downloads API
      const dataUri = `data:application/pdf;base64,${base64}`;
      await chrome.downloads.download({
        url: dataUri,
        filename,
        saveAs: false
      });
      logger.info(`Download initiated successfully via chrome.downloads for ${filename}`);
    } catch (downloadErr) {
      logger.warn('Direct chrome.downloads failed, falling back to in-page Blob download:', downloadErr);
      await chrome.tabs.sendMessage(tabId, {
        type: 'DOWNLOAD_PDF_BLOB',
        payload: {
          base64Data: base64,
          filename
        }
      });
    }
  }

  private updateProgress(progress: ExportProgress): void {
    this.currentProgress = progress;
  }
}
