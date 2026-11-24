import { DomDetector } from './dom-detector';
import { UiInjector } from './ui-injector';
import { PrintStyler } from './print-styler';
import { TocParser } from './toc-parser';
import { PageNavigator } from './page-navigator';
import { logger } from '../utils/logger';
import type { ExtensionMessage } from '../types/messages';

const INIT_GUARD_KEY = '__RBV_UT_EXPORTER_LOADED__';
const chunkDownloadJobs = new Map<string, { filename: string; parts: BlobPart[] }>();

function detectSsoLoginPage(): boolean {
  const urlLower = window.location.href.toLowerCase();
  if (
    /\/(login|signin|sign-in|auth|sso)\b/.test(urlLower) &&
    !urlLower.includes('/reader/chapter/')
  ) {
    return true;
  }
  const hasPasswordInput = !!document.querySelector('input[type="password"]');
  const hasReader = DomDetector.isKotobeeReader();
  return hasPasswordInput && !hasReader;
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function setupMessageListeners(): void {
  chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
    switch (message.type) {
      case 'GET_BOOK_STRUCTURE':
        try {
          const data = TocParser.getBookStructure();
          sendResponse({ success: true, data });
        } catch (err) {
          logger.error('Error during GET_BOOK_STRUCTURE:', err);
          sendResponse({ success: false, error: String(err) });
        }
        return false;

      case 'ENSURE_SINGLE_PAGE_MODE':
        (async () => {
          try {
            const res = await PageNavigator.getInstance().ensureSinglePageMode();
            sendResponse(res);
          } catch (err) {
            logger.error('Error during ENSURE_SINGLE_PAGE_MODE:', err);
            sendResponse({ success: false, wasSpreadMode: false, changed: false, message: String(err) });
          }
        })();
        return true;

      case 'RESTORE_PAGE_VIEW_MODE':
        (async () => {
          try {
            const res = await PageNavigator.getInstance().restorePageViewMode();
            sendResponse(res);
          } catch (err) {
            logger.error('Error during RESTORE_PAGE_VIEW_MODE:', err);
            sendResponse({ success: false, restored: false });
          }
        })();
        return true;

      case 'NAVIGATE_TO_CHAPTER':
        (async () => {
          try {
            const res = await PageNavigator.getInstance().navigateToChapter(message.payload);
            sendResponse(res);
          } catch (err) {
            logger.error('Error during NAVIGATE_TO_CHAPTER:', err);
            sendResponse({
              success: false,
              actualChapter: null,
              chapterTitle: 'Error',
              fingerprint: '',
              error: String(err)
            });
          }
        })();
        return true;

      case 'ABORT_NAVIGATION':
        try {
          PageNavigator.getInstance().abort();
          sendResponse({ success: true });
        } catch (err) {
          logger.error('Error during ABORT_NAVIGATION:', err);
          sendResponse({ success: false });
        }
        return false;

      case 'CHECK_PAGE_HEALTH':
        try {
          sendResponse({
            online: typeof navigator !== 'undefined' ? navigator.onLine : true,
            isLoginPage: detectSsoLoginPage(),
            isKotobeeReader: DomDetector.isKotobeeReader(),
            currentHash: window.location.hash
          });
        } catch {
          sendResponse({
            online: true,
            isLoginPage: false,
            isKotobeeReader: true,
            currentHash: window.location.hash
          });
        }
        return false;

      case 'TOGGLE_WIDGET':
        try {
          const injector = UiInjector.getInstance();
          if (!document.getElementById('rbv-ut-exporter-root')) {
            injector.inject();
          }
          injector.ensureVisibleInViewport();
          injector.getWidget()?.toggleVisibilityOrExpand();
          sendResponse({ success: true });
        } catch (err) {
          logger.warn('Error handling TOGGLE_WIDGET:', err);
          sendResponse({ success: false });
        }
        return false;

      case 'EXPORT_PROGRESS':
        try {
          UiInjector.getInstance().getWidget()?.handleExportProgressNotification(message.payload);
          sendResponse({ success: true });
        } catch (err) {
          logger.warn('Error handling EXPORT_PROGRESS in widget:', err);
          sendResponse({ success: false });
        }
        return false;

      case 'EXPORT_COMPLETE':
        try {
          UiInjector.getInstance().getWidget()?.handleExportCompleteNotification(message.payload);
          sendResponse({ success: true });
        } catch (err) {
          logger.warn('Error handling EXPORT_COMPLETE in widget:', err);
          sendResponse({ success: false });
        }
        return false;

      case 'EXPORT_ERROR':
        try {
          UiInjector.getInstance().getWidget()?.handleExportErrorNotification(message.payload);
          sendResponse({ success: true });
        } catch (err) {
          logger.warn('Error handling EXPORT_ERROR in widget:', err);
          sendResponse({ success: false });
        }
        return false;

      case 'PREPARE_FOR_PRINT':
        (async () => {
          try {
            logger.info('Received PREPARE_FOR_PRINT. Preparing clean page view...');

            // 1. Prepare isolated print stage from active reading chapter
            const applied = await PrintStyler.getInstance().applyPrintStyles();
            
            // 2. Brief wait (150ms) for DOM layout to settle
            await new Promise((r) => setTimeout(r, 150));

            const chapterTitle = DomDetector.detectChapterTitle();
            const estimatedPages = DomDetector.estimatePageCount();
            const isFixedLayout = PrintStyler.getInstance().isFixedLayoutActive();

            sendResponse({
              success: applied,
              chapterTitle,
              estimatedPages,
              isFixedLayout
            });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.error('Error during PREPARE_FOR_PRINT:', err);
            PrintStyler.getInstance().restoreStyles();
            sendResponse({ success: false, error: errorMsg, chapterTitle: 'Error' });
          }
        })();
        return true; // Keep async response channel open

      case 'RESTORE_AFTER_PRINT':
        try {
          logger.info('Received RESTORE_AFTER_PRINT. Reverting styles...');
          PrintStyler.getInstance().restoreStyles();
          sendResponse({ success: true });
        } catch (err) {
          logger.error('Error during RESTORE_AFTER_PRINT:', err);
          sendResponse({ success: false });
        }
        return false;

      case 'DOWNLOAD_PDF_BLOB':
        try {
          const { base64Data, filename } = message.payload;
          logger.info(`Triggering in-page Blob download for ${filename}...`);
          
          const byteCharacters = atob(base64Data);
          const byteNumbers = new Array(byteCharacters.length);
          for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
          }
          const byteArray = new Uint8Array(byteNumbers);
          const blob = new Blob([byteArray], { type: 'application/pdf' });
          const blobUrl = URL.createObjectURL(blob);

          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();

          setTimeout(() => {
            if (a.parentNode) a.parentNode.removeChild(a);
            URL.revokeObjectURL(blobUrl);
          }, 8000);

          sendResponse({ success: true });
        } catch (err) {
          logger.error('Failed to trigger in-page Blob download:', err);
          sendResponse({ success: false, error: String(err) });
        }
        return false;

      case 'DOWNLOAD_PDF_CHUNK_INIT':
        try {
          const { jobId, filename } = message.payload;
          chunkDownloadJobs.set(jobId, { filename, parts: [] });
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
        return false;

      case 'DOWNLOAD_PDF_CHUNK_APPEND':
        try {
          const { jobId, base64Chunk } = message.payload;
          const job = chunkDownloadJobs.get(jobId);
          if (!job) {
            sendResponse({ success: false, error: `Unknown download job: ${jobId}` });
            return false;
          }
          job.parts.push(base64ToUint8(base64Chunk) as unknown as BlobPart);
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
        return false;

      case 'DOWNLOAD_PDF_CHUNK_FINALIZE':
        try {
          const { jobId } = message.payload;
          const job = chunkDownloadJobs.get(jobId);
          if (!job) {
            sendResponse({ success: false, error: `Unknown download job: ${jobId}` });
            return false;
          }
          chunkDownloadJobs.delete(jobId);
          const blob = new Blob(job.parts, { type: 'application/pdf' });
          const blobUrl = URL.createObjectURL(blob);

          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = job.filename;
          document.body.appendChild(a);
          a.click();

          setTimeout(() => {
            if (a.parentNode) a.parentNode.removeChild(a);
            URL.revokeObjectURL(blobUrl);
          }, 15000);

          sendResponse({ success: true });
        } catch (err) {
          logger.error('Failed to finalize chunked in-page Blob download:', err);
          sendResponse({ success: false, error: String(err) });
        }
        return false;

      default:
        return false;
    }
  });
}

function initContentScript(): void {
  // Only execute in top frame to avoid duplicate listeners and duplicate UI widgets
  if (window !== window.top) {
    logger.debug('Skipping content script in sub-frame:', window.location.href);
    return;
  }

  // Idempotent guard: prevent duplicate listener registration on manual toolbar re-injection
  const winRecord = window as unknown as Record<string, unknown>;
  if (winRecord[INIT_GUARD_KEY]) {
    logger.debug('Content script already initialized; toggling existing widget.');
    const injector = UiInjector.getInstance();
    if (!document.getElementById('rbv-ut-exporter-root')) {
      injector.inject();
    }
    injector.ensureVisibleInViewport();
    injector.getWidget()?.toggleVisibilityOrExpand();
    return;
  }
  winRecord[INIT_GUARD_KEY] = true;

  // Highlighted log in DevTools Console
  console.log(
    '%c[RBV-Exporter]%c Content script active on: ' + window.location.href,
    'background: #0284c7; color: #ffffff; font-weight: bold; padding: 3px 8px; border-radius: 4px;',
    'color: #0284c7; font-weight: bold;'
  );

  // Setup message listeners for print preparation and restoration (top frame only)
  setupMessageListeners();

  if (DomDetector.isKotobeeReader()) {
    logger.info('Kotobee reader page detected. Mounting exporter UI...');
    
    const mount = () => {
      UiInjector.getInstance().inject();
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount);
    } else {
      mount();
    }

    // Keep UI persistent across Kotobee SPA route changes
    setInterval(() => {
      if (!document.getElementById('rbv-ut-exporter-root')) {
        logger.debug('Re-injecting floating widget after SPA DOM update...');
        UiInjector.getInstance().inject();
      }
    }, 2500);
  }
}

initContentScript();
