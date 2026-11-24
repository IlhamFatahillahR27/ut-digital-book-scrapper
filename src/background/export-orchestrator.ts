import { DebuggerManager } from './debugger-manager';
import { CdpPrinter } from './cdp-printer';
import { logger } from '../utils/logger';
import { sanitizeFilename } from '../utils/sanitize';
import {
  DEFAULT_EXPORTER_CONFIG,
  type BatchExportSummary,
  type CapturedChapterMeta,
  type ExportProgress,
  type ExportRangeRequest,
  type ExporterConfig
} from '../types/exporter';
import type {
  EnsureSinglePageModeResponse,
  NavigateToChapterResponse,
  PrepareForPrintResponse
} from '../types/messages';

export type ChapterCapturedHook = (
  buffer: Uint8Array,
  meta: CapturedChapterMeta,
  base64: string
) => Promise<void> | void;

export interface OrchestratorCallbacks {
  onProgress: (progress: ExportProgress) => void;
  savePdfFile: (tabId: number, base64: string, filename: string) => Promise<void>;
  /** Pluggable hook for Phase 4 PdfAssembler to collect chapter buffers */
  onChapterCaptured?: ChapterCapturedHook;
  /**
   * When true and >= 1 chapter is captured, keeps progress in 'STITCHING' instead of
   * emitting terminal COMPLETED/STOPPED/ERROR so caller can finish PDF assembly & download
   * before unlocking the UI.
   */
  deferTerminalStatus?: boolean;
}

export class ExportOrchestrator {
  private debuggerManager: DebuggerManager;
  private cdpPrinter: CdpPrinter;

  private activeTabId: number | null = null;
  private activeAbortController: AbortController | null = null;
  private running = false;
  private isPrintingNow = false;
  private stopRequested = false;

  constructor(debuggerManager: DebuggerManager, cdpPrinter: CdpPrinter) {
    this.debuggerManager = debuggerManager;
    this.cdpPrinter = cdpPrinter;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Triggers Graceful Stop on an active export batch.
   * Immediately aborts any ongoing navigation/wait; if CDP Page.printToPDF is in-flight,
   * stops right after the active page completes and guarantees full cleanup.
   */
  async stop(reason = 'User manual stop', onProgress?: (progress: ExportProgress) => void): Promise<void> {
    if (!this.running) {
      await this.debuggerManager.detach().catch(() => {});
      return;
    }

    logger.info(`ExportOrchestrator: Graceful stop requested (${reason}).`);
    this.stopRequested = true;

    if (this.activeAbortController && !this.activeAbortController.signal.aborted) {
      this.activeAbortController.abort();
    }

    if (onProgress) {
      onProgress({
        // Keep a busy status until the finally block completes cleanup & debugger detach
        status: this.isPrintingNow ? 'CAPTURING_PAGE' : 'WAITING_NEXT',
        currentChapter: 0,
        chapterTitle: 'Menghentikan...',
        message: this.isPrintingNow
          ? 'Menghentikan setelah halaman aktif selesai dicetak...'
          : 'Menghentikan navigasi & membersihkan sesi...'
      });
    }

    // Immediately abort any waiting navigation loop in content script (<100ms)
    if (this.activeTabId !== null) {
      try {
        await chrome.tabs.sendMessage(this.activeTabId, { type: 'ABORT_NAVIGATION' });
      } catch {
        // Tab may already be closing or busy
      }
    }
  }

  /**
   * Executes a multi-chapter sequential export over [range.startChapter .. range.endChapter]
   */
  async runBatchExport(
    tabId: number,
    range: ExportRangeRequest,
    partialConfig: Partial<ExporterConfig> | undefined,
    callbacks: OrchestratorCallbacks
  ): Promise<BatchExportSummary> {
    if (this.running) {
      throw new Error('Sesi ekspor lain sedang berjalan. Hentikan terlebih dahulu sebelum memulai sesi baru.');
    }

    const startChapter = Math.max(0, Math.floor(range.startChapter));
    const endChapter = Math.max(startChapter, Math.floor(range.endChapter));
    const totalRequested = endChapter - startChapter + 1;
    const config: ExporterConfig = { ...DEFAULT_EXPORTER_CONFIG, ...partialConfig };
    const bookTitle = range.bookTitle || 'BMP_UT';
    const label = range.label || `Ch ${startChapter}-${endChapter}`;

    this.running = true;
    this.stopRequested = false;
    this.isPrintingNow = false;
    this.activeTabId = tabId;
    this.activeAbortController = new AbortController();
    const { signal } = this.activeAbortController;

    const capturedChapters: CapturedChapterMeta[] = [];
    let totalBytes = 0;
    let failedCount = 0;
    let lastChapterIndex: number | null = null;
    let previousFingerprint: string | undefined;
    let changedPageViewMode = false;
    let finalStatus: BatchExportSummary['status'] = 'COMPLETED';
    let finalErrorMessage: string | undefined;

    // Abort batch immediately if debugger detaches unexpectedly (user closed tab / clicked Cancel on infobar)
    const unsubscribeDetach = this.debuggerManager.onUnexpectedDetach((detachedTabId, reason) => {
      if (detachedTabId === tabId && this.running && !this.stopRequested) {
        logger.warn(`ExportOrchestrator: Unexpected debugger detach (${reason}). Aborting batch.`);
        finalErrorMessage = `Debugger terputus di tengah proses (${reason}).`;
        this.activeAbortController?.abort();
      }
    });

    try {
      // 1. Attach debugger ONCE for the entire batch session
      callbacks.onProgress({
        status: 'INITIALIZING',
        currentChapter: 0,
        currentChapterIndex: startChapter,
        totalChaptersEstimated: totalRequested,
        chapterTitle: label,
        message: `Menghubungkan debugger untuk ${label} (${totalRequested} halaman)...`,
        percent: 0,
        capturedCount: 0,
        totalBytes: 0
      });

      await this.debuggerManager.attach(tabId);
      await this.cdpPrinter.prepare();

      if (signal.aborted) {
        finalStatus = 'STOPPED';
        return this.buildSummary({
          status: finalStatus,
          label,
          startChapter,
          endChapter,
          totalRequested,
          capturedChapters,
          failedCount,
          totalBytes,
          lastChapterIndex,
          errorMessage: finalErrorMessage
        });
      }

      // 2. Ensure Kotobee is in Single-Page mode (avoids Two-Page Spread skipping/duplication)
      try {
        const viewRes = (await chrome.tabs.sendMessage(tabId, {
          type: 'ENSURE_SINGLE_PAGE_MODE'
        })) as EnsureSinglePageModeResponse;
        if (viewRes?.changed) {
          changedPageViewMode = true;
          logger.info('ExportOrchestrator: Temporarily switched Kotobee to Single-Page mode.');
        }
      } catch (viewErr) {
        logger.warn('ExportOrchestrator: ENSURE_SINGLE_PAGE_MODE failed, continuing:', viewErr);
      }

      // 3. Iterate chapter by chapter across [startChapter .. endChapter]
      for (let ch = startChapter; ch <= endChapter; ch++) {
        const seq = ch - startChapter + 1;
        const pctBefore = Math.round(((seq - 1) / totalRequested) * 100);
        const expectedTitle = range.chapterTitles?.[ch] || `Chapter ${ch}`;

        if (signal.aborted || !this.debuggerManager.isAttached()) {
          finalStatus = this.stopRequested ? 'STOPPED' : 'ERROR';
          break;
        }

        const chapterStartMs = Date.now();

        // 3a. Navigate & wait for page stability (with 1x retry on transient timeout)
        callbacks.onProgress({
          status: 'NAVIGATING',
          currentChapter: seq,
          currentChapterIndex: ch,
          totalChaptersEstimated: totalRequested,
          chapterTitle: expectedTitle,
          message: `Halaman ${seq}/${totalRequested}: Memuat ${expectedTitle} (ch/${ch})...`,
          percent: pctBefore,
          capturedCount: capturedChapters.length,
          totalBytes
        });

        const navResult = await this.navigateWithRetry({
          tabId,
          targetChapter: ch,
          bookId: range.bookId,
          previousFingerprint,
          config,
          signal
        });

        if (signal.aborted || navResult.aborted) {
          finalStatus = this.stopRequested ? 'STOPPED' : 'ERROR';
          break;
        }

        if (!navResult.success) {
          failedCount++;
          throw new Error(
            `Gagal memuat chapter/${ch} (${expectedTitle}): ${navResult.error || 'Navigasi gagal'}`
          );
        }

        previousFingerprint = navResult.fingerprint;
        const resolvedTitle =
          (navResult.chapterTitle && navResult.chapterTitle !== 'Bab_Aktif'
            ? navResult.chapterTitle
            : expectedTitle) || `Halaman_${ch + 1}`;

        // 3b. Prepare Isolated Print Stage
        if (signal.aborted) {
          finalStatus = this.stopRequested ? 'STOPPED' : 'ERROR';
          break;
        }

        callbacks.onProgress({
          status: 'CAPTURING_PAGE',
          currentChapter: seq,
          currentChapterIndex: ch,
          totalChaptersEstimated: totalRequested,
          chapterTitle: resolvedTitle,
          message: `Halaman ${seq}/${totalRequested}: Menyiapkan cetak (${resolvedTitle})...`,
          percent: pctBefore,
          capturedCount: capturedChapters.length,
          totalBytes
        });

        let prepResult: PrepareForPrintResponse;
        try {
          prepResult = (await chrome.tabs.sendMessage(tabId, {
            type: 'PREPARE_FOR_PRINT'
          })) as PrepareForPrintResponse;
        } catch (prepErr) {
          throw new Error(`Komunikasi PREPARE_FOR_PRINT gagal pada ch/${ch}: ${String(prepErr)}`);
        }

        if (!prepResult?.success) {
          throw new Error(
            prepResult?.error || `Gagal menyiapkan isolated print stage pada ch/${ch}.`
          );
        }

        if (signal.aborted) {
          await chrome.tabs.sendMessage(tabId, { type: 'RESTORE_AFTER_PRINT' }).catch(() => {});
          finalStatus = this.stopRequested ? 'STOPPED' : 'ERROR';
          break;
        }

        // 3c. Execute silent CDP Page.printToPDF
        callbacks.onProgress({
          status: 'CAPTURING_PAGE',
          currentChapter: seq,
          currentChapterIndex: ch,
          totalChaptersEstimated: totalRequested,
          chapterTitle: resolvedTitle,
          message: `Halaman ${seq}/${totalRequested}: Mencetak PDF (${resolvedTitle})...`,
          percent: pctBefore,
          capturedCount: capturedChapters.length,
          totalBytes
        });

        let base64 = '';
        let buffer: Uint8Array;
        this.isPrintingNow = true;
        try {
          const printResult = await this.cdpPrinter.printCurrentPage({
            printBackground: config.printBackground,
            generateTaggedPDF: true,
            ...(prepResult.isFixedLayout ? { pageRanges: '1' } : {})
          });
          base64 = printResult.base64;
          buffer = printResult.buffer;
        } finally {
          this.isPrintingNow = false;
          // Always restore live DOM immediately after each page print
          await chrome.tabs.sendMessage(tabId, { type: 'RESTORE_AFTER_PRINT' }).catch(() => {});
        }

        const validPdfHeader = this.hasValidPdfHeader(buffer);
        if (!validPdfHeader) {
          logger.warn(`ExportOrchestrator: Chapter/${ch} buffer failed %PDF- header check.`);
        }

        const durationMs = Date.now() - chapterStartMs;
        const meta: CapturedChapterMeta = {
          chapterIndex: ch,
          sequenceNumber: seq,
          title: resolvedTitle,
          byteLength: buffer.byteLength,
          isFixedLayout: !!prepResult.isFixedLayout,
          durationMs,
          validPdfHeader
        };

        capturedChapters.push(meta);
        totalBytes += buffer.byteLength;
        lastChapterIndex = ch;

        logger.info(
          `ExportOrchestrator: Captured [${seq}/${totalRequested}] ch/${ch} "${resolvedTitle}" ` +
            `(${(buffer.byteLength / 1024).toFixed(1)} KB, validPDF=${validPdfHeader}, ${durationMs}ms)`
        );

        // 3d. Optional Phase 4 hook (e.g., PdfAssembler)
        if (callbacks.onChapterCaptured) {
          await callbacks.onChapterCaptured(buffer, meta, base64);
        }

        // 3e. Optional Phase 3 Debug Mode: download individual PDF file per page
        if (range.savePerPageDebug) {
          const seqStr = String(seq).padStart(3, '0');
          const filename = sanitizeFilename(`${seqStr}_ch${ch}_${bookTitle}_${resolvedTitle}`);
          await callbacks.savePdfFile(tabId, base64, filename);
        }

        const pctAfter = Math.round((seq / totalRequested) * 100);
        const postPageStatus =
          seq < totalRequested
            ? 'WAITING_NEXT'
            : callbacks.deferTerminalStatus
              ? 'STITCHING'
              : 'COMPLETED';
        callbacks.onProgress({
          status: postPageStatus,
          currentChapter: seq,
          currentChapterIndex: ch,
          totalChaptersEstimated: totalRequested,
          chapterTitle: resolvedTitle,
          message:
            seq < totalRequested
              ? `Halaman ${seq}/${totalRequested} selesai (${(totalBytes / 1024 / 1024).toFixed(2)} MB total)...`
              : `Halaman ${seq}/${totalRequested} selesai. Menyiapkan penggabungan PDF...`,
          percent: pctAfter,
          capturedCount: capturedChapters.length,
          totalBytes
        });

        // If user clicked Stop while Page.printToPDF was running, exit cleanly right after this page
        if (signal.aborted) {
          finalStatus = this.stopRequested ? 'STOPPED' : 'ERROR';
          break;
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('ExportOrchestrator: Batch export error:', err);
      if (this.stopRequested) {
        finalStatus = 'STOPPED';
      } else {
        finalStatus = 'ERROR';
        finalErrorMessage = finalErrorMessage || errMsg;
      }
    } finally {
      unsubscribeDetach();

      // Guaranteed cleanup: abort any pending wait, remove print stage, restore view mode, detach debugger
      await chrome.tabs.sendMessage(tabId, { type: 'ABORT_NAVIGATION' }).catch(() => {});
      await chrome.tabs.sendMessage(tabId, { type: 'RESTORE_AFTER_PRINT' }).catch(() => {});

      if (changedPageViewMode) {
        await chrome.tabs.sendMessage(tabId, { type: 'RESTORE_PAGE_VIEW_MODE' }).catch(() => {});
      }

      await this.debuggerManager.detach().catch(() => {});

      this.running = false;
      this.isPrintingNow = false;
      this.activeAbortController = null;
      this.activeTabId = null;

      const totalMb = (totalBytes / 1024 / 1024).toFixed(2);
      if (callbacks.deferTerminalStatus && capturedChapters.length > 0) {
        const isPartial = finalStatus !== 'COMPLETED';
        callbacks.onProgress({
          status: 'STITCHING',
          currentChapter: capturedChapters.length,
          currentChapterIndex: lastChapterIndex ?? startChapter,
          totalChaptersEstimated: totalRequested,
          chapterTitle: label,
          message: isPartial
            ? `Menyimpan parsial: menggabungkan ${capturedChapters.length} halaman & menyusun bookmarks...`
            : `Menggabungkan ${capturedChapters.length} halaman & menyusun bookmarks PDF...`,
          percent: isPartial ? Math.round((capturedChapters.length / totalRequested) * 100) : 99,
          capturedCount: capturedChapters.length,
          totalBytes
        });
      } else if (finalStatus === 'COMPLETED') {
        callbacks.onProgress({
          status: 'COMPLETED',
          currentChapter: capturedChapters.length,
          currentChapterIndex: lastChapterIndex ?? endChapter,
          totalChaptersEstimated: totalRequested,
          chapterTitle: label,
          message: `Selesai! ${capturedChapters.length}/${totalRequested} halaman tervalidasi (${totalMb} MB).${
            range.savePerPageDebug ? ' PDF per halaman telah diunduh.' : ''
          }`,
          percent: 100,
          capturedCount: capturedChapters.length,
          totalBytes
        });
      } else if (finalStatus === 'STOPPED') {
        callbacks.onProgress({
          status: 'STOPPED',
          currentChapter: capturedChapters.length,
          currentChapterIndex: lastChapterIndex ?? startChapter,
          totalChaptersEstimated: totalRequested,
          chapterTitle: 'Dihentikan',
          message: `Dihentikan pengguna. ${capturedChapters.length}/${totalRequested} halaman selesai (${totalMb} MB).`,
          percent: Math.round((capturedChapters.length / totalRequested) * 100),
          capturedCount: capturedChapters.length,
          totalBytes
        });
      } else {
        callbacks.onProgress({
          status: 'ERROR',
          currentChapter: capturedChapters.length,
          currentChapterIndex: lastChapterIndex ?? startChapter,
          totalChaptersEstimated: totalRequested,
          chapterTitle: 'Error',
          message: `Gagal (${capturedChapters.length}/${totalRequested} selesai): ${finalErrorMessage || 'Terjadi kesalahan'}`,
          percent: Math.round((capturedChapters.length / totalRequested) * 100),
          capturedCount: capturedChapters.length,
          totalBytes
        });
      }
    }

    return this.buildSummary({
      status: finalStatus,
      label,
      startChapter,
      endChapter,
      totalRequested,
      capturedChapters,
      failedCount,
      totalBytes,
      lastChapterIndex,
      errorMessage: finalErrorMessage
    });
  }

  private async navigateWithRetry(params: {
    tabId: number;
    targetChapter: number;
    bookId?: string | null;
    previousFingerprint?: string;
    config: ExporterConfig;
    signal: AbortSignal;
  }): Promise<NavigateToChapterResponse> {
    const maxAttempts = 1 + Math.max(0, params.config.maxRetriesPerChapter);
    let lastResult: NavigateToChapterResponse = {
      success: false,
      actualChapter: null,
      chapterTitle: '',
      fingerprint: ''
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (params.signal.aborted) {
        return { ...lastResult, aborted: true };
      }

      try {
        lastResult = (await chrome.tabs.sendMessage(params.tabId, {
          type: 'NAVIGATE_TO_CHAPTER',
          payload: {
            targetChapter: params.targetChapter,
            bookId: params.bookId,
            previousFingerprint: params.previousFingerprint,
            timeoutMs: params.config.chapterNavigationTimeoutMs,
            quiescenceMs: params.config.domQuiescenceMs
          }
        })) as NavigateToChapterResponse;

        if (lastResult?.success || lastResult?.aborted) {
          return lastResult;
        }
      } catch (err) {
        lastResult = {
          success: false,
          actualChapter: null,
          chapterTitle: '',
          fingerprint: '',
          error: String(err)
        };
      }

      if (attempt < maxAttempts && !params.signal.aborted) {
        logger.warn(
          `ExportOrchestrator: Navigation attempt ${attempt} failed for ch/${params.targetChapter}. Retrying...`
        );
        await new Promise((r) => setTimeout(r, 800));
      }
    }

    return lastResult;
  }

  /**
   * Verifies PDF magic bytes: "%PDF-" (0x25 0x50 0x44 0x46 0x2D)
   */
  private hasValidPdfHeader(buffer: Uint8Array): boolean {
    return (
      buffer.byteLength > 100 &&
      buffer[0] === 0x25 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x44 &&
      buffer[3] === 0x46 &&
      buffer[4] === 0x2d
    );
  }

  private buildSummary(params: {
    status: BatchExportSummary['status'];
    label: string;
    startChapter: number;
    endChapter: number;
    totalRequested: number;
    capturedChapters: CapturedChapterMeta[];
    failedCount: number;
    totalBytes: number;
    lastChapterIndex: number | null;
    errorMessage?: string;
  }): BatchExportSummary {
    return {
      status: params.status,
      label: params.label,
      startChapter: params.startChapter,
      endChapter: params.endChapter,
      totalRequested: params.totalRequested,
      capturedCount: params.capturedChapters.length,
      failedCount: params.failedCount,
      totalBytes: params.totalBytes,
      lastChapterIndex: params.lastChapterIndex,
      chapters: params.capturedChapters,
      errorMessage: params.errorMessage
    };
  }
}
