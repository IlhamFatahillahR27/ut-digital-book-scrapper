import { TabSessionManager } from './tab-session-manager';
import { FirefoxPdfPrinter } from './firefox-pdf-printer';
import { ExportOrchestrator } from './export-orchestrator';
import { MessageRouter } from './message-router';
import {
  getBrowserApi,
  hasKotobeeHostPermission,
  requestKotobeeHostPermission
} from '../utils/browser-api';
import { logger } from '../utils/logger';
import type { ExtensionMessage } from '../types/messages';

logger.info('RBV-UT Firefox MV3 Background Event Page initializing...');

const api = getBrowserApi();
const sessionManager = new TabSessionManager();
const pdfPrinter = new FirefoxPdfPrinter();
const exportOrchestrator = new ExportOrchestrator(sessionManager, pdfPrinter);
const messageRouter = new MessageRouter(sessionManager, pdfPrinter, exportOrchestrator);

api.runtime.onInstalled.addListener((details) => {
  logger.info(`RBV-UT Firefox Add-on installed/updated. Reason: ${details.reason}`);
});

api.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!message || typeof message !== 'object' || !('type' in message)) {
    return undefined;
  }
  return messageRouter.handleMessage(message as ExtensionMessage, sender);
});

// Maintain active keep-alive ports from content script while long exports run
const keepAlivePorts = new Set<browser.runtime.Port>();
api.runtime.onConnect.addListener((port) => {
  if (port.name !== 'rbv-export-keepalive') return;
  keepAlivePorts.add(port);
  logger.debug(`Keep-alive port connected (active: ${keepAlivePorts.size}).`);
  port.onDisconnect.addListener(() => {
    keepAlivePorts.delete(port);
    logger.debug(`Keep-alive port disconnected (active: ${keepAlivePorts.size}).`);
  });
});

// Handle toolbar icon click: request Firefox MV3 host permission if needed, then toggle or inject widget
api.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  logger.info(`Extension toolbar icon clicked on tab ${tab.id}: ${tab.url ?? 'unknown'}`);

  // In Firefox MV3, host_permissions are user-controlled and must be requested inside a user gesture
  const hasPerm = await hasKotobeeHostPermission();
  if (!hasPerm) {
    const granted = await requestKotobeeHostPermission();
    logger.info(`Kotobee host permission request result: ${granted}`);
    if (!granted) {
      return;
    }
  }

  // Try messaging an already-injected content script first to avoid duplicate injection
  try {
    const res = (await api.tabs.sendMessage(tab.id, { type: 'TOGGLE_WIDGET' })) as
      | { success?: boolean }
      | undefined;
    if (res?.success) {
      logger.debug(`Toggled existing floating widget on tab ${tab.id}.`);
      return;
    }
  } catch {
    // Content script not mounted yet on this tab; proceed to fallback injection if eligible
  }

  const tabUrl = tab.url ?? '';
  if (tabUrl.startsWith('https://univterbuka.kotobee.com/')) {
    try {
      await api.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      logger.info('Injected content script into Kotobee tab:', tab.id);
    } catch (err) {
      logger.error('Failed to inject content script:', err);
    }
  }
});

logger.info('RBV-UT Firefox MV3 Background Event Page ready and listening.');
