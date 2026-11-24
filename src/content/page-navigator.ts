import { DomDetector } from './dom-detector';
import { TocParser } from './toc-parser';
import { logger } from '../utils/logger';
import type {
  EnsureSinglePageModeResponse,
  NavigateToChapterResponse,
  RestorePageViewModeResponse
} from '../types/messages';

export interface NavigateOptions {
  targetChapter: number;
  bookId?: string | null;
  previousFingerprint?: string;
  timeoutMs?: number;
  quiescenceMs?: number;
}

export class PageNavigator {
  private static instance: PageNavigator | null = null;
  private activeAbortController: AbortController | null = null;

  // Saved state if we temporarily switched Kotobee from Double-Page Spread to Single-Page
  private savedPageViewSelect: HTMLSelectElement | null = null;
  private savedPageViewIndex: number | null = null;

  static getInstance(): PageNavigator {
    if (!PageNavigator.instance) {
      PageNavigator.instance = new PageNavigator();
    }
    return PageNavigator.instance;
  }

  /**
   * Immediately aborts any ongoing navigation or readiness wait
   */
  abort(): void {
    if (this.activeAbortController) {
      logger.info('PageNavigator: Aborting active navigation/wait.');
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
  }

  /**
   * Captures a deterministic fingerprint of the currently rendered chapter content
   * to prevent capturing stale DOM from the previous chapter.
   */
  captureContentFingerprint(): string {
    const hash = window.location.hash;
    const directContainer = DomDetector.getActiveDirectReadingContainer();

    if (directContainer) {
      const textSnippet = (directContainer.innerText || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 160);
      const pfIds = Array.from(directContainer.querySelectorAll('.pf'))
        .map((el) => `${el.id}:${el.getAttribute('data-page-no') || ''}`)
        .join(',');
      const imgSrcs = Array.from(directContainer.querySelectorAll('img'))
        .slice(0, 5)
        .map((img) => (img.currentSrc || img.getAttribute('src') || '').slice(-48))
        .join('|');
      return `direct|${hash}|len:${directContainer.innerHTML.length}|pf:${pfIds}|img:${imgSrcs}|txt:${textSnippet}`;
    }

    const activeFrame = DomDetector.findActiveReadingFrame();
    if (activeFrame) {
      try {
        const body = activeFrame.contentDocument?.body;
        const textSnippet = (body?.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 160);
        return `iframe|${hash}|src:${activeFrame.src}|len:${body?.innerHTML.length || 0}|txt:${textSnippet}`;
      } catch {
        return `iframe-xorigin|${hash}|src:${activeFrame.src}`;
      }
    }

    return `empty|${hash}`;
  }

  /**
   * Detects Two-Page Spread mode and switches Kotobee to Single-Page mode
   * using the right-menu Page view selector so chapters never jump +2 or print duplicated spreads.
   */
  async ensureSinglePageMode(): Promise<EnsureSinglePageModeResponse> {
    const isSpread = TocParser.isSpreadModeActive();
    if (!isSpread) {
      return {
        success: true,
        wasSpreadMode: false,
        changed: false,
        message: 'Mode Single-Page sudah aktif.'
      };
    }

    logger.info('PageNavigator: Two-Page Spread mode detected. Switching to Single-Page mode...');

    const pageViewSelect = this.findPageViewSelect();
    if (!pageViewSelect) {
      logger.warn('PageNavigator: Could not locate Page view <select> in .ion-side-menu.menu-right.');
      return {
        success: false,
        wasSpreadMode: true,
        changed: false,
        message: 'Mode Two-Page Spread terdeteksi, namun kontrol Page view tidak ditemukan.'
      };
    }

    const singleOptionIndex = Array.from(pageViewSelect.options).findIndex((opt) =>
      /single|tunggal|1\s*page/i.test(`${opt.textContent || ''} ${opt.value}`)
    );

    if (singleOptionIndex < 0) {
      logger.warn('PageNavigator: Single-page option not found inside Page view select.');
      return {
        success: false,
        wasSpreadMode: true,
        changed: false,
        message: 'Opsi Single page tidak ditemukan pada pengaturan Kotobee.'
      };
    }

    // Save original index only once per session so we can restore cleanly later
    if (this.savedPageViewIndex === null) {
      this.savedPageViewSelect = pageViewSelect;
      this.savedPageViewIndex = pageViewSelect.selectedIndex;
    }

    pageViewSelect.selectedIndex = singleOptionIndex;
    pageViewSelect.value = pageViewSelect.options[singleOptionIndex].value;
    pageViewSelect.dispatchEvent(new Event('input', { bubbles: true }));
    pageViewSelect.dispatchEvent(new Event('change', { bubbles: true }));

    // Wait up to 3.5s for Kotobee to re-render into Single-Page mode
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      if (!TocParser.isSpreadModeActive() && this.hasRenderableContent()) {
        await this.sleep(350);
        logger.info('PageNavigator: Successfully switched to Single-Page mode.');
        return {
          success: true,
          wasSpreadMode: true,
          changed: true,
          message: 'Berhasil beralih sementara ke mode Single-Page.'
        };
      }
      await this.sleep(120);
    }

    logger.warn('PageNavigator: Page view changed, waiting for Single-Page layout timed out.');
    return {
      success: !TocParser.isSpreadModeActive(),
      wasSpreadMode: true,
      changed: true,
      message: 'Mengubah pengaturan ke Single-Page.'
    };
  }

  /**
   * Restores the user's original Page view setting if we switched it temporarily
   */
  async restorePageViewMode(): Promise<RestorePageViewModeResponse> {
    if (!this.savedPageViewSelect || this.savedPageViewIndex === null) {
      return { success: true, restored: false };
    }

    try {
      const select = this.savedPageViewSelect;
      const prevIdx = this.savedPageViewIndex;
      this.savedPageViewSelect = null;
      this.savedPageViewIndex = null;

      if (document.contains(select) && prevIdx >= 0 && prevIdx < select.options.length) {
        select.selectedIndex = prevIdx;
        select.value = select.options[prevIdx].value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        logger.info(`PageNavigator: Restored Page view selector to original index ${prevIdx}.`);
        return { success: true, restored: true };
      }
    } catch (err) {
      logger.warn('PageNavigator: Failed to restore Page view setting:', err);
    }

    return { success: true, restored: false };
  }

  /**
   * Navigates to targetChapter and waits until DOM, scoped CSS, images, and fonts stabilize.
   */
  async navigateToChapter(options: NavigateOptions): Promise<NavigateToChapterResponse> {
    // Cancel any previous pending navigation
    this.abort();
    const controller = new AbortController();
    this.activeAbortController = controller;
    const { signal } = controller;

    const timeoutMs = options.timeoutMs ?? 20000;
    const quiescenceMs = options.quiescenceMs ?? 450;
    const targetChapter = options.targetChapter;

    try {
      const route = TocParser.parseRouteHash();
      const currentChapter = route.chapterIndex;
      const bookId = options.bookId || route.bookId;
      const beforeFingerprint = options.previousFingerprint || this.captureContentFingerprint();
      const needsRouteChange = currentChapter !== targetChapter;

      logger.info(
        `PageNavigator: Navigating to chapter/${targetChapter} (current: ${currentChapter ?? 'unknown'}, routeChange: ${needsRouteChange})`
      );

      if (needsRouteChange) {
        if (!bookId) {
          throw new Error('Tidak dapat mendeteksi bookId dari URL hash Kotobee.');
        }

        const targetHash = `#/book/${bookId}/reader/chapter/${targetChapter}`;
        window.location.hash = targetHash;

        // Wait for route & DOM content transition (with fallback trigger if hash didn't kick Ionic router)
        await this.waitForChapterTransition({
          targetChapter,
          targetHash,
          currentChapter,
          beforeFingerprint,
          timeoutMs,
          signal
        });
      }

      this.throwIfAborted(signal);

      // Ensure images, fonts, and DOM quiescence are fully settled
      await this.waitForAssetsAndQuiescence({
        quiescenceMs,
        signal
      });

      this.throwIfAborted(signal);

      const finalRoute = TocParser.parseRouteHash();
      const finalFingerprint = this.captureContentFingerprint();
      const chapterTitle = DomDetector.detectChapterTitle();

      logger.info(
        `PageNavigator: Chapter/${targetChapter} ready ("${chapterTitle}", actualHashCh=${finalRoute.chapterIndex}).`
      );

      return {
        success: true,
        actualChapter: finalRoute.chapterIndex,
        chapterTitle,
        fingerprint: finalFingerprint
      };
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        logger.info(`PageNavigator: Navigation to chapter/${targetChapter} aborted.`);
        return {
          success: false,
          actualChapter: TocParser.parseRouteHash().chapterIndex,
          chapterTitle: DomDetector.detectChapterTitle(),
          fingerprint: this.captureContentFingerprint(),
          aborted: true,
          error: 'Navigasi dibatalkan oleh pengguna.'
        };
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`PageNavigator: Failed navigating to chapter/${targetChapter}:`, err);
      return {
        success: false,
        actualChapter: TocParser.parseRouteHash().chapterIndex,
        chapterTitle: DomDetector.detectChapterTitle(),
        fingerprint: this.captureContentFingerprint(),
        error: errorMsg
      };
    } finally {
      if (this.activeAbortController === controller) {
        this.activeAbortController = null;
      }
    }
  }

  /**
   * Waits until Kotobee has navigated to targetChapter AND replaced the reading container DOM.
   */
  private async waitForChapterTransition(params: {
    targetChapter: number;
    targetHash: string;
    currentChapter: number | null;
    beforeFingerprint: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<void> {
    const { targetChapter, targetHash, currentChapter, beforeFingerprint, timeoutMs, signal } = params;
    const startTime = Date.now();
    let fallbackAttempted = false;

    while (Date.now() - startTime < timeoutMs) {
      this.throwIfAborted(signal);

      const currentRoute = TocParser.parseRouteHash();
      const hashMatched = currentRoute.chapterIndex === targetChapter;
      const hasContent = this.hasRenderableContent();
      const currentFingerprint = this.captureContentFingerprint();
      const contentChanged = currentFingerprint !== beforeFingerprint;

      if (hashMatched && hasContent && contentChanged) {
        // Also ensure scoped #epubContainer style tag is present for FXL pages
        if (this.isFxlStyleReady()) {
          return;
        }
      }

      // Fallback after 3.5s if hash update alone did not trigger Ionic state transition
      if (!fallbackAttempted && Date.now() - startTime > 3500 && !contentChanged) {
        fallbackAttempted = true;
        logger.warn(
          `PageNavigator: Hash navigation stalled for chapter/${targetChapter}. Attempting TOC/Next fallback...`
        );
        this.triggerFallbackNavigation(targetHash, currentChapter, targetChapter);
      }

      await this.sleepAbortable(150, signal);
    }

    // Final check before throwing timeout: if hash matched and content is valid, allow proceeding with warning
    const finalRoute = TocParser.parseRouteHash();
    if (finalRoute.chapterIndex === targetChapter && this.hasRenderableContent()) {
      logger.warn(
        `PageNavigator: Proceeding on chapter/${targetChapter} after timeout (content present, fingerprint unchanged or identical page).`
      );
      return;
    }

    throw new Error(
      `Timeout (${Math.round(timeoutMs / 1000)}s) menunggu halaman chapter/${targetChapter} dimuat oleh Kotobee.`
    );
  }

  /**
   * Fallback navigation via TOC anchor click or Next Page button (a.next.chapterBtn)
   */
  private triggerFallbackNavigation(
    targetHash: string,
    currentChapter: number | null,
    targetChapter: number
  ): void {
    // 1. Try clicking exact TOC link in left sidebar
    const tocLink = document.querySelector(
      `.ion-side-menu.menu-left a[href="${targetHash}"]`
    ) as HTMLElement | null;
    if (tocLink) {
      logger.info(`PageNavigator: Clicking TOC link fallback for ${targetHash}`);
      tocLink.click();
      return;
    }

    // 2. If stepping +1, try clicking Kotobee's Next Page button
    if (currentChapter !== null && targetChapter === currentChapter + 1) {
      const nextBtn = document.querySelector(
        'a.next.chapterBtn, .chapterBtn.next, [class*="next"][class*="chapter"]'
      ) as HTMLElement | null;
      if (nextBtn) {
        logger.info('PageNavigator: Clicking Next Page button fallback (a.next.chapterBtn)');
        nextBtn.click();
      }
    }
  }

  /**
   * Waits for all images, fonts, and a DOM quiescence window with zero further mutations.
   */
  private async waitForAssetsAndQuiescence(params: {
    quiescenceMs: number;
    signal: AbortSignal;
  }): Promise<void> {
    const { quiescenceMs, signal } = params;

    // 1. Wait for images in active container/iframe (max 4s per image)
    const directContainer = DomDetector.getActiveDirectReadingContainer();
    if (directContainer) {
      await this.waitForImages(Array.from(directContainer.querySelectorAll('img')), signal);
    } else {
      const frame = DomDetector.findActiveReadingFrame();
      if (frame?.contentDocument) {
        await this.waitForImages(Array.from(frame.contentDocument.querySelectorAll('img')), signal);
      }
    }

    this.throwIfAborted(signal);

    // 2. Wait for web fonts (bounded by 2.5s so broken font URLs don't stall export)
    if (document.fonts && document.fonts.ready) {
      await Promise.race([
        document.fonts.ready.catch(() => {}),
        this.sleepAbortable(2500, signal)
      ]);
    }

    this.throwIfAborted(signal);

    // 3. DOM Quiescence Window on #epubContent / #epubContainer
    const observeTarget =
      document.getElementById('epubContent') ||
      document.getElementById('epubContainer') ||
      document.body;

    if (observeTarget && quiescenceMs > 0) {
      await this.waitForDomQuiescence(observeTarget, quiescenceMs, 3000, signal);
    }
  }

  private async waitForImages(images: HTMLImageElement[], signal: AbortSignal): Promise<void> {
    if (images.length === 0) return;

    const pending = images.filter((img) => !img.complete || img.naturalWidth === 0);
    if (pending.length === 0) return;

    logger.debug(`PageNavigator: Waiting for ${pending.length} image(s) to finish loading...`);

    await Promise.all(
      pending.map(
        (img) =>
          new Promise<void>((resolve) => {
            if (signal.aborted || (img.complete && img.naturalWidth > 0)) {
              resolve();
              return;
            }

            const done = () => {
              clearTimeout(timer);
              signal.removeEventListener('abort', done);
              img.removeEventListener('load', done);
              img.removeEventListener('error', done);
              resolve();
            };

            const timer = window.setTimeout(done, 4000);
            signal.addEventListener('abort', done, { once: true });
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
          })
      )
    );
  }

  private waitForDomQuiescence(
    target: Node,
    quiescenceMs: number,
    maxWaitMs: number,
    signal: AbortSignal
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(this.createAbortError());
        return;
      }

      let idleTimer: number | null = null;
      let maxTimer: number | null = null;

      const cleanup = () => {
        observer.disconnect();
        if (idleTimer !== null) clearTimeout(idleTimer);
        if (maxTimer !== null) clearTimeout(maxTimer);
        signal.removeEventListener('abort', onAbort);
      };

      const finish = () => {
        cleanup();
        resolve();
      };

      const onAbort = () => {
        cleanup();
        reject(this.createAbortError());
      };

      const resetIdle = () => {
        if (idleTimer !== null) clearTimeout(idleTimer);
        idleTimer = window.setTimeout(finish, quiescenceMs);
      };

      const observer = new MutationObserver(() => {
        resetIdle();
      });

      observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'style', 'class']
      });

      signal.addEventListener('abort', onAbort, { once: true });
      maxTimer = window.setTimeout(finish, maxWaitMs);
      resetIdle();
    });
  }

  private hasRenderableContent(): boolean {
    const direct = DomDetector.getActiveDirectReadingContainer();
    if (direct && direct.innerHTML.trim().length > 50) {
      return true;
    }

    const frame = DomDetector.findActiveReadingFrame();
    try {
      if (frame?.contentDocument?.body && frame.contentDocument.body.innerHTML.trim().length > 50) {
        return true;
      }
    } catch {
      // Cross-origin frame
    }
    return false;
  }

  private isFxlStyleReady(): boolean {
    const direct = DomDetector.getActiveDirectReadingContainer();
    if (!direct) return true;

    const isFxl = !!direct.querySelector('#fxlChapter, .pf');
    if (!isFxl) return true;

    const styles = Array.from(document.querySelectorAll('style'));
    return styles.some((s) => (s.textContent || '').includes('#epubContainer'));
  }

  private findPageViewSelect(): HTMLSelectElement | null {
    const rightMenu =
      document.querySelector('.ion-side-menu.menu-right') ||
      document.querySelector('.menu-right');
    if (!rightMenu) return null;

    const selects = Array.from(rightMenu.querySelectorAll('select')) as HTMLSelectElement[];
    for (const sel of selects) {
      const labelText = (sel.closest('label')?.textContent || '').toLowerCase();
      if (labelText.includes('page view') || labelText.includes('tampilan halaman')) {
        return sel;
      }
      const optTexts = Array.from(sel.options)
        .map((o) => (o.textContent || '').toLowerCase())
        .join(' ');
      if (optTexts.includes('single') && optTexts.includes('double')) {
        return sel;
      }
    }

    return null;
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw this.createAbortError();
    }
  }

  private createAbortError(): Error {
    const err = new Error('Navigation aborted');
    err.name = 'AbortError';
    return err;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(this.createAbortError());
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(this.createAbortError());
      };
      const timer = window.setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
