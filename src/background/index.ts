import { DebuggerManager } from './debugger-manager';
import { CdpPrinter } from './cdp-printer';
import { ExportOrchestrator } from './export-orchestrator';
import { MessageRouter } from './message-router';
import { logger } from '../utils/logger';
import type { ExtensionMessage } from '../types/messages';

logger.info('RBV-UT Background Service Worker initializing...');

const debuggerManager = new DebuggerManager();
const cdpPrinter = new CdpPrinter(debuggerManager);
const exportOrchestrator = new ExportOrchestrator(debuggerManager, cdpPrinter);
const messageRouter = new MessageRouter(debuggerManager, cdpPrinter, exportOrchestrator);

chrome.runtime.onInstalled.addListener((details) => {
  logger.info(`RBV-UT Extension installed/updated. Reason: ${details.reason}`);
});

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  return messageRouter.handleMessage(message, sender, sendResponse);
});

// Maintain active keep-alive ports from content script while long exports run
const keepAlivePorts = new Set<chrome.runtime.Port>();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'rbv-export-keepalive') return;
  keepAlivePorts.add(port);
  logger.debug(`Keep-alive port connected (active: ${keepAlivePorts.size}).`);
  port.onDisconnect.addListener(() => {
    keepAlivePorts.delete(port);
    logger.debug(`Keep-alive port disconnected (active: ${keepAlivePorts.size}).`);
  });
});

// Toggle widget visibility or inject content script safely when clicking extension toolbar icon
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url) return;
  logger.info(`Extension icon clicked on tab ${tab.id}: ${tab.url}`);

  // First try messaging an already-injected content script to avoid duplicate injection
  try {
    const res = (await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_WIDGET' })) as
      | { success?: boolean }
      | undefined;
    if (res?.success) {
      logger.debug(`Toggled existing floating widget on tab ${tab.id}.`);
      return;
    }
  } catch {
    // Content script not mounted yet on this tab; proceed to fallback injection if eligible
  }

  if (tab.url.startsWith('https://univterbuka.kotobee.com/')) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      logger.info('Injected content script into Kotobee tab:', tab.id);
    } catch (err) {
      logger.error('Failed to inject content script:', err);
    }
  }
});

logger.info('RBV-UT Background Service Worker ready and listening.');
