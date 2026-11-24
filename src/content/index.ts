import { DomDetector } from './dom-detector';
import { UiInjector } from './ui-injector';
import { PrintStyler } from './print-styler';
import { logger } from '../utils/logger';
import type { ExtensionMessage } from '../types/messages';

function setupMessageListeners(): void {
  chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
    switch (message.type) {
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
