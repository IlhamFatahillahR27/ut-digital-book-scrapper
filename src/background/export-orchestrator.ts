import { TabSessionManager } from './tab-session-manager';
import { FirefoxPdfPrinter } from './firefox-pdf-printer';
import { getBrowserApi } from '../utils/browser-api';
import { logger } from '../utils/logger';
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
  CaptureVectorSnapshotResponse,
  CheckPageHealthResponse,
  EnsureSinglePageModeResponse,
  NavigateToChapterResponse
} from '../types/messages';

export interface OrchestratorCallbacks {
  onProgress: (progress: ExportProgress) => void;
  /**
   * When true and >= 1 chapter is captured, keeps progress in 'STITCHING' instead of
   * emitting terminal COMPLETED/STOPPED/ERROR so caller can mount the consolidated
   * vector print stage & run browser.tabs.saveAsPDF() before unlocking the UI.
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
  private sessionManager: TabSessionManager;
  private pdfPrinter: FirefoxPdfPrinter;

  private activeTabId: number | null = null;
  private activeAbortController: AbortController | null = null;
  private running = false;
  private isCapturingNow = false;
  private stopRequested = false;

  constructor(sessionManager: TabSessionManager, pdfPrinter: FirefoxPdfPrinter) {
    this.sessionManager = sessionManager;
    this.pdfPrinter = pdfPrinter;
  }

  getPdfPrinter(): FirefoxPdfPrinter {
    return this.pdfPrinter;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Triggers Graceful Stop on an active export batch.
   * Immediately aborts any ongoing navigation/wait and rescues already-captured snapshots.
   */
  async stop(reason = 'User manual stop', onProgress?: (progress: ExportProgress) => void): Promise<void> {
    if (!this.running) {
      this.sessionManager.endSession();
      return;
    }

    logger.info(`ExportOrchestrator: Graceful stop requested (${reason}).`);
    this.stopRequested = true;

    if (this.activeAbortController && !this.activeAbortController.signal.aborted) {
      this.activeAbortController.abort();
    }

    if (onProgress) {
      onProgress({
        status: this.isCapturingNow ? 'CAPTURING_PAGE' : 'WAITING_NEXT',
        currentChapter: 0,
        chapterTitle: 'Menghentikan...',
        phaseLabel: 'Menghentikan',
        message: this.isCapturingNow
          ? 'Menghentikan setelah halaman aktif selesai direkam...'
          : 'Menghentikan navigasi & menyelamatkan halaman terkumpul...'
      });
    }

    if (this.activeTabId !== null) {
      try {
        await getBrowserApi().tabs.sendMessage(this.activeTabId, { type: 'ABORT_NAVIGATION' });
      } catch {
        // Tab may already be closing or busy
      }
    }
  }

  /**
   * Executes a multi-chapter sequential vector snapshot collection over [startChapter .. endChapter]
   * with exponential-backoff retry, offline/SSO health checks, single-chapter skip,
   * and a 3-consecutive-failure circuit breaker.
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
    const label = range.label || `Ch ${startChapter}-${endChapter}`;
    const startedAt = Date.now();
    const api = getBrowserApi();

    this.running = true;
    this.stopRequested = false;
    this.isCapturingNow = false;
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

    const keepAliveTimer = setInterval(() => {
      try {
        if (api.runtime?.getPlatformInfo) {
          void api.runtime.getPlatformInfo();
        }
      } catch {
        // Ignore heartbeat error
      }
    }, 20000);

    const computeEta = (remainingPages: number): number | null => {
      if (remainingPages <= 0) return 0;
      if (recentDurationsMs.length === 0) return null;
      const avgMs = recentDurationsMs.reduce((a, b) => a + b, 0) / recentDurationsMs.length;
      return Math.max(1, Math.round((avgMs * remainingPages) / 1000));
    };

    const emitProgress = (
      partial: Omit<ExportProgress, 'moduleLabel' | 'startChapter' | 'endChapter' | 'startedAt'>
    ) => {
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

    const unsubscribeEnd = this.sessionManager.onUnexpectedEnd((endedTabId, reason) => {
      if (endedTabId === tabId && this.running && !this.stopRequested) {
        logger.warn(`ExportOrchestrator: Unexpected tab session end (${reason}). Aborting batch.`);
        finalErrorMessage = TabSessionManager.formatFriendlyError(reason);
        this.activeAbortController?.abort();
      }
    });

    try {
      emitProgress({
        status: 'INITIALIZING',
        currentChapter: 0,
        currentChapterIndex: startChapter,
        totalChaptersEstimated: totalRequested,
        chapterTitle: label,
        phaseLabel: 'Inisialisasi',
        message: `Menyiapkan sesi Vektor Native untuk ${label} (${totalRequested} halaman)...`,
        percent: 0,
        etaSeconds: null
      });

      await this.sessionManager.startSession(tabId);
      await api.tabs.sendMessage(tabId, { type: 'CLEAR_VECTOR_SNAPSHOTS' }).catch(() => {});

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

      // Ensure Kotobee is in Single-Page mode
      try {
        const viewRes = (await api.tabs.sendMessage(tabId, {
          type: 'ENSURE_SINGLE_PAGE_MODE'
        })) as EnsureSinglePageModeResponse;
        if (viewRes?.changed) {
          changedPageViewMode = true;
          logger.info('ExportOrchestrator: Temporarily switched Kotobee to Single-Page mode.');
        }
      } catch (viewErr) {
        logger.warn('ExportOrchestrator: ENSURE_SINGLE_PAGE_MODE failed, continuing:', viewErr);
      }

      // Iterate chapter by chapter across [startChapter .. endChapter]
      for (let ch = startChapter; ch <= endChapter; ch++) {
        const seq = ch - startChapter + 1;
        const remainingBefore = totalRequested - (seq - 1);
        const pctBefore = Math.round(((seq - 1) / totalRequested) * 100);
        const expectedTitle = range.chapterTitles?.[ch] || `Halaman ${ch + 1}`;

        if (signal.aborted || !this.sessionManager.isActive()) {
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
          previousFingerprint,
          config,
          signal,
          etaSeconds: computeEta(remainingBefore),
          pctBefore,
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
            phaseLabel: seq < totalRequested ? 'Berikutnya' : 'Simpan Vektor',
            message:
              seq < totalRequested
                ? `Halaman ${seq} dari ${totalRequested} (${label}) terkumpul.`
                : `Semua halaman terkumpul (${capturedChapters.length}/${totalRequested}). Membuka dialog Save As PDF...`,
            percent: pctAfter,
            etaSeconds: computeEta(remainingAfter)
          });

          if (signal.aborted) {
            finalStatus = this.stopRequested ? 'STOPPED' : 'ERROR';
            break;
          }
          continue;
        }

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
      const errMsg = TabSessionManager.formatFriendlyError(err);
      logger.error('ExportOrchestrator: Batch export error:', err);
      if (this.stopRequested) {
        finalStatus = 'STOPPED';
      } else {
        finalStatus = 'ERROR';
        finalErrorMessage = finalErrorMessage || errMsg;
      }
    } finally {
      clearInterval(keepAliveTimer);
      unsubscribeEnd();

      await api.tabs.sendMessage(tabId, { type: 'ABORT_NAVIGATION' }).catch(() => {});

      if (changedPageViewMode) {
        await api.tabs.sendMessage(tabId, { type: 'RESTORE_PAGE_VIEW_MODE' }).catch(() => {});
      }

      this.sessionManager.endSession();

      this.running = false;
      this.isCapturingNow = false;
      this.activeAbortController = null;
      this.activeTabId = null;

      if (callbacks.deferTerminalStatus && capturedChapters.length > 0) {
        const isPartial = finalStatus !== 'COMPLETED';
        emitProgress({
          status: 'STITCHING',
          currentChapter: capturedChapters.length,
          currentChapterIndex: lastChapterIndex ?? startChapter,
          totalChaptersEstimated: totalRequested,
          chapterTitle: label,
          phaseLabel: 'Simpan Vektor',
          message: isPartial
            ? `Menyiapkan PDF vektor parsial (${capturedChapters.length} halaman) untuk dialog Save As...`
            : `Menyiapkan dokumen vektor (${capturedChapters.length} halaman) untuk dialog Save As...`,
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
          message: `Selesai! ${capturedChapters.length}/${totalRequested} halaman terkumpul.${
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
          message: `Dihentikan pengguna. ${capturedChapters.length}/${totalRequested} halaman terkumpul.`,
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

  private async processChapterWithRetry(params: {
    tabId: number;
    ch: number;
    seq: number;
    totalRequested: number;
    expectedTitle: string;
    label: string;
    bookId?: string | null;
    previousFingerprint?: string;
    config: ExporterConfig;
    signal: AbortSignal;
    etaSeconds: number | null;
    pctBefore: number;
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
      previousFingerprint,
      config,
      signal,
      etaSeconds,
      pctBefore,
      emitProgress
    } = params;

    const api = getBrowserApi();
    const maxRetries = Math.max(0, config.maxRetriesPerChapter);
    const maxAttempts = 1 + maxRetries;
    let lastStage: FailedChapterMeta['stage'] = 'NAVIGATE';
    let lastError = 'Terjadi kesalahan saat memproses halaman.';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal.aborted || !this.sessionManager.isActive()) {
        return { success: false, aborted: true, attempts: attempt - 1 };
      }

      const chapterStartMs = Date.now();
      let currentStage: FailedChapterMeta['stage'] = 'NAVIGATE';

      try {
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
            api.tabs.sendMessage(tabId, {
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
          throw new StageError('NAVIGATE', TabSessionManager.formatFriendlyError(navErr));
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
          phaseLabel: 'Snapshot DOM',
          message: `Halaman ${seq} dari ${totalRequested} (${label}): Merekam halaman vektor (${resolvedTitle})...`,
          percent: pctBefore,
          retryAttempt: attempt > 1 ? attempt - 1 : 0,
          maxRetries,
          etaSeconds
        });

        let snapRes: CaptureVectorSnapshotResponse;
        this.isCapturingNow = true;
        try {
          snapRes = await this.withTimeout(
            api.tabs.sendMessage(tabId, {
              type: 'CAPTURE_VECTOR_SNAPSHOT',
              payload: {
                sequenceNumber: seq,
                chapterIndex: ch
              }
            }) as Promise<CaptureVectorSnapshotResponse>,
            config.preparePrintTimeoutMs,
            `Timeout merekam snapshot vektor pada ch/${ch}.`
          );
        } catch (snapErr) {
          throw new StageError('PREPARE', TabSessionManager.formatFriendlyError(snapErr));
        } finally {
          this.isCapturingNow = false;
        }

        if (!snapRes?.success) {
          throw new StageError(
            'PREPARE',
            snapRes?.error || `Gagal merekam snapshot vektor pada ch/${ch}.`
          );
        }

        const durationMs = Date.now() - chapterStartMs;
        const meta: CapturedChapterMeta = {
          chapterIndex: ch,
          sequenceNumber: seq,
          title: resolvedTitle,
          byteLength: snapRes.estimatedBytes || 0,
          isFixedLayout: !!snapRes.isFixedLayout,
          durationMs,
          validPdfHeader: true
        };

        logger.info(
          `ExportOrchestrator: Recorded vector snapshot [${seq}/${totalRequested}] ch/${ch} "${resolvedTitle}" ` +
            `(attempt=${attempt}, ${durationMs}ms)`
        );

        return {
          success: true,
          meta,
          fingerprint: navResult.fingerprint,
          attempts: attempt
        };
      } catch (err) {
        const stageErr = err instanceof StageError ? err : null;
        lastStage = stageErr?.stage ?? currentStage;
        lastError = err instanceof Error ? err.message : TabSessionManager.formatFriendlyError(err);

        if (stageErr?.fatal) {
          return {
            success: false,
            stage: lastStage,
            attempts: attempt,
            fatalError: lastError
          };
        }

        if (signal.aborted || !this.sessionManager.isActive()) {
          return { success: false, aborted: true, stage: lastStage, attempts: attempt, error: lastError };
        }

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

        if (attempt < maxAttempts && !signal.aborted && this.sessionManager.isActive()) {
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
        getBrowserApi().tabs.sendMessage(tabId, { type: 'CHECK_PAGE_HEALTH' }) as Promise<CheckPageHealthResponse>,
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
      exportMode: 'native-vector',
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
