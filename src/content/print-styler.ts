import { logger } from '../utils/logger';
import { DomDetector } from './dom-detector';

const STAGE_ELEMENT_ID = 'rbv-isolated-print-stage';
const STYLE_ELEMENT_ID = 'rbv-isolated-print-styles';
const CLONED_EPUB_CONTAINER_ID = 'rbv-epub-container';

interface ClonedChapterBundle {
  contentNode: HTMLElement;
  scopedCssBlocks: string[];
  isFixedLayout: boolean;
  pageWidthCss: string;
  pageHeightCss: string;
  wrapperClasses: string;
  isDirectDom: boolean;
}

interface VectorChapterSnapshot {
  sequenceNumber: number;
  chapterIndex: number;
  scopeId: string;
  wrapperEl: HTMLElement;
  cssTexts: string[];
  isFixedLayout: boolean;
  pageWidthCss: string;
  pageHeightCss: string;
  estimatedBytes: number;
}

/**
 * AMO-safe Native Vector Print Styler (zero `.innerHTML` assignments).
 * Uses `cloneNode(true)`, `document.importNode()`, and `textContent` exclusively so
 * Mozilla's `addons-linter` reports 0 `UNSAFE_VAR_ASSIGNMENT` warnings.
 */
export class PrintStyler {
  private static instance: PrintStyler | null = null;
  private isApplied = false;
  private lastIsFixedLayout = false;
  private vectorSnapshots: VectorChapterSnapshot[] = [];

  static getInstance(): PrintStyler {
    if (!PrintStyler.instance) {
      PrintStyler.instance = new PrintStyler();
    }
    return PrintStyler.instance;
  }

  /**
   * Single active page: Prepares an isolated `@media print` stage so Firefox's native
   * `browser.tabs.saveAsPDF()` renders clean edge-to-edge vector PDF output.
   */
  async applyPrintStyles(): Promise<boolean> {
    if (this.isApplied) {
      logger.info('Isolated print styles already active.');
      return true;
    }

    try {
      logger.info('Preparing Isolated Print Stage from active reading chapter...');
      const bundle = await this.cloneActiveChapter(CLONED_EPUB_CONTAINER_ID);
      this.lastIsFixedLayout = bundle.isFixedLayout;

      this.restoreStyles();

      const stageEl = document.createElement('div');
      stageEl.id = STAGE_ELEMENT_ID;
      stageEl.dataset.layout = bundle.isFixedLayout ? 'fxl' : 'reflowable';

      for (const cssText of bundle.scopedCssBlocks) {
        const styleNode = document.createElement('style');
        styleNode.dataset.rbvCloned = 'true';
        styleNode.textContent = cssText;
        stageEl.appendChild(styleNode);
      }

      const innerWrapper = document.createElement('div');
      if (bundle.isDirectDom) {
        innerWrapper.id = CLONED_EPUB_CONTAINER_ID;
        innerWrapper.className = bundle.wrapperClasses;
      } else {
        innerWrapper.className = 'rbv-chapter-content';
      }
      innerWrapper.appendChild(bundle.contentNode);
      stageEl.appendChild(innerWrapper);

      document.body.appendChild(stageEl);

      const printCss = bundle.isFixedLayout
        ? this.buildFxlPrintCss(bundle.pageWidthCss, bundle.pageHeightCss)
        : this.buildReflowablePrintCss();

      const styleEl = document.createElement('style');
      styleEl.id = STYLE_ELEMENT_ID;
      styleEl.textContent = printCss;
      document.body.appendChild(styleEl);

      await new Promise((r) => setTimeout(r, 250));

      this.isApplied = true;
      logger.info(`Isolated print stage ready (${bundle.isFixedLayout ? 'FXL' : 'Reflowable'}).`);
      return true;
    } catch (err) {
      logger.error('Failed to apply isolated print stage:', err);
      this.restoreStyles();
      return false;
    }
  }

  /**
   * Multi-chapter batch: Captures the currently loaded Kotobee chapter as a
   * self-contained DOM snapshot with a unique CSS scope ID so multiple chapters can be
   * consolidated into one `@media print` document without style collisions.
   */
  async captureVectorSnapshot(
    sequenceNumber: number,
    chapterIndex: number
  ): Promise<{
    chapterTitle: string;
    isFixedLayout: boolean;
    estimatedBytes: number;
    snapshotCount: number;
  }> {
    const scopeId = `rbv-vec-ch-${sequenceNumber}-${chapterIndex}`;
    const bundle = await this.cloneActiveChapter(scopeId);
    this.lastIsFixedLayout = bundle.isFixedLayout;

    const sectionEl = document.createElement('section');
    sectionEl.className = bundle.isFixedLayout ? 'rbv-vec-page rbv-vec-fxl' : 'rbv-vec-page rbv-vec-reflow';
    sectionEl.dataset.chapterIndex = String(chapterIndex);

    const scopedHost = document.createElement('div');
    scopedHost.id = scopeId;
    scopedHost.className = bundle.isDirectDom ? bundle.wrapperClasses : 'rbv-chapter-content';
    scopedHost.appendChild(bundle.contentNode);
    sectionEl.appendChild(scopedHost);

    const estimatedBytes =
      (sectionEl.textContent?.length ?? 0) * 2 +
      bundle.scopedCssBlocks.reduce((acc, s) => acc + s.length, 0) +
      sectionEl.querySelectorAll('img').length * 45000;

    const existingIdx = this.vectorSnapshots.findIndex((s) => s.chapterIndex === chapterIndex);
    const snapshot: VectorChapterSnapshot = {
      sequenceNumber,
      chapterIndex,
      scopeId,
      wrapperEl: sectionEl,
      cssTexts: bundle.scopedCssBlocks,
      isFixedLayout: bundle.isFixedLayout,
      pageWidthCss: bundle.pageWidthCss,
      pageHeightCss: bundle.pageHeightCss,
      estimatedBytes
    };

    if (existingIdx >= 0) {
      this.vectorSnapshots[existingIdx] = snapshot;
    } else {
      this.vectorSnapshots.push(snapshot);
    }

    const chapterTitle = DomDetector.detectChapterTitle();
    logger.info(
      `PrintStyler: Stored vector snapshot #${this.vectorSnapshots.length} for ch/${chapterIndex} ("${chapterTitle}").`
    );

    return {
      chapterTitle,
      isFixedLayout: bundle.isFixedLayout,
      estimatedBytes,
      snapshotCount: this.vectorSnapshots.length
    };
  }

  /**
   * Mounts all collected vector chapter snapshots into `#rbv-isolated-print-stage`
   * with page breaks between chapters so a single `browser.tabs.saveAsPDF()` prints all of them.
   */
  async mountConsolidatedVectorStage(): Promise<number> {
    if (this.vectorSnapshots.length === 0) {
      return 0;
    }

    this.restoreStyles();

    const stageEl = document.createElement('div');
    stageEl.id = STAGE_ELEMENT_ID;
    stageEl.dataset.layout = 'consolidated-vector';

    const firstFxl = this.vectorSnapshots.find((s) => s.isFixedLayout);
    const pageWidthCss = firstFxl?.pageWidthCss || '210mm';
    const pageHeightCss = firstFxl?.pageHeightCss || '297mm';

    for (const snap of this.vectorSnapshots) {
      for (const cssText of snap.cssTexts) {
        const styleNode = document.createElement('style');
        styleNode.dataset.rbvCloned = 'true';
        styleNode.textContent = cssText;
        stageEl.appendChild(styleNode);
      }
      stageEl.appendChild(snap.wrapperEl);
    }

    const styleEl = document.createElement('style');
    styleEl.id = STYLE_ELEMENT_ID;
    styleEl.textContent = this.buildConsolidatedVectorPrintCss(pageWidthCss, pageHeightCss, !!firstFxl);

    document.body.appendChild(stageEl);
    document.body.appendChild(styleEl);

    await new Promise((r) => setTimeout(r, 300));
    this.isApplied = true;

    logger.info(
      `PrintStyler: Mounted consolidated vector print stage with ${this.vectorSnapshots.length} chapter(s).`
    );
    return this.vectorSnapshots.length;
  }

  clearVectorSnapshots(): void {
    this.vectorSnapshots = [];
  }

  restoreStyles(): void {
    const stageEl = document.getElementById(STAGE_ELEMENT_ID);
    if (stageEl && stageEl.parentNode) {
      stageEl.parentNode.removeChild(stageEl);
    }

    const styleEl = document.getElementById(STYLE_ELEMENT_ID);
    if (styleEl && styleEl.parentNode) {
      styleEl.parentNode.removeChild(styleEl);
    }

    this.isApplied = false;
  }

  isStyleApplied(): boolean {
    return this.isApplied;
  }

  isFixedLayoutActive(): boolean {
    return this.lastIsFixedLayout;
  }

  /**
   * Clones the active reading chapter (Direct DOM `#epubContent` or reading `iframe`)
   * strictly via DOM Node cloning (zero `.innerHTML`), rewrites Kotobee's scoped CSS
   * to target `targetScopeId`, and inlines `blob:` images as PNG data URLs.
   */
  private async cloneActiveChapter(targetScopeId: string): Promise<ClonedChapterBundle> {
    const directContainer = DomDetector.getActiveDirectReadingContainer();

    let contentNode: HTMLElement;
    const scopedCssBlocks: string[] = [];
    let combinedKotobeeCss = '';
    let originalImages: HTMLImageElement[] = [];
    let isFixedLayout = false;
    let pageWidthCss = '756pt';
    let pageHeightCss = '1020.64pt';
    let wrapperClasses = 'stylesEnabled';
    let isDirectDom = false;

    if (directContainer) {
      isDirectDom = true;
      contentNode = directContainer.cloneNode(true) as HTMLElement;

      const liveContainer = document.getElementById('epubContainer');
      if (liveContainer) {
        const keepClasses = Array.from(liveContainer.classList).filter(
          (cls) =>
            ![
              'ionic-scroll',
              'ion-content',
              'has-header',
              'has-footer',
              'scroll-content',
              'delegate-content',
              'overflow-scroll'
            ].includes(cls)
        );
        if (!keepClasses.includes('stylesEnabled')) {
          keepClasses.push('stylesEnabled');
        }
        wrapperClasses = keepClasses.join(' ');
      }

      const styleElements = Array.from(document.querySelectorAll('style'));
      for (const el of styleElements) {
        if (el.id === STYLE_ELEMENT_ID || el.dataset.rbvCloned === 'true') {
          continue;
        }
        const cssText = el.textContent || '';
        if (cssText.includes('#epubContainer')) {
          combinedKotobeeCss += cssText + '\n';
          const rewrittenCss = cssText.replace(/#epubContainer\b/g, `#${targetScopeId}`);
          scopedCssBlocks.push(rewrittenCss);
        }
      }

      const fxlChapter = directContainer.querySelector('#fxlChapter') as HTMLElement | null;
      const pfEl = directContainer.querySelector('.pf') as HTMLElement | null;
      isFixedLayout = !!(fxlChapter || pfEl);

      if (isFixedLayout) {
        const dims = this.extractFxlPrintDimensions(pfEl, fxlChapter, directContainer, combinedKotobeeCss);
        pageWidthCss = dims.widthCss;
        pageHeightCss = dims.heightCss;
      }

      originalImages = Array.from(directContainer.querySelectorAll('img'));
    } else {
      const activeFrame = DomDetector.findActiveReadingFrame();
      if (!activeFrame || !activeFrame.contentDocument || !activeFrame.contentDocument.body) {
        throw new Error('Tidak dapat menemukan iframe atau kontainer bacaan aktif yang valid.');
      }

      const frameDoc = activeFrame.contentDocument;
      const importedWrapper = document.createElement('div');
      for (const child of Array.from(frameDoc.body.childNodes)) {
        importedWrapper.appendChild(document.importNode(child, true));
      }
      contentNode = importedWrapper;
      isFixedLayout = !!frameDoc.querySelector('#fxlChapter, .pf');

      const styleElements = Array.from(frameDoc.querySelectorAll('style'));
      for (const el of styleElements) {
        const cssText = el.textContent || '';
        combinedKotobeeCss += cssText + '\n';
        scopedCssBlocks.push(cssText);
      }

      if (isFixedLayout) {
        const pfEl = frameDoc.querySelector('.pf') as HTMLElement | null;
        const fxlChapter = frameDoc.querySelector('#fxlChapter') as HTMLElement | null;
        const dims = this.extractFxlPrintDimensions(pfEl, fxlChapter, frameDoc.body, combinedKotobeeCss);
        pageWidthCss = dims.widthCss;
        pageHeightCss = dims.heightCss;
      }

      originalImages = Array.from(frameDoc.querySelectorAll('img'));
    }

    const clonedImages = Array.from(contentNode.querySelectorAll('img'));
    for (let i = 0; i < clonedImages.length; i++) {
      const origImg = originalImages[i];
      const clonedImg = clonedImages[i];
      if (!origImg || !clonedImg) continue;

      if (origImg.currentSrc) {
        clonedImg.src = origImg.currentSrc;
      }

      if (origImg.src.startsWith('blob:') && origImg.complete && origImg.naturalWidth > 0) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = origImg.naturalWidth;
          canvas.height = origImg.naturalHeight;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(origImg, 0, 0);
            clonedImg.src = canvas.toDataURL('image/png');
          }
        } catch (canvasErr) {
          logger.warn('PrintStyler: Failed to inline blob image via canvas:', canvasErr);
        }
      }
    }

    return {
      contentNode,
      scopedCssBlocks,
      isFixedLayout,
      pageWidthCss,
      pageHeightCss,
      wrapperClasses,
      isDirectDom
    };
  }

  private extractFxlPrintDimensions(
    pfEl: HTMLElement | null,
    fxlChapter: HTMLElement | null,
    fallbackContainer: HTMLElement,
    cssText: string
  ): { widthCss: string; heightCss: string } {
    if (pfEl && cssText) {
      const pfClasses = Array.from(pfEl.classList);
      const wClass = pfClasses.find((c) => /^w[0-9a-f]+$/i.test(c)) || 'w0';
      const hClass = pfClasses.find((c) => /^h[0-9a-f]+$/i.test(c)) || 'h0';

      const wPtRegex = new RegExp(`\\.${wClass}\\s*\\{\\s*width\\s*:\\s*([0-9.]+)\\s*pt`, 'i');
      const hPtRegex = new RegExp(`\\.${hClass}\\s*\\{\\s*height\\s*:\\s*([0-9.]+)\\s*pt`, 'i');

      const wPtMatch = cssText.match(wPtRegex);
      const hPtMatch = cssText.match(hPtRegex);

      if (wPtMatch && hPtMatch) {
        const wPt = parseFloat(wPtMatch[1]);
        const hPt = parseFloat(hPtMatch[1]);
        if (wPt > 100 && hPt > 100) {
          return {
            widthCss: `${wPt.toFixed(2)}pt`,
            heightCss: `${hPt.toFixed(2)}pt`
          };
        }
      }
    }

    const measureEl = pfEl || fxlChapter || fallbackContainer;
    const styleAttr = (fxlChapter || fallbackContainer).getAttribute('style') || '';
    const wMatch = styleAttr.match(/width:\s*(\d+(?:\.\d+)?)px/i);
    const hMatch = styleAttr.match(/height:\s*(\d+(?:\.\d+)?)px/i);

    const wPx = Math.ceil((wMatch ? parseFloat(wMatch[1]) : 0) || measureEl.offsetWidth || 1008);
    const hPx = Math.ceil((hMatch ? parseFloat(hMatch[1]) : 0) || measureEl.offsetHeight || 1361);

    return { widthCss: `${wPx}px`, heightCss: `${hPx}px` };
  }

  private buildFxlPrintCss(widthCss: string, heightCss: string): string {
    return `
      @media screen {
        #${STAGE_ELEMENT_ID} {
          display: none !important;
          visibility: hidden !important;
        }
      }

      @media print {
        @page {
          size: ${widthCss} ${heightCss};
          margin: 0 !important;
        }

        html, body {
          background: #ffffff !important;
          margin: 0 !important;
          padding: 0 !important;
          width: ${widthCss} !important;
          height: ${heightCss} !important;
          min-height: 0 !important;
          overflow: hidden !important;
          print-color-adjust: exact !important;
        }

        body > :not(#${STAGE_ELEMENT_ID}):not(#${STYLE_ELEMENT_ID}) {
          display: none !important;
          visibility: hidden !important;
          opacity: 0 !important;
          height: 0 !important;
          overflow: hidden !important;
        }

        body > #${STAGE_ELEMENT_ID},
        #${STAGE_ELEMENT_ID} #${CLONED_EPUB_CONTAINER_ID},
        #${STAGE_ELEMENT_ID} #epubContent,
        #${STAGE_ELEMENT_ID} #spreadL,
        #${STAGE_ELEMENT_ID} #fxlChapter {
          display: block !important;
          visibility: visible !important;
          opacity: 1 !important;
          position: static !important;
          width: ${widthCss} !important;
          height: ${heightCss} !important;
          margin: 0 !important;
          padding: 0 !important;
          background: #ffffff !important;
          overflow: hidden !important;
          transform: none !important;
          page-break-after: avoid !important;
          break-after: avoid !important;
        }

        #${STAGE_ELEMENT_ID} .pf {
          margin: 0 !important;
          box-shadow: none !important;
          break-after: avoid !important;
          page-break-after: avoid !important;
          break-inside: avoid !important;
          page-break-inside: avoid !important;
        }
      }
    `;
  }

  private buildReflowablePrintCss(): string {
    return `
      @media screen {
        #${STAGE_ELEMENT_ID} {
          display: none !important;
          visibility: hidden !important;
        }
      }

      @media print {
        @page {
          size: A4 portrait;
          margin: 12mm;
        }

        html, body {
          background: #ffffff !important;
          color: #111827 !important;
          margin: 0 !important;
          padding: 0 !important;
          width: 100% !important;
          height: auto !important;
          overflow: visible !important;
          print-color-adjust: exact !important;
        }

        body > :not(#${STAGE_ELEMENT_ID}):not(#${STYLE_ELEMENT_ID}) {
          display: none !important;
          visibility: hidden !important;
          opacity: 0 !important;
          height: 0 !important;
          overflow: hidden !important;
        }

        body > #${STAGE_ELEMENT_ID} {
          display: block !important;
          visibility: visible !important;
          opacity: 1 !important;
          position: static !important;
          width: 100% !important;
          height: auto !important;
          background: #ffffff !important;
          color: #111827 !important;
          font-size: 11pt !important;
          line-height: 1.6 !important;
        }

        #${STAGE_ELEMENT_ID} #${CLONED_EPUB_CONTAINER_ID},
        #${STAGE_ELEMENT_ID} .rbv-chapter-content {
          position: static !important;
          display: block !important;
          width: 100% !important;
          height: auto !important;
          transform: none !important;
        }

        #${STAGE_ELEMENT_ID} img,
        #${STAGE_ELEMENT_ID} svg,
        #${STAGE_ELEMENT_ID} table {
          max-width: 100% !important;
          page-break-inside: avoid !important;
          break-inside: avoid !important;
        }
      }
    `;
  }

  private buildConsolidatedVectorPrintCss(
    widthCss: string,
    heightCss: string,
    hasFxl: boolean
  ): string {
    return `
      @media screen {
        #${STAGE_ELEMENT_ID} {
          display: none !important;
          visibility: hidden !important;
        }
      }

      @media print {
        @page {
          size: ${hasFxl ? `${widthCss} ${heightCss}` : 'A4 portrait'};
          margin: ${hasFxl ? '0' : '12mm'} !important;
        }

        html, body {
          background: #ffffff !important;
          margin: 0 !important;
          padding: 0 !important;
          width: auto !important;
          height: auto !important;
          overflow: visible !important;
          print-color-adjust: exact !important;
        }

        body > :not(#${STAGE_ELEMENT_ID}):not(#${STYLE_ELEMENT_ID}) {
          display: none !important;
          visibility: hidden !important;
          opacity: 0 !important;
          height: 0 !important;
          overflow: hidden !important;
        }

        body > #${STAGE_ELEMENT_ID} {
          display: block !important;
          visibility: visible !important;
          opacity: 1 !important;
          position: static !important;
          margin: 0 !important;
          padding: 0 !important;
          background: #ffffff !important;
        }

        #${STAGE_ELEMENT_ID} .rbv-vec-page {
          display: block !important;
          position: relative !important;
          page-break-after: always !important;
          break-after: page !important;
          background: #ffffff !important;
        }

        #${STAGE_ELEMENT_ID} .rbv-vec-page:last-child {
          page-break-after: auto !important;
          break-after: auto !important;
        }

        #${STAGE_ELEMENT_ID} .rbv-vec-fxl,
        #${STAGE_ELEMENT_ID} .rbv-vec-fxl > div,
        #${STAGE_ELEMENT_ID} .rbv-vec-fxl #epubContent,
        #${STAGE_ELEMENT_ID} .rbv-vec-fxl #spreadL,
        #${STAGE_ELEMENT_ID} .rbv-vec-fxl #fxlChapter {
          display: block !important;
          position: relative !important;
          width: ${widthCss} !important;
          height: ${heightCss} !important;
          margin: 0 !important;
          padding: 0 !important;
          overflow: hidden !important;
          transform: none !important;
        }

        #${STAGE_ELEMENT_ID} .rbv-vec-reflow {
          padding: 12mm !important;
          box-sizing: border-box !important;
        }

        #${STAGE_ELEMENT_ID} .pf {
          margin: 0 !important;
          box-shadow: none !important;
          break-after: avoid !important;
          page-break-after: avoid !important;
        }
      }
    `;
  }
}
