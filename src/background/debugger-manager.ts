import { logger } from '../utils/logger';

export class DebuggerManager {
  private attachedTabId: number | null = null;
  private attachedBaseUrl: string | null = null;
  private protocolVersion = '1.3';
  private unexpectedDetachListeners = new Set<(tabId: number, reason: string) => void>();

  constructor() {
    this.setupListeners();
  }

  onUnexpectedDetach(listener: (tabId: number, reason: string) => void): () => void {
    this.unexpectedDetachListeners.add(listener);
    return () => {
      this.unexpectedDetachListeners.delete(listener);
    };
  }

  private stripHash(url?: string): string | null {
    if (!url) return null;
    const hashIdx = url.indexOf('#');
    return hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  }

  private notifyUnexpectedDetach(tabId: number, reason: string): void {
    for (const listener of this.unexpectedDetachListeners) {
      try {
        listener(tabId, reason);
      } catch (err) {
        logger.warn('Error in unexpectedDetach listener:', err);
      }
    }
  }

  private setupListeners(): void {
    // When debugger is detached (either manually or by closing target/DevTools)
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (this.attachedTabId && source.tabId === this.attachedTabId) {
        const detachedTabId = source.tabId;
        logger.warn(`Debugger detached unexpectedly from tab ${detachedTabId}. Reason: ${reason}`);
        this.attachedTabId = null;
        this.attachedBaseUrl = null;
        this.notifyUnexpectedDetach(detachedTabId, reason);
      }
    });

    // Clean up if the attached tab is closed by the user
    chrome.tabs.onRemoved.addListener((tabId) => {
      if (this.attachedTabId === tabId) {
        logger.warn(`Target tab ${tabId} was closed. Cleaning up debugger session.`);
        this.attachedTabId = null;
        this.attachedBaseUrl = null;
        this.notifyUnexpectedDetach(tabId, 'tab_closed');
      }
    });

    // Watch for FULL navigation/reload on the attached tab, while ALLOWING SPA #hash chapter changes
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (this.attachedTabId !== tabId) return;

      // Pure SPA hash change (e.g. #/book/57062/reader/chapter/3 -> chapter/4) stays on same base URL
      if (changeInfo.url) {
        const nextBase = this.stripHash(changeInfo.url);
        if (this.attachedBaseUrl && nextBase === this.attachedBaseUrl) {
          logger.debug(`Ignoring SPA hash update on attached tab ${tabId}: ${changeInfo.url}`);
          return;
        }
        // Navigated to a different page or domain
        logger.warn(`Target tab ${tabId} navigated away (${changeInfo.url}). Detaching debugger.`);
        this.detach().catch((err) => logger.warn('Error during auto-detach on navigation:', err));
        this.notifyUnexpectedDetach(tabId, 'navigated_away');
        return;
      }

      // Full page reload triggers status='loading' without a same-base hash URL update
      if (changeInfo.status === 'loading') {
        const currentBase = this.stripHash(tab?.url);
        if (!currentBase || !this.attachedBaseUrl || currentBase !== this.attachedBaseUrl || !changeInfo.url) {
          logger.warn(`Target tab ${tabId} reloaded. Detaching debugger.`);
          this.detach().catch((err) => logger.warn('Error during auto-detach on reload:', err));
          this.notifyUnexpectedDetach(tabId, 'tab_reloaded');
        }
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
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      await chrome.debugger.attach({ tabId }, this.protocolVersion);
      this.attachedTabId = tabId;
      this.attachedBaseUrl = this.stripHash(tab?.url);
      logger.info(`Debugger successfully attached to tab ${tabId} (base: ${this.attachedBaseUrl ?? 'unknown'})`);
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
    this.attachedBaseUrl = null;

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
