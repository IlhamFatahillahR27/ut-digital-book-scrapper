import { DomDetector } from './dom-detector';
import { UiInjector } from './ui-injector';
import { PrintStyler } from './print-styler';
import { TocParser } from './toc-parser';
import { PageNavigator } from './page-navigator';
import { getBrowserApi } from '../utils/browser-api';
import { logger } from '../utils/logger';
import type { ExtensionMessage } from '../types/messages';

const INIT_GUARD_KEY = '__RBV_UT_EXPORTER_LOADED__';

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

function setupMessageListeners(): void {
  const api = getBrowserApi();

  api.runtime.onMessage.addListener((rawMessage: unknown) => {
    if (!rawMessage || typeof rawMessage !== 'object' || !('type' in rawMessage)) {
      return undefined;
    }
    const message = rawMessage as ExtensionMessage;

    switch (message.type) {
      case 'GET_BOOK_STRUCTURE':
        try {
          const data = TocParser.getBookStructure();
          return Promise.resolve({ success: true, data });
        } catch (err) {
          logger.error('Error during GET_BOOK_STRUCTURE:', err);
          return Promise.resolve({ success: false, error: String(err) });
        }

      case 'ENSURE_SINGLE_PAGE_MODE':
        return PageNavigator.getInstance()
          .ensureSinglePageMode()
          .catch((err) => {
            logger.error('Error during ENSURE_SINGLE_PAGE_MODE:', err);
            return { success: false, wasSpreadMode: false, changed: false, message: String(err) };
          });

      case 'RESTORE_PAGE_VIEW_MODE':
        return PageNavigator.getInstance()
          .restorePageViewMode()
          .catch((err) => {
            logger.error('Error during RESTORE_PAGE_VIEW_MODE:', err);
            return { success: false, restored: false };
          });

      case 'NAVIGATE_TO_CHAPTER':
        return PageNavigator.getInstance()
          .navigateToChapter(message.payload)
          .catch((err) => {
            logger.error('Error during NAVIGATE_TO_CHAPTER:', err);
            return {
              success: false,
              actualChapter: null,
              chapterTitle: 'Error',
              fingerprint: '',
              error: String(err)
            };
          });

      case 'ABORT_NAVIGATION':
        try {
          PageNavigator.getInstance().abort();
          return Promise.resolve({ success: true });
        } catch (err) {
          logger.error('Error during ABORT_NAVIGATION:', err);
          return Promise.resolve({ success: false });
        }

      case 'CHECK_PAGE_HEALTH':
        try {
          return Promise.resolve({
            online: typeof navigator !== 'undefined' ? navigator.onLine : true,
            isLoginPage: detectSsoLoginPage(),
            isKotobeeReader: DomDetector.isKotobeeReader(),
            currentHash: window.location.hash
          });
        } catch {
          return Promise.resolve({
            online: true,
            isLoginPage: false,
            isKotobeeReader: true,
            currentHash: window.location.hash
          });
        }

      case 'TOGGLE_WIDGET':
        try {
          const injector = UiInjector.getInstance();
          if (!document.getElementById('rbv-ut-exporter-root')) {
            injector.inject();
          }
          injector.ensureVisibleInViewport();
          injector.getWidget()?.toggleVisibilityOrExpand();
          return Promise.resolve({ success: true });
        } catch (err) {
          logger.warn('Error handling TOGGLE_WIDGET:', err);
          return Promise.resolve({ success: false });
        }

      case 'EXPORT_PROGRESS':
        try {
          UiInjector.getInstance().getWidget()?.handleExportProgressNotification(message.payload);
          return Promise.resolve({ success: true });
        } catch (err) {
          logger.warn('Error handling EXPORT_PROGRESS in widget:', err);
          return Promise.resolve({ success: false });
        }

      case 'EXPORT_COMPLETE':
        try {
          UiInjector.getInstance().getWidget()?.handleExportCompleteNotification(message.payload);
          return Promise.resolve({ success: true });
        } catch (err) {
          logger.warn('Error handling EXPORT_COMPLETE in widget:', err);
          return Promise.resolve({ success: false });
        }

      case 'EXPORT_ERROR':
        try {
          UiInjector.getInstance().getWidget()?.handleExportErrorNotification(message.payload);
          return Promise.resolve({ success: true });
        } catch (err) {
          logger.warn('Error handling EXPORT_ERROR in widget:', err);
          return Promise.resolve({ success: false });
        }

      case 'PREPARE_FOR_PRINT':
        return (async () => {
          try {
            logger.info('Received PREPARE_FOR_PRINT. Preparing vector isolated print stage...');
            const applied = await PrintStyler.getInstance().applyPrintStyles();
            await new Promise((r) => setTimeout(r, 150));

            const chapterTitle = DomDetector.detectChapterTitle();
            const estimatedPages = DomDetector.estimatePageCount();
            const isFixedLayout = PrintStyler.getInstance().isFixedLayoutActive();

            return {
              success: applied,
              chapterTitle,
              estimatedPages,
              isFixedLayout
            };
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.error('Error during PREPARE_FOR_PRINT:', err);
            PrintStyler.getInstance().restoreStyles();
            return { success: false, error: errorMsg, chapterTitle: 'Error' };
          }
        })();

      case 'RESTORE_AFTER_PRINT':
        try {
          PrintStyler.getInstance().restoreStyles();
          return Promise.resolve({ success: true });
        } catch (err) {
          logger.error('Error during RESTORE_AFTER_PRINT:', err);
          return Promise.resolve({ success: false });
        }

      case 'CAPTURE_VECTOR_SNAPSHOT':
        return (async () => {
          try {
            const res = await PrintStyler.getInstance().captureVectorSnapshot(
              message.payload.sequenceNumber,
              message.payload.chapterIndex
            );
            return { success: true, ...res };
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.error('Error during CAPTURE_VECTOR_SNAPSHOT:', err);
            return {
              success: false,
              chapterTitle: 'Error',
              isFixedLayout: false,
              estimatedBytes: 0,
              snapshotCount: 0,
              error: errorMsg
            };
          }
        })();

      case 'MOUNT_VECTOR_PRINT_STAGE':
        return (async () => {
          try {
            const snapshotCount = await PrintStyler.getInstance().mountConsolidatedVectorStage();
            return { success: snapshotCount > 0, snapshotCount };
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.error('Error during MOUNT_VECTOR_PRINT_STAGE:', err);
            return { success: false, snapshotCount: 0, error: errorMsg };
          }
        })();

      case 'CLEAR_VECTOR_SNAPSHOTS':
        PrintStyler.getInstance().clearVectorSnapshots();
        return Promise.resolve({ success: true });

      case 'TRIGGER_WINDOW_PRINT':
        window.setTimeout(() => {
          window.print();
        }, 50);
        return Promise.resolve({ success: true });

      default:
        return undefined;
    }
  });
}

function initContentScript(): void {
  if (window !== window.top) {
    logger.debug('Skipping content script in sub-frame:', window.location.href);
    return;
  }

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

  console.log(
    '%c[RBV-Exporter Firefox]%c Content script active on: ' + window.location.href,
    'background: #0284c7; color: #ffffff; font-weight: bold; padding: 3px 8px; border-radius: 4px;',
    'color: #0284c7; font-weight: bold;'
  );

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

    setInterval(() => {
      if (!document.getElementById('rbv-ut-exporter-root')) {
        logger.debug('Re-injecting floating widget after SPA DOM update...');
        UiInjector.getInstance().inject();
      }
    }, 2500);
  }
}

initContentScript();
