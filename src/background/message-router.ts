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
import { PdfAssembler } from './pdf-assembler';
import { PdfDownloader } from './pdf-downloader';
import { sanitizeFilename } from '../utils/sanitize';

export class MessageRouter {
  private debuggerManager: DebuggerManager;
  private cdpPrinter: CdpPrinter;
  private orchestrator: ExportOrchestrator;
  private pdfDownloader: PdfDownloader;
  private isFinalizing = false;
  private currentProgress: ExportProgress = {
    status: 'IDLE',
    currentChapter: 0,
    chapterTitle: 'Siap',
    message: 'Ekstensi siap digunakan.'
  };

  constructor(
    debuggerManager: DebuggerManager,
    cdpPrinter: CdpPrinter,
    orchestrator?: ExportOrchestrator,
    pdfDownloader?: PdfDownloader
  ) {
    this.debuggerManager = debuggerManager;
    this.cdpPrinter = cdpPrinter;
    this.orchestrator = orchestrator ?? new ExportOrchestrator(debuggerManager, cdpPrinter);
    this.pdfDownloader = pdfDownloader ?? new PdfDownloader();
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
   * Phase 3 + Phase 4: Multi-chapter auto-navigation capture, incremental pdf-lib stitching,
   * hierarchical bookmarks, and automatic download (including Stop & Save Partial).
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

    if (this.orchestrator.isRunning() || this.isFinalizing) {
      sendResponse({
        success: false,
        error: 'Sesi ekspor atau penggabungan PDF sedang berjalan. Tunggu selesai atau klik Berhenti terlebih dahulu.'
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

    const bookTitle = range.bookTitle || message.payload?.bookTitle || 'BMP_UT';
    const assembler = new PdfAssembler();
    try {
      await assembler.init({
        bookTitle,
        label: range.label,
        author: range.bookAuthor
      });
    } catch (initErr) {
      const msg = initErr instanceof Error ? initErr.message : String(initErr);
      sendResponse({ success: false, error: `Gagal inisialisasi PDF Assembler: ${msg}` });
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
      message: `Memulai ekspor untuk ${range.label} (ch/${range.startChapter}–${range.endChapter})...`,
      percent: 0,
      capturedCount: 0,
      totalBytes: 0
    });

    // Acknowledge start immediately so long-running batches never hit sendMessage IPC timeouts;
    // live updates are delivered via GET_STATUS polling + EXPORT_COMPLETE/EXPORT_ERROR push notifications.
    sendResponse({
      success: true,
      message: `Memulai ekspor untuk ${range.label} (ch/${range.startChapter}–${range.endChapter})...`
    });

    // Launch batch export + incremental stitching asynchronously
    this.orchestrator
      .runBatchExport(tabId, range, message.payload?.config, {
        onProgress: (progress) => this.updateProgress(progress),
        savePdfFile: (tId, base64, filename) => this.savePdfFile(tId, base64, filename),
        deferTerminalStatus: true,
        onChapterCaptured: async (buffer, meta) => {
          await assembler.appendChapter(buffer, meta);
        }
      })
      .then(async (summary) => {
        logger.info('Batch capture finished; entering Phase 4 finalization:', {
          status: summary.status,
          captured: summary.capturedCount,
          totalRequested: summary.totalRequested,
          totalBytes: summary.totalBytes,
          lastChapterIndex: summary.lastChapterIndex
        });

        this.isFinalizing = true;
        try {
          // Stitch & download merged PDF if >= 1 chapter was captured (including Stop & Error Partial Save)
          if (summary.capturedCount > 0 && assembler.getTotalPages() > 0) {
            const isPartial =
              summary.status !== 'COMPLETED' || summary.capturedCount < summary.totalRequested;
            summary.isPartial = isPartial;

            this.updateProgress({
              status: 'STITCHING',
              currentChapter: summary.capturedCount,
              currentChapterIndex: summary.lastChapterIndex ?? summary.startChapter,
              totalChaptersEstimated: summary.totalRequested,
              chapterTitle: range.label,
              message: isPartial
                ? `Menyimpan PDF parsial (${summary.capturedCount} hal) & menyusun bookmarks...`
                : `Menggabungkan ${summary.capturedCount} hal & menyusun bookmarks PDF...`,
              percent: isPartial
                ? Math.round((summary.capturedCount / summary.totalRequested) * 100)
                : 99,
              capturedCount: summary.capturedCount,
              totalBytes: summary.totalBytes
            });

            const assembled = await assembler.finalize(range.tocItems, { isPartial });

            const rawName = isPartial
              ? `${bookTitle}_${range.label}_Partial_ch${summary.startChapter}-${summary.lastChapterIndex ?? summary.startChapter}`
              : `${bookTitle}_${range.label}`;
            const outputFilename = sanitizeFilename(rawName);
            const sizeMb = (assembled.bytes.byteLength / 1024 / 1024).toFixed(2);

            this.updateProgress({
              status: 'STITCHING',
              currentChapter: summary.capturedCount,
              currentChapterIndex: summary.lastChapterIndex ?? summary.startChapter,
              totalChaptersEstimated: summary.totalRequested,
              chapterTitle: range.label,
              message: `Mengunduh ${outputFilename} (${sizeMb} MB, ${assembled.bookmarkCount} bookmarks)...`,
              percent: 99,
              capturedCount: summary.capturedCount,
              totalBytes: assembled.bytes.byteLength
            });

            const dlResult = await this.pdfDownloader.downloadBytes(
              tabId,
              assembled.bytes,
              outputFilename
            );

            summary.outputFilename = outputFilename;
            summary.outputBytes = assembled.bytes.byteLength;
            summary.totalPdfPages = assembled.totalPages;
            summary.bookmarkCount = assembled.bookmarkCount;
            summary.downloadId = dlResult.downloadId;

            if (summary.status === 'COMPLETED') {
              this.updateProgress({
                status: 'COMPLETED',
                currentChapter: summary.capturedCount,
                currentChapterIndex: summary.lastChapterIndex ?? summary.endChapter,
                totalChaptersEstimated: summary.totalRequested,
                chapterTitle: range.label,
                message: `Selesai! ${outputFilename} (${assembled.totalPages} hal, ${sizeMb} MB, ${assembled.bookmarkCount} bookmarks) diunduh.`,
                percent: 100,
                capturedCount: summary.capturedCount,
                totalBytes: assembled.bytes.byteLength
              });

              await chrome.tabs
                .sendMessage(tabId, {
                  type: 'EXPORT_COMPLETE',
                  payload: {
                    filename: outputFilename,
                    totalChapters: summary.capturedCount,
                    totalPdfPages: assembled.totalPages,
                    bookmarkCount: assembled.bookmarkCount,
                    outputBytes: assembled.bytes.byteLength,
                    isPartial: false,
                    downloadId: dlResult.downloadId,
                    summary
                  }
                })
                .catch(() => {});
            } else if (summary.status === 'STOPPED') {
              this.updateProgress({
                status: 'STOPPED',
                currentChapter: summary.capturedCount,
                currentChapterIndex: summary.lastChapterIndex ?? summary.startChapter,
                totalChaptersEstimated: summary.totalRequested,
                chapterTitle: 'Dihentikan (Parsial Tersimpan)',
                message: `Dihentikan. PDF parsial disimpan: ${outputFilename} (${assembled.totalPages} hal, ${sizeMb} MB, ${assembled.bookmarkCount} bookmarks).`,
                percent: Math.round((summary.capturedCount / summary.totalRequested) * 100),
                capturedCount: summary.capturedCount,
                totalBytes: assembled.bytes.byteLength
              });

              await chrome.tabs
                .sendMessage(tabId, {
                  type: 'EXPORT_COMPLETE',
                  payload: {
                    filename: outputFilename,
                    totalChapters: summary.capturedCount,
                    totalPdfPages: assembled.totalPages,
                    bookmarkCount: assembled.bookmarkCount,
                    outputBytes: assembled.bytes.byteLength,
                    isPartial: true,
                    downloadId: dlResult.downloadId,
                    summary
                  }
                })
                .catch(() => {});
            } else {
              // ERROR mid-batch, but partial PDF was rescued and saved!
              this.updateProgress({
                status: 'ERROR',
                currentChapter: summary.capturedCount,
                currentChapterIndex: summary.lastChapterIndex ?? summary.startChapter,
                totalChaptersEstimated: summary.totalRequested,
                chapterTitle: 'Error (Parsial Tersimpan)',
                message: `Terhenti karena error, namun PDF parsial tersimpan: ${outputFilename} (${assembled.totalPages} hal, ${sizeMb} MB).`,
                percent: Math.round((summary.capturedCount / summary.totalRequested) * 100),
                capturedCount: summary.capturedCount,
                totalBytes: assembled.bytes.byteLength
              });

              await chrome.tabs
                .sendMessage(tabId, {
                  type: 'EXPORT_ERROR',
                  payload: {
                    message: summary.errorMessage || 'Ekspor terhenti di tengah proses.',
                    details: `PDF parsial tersimpan: ${outputFilename} (${assembled.totalPages} hal, ${sizeMb} MB).`,
                    partialFilename: outputFilename,
                    summary
                  }
                })
                .catch(() => {});
            }
          } else {
            // 0 chapters captured — emit terminal error/stopped without creating empty PDF
            if (summary.status === 'ERROR') {
              await chrome.tabs
                .sendMessage(tabId, {
                  type: 'EXPORT_ERROR',
                  payload: {
                    message: summary.errorMessage || 'Ekspor rentang halaman gagal.',
                    details: '0 halaman berhasil ditangkap.',
                    summary
                  }
                })
                .catch(() => {});
            } else {
              await chrome.tabs
                .sendMessage(tabId, {
                  type: 'EXPORT_COMPLETE',
                  payload: {
                    filename: range.label,
                    totalChapters: 0,
                    isPartial: true,
                    summary
                  }
                })
                .catch(() => {});
            }
          }
        } catch (stitchErr) {
          const errMsg = stitchErr instanceof Error ? stitchErr.message : String(stitchErr);
          logger.error('Error during Phase 4 PDF stitching/download:', stitchErr);
          this.updateProgress({
            status: 'ERROR',
            currentChapter: summary.capturedCount,
            currentChapterIndex: summary.lastChapterIndex ?? summary.startChapter,
            totalChaptersEstimated: summary.totalRequested,
            chapterTitle: 'Error Stitching',
            message: `Gagal menggabungkan/mengunduh PDF: ${errMsg}`
          });

          await chrome.tabs
            .sendMessage(tabId, {
              type: 'EXPORT_ERROR',
              payload: {
                message: `Gagal menggabungkan/mengunduh PDF: ${errMsg}`,
                details: `${summary.capturedCount} halaman telah ditangkap sebelum gagal.`
              }
            })
            .catch(() => {});
        } finally {
          assembler.dispose();
          this.isFinalizing = false;
        }
      })
      .catch((err) => {
        assembler.dispose();
        this.isFinalizing = false;
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
    if (!this.orchestrator.isRunning() && !this.isFinalizing) {
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
