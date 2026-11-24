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
  type ExporterConfig,
  type FailedChapterMeta
} from '../types/exporter';
import type {
  CheckPageHealthResponse,
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

class StageError extends Error {
  readonly stage: FailedChapterMeta['stage'];
  readonly fatal: boolean;

  constructor(stage: FailedChapterMeta['stage'], message: string, fatal = false) {
    super(message);
    this.name = 'StageError';
    this.stage = stage;
    this.fatal = fatal;
  }
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
        phaseLabel: 'Menghentikan',
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
   * with exponential-backoff retry, CDP timeout guards, offline/SSO health checks,
   * single-chapter skip, and a 3-consecutive-failure circuit breaker.
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
    const startedAt = Date.now();

    this.running = true;
    this.stopRequested = false;
    this.isPrintingNow = false;
    this.activeTabId = tabId;
    this.activeAbortController = new AbortController();
    const { signal } = this.activeAbortController;

    const capturedChapters: CapturedChapterMeta[] = [];
    const failedChapters: FailedChapterMeta[] = [];
    const recentDurationsMs: number[] = [];

    let totalBytes = 0;
    let failedCount = 0;
    let consecutiveFailures = 0;
    let circuitBreakerTriggered = false;
    let lastChapterIndex: number | null = null;
    let previousFingerprint: string | undefined;
    let changedPageViewMode = false;
    let finalStatus: BatchExportSummary['status'] = 'COMPLETED';
    let finalErrorMessage: string | undefined;

    // MV3 Service Worker lightweight keep-alive heartbeat during long batches
    const keepAliveTimer = setInterval(() => {
      if (typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo) {
        chrome.runtime.getPlatformInfo(() => {});
      }
    }, 20000);

    const computeEta = (remainingPages: number): number | null => {
      if (remainingPages <= 0) return 0;
      if (recentDurationsMs.length === 0) return null;
      const avgMs = recentDurationsMs.reduce((a, b) => a + b, 0) / recentDurationsMs.length;
      return Math.max(1, Math.round((avgMs * remainingPages) / 1000));
    };

    const emitProgress = (partial: Omit<ExportProgress, 'moduleLabel' | 'startChapter' | 'endChapter' | 'startedAt'>) => {
      callbacks.onProgress({
        moduleLabel: label,
        startChapter,
        endChapter,
        startedAt,
        failedCount,
        consecutiveFailures,
        capturedCount: capturedChapters.length,
        totalBytes,
        ...partial
      });
    };

    // Abort batch immediately if debugger detaches unexpectedly (user closed tab / clicked Cancel on infobar)
    const unsubscribeDetach = this.debuggerManager.onUnexpectedDetach((detachedTabId, reason) => {
      if (detachedTabId === tabId && this.running && !this.stopRequested) {
        logger.warn(`ExportOrchestrator: Unexpected debugger detach (${reason}). Aborting batch.`);
        finalErrorMessage = DebuggerManager.formatFriendlyError(reason);
        this.activeAbortController?.abort();
      }
    });

    try {
      // 1. Attach debugger ONCE for the entire batch session
      emitProgress({
        status: 'INITIALIZING',
        currentChapter: 0,
        currentChapterIndex: startChapter,
        totalChaptersEstimated: totalRequested,
        chapterTitle: label,
        phaseLabel: 'Inisialisasi',
        message: `Menghubungkan browser untuk ${label} (${totalRequested} halaman)...`,
        percent: 0,
        etaSeconds: null
      });

      await this.debuggerManager.attach(tabId);
      await this.cdpPrinter.prepare();

      if (signal.aborted) {
        finalStatus = this.stopRequested ? 'STOPPED' : 'ERROR';
        return this.buildSummary({
          status: finalStatus,
          label,
          startChapter,
          endChapter,
          totalRequested,
          capturedChapters,
          failedChapters,
          failedCount,
          circuitBreakerTriggered,
          totalBytes,
          lastChapterIndex,
          startedAt,
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
        const remainingBefore = totalRequested - (seq - 1);
        const pctBefore = Math.round(((seq - 1) / totalRequested) * 100);
        const expectedTitle = range.chapterTitles?.[ch] || `Halaman ${ch + 1}`;

        if (signal.aborted || !this.debuggerManager.isAttached()) {
          finalStatus = this.stopRequested ? 'STOPPED' : 'ERROR';
          break;
        }

        const attemptResult = await this.processChapterWithRetry({
          tabId,
          ch,
          seq,
          totalRequested,
          expectedTitle,
          label,
          bookId: range.bookId,
          bookTitle,
          savePerPageDebug: !!range.savePerPageDebug,
          previousFingerprint,
          config,
          signal,
          etaSeconds: computeEta(remainingBefore),
          pctBefore,
          callbacks,
          emitProgress
        });

        if (attemptResult.aborted) {
          finalStatus = this.stopRequested ? 'STOPPED' : 'ERROR';
          if (attemptResult.fatalError) {
            finalErrorMessage = finalErrorMessage || attemptResult.fatalError;
          }
          break;
        }

        if (attemptResult.success && attemptResult.meta) {
          consecutiveFailures = 0;
          previousFingerprint = attemptResult.fingerprint;
          capturedChapters.push(attemptResult.meta);
          totalBytes += attemptResult.meta.byteLength;
          lastChapterIndex = ch;

          recentDurationsMs.push(attemptResult.meta.durationMs);
          if (recentDurationsMs.length > 5) {
            recentDurationsMs.shift();
          }

          const pctAfter = Math.round((seq / totalRequested) * 100);
          const remainingAfter = totalRequested - seq;
          const postPageStatus =
            seq < totalRequested
              ? 'WAITING_NEXT'
              : callbacks.deferTerminalStatus
                ? 'STITCHING'
                : 'COMPLETED';

          emitProgress({
            status: postPageStatus,
            currentChapter: seq,
            currentChapterIndex: ch,
            totalChaptersEstimated: totalRequested,
            chapterTitle: attemptResult.meta.title,
            phaseLabel: seq < totalRequested ? 'Berikutnya' : 'Menggabungkan',
            message:
              seq < totalRequested
                ? `Halaman ${seq} dari ${totalRequested} (${label}) selesai.`
                : `Semua halaman selesai (${capturedChapters.length}/${totalRequested}). Menyatukan PDF...`,
            percent: pctAfter,
            etaSeconds: computeEta(remainingAfter)
          });

          if (signal.aborted) {
            finalStatus = this.stopRequested ? 'STOPPED' : 'ERROR';
            break;
          }
          continue;
        }

        // Chapter failed after retries (or fatal non-retryable error like SSO session expired)
        if (attemptResult.fatalError) {
          failedCount++;
          failedChapters.push({
            chapterIndex: ch,
            sequenceNumber: seq,
            title: expectedTitle,
            stage: attemptResult.stage || 'NAVIGATE',
            attempts: attemptResult.attempts,
            error: attemptResult.fatalError
          });
          finalStatus = 'ERROR';
          finalErrorMessage = attemptResult.fatalError;
          break;
        }

        failedCount++;
        consecutiveFailures++;
        const failureMeta: FailedChapterMeta = {
          chapterIndex: ch,
          sequenceNumber: seq,
          title: expectedTitle,
          stage: attemptResult.stage || 'NAVIGATE',
          attempts: attemptResult.attempts,
          error: attemptResult.error || 'Gagal memproses halaman'
        };
        failedChapters.push(failureMeta);

        logger.warn(
          `ExportOrchestrator: Chapter/${ch} ("${expectedTitle}") failed after ${attemptResult.attempts} attempt(s) ` +
            `[consecutive=${consecutiveFailures}/${config.maxConsecutiveFailures}]: ${failureMeta.error}`
        );

        const hitCircuitBreaker = consecutiveFailures >= Math.max(1, config.maxConsecutiveFailures);
        if (hitCircuitBreaker || !config.skipFailedChapters) {
          circuitBreakerTriggered = hitCircuitBreaker;
          finalStatus = 'ERROR';
          finalErrorMessage = hitCircuitBreaker
            ? `Ekspor dihentikan otomatis setelah ${consecutiveFailures} halaman gagal berturut-turut ` +
              `(terakhir ch/${ch}: ${failureMeta.error}).`
            : `Gagal pada halaman ch/${ch} (${expectedTitle}): ${failureMeta.error}`;
          break;
        }

        // Skip chapter & continue to the next page
        const pctAfterSkip = Math.round((seq / totalRequested) * 100);
        emitProgress({
          status: 'WAITING_NEXT',
          currentChapter: seq,
          currentChapterIndex: ch,
          totalChaptersEstimated: totalRequested,
          chapterTitle: expectedTitle,
          phaseLabel: 'Dilewati',
          message: `Halaman ${seq} dari ${totalRequested} (ch/${ch}) dilewati setelah ${attemptResult.attempts} percobaan. Melanjutkan...`,
          percent: pctAfterSkip,
          etaSeconds: computeEta(totalRequested - seq)
        });
      }
    } catch (err) {
      const errMsg = DebuggerManager.formatFriendlyError(err);
      logger.error('ExportOrchestrator: Batch export error:', err);
      if (this.stopRequested) {
        finalStatus = 'STOPPED';
      } else {
        finalStatus = 'ERROR';
        finalErrorMessage = finalErrorMessage || errMsg;
      }
    } finally {
      clearInterval(keepAliveTimer);
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
        emitProgress({
          status: 'STITCHING',
          currentChapter: capturedChapters.length,
          currentChapterIndex: lastChapterIndex ?? startChapter,
          totalChaptersEstimated: totalRequested,
          chapterTitle: label,
          phaseLabel: 'Menggabungkan',
          message: isPartial
            ? `Menyelamatkan PDF parsial (${capturedChapters.length} halaman) & menyusun bookmarks...`
            : `Menggabungkan ${capturedChapters.length} halaman & menyusun bookmarks PDF...`,
          percent: isPartial ? Math.round((capturedChapters.length / totalRequested) * 100) : 99,
          etaSeconds: 0
        });
      } else if (finalStatus === 'COMPLETED') {
        emitProgress({
          status: 'COMPLETED',
          currentChapter: capturedChapters.length,
          currentChapterIndex: lastChapterIndex ?? endChapter,
          totalChaptersEstimated: totalRequested,
          chapterTitle: label,
          phaseLabel: 'Selesai',
          message: `Selesai! ${capturedChapters.length}/${totalRequested} halaman (${totalMb} MB).${
            failedCount > 0 ? ` (${failedCount} halaman dilewati)` : ''
          }`,
          percent: 100,
          etaSeconds: 0
        });
      } else if (finalStatus === 'STOPPED') {
        emitProgress({
          status: 'STOPPED',
          currentChapter: capturedChapters.length,
          currentChapterIndex: lastChapterIndex ?? startChapter,
          totalChaptersEstimated: totalRequested,
          chapterTitle: 'Dihentikan',
          phaseLabel: 'Dihentikan',
          message: `Dihentikan pengguna. ${capturedChapters.length}/${totalRequested} halaman selesai (${totalMb} MB).`,
          percent: Math.round((capturedChapters.length / totalRequested) * 100),
          etaSeconds: null
        });
      } else {
        emitProgress({
          status: 'ERROR',
          currentChapter: capturedChapters.length,
          currentChapterIndex: lastChapterIndex ?? startChapter,
          totalChaptersEstimated: totalRequested,
          chapterTitle: 'Error',
          phaseLabel: 'Error',
          message: `Gagal (${capturedChapters.length}/${totalRequested} selesai): ${finalErrorMessage || 'Terjadi kesalahan'}`,
          percent: Math.round((capturedChapters.length / totalRequested) * 100),
          etaSeconds: null
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
      failedChapters,
      failedCount,
      circuitBreakerTriggered,
      totalBytes,
      lastChapterIndex,
      startedAt,
      errorMessage: finalErrorMessage
    });
  }

  /**
   * Executes the full per-chapter capture pipeline (NAVIGATE -> PREPARE -> PRINT -> ASSEMBLE)
   * with exponential-backoff retry and offline/SSO health checks.
   */
  private async processChapterWithRetry(params: {
    tabId: number;
    ch: number;
    seq: number;
    totalRequested: number;
    expectedTitle: string;
    label: string;
    bookId?: string | null;
    bookTitle: string;
    savePerPageDebug: boolean;
    previousFingerprint?: string;
    config: ExporterConfig;
    signal: AbortSignal;
    etaSeconds: number | null;
    pctBefore: number;
    callbacks: OrchestratorCallbacks;
    emitProgress: (
      partial: Omit<ExportProgress, 'moduleLabel' | 'startChapter' | 'endChapter' | 'startedAt'>
    ) => void;
  }): Promise<{
    success: boolean;
    aborted?: boolean;
    meta?: CapturedChapterMeta;
    fingerprint?: string;
    stage?: FailedChapterMeta['stage'];
    attempts: number;
    error?: string;
    fatalError?: string;
  }> {
    const {
      tabId,
      ch,
      seq,
      totalRequested,
      expectedTitle,
      label,
      bookId,
      bookTitle,
      savePerPageDebug,
      previousFingerprint,
      config,
      signal,
      etaSeconds,
      pctBefore,
      callbacks,
      emitProgress
    } = params;

    const maxRetries = Math.max(0, config.maxRetriesPerChapter);
    const maxAttempts = 1 + maxRetries;
    let lastStage: FailedChapterMeta['stage'] = 'NAVIGATE';
    let lastError = 'Terjadi kesalahan saat memproses halaman.';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal.aborted || !this.debuggerManager.isAttached()) {
        return { success: false, aborted: true, attempts: attempt - 1 };
      }

      const chapterStartMs = Date.now();
      let currentStage: FailedChapterMeta['stage'] = 'NAVIGATE';

      try {
        // 3a. Navigate & wait for page stability
        emitProgress({
          status: attempt > 1 ? 'RETRYING' : 'NAVIGATING',
          currentChapter: seq,
          currentChapterIndex: ch,
          totalChaptersEstimated: totalRequested,
          chapterTitle: expectedTitle,
          phaseLabel: attempt > 1 ? `Retry ${attempt - 1}/${maxRetries}` : 'Navigasi',
          message:
            attempt > 1
              ? `Halaman ${seq} dari ${totalRequested} (${label}): Mengulang muat ch/${ch} (${attempt}/${maxAttempts})...`
              : `Halaman ${seq} dari ${totalRequested} (${label}): Memuat ${expectedTitle}...`,
          percent: pctBefore,
          retryAttempt: attempt > 1 ? attempt - 1 : 0,
          maxRetries,
          etaSeconds
        });

        let navResult: NavigateToChapterResponse;
        try {
          navResult = await this.withTimeout(
            chrome.tabs.sendMessage(tabId, {
              type: 'NAVIGATE_TO_CHAPTER',
              payload: {
                targetChapter: ch,
                bookId,
                previousFingerprint,
                timeoutMs: config.chapterNavigationTimeoutMs,
                quiescenceMs: config.domQuiescenceMs
              }
            }) as Promise<NavigateToChapterResponse>,
            config.chapterNavigationTimeoutMs + 5000,
            `Timeout komunikasi navigasi pada ch/${ch}.`
          );
        } catch (navErr) {
          throw new StageError('NAVIGATE', DebuggerManager.formatFriendlyError(navErr));
        }

        if (signal.aborted || navResult?.aborted) {
          return { success: false, aborted: true, attempts: attempt };
        }

        if (!navResult?.success) {
          throw new StageError('NAVIGATE', navResult?.error || `Navigasi ke ch/${ch} gagal.`);
        }

        const resolvedTitle =
          (navResult.chapterTitle && navResult.chapterTitle !== 'Bab_Aktif'
            ? navResult.chapterTitle
            : expectedTitle) || `Halaman_${ch + 1}`;

        // 3b. Prepare Isolated Print Stage
        currentStage = 'PREPARE';
        if (signal.aborted) {
          return { success: false, aborted: true, attempts: attempt };
        }

        emitProgress({
          status: 'CAPTURING_PAGE',
          currentChapter: seq,
          currentChapterIndex: ch,
          totalChaptersEstimated: totalRequested,
          chapterTitle: resolvedTitle,
          phaseLabel: 'Menyiapkan',
          message: `Halaman ${seq} dari ${totalRequested} (${label}): Menyiapkan halaman cetak...`,
          percent: pctBefore,
          retryAttempt: attempt > 1 ? attempt - 1 : 0,
          maxRetries,
          etaSeconds
        });

        let prepResult: PrepareForPrintResponse;
        try {
          prepResult = await this.withTimeout(
            chrome.tabs.sendMessage(tabId, {
              type: 'PREPARE_FOR_PRINT'
            }) as Promise<PrepareForPrintResponse>,
            config.preparePrintTimeoutMs,
            `Timeout menyiapkan halaman cetak pada ch/${ch}.`
          );
        } catch (prepErr) {
          throw new StageError('PREPARE', DebuggerManager.formatFriendlyError(prepErr));
        }

        if (!prepResult?.success) {
          throw new StageError(
            'PREPARE',
            prepResult?.error || `Gagal menyiapkan panggung cetak pada ch/${ch}.`
          );
        }

        if (signal.aborted) {
          await chrome.tabs.sendMessage(tabId, { type: 'RESTORE_AFTER_PRINT' }).catch(() => {});
          return { success: false, aborted: true, attempts: attempt };
        }

        // 3c. Execute silent CDP Page.printToPDF with timeout
        currentStage = 'PRINT';
        emitProgress({
          status: 'CAPTURING_PAGE',
          currentChapter: seq,
          currentChapterIndex: ch,
          totalChaptersEstimated: totalRequested,
          chapterTitle: resolvedTitle,
          phaseLabel: 'Cetak PDF',
          message: `Halaman ${seq} dari ${totalRequested} (${label}): Mencetak PDF (${resolvedTitle})...`,
          percent: pctBefore,
          retryAttempt: attempt > 1 ? attempt - 1 : 0,
          maxRetries,
          etaSeconds
        });

        let base64 = '';
        let buffer: Uint8Array;
        this.isPrintingNow = true;
        try {
          const printResult = await this.cdpPrinter.printCurrentPage(
            {
              printBackground: config.printBackground,
              generateTaggedPDF: true,
              ...(prepResult.isFixedLayout ? { pageRanges: '1' } : {})
            },
            config.cdpPrintTimeoutMs
          );
          base64 = printResult.base64;
          buffer = printResult.buffer;
        } catch (printErr) {
          throw new StageError('PRINT', DebuggerManager.formatFriendlyError(printErr));
        } finally {
          this.isPrintingNow = false;
          await chrome.tabs.sendMessage(tabId, { type: 'RESTORE_AFTER_PRINT' }).catch(() => {});
        }

        const validPdfHeader = this.hasValidPdfHeader(buffer);
        if (!validPdfHeader) {
          throw new StageError('PRINT', `Hasil cetak ch/${ch} rusak (header %PDF- tidak valid).`);
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

        // 3d. Phase 4 incremental assembly hook (wrapped so corrupt single-page PDF triggers retry)
        currentStage = 'ASSEMBLE';
        if (callbacks.onChapterCaptured) {
          try {
            await callbacks.onChapterCaptured(buffer, meta, base64);
          } catch (asmErr) {
            throw new StageError(
              'ASSEMBLE',
              `Gagal menggabungkan ch/${ch}: ${asmErr instanceof Error ? asmErr.message : String(asmErr)}`
            );
          }
        }

        // 3e. Optional Debug Mode: download individual PDF file per page
        if (savePerPageDebug) {
          const seqStr = String(seq).padStart(3, '0');
          const filename = sanitizeFilename(`${seqStr}_ch${ch}_${bookTitle}_${resolvedTitle}`);
          await callbacks.savePdfFile(tabId, base64, filename);
        }

        logger.info(
          `ExportOrchestrator: Captured [${seq}/${totalRequested}] ch/${ch} "${resolvedTitle}" ` +
            `(${(buffer.byteLength / 1024).toFixed(1)} KB, attempt=${attempt}, ${durationMs}ms)`
        );

        return {
          success: true,
          meta,
          fingerprint: navResult.fingerprint,
          attempts: attempt
        };
      } catch (err) {
        // Ensure clean DOM after any failed attempt
        await chrome.tabs.sendMessage(tabId, { type: 'RESTORE_AFTER_PRINT' }).catch(() => {});

        const stageErr = err instanceof StageError ? err : null;
        lastStage = stageErr?.stage ?? currentStage;
        lastError = err instanceof Error ? err.message : DebuggerManager.formatFriendlyError(err);

        if (signal.aborted || !this.debuggerManager.isAttached()) {
          return { success: false, aborted: true, stage: lastStage, attempts: attempt, error: lastError };
        }

        // Diagnose page health (SSO session expired vs offline vs transient glitch)
        const health = await this.checkPageHealth(tabId);
        if (health?.isLoginPage) {
          return {
            success: false,
            stage: lastStage,
            attempts: attempt,
            fatalError:
              'Sesi login SSO UT telah berakhir. Silakan login ulang di tab Kotobee lalu klik "Lanjutkan" untuk meneruskan ekspor.'
          };
        }

        if (health && !health.online) {
          emitProgress({
            status: 'RETRYING',
            currentChapter: seq,
            currentChapterIndex: ch,
            totalChaptersEstimated: totalRequested,
            chapterTitle: expectedTitle,
            phaseLabel: 'Offline',
            message: `Koneksi internet terputus di ch/${ch}. Menunggu koneksi pulih (maks 15 dtk)...`,
            percent: pctBefore,
            retryAttempt: attempt,
            maxRetries,
            etaSeconds
          });

          const recoveredOnline = await this.waitForOnlineRecovery(tabId, 15000, signal);
          if (signal.aborted) {
            return { success: false, aborted: true, stage: lastStage, attempts: attempt, error: lastError };
          }
          if (!recoveredOnline) {
            lastError = 'Koneksi internet terputus saat memuat halaman Kotobee.';
          }
        }

        if (attempt < maxAttempts && !signal.aborted && this.debuggerManager.isAttached()) {
          const backoffMs = Math.max(200, config.retryBaseDelayMs) * Math.pow(2, attempt - 1);
          const backoffSec = (backoffMs / 1000).toFixed(1);
          logger.warn(
            `ExportOrchestrator: Attempt ${attempt}/${maxAttempts} failed for ch/${ch} [${lastStage}]: ${lastError}. ` +
              `Retrying in ${backoffMs}ms...`
          );

          emitProgress({
            status: 'RETRYING',
            currentChapter: seq,
            currentChapterIndex: ch,
            totalChaptersEstimated: totalRequested,
            chapterTitle: expectedTitle,
            phaseLabel: `Retry ${attempt}/${maxRetries}`,
            message: `Halaman ${seq}/${totalRequested} gagal (${lastStage}). Mengulang dalam ${backoffSec} dtk...`,
            percent: pctBefore,
            retryAttempt: attempt,
            maxRetries,
            etaSeconds
          });

          const completedSleep = await this.sleepAbortable(backoffMs, signal);
          if (!completedSleep) {
            return { success: false, aborted: true, stage: lastStage, attempts: attempt, error: lastError };
          }
        }
      }
    }

    return {
      success: false,
      stage: lastStage,
      attempts: maxAttempts,
      error: lastError
    };
  }

  private async checkPageHealth(tabId: number): Promise<CheckPageHealthResponse | null> {
    try {
      const res = await this.withTimeout(
        chrome.tabs.sendMessage(tabId, { type: 'CHECK_PAGE_HEALTH' }) as Promise<CheckPageHealthResponse>,
        3000,
        'Health check timeout'
      );
      return res ?? null;
    } catch {
      return null;
    }
  }

  private async waitForOnlineRecovery(
    tabId: number,
    maxWaitMs: number,
    signal: AbortSignal
  ): Promise<boolean> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const ok = await this.sleepAbortable(1500, signal);
      if (!ok) return false;
      const health = await this.checkPageHealth(tabId);
      if (health?.online) {
        return true;
      }
    }
    return false;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(100, timeoutMs));
      })
    ]).finally(() => {
      if (timer !== null) clearTimeout(timer);
    });
  }

  private sleepAbortable(ms: number, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (signal.aborted) {
        resolve(false);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
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
    failedChapters: FailedChapterMeta[];
    failedCount: number;
    circuitBreakerTriggered: boolean;
    totalBytes: number;
    lastChapterIndex: number | null;
    startedAt: number;
    errorMessage?: string;
  }): BatchExportSummary {
    let resumeFromChapter: number | null = null;
    if (params.status !== 'COMPLETED') {
      if (params.lastChapterIndex === null) {
        resumeFromChapter = params.startChapter;
      } else if (params.lastChapterIndex < params.endChapter) {
        resumeFromChapter = params.lastChapterIndex + 1;
      }
    }

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
      failedChapters: params.failedChapters,
      circuitBreakerTriggered: params.circuitBreakerTriggered,
      resumeFromChapter,
      elapsedMs: Date.now() - params.startedAt,
      errorMessage: params.errorMessage
    };
  }
}
