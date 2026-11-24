import type { ExtensionMessage, ExportProgress } from '../types/messages';
import { logger } from '../utils/logger';
import { DebuggerManager } from './debugger-manager';

export class MessageRouter {
  private debuggerManager: DebuggerManager;
  private currentProgress: ExportProgress = {
    status: 'IDLE',
    currentChapter: 0,
    chapterTitle: 'Siap',
    message: 'Ekstensi siap digunakan.'
  };

  constructor(debuggerManager: DebuggerManager) {
    this.debuggerManager = debuggerManager;
  }

  handleMessage(
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ): boolean {
    logger.debug(`Received message [${message.type}] from tab ${sender.tab?.id ?? 'unknown'}`);

    switch (message.type) {
      case 'PING':
        sendResponse({ type: 'PONG', timestamp: Date.now() });
        return false;

      case 'GET_STATUS':
        sendResponse({
          type: 'STATUS_RESPONSE',
          payload: this.currentProgress
        });
        return false;

      case 'START_EXPORT':
        this.handleStartExport(message, sender, sendResponse);
        return true; // Keep channel open for async response

      case 'STOP_EXPORT':
        this.handleStopExport(message, sender, sendResponse);
        return true;

      default:
        logger.warn('Unhandled message type:', (message as { type: string }).type);
        sendResponse({ error: 'Unknown message type' });
        return false;
    }
  }

  private async handleStartExport(
    message: Extract<ExtensionMessage, { type: 'START_EXPORT' }>,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ): Promise<void> {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: 'No active tab found in sender context.' });
      return;
    }

    try {
      this.updateProgress({
        status: 'INITIALIZING',
        currentChapter: 1,
        chapterTitle: message.payload?.bookTitle || 'Menginisialisasi...',
        message: 'Menghubungkan debugger ke tab Kotobee...'
      });

      // Test attaching debugger (will be verified in Phase 2)
      await this.debuggerManager.attach(tabId);

      sendResponse({
        success: true,
        message: 'Export session initialized. Debugger attached.'
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.updateProgress({
        status: 'ERROR',
        currentChapter: 0,
        chapterTitle: 'Error',
        message: `Gagal inisialisasi: ${errorMsg}`
      });
      await this.debuggerManager.detach();
      sendResponse({ success: false, error: errorMsg });
    }
  }

  private async handleStopExport(
    _message: Extract<ExtensionMessage, { type: 'STOP_EXPORT' }>,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ): Promise<void> {
    logger.info('Stopping export session by user request.');
    await this.debuggerManager.detach();
    this.updateProgress({
      status: 'STOPPED',
      currentChapter: 0,
      chapterTitle: 'Dihentikan',
      message: 'Proses ekspor dihentikan oleh pengguna.'
    });
    sendResponse({ success: true, message: 'Export stopped.' });
  }

  private updateProgress(progress: ExportProgress): void {
    this.currentProgress = progress;
  }
}
