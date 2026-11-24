import { logger } from '../utils/logger';

export class DebuggerManager {
  private attachedTabId: number | null = null;
  private attachedBaseUrl: string | null = null;
  private protocolVersion = '1.3';
  private unexpectedDetachListeners = new Set<(tabId: number, reason: string) => void>();

  constructor() {
    this.setupListeners();
  }

  /**
   * Maps low-level Chromium / CDP debugger errors and detach reasons into
   * clear, actionable Indonesian messages for students.
   */
  static formatFriendlyError(errOrReason: unknown): string {
    const raw = errOrReason instanceof Error ? errOrReason.message : String(errOrReason ?? '');
    const lower = raw.toLowerCase();

    if (lower.includes('another debugger is already attached')) {
      return 'DevTools (F12 / Inspect) sedang terbuka pada tab ini. Tutup jendela DevTools terlebih dahulu lalu coba lagi.';
    }
    if (lower.includes('canceled_by_user') || lower.includes('cancelled_by_user')) {
      return 'Sesi cetak dibatalkan karena tombol "Cancel" pada banner debugging browser diklik.';
    }
    if (lower.includes('tab_closed') || lower.includes('target closed') || lower.includes('no tab with id')) {
      return 'Tab Kotobee ditutup saat proses ekspor berlangsung.';
    }
    if (lower.includes('navigated_away')) {
      return 'Tab berpindah ke halaman/situs lain saat proses ekspor berlangsung.';
    }
    if (lower.includes('tab_reloaded')) {
      return 'Halaman Kotobee dimuat ulang (refresh) saat proses ekspor berlangsung.';
    }
    if (lower.includes('frame was detached') || lower.includes('execution context was destroyed')) {
      return 'Frame pembaca Kotobee sempat terputus atau dimuat ulang oleh browser.';
    }
    if (lower.includes('detached while handling command') || lower.includes('debugger is not attached')) {
      return 'Koneksi Chrome DevTools Protocol terputus di tengah proses cetak.';
    }
    if (lower.includes('cannot access a chrome://') || lower.includes('cannot attach to this target')) {
      return 'Halaman ini tidak dapat diakses oleh ekstensi. Pastikan Anda berada di halaman pembaca Kotobee UT.';
    }
    if (lower.includes('receiving end does not exist') || lower.includes('could not establish connection')) {
      return 'Koneksi ke halaman Kotobee terputus. Coba muat ulang halaman lalu lanjutkan ekspor.';
    }

    return raw || 'Terjadi kesalahan tidak terduga pada sesi browser.';
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
      const friendly = DebuggerManager.formatFriendlyError(err);
      logger.error(`Failed to attach debugger to tab ${tabId}:`, err);
      throw new Error(friendly);
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
