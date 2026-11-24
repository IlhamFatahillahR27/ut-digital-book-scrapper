import assert from 'node:assert/strict';
import { CdpPrinter, CdpPrintTimeoutError } from '../src/background/cdp-printer';
import { DebuggerManager } from '../src/background/debugger-manager';
import { ExportOrchestrator } from '../src/background/export-orchestrator';
import type { ExportProgress } from '../src/types/exporter';

// Minimal valid PDF byte payload (>100 bytes with %PDF- magic header)
function makeFakePdfBase64(tag: string): string {
  const content =
    `%PDF-1.7\n% Fake test PDF for ${tag}\n` +
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
    '2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n' +
    '%%EOF\n'.padEnd(160, ' ');
  return Buffer.from(content, 'utf8').toString('base64');
}

interface MockChromeController {
  onTabMessage: (tabId: number, msg: { type: string; payload?: Record<string, unknown> }) => Promise<unknown>;
  sentMessages: Array<{ tabId: number; type: string; payload?: Record<string, unknown> }>;
}

function installMockChrome(handler: MockChromeController['onTabMessage']): MockChromeController {
  const controller: MockChromeController = {
    onTabMessage: handler,
    sentMessages: []
  };

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      getPlatformInfo: (cb: (info: unknown) => void) => cb({ os: 'win' })
    },
    tabs: {
      sendMessage: async (tabId: number, msg: { type: string; payload?: Record<string, unknown> }) => {
        controller.sentMessages.push({ tabId, type: msg.type, payload: msg.payload });
        return controller.onTabMessage(tabId, msg);
      }
    }
  };

  return controller;
}

class MockDebuggerManager {
  attachedTabId: number | null = null;
  detachCount = 0;
  sendCommandHandler: (method: string, params?: object) => Promise<unknown>;

  constructor(sendCommandHandler?: (method: string, params?: object) => Promise<unknown>) {
    this.sendCommandHandler =
      sendCommandHandler ??
      (async (method: string) => {
        if (method === 'Page.printToPDF') {
          return { data: makeFakePdfBase64('default') };
        }
        return {};
      });
  }

  onUnexpectedDetach(_listener: (tabId: number, reason: string) => void): () => void {
    return () => {};
  }

  async attach(tabId: number): Promise<void> {
    this.attachedTabId = tabId;
  }

  async detach(): Promise<void> {
    if (this.attachedTabId !== null) {
      this.detachCount++;
      this.attachedTabId = null;
    }
  }

  isAttached(): boolean {
    return this.attachedTabId !== null;
  }

  async sendCommand<T = unknown>(method: string, params?: object): Promise<T> {
    return (await this.sendCommandHandler(method, params)) as T;
  }
}

async function testScenario1TransientRetryRecovery(): Promise<void> {
  let ch2NavCalls = 0;
  let ch2PrintCalls = 0;
  let currentCh = 0;

  installMockChrome(async (_tabId, msg) => {
    if (msg.type === 'ENSURE_SINGLE_PAGE_MODE') return { success: true, wasSpreadMode: false, changed: false };
    if (msg.type === 'CHECK_PAGE_HEALTH') return { online: true, isLoginPage: false, isKotobeeReader: true, currentHash: '' };
    if (msg.type === 'RESTORE_AFTER_PRINT' || msg.type === 'ABORT_NAVIGATION') return { success: true };
    if (msg.type === 'NAVIGATE_TO_CHAPTER') {
      currentCh = Number(msg.payload?.targetChapter ?? 0);
      if (currentCh === 2) {
        ch2NavCalls++;
        if (ch2NavCalls === 1) {
          return { success: false, actualChapter: null, chapterTitle: '', fingerprint: '', error: 'Slow network timeout' };
        }
      }
      return { success: true, actualChapter: currentCh, chapterTitle: `Bab ${currentCh}`, fingerprint: `fp-${currentCh}` };
    }
    if (msg.type === 'PREPARE_FOR_PRINT') {
      return { success: true, chapterTitle: `Bab ${currentCh}`, isFixedLayout: true };
    }
    return { success: true };
  });

  const dbg = new MockDebuggerManager(async (method) => {
    if (method === 'Page.printToPDF') {
      if (currentCh === 2) {
        ch2PrintCalls++;
        if (ch2PrintCalls === 1) {
          throw new Error('Frame was detached transiently');
        }
      }
      return { data: makeFakePdfBase64(`ch-${currentCh}`) };
    }
    return {};
  });

  const printer = new CdpPrinter(dbg as unknown as DebuggerManager);
  const orchestrator = new ExportOrchestrator(dbg as unknown as DebuggerManager, printer);
  const progressEvents: ExportProgress[] = [];

  const summary = await orchestrator.runBatchExport(
    101,
    { startChapter: 1, endChapter: 3, label: 'Modul 1', bookTitle: 'MSIM4303' },
    { maxRetriesPerChapter: 2, retryBaseDelayMs: 30, cdpPrintTimeoutMs: 2000 },
    {
      onProgress: (p) => progressEvents.push(p),
      savePdfFile: async () => {}
    }
  );

  assert.equal(summary.status, 'COMPLETED');
  assert.equal(summary.capturedCount, 3);
  assert.equal(summary.failedCount, 0);
  assert.equal(dbg.isAttached(), false);
  assert.ok(dbg.detachCount >= 1);
  assert.ok(progressEvents.some((p) => p.status === 'RETRYING'), 'Expected RETRYING status event');
  console.log('✅ Scenario 1 (Transient Retry Recovery) PASSED');
}

async function testScenario2SingleChapterSkip(): Promise<void> {
  let currentCh = 0;

  installMockChrome(async (_tabId, msg) => {
    if (msg.type === 'ENSURE_SINGLE_PAGE_MODE') return { success: true, wasSpreadMode: false, changed: false };
    if (msg.type === 'CHECK_PAGE_HEALTH') return { online: true, isLoginPage: false, isKotobeeReader: true, currentHash: '' };
    if (msg.type === 'RESTORE_AFTER_PRINT' || msg.type === 'ABORT_NAVIGATION') return { success: true };
    if (msg.type === 'NAVIGATE_TO_CHAPTER') {
      currentCh = Number(msg.payload?.targetChapter ?? 0);
      return { success: true, actualChapter: currentCh, chapterTitle: `Bab ${currentCh}`, fingerprint: `fp-${currentCh}` };
    }
    if (msg.type === 'PREPARE_FOR_PRINT') {
      if (currentCh === 2) {
        return { success: false, chapterTitle: 'Bab 2', error: 'Corrupt iframe container' };
      }
      return { success: true, chapterTitle: `Bab ${currentCh}`, isFixedLayout: true };
    }
    return { success: true };
  });

  const dbg = new MockDebuggerManager();
  const printer = new CdpPrinter(dbg as unknown as DebuggerManager);
  const orchestrator = new ExportOrchestrator(dbg as unknown as DebuggerManager, printer);

  const summary = await orchestrator.runBatchExport(
    102,
    { startChapter: 1, endChapter: 4, label: 'Modul 2', bookTitle: 'MSIM4303' },
    { maxRetriesPerChapter: 1, retryBaseDelayMs: 25, maxConsecutiveFailures: 3, skipFailedChapters: true },
    {
      onProgress: () => {},
      savePdfFile: async () => {}
    }
  );

  assert.equal(summary.status, 'COMPLETED');
  assert.equal(summary.capturedCount, 3);
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.circuitBreakerTriggered, false);
  assert.equal(summary.resumeFromChapter, null);
  assert.equal(summary.failedChapters?.length, 1);
  assert.equal(summary.failedChapters?.[0].chapterIndex, 2);
  assert.equal(summary.failedChapters?.[0].stage, 'PREPARE');
  assert.equal(dbg.isAttached(), false);
  console.log('✅ Scenario 2 (Single Chapter Skip & Continue) PASSED');
}

async function testScenario3CircuitBreaker(): Promise<void> {
  const attemptedChapters = new Set<number>();

  installMockChrome(async (_tabId, msg) => {
    if (msg.type === 'ENSURE_SINGLE_PAGE_MODE') return { success: true, wasSpreadMode: false, changed: false };
    if (msg.type === 'CHECK_PAGE_HEALTH') return { online: true, isLoginPage: false, isKotobeeReader: true, currentHash: '' };
    if (msg.type === 'RESTORE_AFTER_PRINT' || msg.type === 'ABORT_NAVIGATION') return { success: true };
    if (msg.type === 'NAVIGATE_TO_CHAPTER') {
      const ch = Number(msg.payload?.targetChapter ?? 0);
      attemptedChapters.add(ch);
      if (ch >= 3) {
        return { success: false, actualChapter: null, chapterTitle: '', fingerprint: '', error: `Timeout ch/${ch}` };
      }
      return { success: true, actualChapter: ch, chapterTitle: `Bab ${ch}`, fingerprint: `fp-${ch}` };
    }
    if (msg.type === 'PREPARE_FOR_PRINT') {
      return { success: true, chapterTitle: 'OK', isFixedLayout: true };
    }
    return { success: true };
  });

  const dbg = new MockDebuggerManager();
  const printer = new CdpPrinter(dbg as unknown as DebuggerManager);
  const orchestrator = new ExportOrchestrator(dbg as unknown as DebuggerManager, printer);

  const summary = await orchestrator.runBatchExport(
    103,
    { startChapter: 1, endChapter: 6, label: 'Modul 3', bookTitle: 'MSIM4303' },
    { maxRetriesPerChapter: 1, retryBaseDelayMs: 20, maxConsecutiveFailures: 3, skipFailedChapters: true },
    {
      onProgress: () => {},
      savePdfFile: async () => {}
    }
  );

  assert.equal(summary.status, 'ERROR');
  assert.equal(summary.circuitBreakerTriggered, true);
  assert.equal(summary.capturedCount, 2);
  assert.equal(summary.failedCount, 3);
  assert.equal(summary.resumeFromChapter, 3, 'Should resume from ch/3 (first uncaptured after ch/2)');
  assert.equal(attemptedChapters.has(6), false, 'Circuit breaker must stop before ch/6');
  assert.equal(dbg.isAttached(), false);
  console.log('✅ Scenario 3 (Circuit Breaker 3x Consecutive Failures) PASSED');
}

async function testScenario4CdpPrintTimeoutGuard(): Promise<void> {
  let printAttempts = 0;

  installMockChrome(async (_tabId, msg) => {
    if (msg.type === 'ENSURE_SINGLE_PAGE_MODE') return { success: true, wasSpreadMode: false, changed: false };
    if (msg.type === 'CHECK_PAGE_HEALTH') return { online: true, isLoginPage: false, isKotobeeReader: true, currentHash: '' };
    if (msg.type === 'RESTORE_AFTER_PRINT' || msg.type === 'ABORT_NAVIGATION') return { success: true };
    if (msg.type === 'NAVIGATE_TO_CHAPTER') {
      return { success: true, actualChapter: 1, chapterTitle: 'Bab 1', fingerprint: 'fp-1' };
    }
    if (msg.type === 'PREPARE_FOR_PRINT') {
      return { success: true, chapterTitle: 'Bab 1', isFixedLayout: true };
    }
    return { success: true };
  });

  const dbg = new MockDebuggerManager(async (method) => {
    if (method === 'Page.printToPDF') {
      printAttempts++;
      if (printAttempts === 1) {
        // Simulate hung CDP print pipeline (5s) against 1000ms guard
        await new Promise((r) => setTimeout(r, 5000));
      }
      return { data: makeFakePdfBase64('recovered') };
    }
    return {};
  });

  const printer = new CdpPrinter(dbg as unknown as DebuggerManager);

  // Direct CdpPrinter timeout assertion
  await dbg.attach(104);
  const t0 = Date.now();
  await assert.rejects(
    () => printer.printCurrentPage({}, 1000),
    (err: unknown) => err instanceof CdpPrintTimeoutError
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2200, `Expected timeout < 2200ms, got ${elapsed}ms`);
  await dbg.detach();

  // Orchestrator recovery after print timeout
  printAttempts = 0;
  const orchestrator = new ExportOrchestrator(dbg as unknown as DebuggerManager, printer);
  const summary = await orchestrator.runBatchExport(
    104,
    { startChapter: 1, endChapter: 1, label: 'Single Timeout Test', bookTitle: 'MSIM4303' },
    { maxRetriesPerChapter: 1, retryBaseDelayMs: 25, cdpPrintTimeoutMs: 1000 },
    {
      onProgress: () => {},
      savePdfFile: async () => {}
    }
  );

  assert.equal(summary.status, 'COMPLETED');
  assert.equal(summary.capturedCount, 1);
  assert.equal(printAttempts, 2);
  assert.equal(dbg.isAttached(), false);
  console.log('✅ Scenario 4 (CDP Page.printToPDF Timeout Guard & Recovery) PASSED');
}

async function testScenario5SsoSessionExpired(): Promise<void> {
  let navCh2Calls = 0;

  installMockChrome(async (_tabId, msg) => {
    if (msg.type === 'ENSURE_SINGLE_PAGE_MODE') return { success: true, wasSpreadMode: false, changed: false };
    if (msg.type === 'RESTORE_AFTER_PRINT' || msg.type === 'ABORT_NAVIGATION') return { success: true };
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
    if (msg.type === 'PREPARE_FOR_PRINT') {
      return { success: true, chapterTitle: 'Bab 1', isFixedLayout: true };
    }
    return { success: true };
  });

  const dbg = new MockDebuggerManager();
  const printer = new CdpPrinter(dbg as unknown as DebuggerManager);
  const orchestrator = new ExportOrchestrator(dbg as unknown as DebuggerManager, printer);

  const summary = await orchestrator.runBatchExport(
    105,
    { startChapter: 1, endChapter: 4, label: 'Modul SSO', bookTitle: 'MSIM4303' },
    { maxRetriesPerChapter: 3, retryBaseDelayMs: 20 },
    {
      onProgress: () => {},
      savePdfFile: async () => {}
    }
  );

  assert.equal(summary.status, 'ERROR');
  assert.equal(summary.capturedCount, 1);
  assert.equal(navCh2Calls, 1, 'Must stop immediately on SSO expiry without wasting retries');
  assert.equal(summary.resumeFromChapter, 2);
  assert.ok(summary.errorMessage?.includes('SSO'), `Expected SSO message, got: ${summary.errorMessage}`);
  assert.equal(dbg.isAttached(), false);
  console.log('✅ Scenario 5 (SSO Session Expired Fatal Detection) PASSED');
}

function testScenario6FriendlyErrorFormatter(): void {
  assert.ok(
    DebuggerManager.formatFriendlyError(new Error('Another debugger is already attached')).includes('DevTools')
  );
  assert.ok(DebuggerManager.formatFriendlyError('canceled_by_user').includes('Cancel'));
  assert.ok(DebuggerManager.formatFriendlyError('tab_closed').includes('ditutup'));
  assert.ok(DebuggerManager.formatFriendlyError('Frame was detached').includes('Frame'));
  console.log('✅ Scenario 6 (Friendly Error Formatter) PASSED');
}

async function main(): Promise<void> {
  console.log('🧪 Running Phase 5 Resilience & Recovery Test Suite...\n');
  await testScenario1TransientRetryRecovery();
  await testScenario2SingleChapterSkip();
  await testScenario3CircuitBreaker();
  await testScenario4CdpPrintTimeoutGuard();
  await testScenario5SsoSessionExpired();
  testScenario6FriendlyErrorFormatter();
  console.log('\n🎉 All 6 Phase 5 resilience scenarios PASSED!');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
