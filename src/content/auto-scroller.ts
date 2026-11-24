import { logger } from '../utils/logger';
import { DomDetector } from './dom-detector';

export class AutoScroller {
  /**
   * Performs a stepped scroll from top to bottom of the reading container and iframe,
   * waits for lazy-loaded blob images and equations, then scrolls back to top.
   */
  static async triggerLazyLoading(options?: {
    stepDelayMs?: number;
    renderWaitMs?: number;
  }): Promise<void> {
    const stepDelayMs = options?.stepDelayMs ?? 60;
    const renderWaitMs = options?.renderWaitMs ?? 1800;

    logger.info('Starting auto-scroll lazy-load trigger...');

    const iframe = DomDetector.findReadingFrame();
    const iframeWindow = iframe?.contentWindow;
    const iframeDoc = iframe?.contentDocument;

    // 1. Scroll iframe if accessible
    if (iframeWindow && iframeDoc && iframeDoc.documentElement) {
      await this.scrollContainer(
        iframeDoc.documentElement,
        iframeWindow,
        stepDelayMs
      );
    }

    // 2. Also scroll main top window
    const topTarget = document.scrollingElement || document.documentElement || document.body;
    await this.scrollContainer(topTarget, window, stepDelayMs);

    // 3. Wait for all images to complete loading
    logger.info('Stepped scroll completed. Waiting for images and math typesetting...');
    await this.waitForImages(document);
    if (iframeDoc) {
      await this.waitForImages(iframeDoc);
    }

    // 4. Render wait tolerance
    if (renderWaitMs > 0) {
      await this.sleep(renderWaitMs);
    }

    // 5. Scroll back to top
    if (iframeWindow && iframeDoc) {
      iframeWindow.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
      if (iframeDoc.documentElement) iframeDoc.documentElement.scrollTop = 0;
      if (iframeDoc.body) iframeDoc.body.scrollTop = 0;
    }
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
    if (topTarget) topTarget.scrollTop = 0;

    logger.info('Auto-scroll lazy-loading completed and scroll reset to top.');
  }

  private static async scrollContainer(
    element: HTMLElement | Element,
    win: Window,
    stepDelayMs: number
  ): Promise<void> {
    const scrollHeight = Math.max(element.scrollHeight, 1000);
    const clientHeight = win.innerHeight || 800;
    const stepSize = Math.max(250, Math.floor(clientHeight * 0.7));

    let currentScroll = 0;
    while (currentScroll < scrollHeight) {
      currentScroll += stepSize;
      win.scrollTo(0, currentScroll);
      element.scrollTop = currentScroll;
      await this.sleep(stepDelayMs);
    }
  }

  private static async waitForImages(doc: Document): Promise<void> {
    const images = Array.from(doc.querySelectorAll('img'));
    if (images.length === 0) return;

    logger.debug(`Found ${images.length} images to verify...`);

    const imagePromises = images.map((img) => {
      if (img.complete) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          resolve();
        }, 3000); // 3s max per image

        img.addEventListener('load', () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });

        img.addEventListener('error', () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
      });
    });

    await Promise.all(imagePromises);
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
