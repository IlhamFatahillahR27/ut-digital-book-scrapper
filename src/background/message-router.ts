import type {
  ExtensionMessage,
  ExportProgress,
  PrepareForPrintResponse,
  ExportRangeRequest
} from '../types/messages';
import { logger } from '../utils/logger';
import { DebuggerManager } from './debugger-manager';
import { CdpPrinter } from './cdp-printer';
import { ExportOrchestrator } from './export-orchestrator';
import { sanitizeFilename } from '../utils/sanitize';

export class MessageRouter {
  private debuggerManager: DebuggerManager;
  private cdpPrinter: CdpPrinter;
  private orchestrator: ExportOrchestrator;
  private currentProgress: ExportProgress = {
    status: 'IDLE',
    currentChapter: 0,
    chapterTitle: 'Siap',
    message: 'Ekstensi siap digunakan.'
  };

  constructor(
    debuggerManager: DebuggerManager,
    cdpPrinter: CdpPrinter,
    orchestrator?: ExportOrchestrator
  ) {
    this.debuggerManager = debuggerManager;
    this.cdpPrinter = cdpPrinter;
    this.orchestrator = orchestrator ?? new ExportOrchestrator(debuggerManager, cdpPrinter);
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
   * Phase 3: Initiates multi-chapter module / page-range auto-navigation export session
   */
  private async handleStartExport(
    message: Extract<ExtensionMessage, { type: 'START_EXPORT' }>,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ): Promise<void> {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: 'Tidak ditemukan tab aktif pada pengirim.' });
      return;
    }

    if (this.orchestrator.isRunning()) {
      sendResponse({
        success: false,
        error: 'Sesi ekspor sedang berjalan. Klik Berhenti terlebih dahulu jika ingin membatalkan.'
      });
      return;
    }

    const incomingRange = message.payload?.range;
    const range: ExportRangeRequest = incomingRange ?? {
      startChapter: 0,
      endChapter: 0,
      label: message.payload?.bookTitle || 'Bab Aktif',
      bookTitle: message.payload?.bookTitle || 'BMP_UT',
      savePerPageDebug: false
    };

    if (range.startChapter < 0 || range.endChapter < range.startChapter) {
      sendResponse({
        success: false,
        error: `Rentang chapter tidak valid (${range.startChapter} s.d. ${range.endChapter}).`
      });
      return;
    }

    // Reset progress to INITIALIZING synchronously before acknowledging start
    // so widget polling never reads stale COMPLETED/STOPPED/ERROR from a previous session.
    this.updateProgress({
      status: 'INITIALIZING',
      currentChapter: 0,
      currentChapterIndex: range.startChapter,
      totalChaptersEstimated: range.endChapter - range.startChapter + 1,
      chapterTitle: range.label,
      message: `Memulai navigasi otomatis untuk ${range.label} (ch/${range.startChapter}–${range.endChapter})...`,
      percent: 0,
      capturedCount: 0,
      totalBytes: 0
    });

    // Acknowledge start immediately so long-running batches never hit sendMessage IPC timeouts;
    // live updates are delivered via GET_STATUS polling + EXPORT_COMPLETE/EXPORT_ERROR push notifications.
    sendResponse({
      success: true,
      message: `Memulai navigasi otomatis untuk ${range.label} (ch/${range.startChapter}–${range.endChapter})...`
    });

    // Launch batch export asynchronously
    this.orchestrator
      .runBatchExport(tabId, range, message.payload?.config, {
        onProgress: (progress) => this.updateProgress(progress),
        savePdfFile: (tId, base64, filename) => this.savePdfFile(tId, base64, filename)
      })
      .then(async (summary) => {
        logger.info('Batch export finished with summary:', {
          status: summary.status,
          captured: summary.capturedCount,
          totalRequested: summary.totalRequested,
          totalBytes: summary.totalBytes,
          lastChapterIndex: summary.lastChapterIndex
        });

        try {
          if (summary.status === 'ERROR') {
            await chrome.tabs.sendMessage(tabId, {
              type: 'EXPORT_ERROR',
              payload: {
                message: summary.errorMessage || 'Ekspor rentang halaman gagal.',
                details: `Berhasil ${summary.capturedCount}/${summary.totalRequested} halaman.`
              }
            });
          } else {
            await chrome.tabs.sendMessage(tabId, {
              type: 'EXPORT_COMPLETE',
              payload: {
                filename: range.label,
                totalChapters: summary.capturedCount,
                summary
              }
            });
          }
        } catch {
          // Tab might have been closed
        }
      })
      .catch((err) => {
        logger.error('Unhandled error in orchestrator.runBatchExport:', err);
      });
  }

  private async handleStopExport(
    message: Extract<ExtensionMessage, { type: 'STOP_EXPORT' }>,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ): Promise<void> {
    logger.info('Stopping export session by user request.');
    await this.orchestrator.stop(message.reason || 'User manual stop', (progress) =>
      this.updateProgress(progress)
    );
    if (!this.orchestrator.isRunning()) {
      await this.debuggerManager.detach().catch(() => {});
      this.updateProgress({
        status: 'STOPPED',
        currentChapter: 0,
        chapterTitle: 'Dihentikan',
        message: 'Proses ekspor dihentikan oleh pengguna.'
      });
    }
    sendResponse({ success: true, message: 'Permintaan berhenti diterima.' });
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
