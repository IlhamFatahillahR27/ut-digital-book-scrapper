import type {
  ExtensionMessage,
  ExportProgress,
  ExportRangeRequest,
  MountVectorPrintStageResponse,
  PrepareForPrintResponse,
  VectorSaveStatus
} from '../types/messages';
import { getBrowserApi, hasBrowserApi } from '../utils/browser-api';
import { logger } from '../utils/logger';
import { TabSessionManager } from './tab-session-manager';
import { FirefoxPdfPrinter } from './firefox-pdf-printer';
import { ExportOrchestrator } from './export-orchestrator';
import { sanitizeFilename } from '../utils/sanitize';

export class MessageRouter {
  private sessionManager: TabSessionManager;
  private pdfPrinter: FirefoxPdfPrinter;
  private orchestrator: ExportOrchestrator;
  private isFinalizing = false;
  private activeTabId: number | null = null;
  private currentProgress: ExportProgress = {
    status: 'IDLE',
    currentChapter: 0,
    chapterTitle: 'Siap',
    message: 'Ekstensi siap digunakan.'
  };

  constructor(
    sessionManager: TabSessionManager,
    pdfPrinter: FirefoxPdfPrinter,
    orchestrator?: ExportOrchestrator
  ) {
    this.sessionManager = sessionManager;
    this.pdfPrinter = pdfPrinter;
    this.orchestrator = orchestrator ?? new ExportOrchestrator(sessionManager, pdfPrinter);
  }

  handleMessage(
    message: ExtensionMessage,
    sender: browser.runtime.MessageSender
  ): Promise<unknown> | undefined {
    logger.debug(`Received message [${message.type}] from tab ${sender.tab?.id ?? 'unknown'}`);

    switch (message.type) {
      case 'PING':
        return Promise.resolve({ type: 'PONG', timestamp: Date.now() });

      case 'GET_STATUS':
        return Promise.resolve({
          type: 'STATUS_RESPONSE',
          payload: this.currentProgress
        });

      case 'START_TEST_PRINT':
        return this.handleStartTestPrint(message, sender);

      case 'START_EXPORT':
        return this.handleStartExport(message, sender);

      case 'STOP_EXPORT':
        return this.handleStopExport(message);

      default:
        return undefined;
    }
  }

  /**
   * Single active chapter export via Firefox Native Vector (`browser.tabs.saveAsPDF`)
   */
  private async handleStartTestPrint(
    message: Extract<ExtensionMessage, { type: 'START_TEST_PRINT' }>,
    sender: browser.runtime.MessageSender
  ): Promise<unknown> {
    const tabId = sender.tab?.id;
    if (!tabId) {
      return { success: false, error: 'Tidak ditemukan tab aktif pada pengirim.' };
    }

    if (this.orchestrator.isRunning() || this.isFinalizing) {
      return {
        success: false,
        error: 'Sesi ekspor lain sedang berjalan. Tunggu selesai atau klik Berhenti terlebih dahulu.'
      };
    }

    const bookTitle = message.payload?.bookTitle || 'BMP_UT';
    const api = getBrowserApi();

    try {
      this.activeTabId = tabId;
      await this.sessionManager.startSession(tabId);

      this.updateProgress(
        {
          status: 'CAPTURING_PAGE',
          currentChapter: 1,
          totalChaptersEstimated: 1,
          chapterTitle: message.payload?.chapterTitle || 'Halaman Aktif',
          moduleLabel: 'Halaman Aktif',
          phaseLabel: 'Menyiapkan',
          percent: 45,
          message: 'Menyiapkan panggung cetak vektor halaman aktif...'
        },
        tabId
      );

      const prepResult = (await api.tabs.sendMessage(tabId, {
        type: 'PREPARE_FOR_PRINT'
      })) as PrepareForPrintResponse;

      if (!prepResult?.success) {
        throw new Error(prepResult?.error || 'Gagal menyiapkan panggung cetak vektor pada halaman Kotobee.');
      }

      const chapterTitle = prepResult.chapterTitle || message.payload?.chapterTitle || 'Bab_Aktif';
      const filename = sanitizeFilename(`${bookTitle}_${chapterTitle}`);

      this.updateProgress(
        {
          status: 'STITCHING',
          currentChapter: 1,
          totalChaptersEstimated: 1,
          chapterTitle,
          moduleLabel: 'Halaman Aktif',
          phaseLabel: 'Simpan PDF',
          percent: 85,
          message: 'Membuka dialog Save As PDF vektor Firefox...'
        },
        tabId
      );

      let saveStatus: VectorSaveStatus = 'saved';
      try {
        saveStatus = await this.pdfPrinter.saveConsolidatedVectorPdf(tabId, filename);
      } finally {
        await api.tabs.sendMessage(tabId, { type: 'RESTORE_AFTER_PRINT' }).catch(() => {});
      }

      const isCanceled = saveStatus === 'canceled';
      this.updateProgress(
        {
          status: isCanceled ? 'STOPPED' : 'COMPLETED',
          currentChapter: 1,
          totalChaptersEstimated: 1,
          chapterTitle,
          moduleLabel: 'Halaman Aktif',
          phaseLabel: isCanceled ? 'Dibatalkan' : 'Selesai',
          percent: isCanceled ? 0 : 100,
          capturedCount: isCanceled ? 0 : 1,
          message: isCanceled
            ? 'Dialog simpan PDF dibatalkan pengguna.'
            : saveStatus === 'fallback-print'
              ? 'Dialog cetak sistem dibuka — pilih "Save to PDF" untuk menyimpan.'
              : `Berhasil! ${filename} (Vektor) telah disimpan.`
        },
        tabId
      );

      return {
        success: !isCanceled,
        message: isCanceled
          ? 'Penyimpanan PDF dibatalkan pengguna.'
          : `File vektor berhasil disimpan: ${filename}`,
        filename,
        vectorSaveStatus: saveStatus
      };
    } catch (err) {
      const errorMsg = TabSessionManager.formatFriendlyError(err);
      logger.error('Error during handleStartTestPrint:', err);

      await api.tabs.sendMessage(tabId, { type: 'RESTORE_AFTER_PRINT' }).catch(() => {});

      this.updateProgress(
        {
          status: 'ERROR',
          currentChapter: 0,
          chapterTitle: 'Error',
          phaseLabel: 'Error',
          message: `Gagal cetak halaman aktif: ${errorMsg}`
        },
        tabId
      );

      return { success: false, error: errorMsg };
    } finally {
      this.sessionManager.endSession();
      this.activeTabId = null;
    }
  }

  /**
   * Multi-chapter module / page-range Native Vector export:
   * Collects clean DOM snapshots across [startChapter .. endChapter], mounts a single
   * consolidated `@media print` stage, and invokes `browser.tabs.saveAsPDF()` once.
   */
  private async handleStartExport(
    message: Extract<ExtensionMessage, { type: 'START_EXPORT' }>,
    sender: browser.runtime.MessageSender
  ): Promise<unknown> {
    const tabId = sender.tab?.id;
    if (!tabId) {
      return { success: false, error: 'Tidak ditemukan tab aktif pada pengirim.' };
    }

    if (this.orchestrator.isRunning() || this.isFinalizing) {
      return {
        success: false,
        error: 'Sesi ekspor sedang berjalan. Tunggu selesai atau klik Berhenti terlebih dahulu.'
      };
    }

    const incomingRange = message.payload?.range;
    const range: ExportRangeRequest = incomingRange
      ? { ...incomingRange, exportMode: 'native-vector' }
      : {
          startChapter: 0,
          endChapter: 0,
          label: message.payload?.bookTitle || 'Bab Aktif',
          bookTitle: message.payload?.bookTitle || 'BMP_UT',
          exportMode: 'native-vector'
        };

    if (range.startChapter < 0 || range.endChapter < range.startChapter) {
      return {
        success: false,
        error: `Rentang chapter tidak valid (${range.startChapter} s.d. ${range.endChapter}).`
      };
    }

    const bookTitle = range.bookTitle || message.payload?.bookTitle || 'BMP_UT';

    this.activeTabId = tabId;
    this.updateProgress(
      {
        status: 'INITIALIZING',
        currentChapter: 0,
        currentChapterIndex: range.startChapter,
        totalChaptersEstimated: range.endChapter - range.startChapter + 1,
        chapterTitle: range.label,
        moduleLabel: range.label,
        startChapter: range.startChapter,
        endChapter: range.endChapter,
        phaseLabel: 'Inisialisasi',
        message: `Memulai ekspor Vektor Native untuk ${range.label} (ch/${range.startChapter}–${range.endChapter})...`,
        percent: 0,
        capturedCount: 0,
        failedCount: 0,
        totalBytes: 0,
        startedAt: Date.now(),
        etaSeconds: null
      },
      tabId
    );

    const api = getBrowserApi();

    void this.orchestrator
      .runBatchExport(tabId, range, message.payload?.config, {
        onProgress: (progress) => this.updateProgress(progress, tabId),
        deferTerminalStatus: true
      })
      .then(async (summary) => {
        logger.info('Batch vector snapshot collection finished; mounting consolidated print stage:', {
          status: summary.status,
          captured: summary.capturedCount,
          totalRequested: summary.totalRequested,
          lastChapterIndex: summary.lastChapterIndex
        });

        this.isFinalizing = true;
        try {
          if (summary.capturedCount > 0) {
            const isPartial =
              summary.status !== 'COMPLETED' || summary.capturedCount < summary.totalRequested;
            summary.isPartial = isPartial;

            const rawName = isPartial
              ? `${bookTitle}_${range.label}_Partial_ch${summary.startChapter}-${summary.lastChapterIndex ?? summary.startChapter}`
              : `${bookTitle}_${range.label}`;
            const outputFilename = sanitizeFilename(rawName);

            const mountRes = (await api.tabs.sendMessage(tabId, {
              type: 'MOUNT_VECTOR_PRINT_STAGE'
            })) as MountVectorPrintStageResponse;

            if (!mountRes?.success || mountRes.snapshotCount === 0) {
              throw new Error(mountRes?.error || 'Gagal memasang panggung cetak vektor gabungan.');
            }

            this.updateProgress(
              {
                status: 'STITCHING',
                currentChapter: summary.capturedCount,
                currentChapterIndex: summary.lastChapterIndex ?? summary.startChapter,
                totalChaptersEstimated: summary.totalRequested,
                chapterTitle: range.label,
                moduleLabel: range.label,
                phaseLabel: 'Simpan Vektor',
                message: `Membuka dialog Save As PDF untuk ${outputFilename} (${mountRes.snapshotCount} halaman)...`,
                percent: 99,
                capturedCount: summary.capturedCount,
                failedCount: summary.failedCount,
                totalBytes: summary.totalBytes,
                etaSeconds: 0
              },
              tabId
            );

            let saveStatus: VectorSaveStatus = 'saved';
            try {
              saveStatus = await this.pdfPrinter.saveConsolidatedVectorPdf(tabId, outputFilename);
            } finally {
              await api.tabs.sendMessage(tabId, { type: 'RESTORE_AFTER_PRINT' }).catch(() => {});
              await api.tabs.sendMessage(tabId, { type: 'CLEAR_VECTOR_SNAPSHOTS' }).catch(() => {});
            }

            summary.outputFilename = outputFilename;
            summary.totalPdfPages = mountRes.snapshotCount;
            summary.vectorSaveStatus = saveStatus;

            const isCanceled = saveStatus === 'canceled';
            const finalUiStatus = isCanceled
              ? 'STOPPED'
              : summary.status === 'ERROR'
                ? 'ERROR'
                : summary.status === 'STOPPED'
                  ? 'STOPPED'
                  : 'COMPLETED';

            const statusMsg = isCanceled
              ? `Dialog simpan PDF dibatalkan (${mountRes.snapshotCount} halaman sempat dikumpulkan).`
              : saveStatus === 'fallback-print'
                ? `Dialog cetak sistem dibuka (${mountRes.snapshotCount} halaman). Pilih "Save to PDF".`
                : `Selesai! PDF Vektor disimpan: ${outputFilename} (${mountRes.snapshotCount} hal).`;

            this.updateProgress(
              {
                status: finalUiStatus,
                currentChapter: summary.capturedCount,
                currentChapterIndex: summary.lastChapterIndex ?? summary.endChapter,
                totalChaptersEstimated: summary.totalRequested,
                chapterTitle: isCanceled ? 'Dibatalkan' : range.label,
                moduleLabel: range.label,
                phaseLabel: isCanceled ? 'Dibatalkan' : isPartial ? 'Parsial' : 'Selesai',
                message: statusMsg,
                percent:
                  finalUiStatus === 'COMPLETED'
                    ? 100
                    : Math.round((summary.capturedCount / summary.totalRequested) * 100),
                capturedCount: summary.capturedCount,
                failedCount: summary.failedCount,
                totalBytes: summary.totalBytes,
                etaSeconds: 0
              },
              tabId
            );

            if (summary.status === 'ERROR' && !isCanceled) {
              await api.tabs
                .sendMessage(tabId, {
                  type: 'EXPORT_ERROR',
                  payload: {
                    message: summary.errorMessage || 'Ekspor terhenti di tengah proses.',
                    details: `PDF vektor parsial disimpan: ${outputFilename} (${mountRes.snapshotCount} hal).`,
                    recoverable: summary.resumeFromChapter !== null && summary.resumeFromChapter !== undefined,
                    partialFilename: outputFilename,
                    summary
                  }
                })
                .catch(() => {});
            } else {
              await api.tabs
                .sendMessage(tabId, {
                  type: 'EXPORT_COMPLETE',
                  payload: {
                    filename: outputFilename,
                    totalChapters: summary.capturedCount,
                    totalPdfPages: mountRes.snapshotCount,
                    isPartial: isPartial || isCanceled,
                    vectorSaveStatus: saveStatus,
                    summary
                  }
                })
                .catch(() => {});
            }
          } else {
            await api.tabs.sendMessage(tabId, { type: 'CLEAR_VECTOR_SNAPSHOTS' }).catch(() => {});
            await this.emitZeroCapturedTerminal(tabId, range, summary);
          }
        } catch (err) {
          const errMsg = TabSessionManager.formatFriendlyError(err);
          logger.error('Error during Native Vector finalization:', err);
          await api.tabs.sendMessage(tabId, { type: 'RESTORE_AFTER_PRINT' }).catch(() => {});
          await api.tabs.sendMessage(tabId, { type: 'CLEAR_VECTOR_SNAPSHOTS' }).catch(() => {});

          this.updateProgress(
            {
              status: 'ERROR',
              currentChapter: summary.capturedCount,
              currentChapterIndex: summary.lastChapterIndex ?? summary.startChapter,
              totalChaptersEstimated: summary.totalRequested,
              chapterTitle: 'Error Simpan PDF',
              message: `Gagal menyimpan PDF vektor: ${errMsg}`
            },
            tabId
          );

          await api.tabs
            .sendMessage(tabId, {
              type: 'EXPORT_ERROR',
              payload: {
                message: `Gagal menyimpan PDF vektor: ${errMsg}`,
                details: `${summary.capturedCount} halaman telah direkam sebelum gagal.`
              }
            })
            .catch(() => {});
        } finally {
          this.isFinalizing = false;
          this.activeTabId = null;
        }
      })
      .catch((err) => {
        this.isFinalizing = false;
        this.activeTabId = null;
        logger.error('Unhandled error in orchestrator.runBatchExport:', err);
      });

    return {
      success: true,
      message: `Memulai ekspor Vektor Native untuk ${range.label} (ch/${range.startChapter}–${range.endChapter})...`
    };
  }

  private async emitZeroCapturedTerminal(
    tabId: number,
    range: ExportRangeRequest,
    summary: import('../types/exporter').BatchExportSummary
  ): Promise<void> {
    const api = getBrowserApi();
    if (summary.status === 'ERROR') {
      await api.tabs
        .sendMessage(tabId, {
          type: 'EXPORT_ERROR',
          payload: {
            message: summary.errorMessage || 'Ekspor rentang halaman gagal.',
            details: '0 halaman berhasil direkam.',
            summary
          }
        })
        .catch(() => {});
    } else {
      await api.tabs
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

  private async handleStopExport(
    message: Extract<ExtensionMessage, { type: 'STOP_EXPORT' }>
  ): Promise<unknown> {
    logger.info('Stopping export session by user request.');
    await this.orchestrator.stop(message.reason || 'User manual stop', (progress) =>
      this.updateProgress(progress, this.activeTabId ?? undefined)
    );
    if (!this.orchestrator.isRunning() && !this.isFinalizing) {
      this.sessionManager.endSession();
      this.updateProgress(
        {
          status: 'STOPPED',
          currentChapter: 0,
          chapterTitle: 'Dihentikan',
          phaseLabel: 'Dihentikan',
          message: 'Proses ekspor dihentikan oleh pengguna.'
        },
        this.activeTabId ?? undefined
      );
    }
    return { success: true, message: 'Permintaan berhenti diterima.' };
  }

  private updateProgress(progress: ExportProgress, tabId?: number): void {
    this.currentProgress = progress;
    const targetTabId = tabId ?? this.activeTabId;
    if (targetTabId !== null && hasBrowserApi()) {
      const api = getBrowserApi();
      if (api.tabs?.sendMessage) {
        api.tabs
          .sendMessage(targetTabId, {
            type: 'EXPORT_PROGRESS',
            payload: progress
          })
          .catch(() => {
            // Tab may be busy or closed; widget also reconciles via GET_STATUS fallback
          });
      }
    }
  }
}
