import { getBrowserApi, hasBrowserApi } from '../utils/browser-api';
import { logger } from '../utils/logger';

/**
 * Tracks the active Kotobee tab during a Firefox export session without requiring
 * Chromium's `debugger` API. Monitors tab closure, full reload, and cross-page navigation
 * while permitting Kotobee's SPA `#/book/.../reader/chapter/N` hash route transitions.
 */
export class TabSessionManager {
  private activeTabId: number | null = null;
  private activeBaseUrl: string | null = null;
  private unexpectedEndListeners = new Set<(tabId: number, reason: string) => void>();
  private listenersInstalled = false;

  constructor() {
    this.setupListeners();
  }

  /**
   * Maps low-level Firefox WebExtension errors and session termination reasons
   * into clear, actionable Indonesian messages for UT students.
   */
  static formatFriendlyError(errOrReason: unknown): string {
    const raw = errOrReason instanceof Error ? errOrReason.message : String(errOrReason ?? '');
    const lower = raw.toLowerCase();

    if (
      lower.includes('missing host permission') ||
      lower.includes('host permission') ||
      lower.includes('not granted')
    ) {
      return 'Izin akses situs univterbuka.kotobee.com belum aktif di Firefox. Klik ikon ekstensi di toolbar lalu pilih "Izinkan / Allow" untuk situs ini.';
    }
    if (lower.includes('tab_closed') || lower.includes('invalid tab id') || lower.includes('no tab with id')) {
      return 'Tab Kotobee ditutup saat proses ekspor berlangsung.';
    }
    if (lower.includes('navigated_away')) {
      return 'Tab berpindah ke halaman/situs lain saat proses ekspor berlangsung.';
    }
    if (lower.includes('tab_reloaded')) {
      return 'Halaman Kotobee dimuat ulang (refresh) saat proses ekspor berlangsung.';
    }
    if (lower.includes('capturetab') && lower.includes('not')) {
      return 'Tab tidak dapat dipotret oleh Firefox. Pastikan tab Kotobee tetap terbuka dan aktif.';
    }
    if (lower.includes('not supported on macos') || lower.includes('saveaspdf')) {
      return 'Fitur simpan PDF native browser tidak tersedia di platform ini; gunakan mode Silent + Bookmarks atau cetak manual.';
    }
    if (lower.includes('frame was detached') || lower.includes('execution context was destroyed')) {
      return 'Frame pembaca Kotobee sempat terputus atau dimuat ulang oleh browser.';
    }
    if (
      lower.includes('receiving end does not exist') ||
      lower.includes('could not establish connection')
    ) {
      return 'Koneksi ke halaman Kotobee terputus. Coba muat ulang halaman lalu klik "Lanjutkan".';
    }

    return raw || 'Terjadi kesalahan tidak terduga pada sesi ekspor Firefox.';
  }

  onUnexpectedEnd(listener: (tabId: number, reason: string) => void): () => void {
    this.unexpectedEndListeners.add(listener);
    return () => {
      this.unexpectedEndListeners.delete(listener);
    };
  }

  private stripHash(url?: string): string | null {
    if (!url) return null;
    const hashIdx = url.indexOf('#');
    return hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  }

  private notifyUnexpectedEnd(tabId: number, reason: string): void {
    for (const listener of this.unexpectedEndListeners) {
      try {
        listener(tabId, reason);
      } catch (err) {
        logger.warn('TabSessionManager: Error in unexpectedEnd listener:', err);
      }
    }
  }

  private setupListeners(): void {
    if (this.listenersInstalled || !hasBrowserApi()) {
      return;
    }

    const api = getBrowserApi();
    if (!api.tabs?.onRemoved || !api.tabs?.onUpdated) {
      return;
    }
    this.listenersInstalled = true;

    api.tabs.onRemoved.addListener((tabId) => {
      if (this.activeTabId === tabId) {
        logger.warn(`TabSessionManager: Target tab ${tabId} was closed. Ending session.`);
        this.activeTabId = null;
        this.activeBaseUrl = null;
        this.notifyUnexpectedEnd(tabId, 'tab_closed');
      }
    });

    api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (this.activeTabId !== tabId) return;

      // Allow SPA hash changes (e.g. #/book/57062/reader/chapter/3 -> chapter/4)
      if (changeInfo.url) {
        const nextBase = this.stripHash(changeInfo.url);
        if (this.activeBaseUrl && nextBase === this.activeBaseUrl) {
          logger.debug(`TabSessionManager: Ignoring SPA hash update on tab ${tabId}: ${changeInfo.url}`);
          return;
        }
        logger.warn(`TabSessionManager: Tab ${tabId} navigated away (${changeInfo.url}).`);
        this.activeTabId = null;
        this.activeBaseUrl = null;
        this.notifyUnexpectedEnd(tabId, 'navigated_away');
        return;
      }

      if (changeInfo.status === 'loading') {
        const currentBase = this.stripHash(tab?.url);
        if (!currentBase || !this.activeBaseUrl || currentBase !== this.activeBaseUrl) {
          logger.warn(`TabSessionManager: Tab ${tabId} reloaded unexpectedly.`);
          this.activeTabId = null;
          this.activeBaseUrl = null;
          this.notifyUnexpectedEnd(tabId, 'tab_reloaded');
        }
      }
    });
  }

  async startSession(tabId: number): Promise<void> {
    if (this.activeTabId === tabId) {
      return;
    }
    if (this.activeTabId !== null) {
      this.endSession();
    }

    let baseUrl: string | null = null;
    try {
      if (hasBrowserApi()) {
        const api = getBrowserApi();
        if (api.tabs?.get) {
          const tab = await api.tabs.get(tabId);
          baseUrl = this.stripHash(tab?.url);
        }
      }
    } catch (err) {
      const friendly = TabSessionManager.formatFriendlyError(err);
      logger.error(`TabSessionManager: Cannot access tab ${tabId}:`, err);
      throw new Error(friendly);
    }

    this.activeTabId = tabId;
    this.activeBaseUrl = baseUrl;
    logger.info(`TabSessionManager: Session started on tab ${tabId} (base: ${baseUrl ?? 'unknown'}).`);
  }

  endSession(): void {
    if (this.activeTabId !== null) {
      logger.info(`TabSessionManager: Session ended on tab ${this.activeTabId}.`);
    }
    this.activeTabId = null;
    this.activeBaseUrl = null;
  }

  isActive(): boolean {
    return this.activeTabId !== null;
  }

  getActiveTabId(): number | null {
    return this.activeTabId;
  }
}
