import { DebuggerManager } from './debugger-manager';
import { CdpPrinter } from './cdp-printer';
import { MessageRouter } from './message-router';
import { logger } from '../utils/logger';
import type { ExtensionMessage } from '../types/messages';

logger.info('RBV-UT Background Service Worker initializing...');

const debuggerManager = new DebuggerManager();
const cdpPrinter = new CdpPrinter(debuggerManager);
const messageRouter = new MessageRouter(debuggerManager, cdpPrinter);

chrome.runtime.onInstalled.addListener((details) => {
  logger.info(`RBV-UT Extension installed/updated. Reason: ${details.reason}`);
});

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  return messageRouter.handleMessage(message, sender, sendResponse);
});

// Allow manual injection or activation by clicking the extension icon in the browser toolbar
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url) return;
  logger.info(`Extension icon clicked on tab ${tab.id}: ${tab.url}`);

  if (tab.url.includes('kotobee.com')) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      logger.info('Manually injected content script into Kotobee tab:', tab.id);
    } catch (err) {
      logger.error('Failed to manually inject content script:', err);
    }
  }
});

logger.info('RBV-UT Background Service Worker ready and listening.');
