import { logger } from '../utils/logger';

export class DebuggerManager {
  private attachedTabId: number | null = null;
  private protocolVersion = '1.3';

  constructor() {
    this.setupListeners();
  }

  private setupListeners(): void {
    // When debugger is detached (either manually or by closing target/DevTools)
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (this.attachedTabId && source.tabId === this.attachedTabId) {
        logger.warn(`Debugger detached unexpectedly from tab ${source.tabId}. Reason: ${reason}`);
        this.attachedTabId = null;
      }
    });

    // Clean up if the attached tab is closed by the user
    chrome.tabs.onRemoved.addListener((tabId) => {
      if (this.attachedTabId === tabId) {
        logger.warn(`Target tab ${tabId} was closed. Cleaning up debugger session.`);
        this.attachedTabId = null;
      }
    });

    // Watch for navigation/reload on the attached tab
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (this.attachedTabId === tabId && changeInfo.status === 'loading') {
        logger.warn(`Target tab ${tabId} navigated or reloaded. Detaching debugger.`);
        this.detach().catch((err) => logger.warn('Error during auto-detach on reload:', err));
      }
    });
  }

  async attach(tabId: number): Promise<void> {
    if (this.attachedTabId === tabId) {
      logger.info(`Debugger already attached to tab ${tabId}`);
      return;
    }

    if (this.attachedTabId !== null) {
      await this.detach();
    }

    try {
      await chrome.debugger.attach({ tabId }, this.protocolVersion);
      this.attachedTabId = tabId;
      logger.info(`Debugger successfully attached to tab ${tabId}`);
    } catch (err) {
      const errorStr = String(err);
      if (errorStr.includes('Another debugger is already attached')) {
        const customErr = new Error(
          'DevTools (F12) terdeteksi aktif pada tab Kotobee ini. Silakan tutup jendela DevTools (Inspect) terlebih dahulu lalu coba lagi.'
        );
        logger.error('Failed to attach debugger:', customErr.message);
        throw customErr;
      }
      logger.error(`Failed to attach debugger to tab ${tabId}:`, err);
      throw err;
    }
  }

  async detach(): Promise<void> {
    if (!this.attachedTabId) {
      return;
    }

    const tabId = this.attachedTabId;
    this.attachedTabId = null;

    try {
      await chrome.debugger.detach({ tabId });
      logger.info(`Debugger successfully detached from tab ${tabId}`);
    } catch (err) {
      logger.warn(`Warning while detaching debugger from tab ${tabId}:`, err);
    }
  }

  async sendCommand<T = unknown>(method: string, params?: object): Promise<T> {
    if (!this.attachedTabId) {
      throw new Error('Cannot send CDP command: Debugger is not attached to any tab.');
    }

    try {
      const result = await chrome.debugger.sendCommand(
        { tabId: this.attachedTabId },
        method,
        params
      );
      return result as T;
    } catch (err) {
      logger.error(`CDP command failed [${method}]:`, err);
      throw err;
    }
  }

  isAttached(): boolean {
    return this.attachedTabId !== null;
  }

  getAttachedTabId(): number | null {
    return this.attachedTabId;
  }
}
