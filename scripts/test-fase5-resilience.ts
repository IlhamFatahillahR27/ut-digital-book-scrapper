import assert from 'node:assert/strict';
import {
  FirefoxPdfPrinter,
  FirefoxSavePdfTimeoutError
} from '../src/background/firefox-pdf-printer';
import { TabSessionManager } from '../src/background/tab-session-manager';
import { ExportOrchestrator } from '../src/background/export-orchestrator';
import type { ExportProgress } from '../src/types/exporter';

interface MockBrowserController {
  onTabMessage: (tabId: number, msg: { type: string; payload?: Record<string, unknown> }) => Promise<unknown>;
  onSaveAsPdf?: (settings: Record<string, unknown>) => Promise<string>;
  sentMessages: Array<{ tabId: number; type: string; payload?: Record<string, unknown> }>;
  saveAsPdfCalls: number;
}

function installMockBrowser(
  handler: MockBrowserController['onTabMessage'],
  options?: {
    onSaveAsPdf?: MockBrowserController['onSaveAsPdf'];
  }
): MockBrowserController {
  const controller: MockBrowserController = {
    onTabMessage: handler,
    onSaveAsPdf: options?.onSaveAsPdf,
    sentMessages: [],
    saveAsPdfCalls: 0
  };

  const mockBrowser = {
    runtime: {
      getPlatformInfo: async () => ({ os: 'win' })
    },
    tabs: {
      get: async (tabId: number) => ({
        id: tabId,
        url: 'https://univterbuka.kotobee.com/#/book/57062/reader/chapter/1'
      }),
      sendMessage: async (tabId: number, msg: { type: string; payload?: Record<string, unknown> }) => {
        controller.sentMessages.push({ tabId, type: msg.type, payload: msg.payload });
        return controller.onTabMessage(tabId, msg);
      },
      saveAsPDF: async (settings: Record<string, unknown>) => {
        controller.saveAsPdfCalls++;
        if (controller.onSaveAsPdf) {
          return controller.onSaveAsPdf(settings);
        }
        return 'saved';
      },
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {} }
    }
  };

  (globalThis as unknown as { browser: unknown; chrome: unknown }).browser = mockBrowser;
  (globalThis as unknown as { browser: unknown; chrome: unknown }).chrome = mockBrowser;

  return controller;
}

async function testScenario1TransientRetryRecovery(): Promise<void> {
  let ch2NavCalls = 0;
  let ch2SnapCalls = 0;
  let currentCh = 0;
  let snapshotCount = 0;

  installMockBrowser(async (_tabId, msg) => {
    if (msg.type === 'ENSURE_SINGLE_PAGE_MODE') return { success: true, wasSpreadMode: false, changed: false };
    if (msg.type === 'CHECK_PAGE_HEALTH')
      return { online: true, isLoginPage: false, isKotobeeReader: true, currentHash: '' };
    if (msg.type === 'CLEAR_VECTOR_SNAPSHOTS' || msg.type === 'ABORT_NAVIGATION') return { success: true };
    if (msg.type === 'NAVIGATE_TO_CHAPTER') {
      currentCh = Number(msg.payload?.targetChapter ?? 0);
      if (currentCh === 2) {
        ch2NavCalls++;
        if (ch2NavCalls === 1) {
          return { success: false, actualChapter: null, chapterTitle: '', fingerprint: '', error: 'Slow network' };
        }
      }
      return { success: true, actualChapter: currentCh, chapterTitle: `Bab ${currentCh}`, fingerprint: `fp-${currentCh}` };
    }
    if (msg.type === 'CAPTURE_VECTOR_SNAPSHOT') {
      if (currentCh === 2) {
        ch2SnapCalls++;
        if (ch2SnapCalls === 1) {
          return { success: false, chapterTitle: '', isFixedLayout: true, estimatedBytes: 0, snapshotCount, error: 'Transient DOM glitch' };
        }
      }
      snapshotCount++;
      return { success: true, chapterTitle: `Bab ${currentCh}`, isFixedLayout: true, estimatedBytes: 50000, snapshotCount };
    }
    return { success: true };
  });

  const sessionMgr = new TabSessionManager();
  const printer = new FirefoxPdfPrinter();
  const orchestrator = new ExportOrchestrator(sessionMgr, printer);
  const progressEvents: ExportProgress[] = [];

  const summary = await orchestrator.runBatchExport(
    101,
    { startChapter: 1, endChapter: 3, label: 'Modul 1', bookTitle: 'MSIM4303', exportMode: 'native-vector' },
    { maxRetriesPerChapter: 2, retryBaseDelayMs: 25 },
    { onProgress: (p) => progressEvents.push(p) }
  );

  assert.equal(summary.status, 'COMPLETED');
  assert.equal(summary.capturedCount, 3);
  assert.equal(summary.failedCount, 0);
  assert.equal(sessionMgr.isActive(), false);
  assert.ok(progressEvents.some((p) => p.status === 'RETRYING'), 'Expected RETRYING status event');
  console.log('✅ Scenario 1 (Transient Retry Recovery) PASSED');
}

async function testScenario2SingleChapterSkip(): Promise<void> {
  let currentCh = 0;
  let snapshotCount = 0;

  installMockBrowser(async (_tabId, msg) => {
    if (msg.type === 'ENSURE_SINGLE_PAGE_MODE') return { success: true, wasSpreadMode: false, changed: false };
    if (msg.type === 'CHECK_PAGE_HEALTH')
      return { online: true, isLoginPage: false, isKotobeeReader: true, currentHash: '' };
    if (msg.type === 'CLEAR_VECTOR_SNAPSHOTS' || msg.type === 'ABORT_NAVIGATION') return { success: true };
    if (msg.type === 'NAVIGATE_TO_CHAPTER') {
      currentCh = Number(msg.payload?.targetChapter ?? 0);
      return { success: true, actualChapter: currentCh, chapterTitle: `Bab ${currentCh}`, fingerprint: `fp-${currentCh}` };
    }
    if (msg.type === 'CAPTURE_VECTOR_SNAPSHOT') {
      if (currentCh === 2) {
        return { success: false, chapterTitle: 'Bab 2', isFixedLayout: true, estimatedBytes: 0, snapshotCount, error: 'Corrupt iframe container' };
      }
      snapshotCount++;
      return { success: true, chapterTitle: `Bab ${currentCh}`, isFixedLayout: true, estimatedBytes: 50000, snapshotCount };
    }
    return { success: true };
  });

  const sessionMgr = new TabSessionManager();
  const printer = new FirefoxPdfPrinter();
  const orchestrator = new ExportOrchestrator(sessionMgr, printer);

  const summary = await orchestrator.runBatchExport(
    102,
    { startChapter: 1, endChapter: 4, label: 'Modul 2', bookTitle: 'MSIM4303', exportMode: 'native-vector' },
    { maxRetriesPerChapter: 1, retryBaseDelayMs: 20, maxConsecutiveFailures: 3, skipFailedChapters: true },
    { onProgress: () => {} }
  );

  assert.equal(summary.status, 'COMPLETED');
  assert.equal(summary.capturedCount, 3);
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.circuitBreakerTriggered, false);
  assert.equal(summary.resumeFromChapter, null);
  assert.equal(summary.failedChapters?.[0].chapterIndex, 2);
  assert.equal(summary.failedChapters?.[0].stage, 'PREPARE');
  assert.equal(sessionMgr.isActive(), false);
  console.log('✅ Scenario 2 (Single Chapter Skip & Continue) PASSED');
}

async function testScenario3CircuitBreaker(): Promise<void> {
  const attemptedChapters = new Set<number>();
  let snapshotCount = 0;

  installMockBrowser(async (_tabId, msg) => {
    if (msg.type === 'ENSURE_SINGLE_PAGE_MODE') return { success: true, wasSpreadMode: false, changed: false };
    if (msg.type === 'CHECK_PAGE_HEALTH')
      return { online: true, isLoginPage: false, isKotobeeReader: true, currentHash: '' };
    if (msg.type === 'CLEAR_VECTOR_SNAPSHOTS' || msg.type === 'ABORT_NAVIGATION') return { success: true };
    if (msg.type === 'NAVIGATE_TO_CHAPTER') {
      const ch = Number(msg.payload?.targetChapter ?? 0);
      attemptedChapters.add(ch);
      if (ch >= 3) {
        return { success: false, actualChapter: null, chapterTitle: '', fingerprint: '', error: `Timeout ch/${ch}` };
      }
      return { success: true, actualChapter: ch, chapterTitle: `Bab ${ch}`, fingerprint: `fp-${ch}` };
    }
    if (msg.type === 'CAPTURE_VECTOR_SNAPSHOT') {
      snapshotCount++;
      return { success: true, chapterTitle: 'OK', isFixedLayout: true, estimatedBytes: 50000, snapshotCount };
    }
    return { success: true };
  });

  const sessionMgr = new TabSessionManager();
  const printer = new FirefoxPdfPrinter();
  const orchestrator = new ExportOrchestrator(sessionMgr, printer);

  const summary = await orchestrator.runBatchExport(
    103,
    { startChapter: 1, endChapter: 6, label: 'Modul 3', bookTitle: 'MSIM4303', exportMode: 'native-vector' },
    { maxRetriesPerChapter: 1, retryBaseDelayMs: 20, maxConsecutiveFailures: 3, skipFailedChapters: true },
    { onProgress: () => {} }
  );

  assert.equal(summary.status, 'ERROR');
  assert.equal(summary.circuitBreakerTriggered, true);
  assert.equal(summary.capturedCount, 2);
  assert.equal(summary.failedCount, 3);
  assert.equal(summary.resumeFromChapter, 3);
  assert.equal(attemptedChapters.has(6), false);
  assert.equal(sessionMgr.isActive(), false);
  console.log('✅ Scenario 3 (Circuit Breaker 3x Consecutive Failures) PASSED');
}

async function testScenario4SaveAsPdfAndMacFallback(): Promise<void> {
  const ctrl1 = installMockBrowser(async () => ({ success: true }), {
    onSaveAsPdf: async () => 'saved'
  });
  const printer = new FirefoxPdfPrinter();
  const status1 = await printer.saveConsolidatedVectorPdf(104, 'MSIM4303_Modul_1.pdf');
  assert.equal(status1, 'saved');
  assert.equal(ctrl1.saveAsPdfCalls, 1);

  // macOS unsupported fallback -> TRIGGER_WINDOW_PRINT
  const ctrl2 = installMockBrowser(async () => ({ success: true }), {
    onSaveAsPdf: async () => {
      throw new Error('Not supported on macOS');
    }
  });
  const status2 = await printer.saveConsolidatedVectorPdf(104, 'MSIM4303_Modul_1.pdf');
  assert.equal(status2, 'fallback-print');
  assert.ok(ctrl2.sentMessages.some((m) => m.type === 'TRIGGER_WINDOW_PRINT'));

  // Timeout guard verification
  installMockBrowser(async () => ({ success: true }), {
    onSaveAsPdf: async () => {
      await new Promise((r) => setTimeout(r, 7000));
      return 'saved';
    }
  });
  await assert.rejects(
    () => printer.saveConsolidatedVectorPdf(104, 'Slow.pdf', 5000),
    (err: unknown) => err instanceof FirefoxSavePdfTimeoutError
  );
  console.log('✅ Scenario 4 (saveAsPDF, macOS window.print Fallback & Timeout Guard) PASSED');
}

async function testScenario5SsoSessionExpired(): Promise<void> {
  let navCh2Calls = 0;
  let snapshotCount = 0;

  installMockBrowser(async (_tabId, msg) => {
    if (msg.type === 'ENSURE_SINGLE_PAGE_MODE') return { success: true, wasSpreadMode: false, changed: false };
    if (msg.type === 'CLEAR_VECTOR_SNAPSHOTS' || msg.type === 'ABORT_NAVIGATION') return { success: true };
    if (msg.type === 'CHECK_PAGE_HEALTH') {
      return { online: true, isLoginPage: true, isKotobeeReader: false, currentHash: '' };
    }
    if (msg.type === 'NAVIGATE_TO_CHAPTER') {
      const ch = Number(msg.payload?.targetChapter ?? 0);
      if (ch === 2) {
        navCh2Calls++;
        return { success: false, actualChapter: null, chapterTitle: '', fingerprint: '', error: 'Redirected to login' };
      }
      return { success: true, actualChapter: ch, chapterTitle: `Bab ${ch}`, fingerprint: `fp-${ch}` };
    }
    if (msg.type === 'CAPTURE_VECTOR_SNAPSHOT') {
      snapshotCount++;
      return { success: true, chapterTitle: 'Bab 1', isFixedLayout: true, estimatedBytes: 50000, snapshotCount };
    }
    return { success: true };
  });

  const sessionMgr = new TabSessionManager();
  const printer = new FirefoxPdfPrinter();
  const orchestrator = new ExportOrchestrator(sessionMgr, printer);

  const summary = await orchestrator.runBatchExport(
    105,
    { startChapter: 1, endChapter: 4, label: 'Modul SSO', bookTitle: 'MSIM4303', exportMode: 'native-vector' },
    { maxRetriesPerChapter: 3, retryBaseDelayMs: 20 },
    { onProgress: () => {} }
  );

  assert.equal(summary.status, 'ERROR');
  assert.equal(summary.capturedCount, 1);
  assert.equal(navCh2Calls, 1);
  assert.equal(summary.resumeFromChapter, 2);
  assert.ok(summary.errorMessage?.includes('SSO'));
  assert.equal(sessionMgr.isActive(), false);
  console.log('✅ Scenario 5 (SSO Session Expired Fatal Detection) PASSED');
}

function testScenario6FriendlyErrorFormatter(): void {
  assert.ok(
    TabSessionManager.formatFriendlyError(new Error('Missing host permission for the tab')).includes('univterbuka.kotobee.com')
  );
  assert.ok(TabSessionManager.formatFriendlyError('tab_closed').includes('ditutup'));
  assert.ok(TabSessionManager.formatFriendlyError('navigated_away').includes('situs lain'));
  assert.ok(TabSessionManager.formatFriendlyError('Frame was detached').includes('Frame'));
  console.log('✅ Scenario 6 (Firefox Friendly Error Formatter) PASSED');
}

async function main(): Promise<void> {
  console.log('🧪 Running Firefox Native Vector & Resilience Test Suite...\n');
  await testScenario1TransientRetryRecovery();
  await testScenario2SingleChapterSkip();
  await testScenario3CircuitBreaker();
  await testScenario4SaveAsPdfAndMacFallback();
  await testScenario5SsoSessionExpired();
  testScenario6FriendlyErrorFormatter();
  console.log('\n🎉 All 6 Firefox Native Vector & resilience scenarios PASSED!');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
