import { logger } from '../utils/logger';
import { DomDetector } from './dom-detector';

const STAGE_ELEMENT_ID = 'rbv-isolated-print-stage';
const STYLE_ELEMENT_ID = 'rbv-isolated-print-styles';
const CLONED_EPUB_CONTAINER_ID = 'rbv-epub-container';

export class PrintStyler {
  private static instance: PrintStyler | null = null;
  private isApplied = false;
  private lastIsFixedLayout = false;

  static getInstance(): PrintStyler {
    if (!PrintStyler.instance) {
      PrintStyler.instance = new PrintStyler();
    }
    return PrintStyler.instance;
  }

  /**
   * Prepares the page for clean isolated printing:
   * 1. Extracts the active reading chapter from Kotobee's Direct DOM (#epubContent / #epubInner)
   *    or falls back to an active reading iframe (strictly excluding #nextPage/#prevPage buffers).
   * 2. Preserves Kotobee's scoped pdf2htmlEX chapter styles (#epubContainer.stylesEnabled -> #rbv-epub-container.stylesEnabled)
   *    so Fixed-Layout (FXL) typography, background images, and absolute coordinates stay 100% pixel-accurate.
   * 3. Reads exact @media print point dimensions (e.g. 756pt x 1020.64pt) from Kotobee's stylesheet
   *    so FXL pages render 100% edge-to-edge with zero excess right/bottom margin.
   * 4. Uses clean A4 portrait layout for reflowable pages (e.g. Daftar Isi).
   */
  async applyPrintStyles(): Promise<boolean> {
    if (this.isApplied) {
      logger.info('Isolated print styles already active.');
      return true;
    }

    try {
      logger.info('Preparing Isolated Print Stage from active reading chapter...');

      // 1. Check for Kotobee Direct DOM container first (#epubContent / #epubInner)
      const directContainer = DomDetector.getActiveDirectReadingContainer();

      let bodyHtml = '';
      let scopedStylesHtml = '';
      let combinedKotobeeCss = '';
      let originalImages: HTMLImageElement[] = [];
      let isFixedLayout = false;
      let pageWidthCss = '756pt';
      let pageHeightCss = '1020.64pt';
      let wrapperClasses = 'stylesEnabled';

      if (directContainer) {
        logger.info('Detected Kotobee Direct DOM reading container (#epubContent).');
        bodyHtml = directContainer.outerHTML;

        // Preserve non-Ionic semantic classes from #epubContainer (e.g. stylesEnabled, fxl, single)
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

        // Rewrite Kotobee's scoped #epubContainer styles to target #rbv-epub-container
        const styleElements = Array.from(document.querySelectorAll('style'));
        for (const el of styleElements) {
          if (el.id === STYLE_ELEMENT_ID) continue;
          const cssText = el.textContent || '';
          if (cssText.includes('#epubContainer')) {
            combinedKotobeeCss += cssText + '\n';
            const rewrittenCss = cssText.replace(/#epubContainer\b/g, `#${CLONED_EPUB_CONTAINER_ID}`);
            scopedStylesHtml += `<style data-rbv-cloned="true">${rewrittenCss}</style>\n`;
          }
        }

        // Check if this chapter is a pdf2htmlEX Fixed-Layout (FXL) page
        const fxlChapter = directContainer.querySelector('#fxlChapter') as HTMLElement | null;
        const pfEl = directContainer.querySelector('.pf') as HTMLElement | null;
        isFixedLayout = !!(fxlChapter || pfEl);

        if (isFixedLayout) {
          const dims = this.extractFxlPrintDimensions(pfEl, fxlChapter, directContainer, combinedKotobeeCss);
          pageWidthCss = dims.width;
          pageHeightCss = dims.height;
          logger.info(`Detected Kotobee FXL print page dimensions: ${pageWidthCss} x ${pageHeightCss}`);
        }

        originalImages = Array.from(directContainer.querySelectorAll('img'));
      } else {
        // Fallback: Locate active reading iframe (strictly excluding #nextPage and #prevPage)
        const activeFrame = DomDetector.findActiveReadingFrame();
        if (!activeFrame || !activeFrame.contentDocument || !activeFrame.contentDocument.body) {
          throw new Error('Tidak dapat menemukan iframe atau kontainer bacaan aktif yang valid.');
        }

        const frameDoc = activeFrame.contentDocument;
        bodyHtml = frameDoc.body.innerHTML;
        isFixedLayout = !!frameDoc.querySelector('#fxlChapter, .pf');

        const styleElements = Array.from(frameDoc.querySelectorAll('style, link[rel="stylesheet"]'));
        for (const el of styleElements) {
          scopedStylesHtml += el.outerHTML + '\n';
          if (el.tagName === 'STYLE') {
            combinedKotobeeCss += (el.textContent || '') + '\n';
          }
        }

        if (isFixedLayout) {
          const pfEl = frameDoc.querySelector('.pf') as HTMLElement | null;
          const fxlChapter = frameDoc.querySelector('#fxlChapter') as HTMLElement | null;
          const dims = this.extractFxlPrintDimensions(pfEl, fxlChapter, frameDoc.body, combinedKotobeeCss);
          pageWidthCss = dims.width;
          pageHeightCss = dims.height;
        }

        originalImages = Array.from(frameDoc.querySelectorAll('img'));
      }

      this.lastIsFixedLayout = isFixedLayout;

      // 2. Remove any previous stage if left behind
      this.restoreStyles();

      // 3. Create the isolated print stage element
      const stageEl = document.createElement('div');
      stageEl.id = STAGE_ELEMENT_ID;
      stageEl.dataset.layout = isFixedLayout ? 'fxl' : 'reflowable';

      if (directContainer) {
        stageEl.innerHTML = `
          ${scopedStylesHtml}
          <div id="${CLONED_EPUB_CONTAINER_ID}" class="${wrapperClasses}">
            ${bodyHtml}
          </div>
        `;
      } else {
        stageEl.innerHTML = `
          ${scopedStylesHtml}
          <div class="rbv-chapter-content">
            ${bodyHtml}
          </div>
        `;
      }

      // 4. Preserve and inline loaded images (especially blob: or relative URLs)
      const stageImages = Array.from(stageEl.querySelectorAll('img'));

      for (let i = 0; i < stageImages.length; i++) {
        const origImg = originalImages[i];
        const stageImg = stageImages[i];

        if (origImg && stageImg) {
          if (origImg.currentSrc) {
            stageImg.src = origImg.currentSrc;
          }

          if (origImg.src.startsWith('blob:') && origImg.complete && origImg.naturalWidth > 0) {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = origImg.naturalWidth;
              canvas.height = origImg.naturalHeight;
              const ctx = canvas.getContext('2d');
              if (ctx) {
                ctx.drawImage(origImg, 0, 0);
                stageImg.src = canvas.toDataURL('image/png');
              }
            } catch (canvasErr) {
              logger.warn('Failed to convert blob image to data URL:', canvasErr);
            }
          }
        }
      }

      // Append stage to body
      document.body.appendChild(stageEl);

      // 5. Build clean @media print styles tailored for FXL vs Reflowable chapters
      const printCss = isFixedLayout
        ? this.buildFxlPrintCss(pageWidthCss, pageHeightCss)
        : this.buildReflowablePrintCss();

      const styleEl = document.createElement('style');
      styleEl.id = STYLE_ELEMENT_ID;
      styleEl.textContent = printCss;
      // Append to document.body (after Kotobee's body <style>) so our @page & @media print win cascade
      document.body.appendChild(styleEl);

      // Brief wait (250ms) for DOM attachment, font metrics, and image rendering
      await new Promise((r) => setTimeout(r, 250));

      this.isApplied = true;
      logger.info(`Isolated print stage ready (${isFixedLayout ? 'FXL' : 'Reflowable'}).`);
      return true;
    } catch (err) {
      logger.error('Failed to apply isolated print stage:', err);
      this.restoreStyles();
      return false;
    }
  }

  /**
   * Extracts exact print dimensions from pdf2htmlEX's @media print rules (e.g. .w0{width:756pt} .h0{height:1020.64pt}).
   * Falls back to screen pixel dimensions if @media print pt rules are not found.
   */
  private extractFxlPrintDimensions(
    pfEl: HTMLElement | null,
    fxlChapter: HTMLElement | null,
    fallbackContainer: HTMLElement,
    cssText: string
  ): { width: string; height: string } {
    if (pfEl && cssText) {
      const pfClasses = Array.from(pfEl.classList);
      const wClass = pfClasses.find((c) => /^w[0-9a-f]+$/i.test(c)) || 'w0';
      const hClass = pfClasses.find((c) => /^h[0-9a-f]+$/i.test(c)) || 'h0';

      // Match pdf2htmlEX's @media print pt definitions (e.g. .w0{width:756.000000pt;})
      const wPtRegex = new RegExp(`\\.${wClass}\\s*\\{\\s*width\\s*:\\s*([0-9.]+)\\s*pt`, 'i');
      const hPtRegex = new RegExp(`\\.${hClass}\\s*\\{\\s*height\\s*:\\s*([0-9.]+)\\s*pt`, 'i');

      const wPtMatch = cssText.match(wPtRegex);
      const hPtMatch = cssText.match(hPtRegex);

      if (wPtMatch && hPtMatch) {
        const wPt = parseFloat(wPtMatch[1]);
        const hPt = parseFloat(hPtMatch[1]);
        if (wPt > 100 && hPt > 100) {
          return {
            width: `${wPt.toFixed(2)}pt`,
            height: `${hPt.toFixed(2)}pt`
          };
        }
      }
    }

    // Fallback to screen px dimensions
    const measureEl = pfEl || fxlChapter || fallbackContainer;
    const styleAttr = (fxlChapter || fallbackContainer).getAttribute('style') || '';
    const wMatch = styleAttr.match(/width:\s*(\d+(?:\.\d+)?)px/i);
    const hMatch = styleAttr.match(/height:\s*(\d+(?:\.\d+)?)px/i);

    const wPx = Math.ceil((wMatch ? parseFloat(wMatch[1]) : 0) || measureEl.offsetWidth || 1481);
    const hPx = Math.ceil((hMatch ? parseFloat(hMatch[1]) : 0) || measureEl.offsetHeight || 2000);

    return { width: `${wPx}px`, height: `${hPx}px` };
  }

  /**
   * Pixel-perfect edge-to-edge @media print stylesheet for Kotobee Fixed-Layout (pdf2htmlEX) pages.
   * Preserves all internal .pf / .pc / .bi / .t / .c positioning and font transforms untouched.
   */
  private buildFxlPrintCss(widthCss: string, heightCss: string): string {
    return `
      /* RBV-UT Isolated Print Stage (FXL Edge-to-Edge Mode) */
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
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }

        /* Hide all Kotobee UI, sidebars, headers, footers, live #epubContainer, and extension widgets */
        body > :not(#${STAGE_ELEMENT_ID}):not(#${STYLE_ELEMENT_ID}) {
          display: none !important;
          visibility: hidden !important;
          opacity: 0 !important;
          height: 0 !important;
          overflow: hidden !important;
        }

        /* Display ONLY our isolated print stage at exact native print point dimensions */
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
          top: 0 !important;
          left: 0 !important;
          bottom: auto !important;
          right: auto !important;
          background: #ffffff !important;
          overflow: hidden !important;
          transform: none !important;
          page-break-after: avoid !important;
          break-after: avoid !important;
        }

        /* Override Kotobee's default break-after: page on .pf to prevent blank trailing page */
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

  /**
   * Clean A4 portrait @media print stylesheet for Reflowable chapters (e.g. Daftar Isi).
   */
  private buildReflowablePrintCss(): string {
    return `
      /* RBV-UT Isolated Print Stage (Reflowable A4 Mode) */
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
          min-height: 0 !important;
          overflow: visible !important;
          -webkit-print-color-adjust: exact !important;
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
          max-width: 100% !important;
          height: auto !important;
          min-height: 0 !important;
          background: #ffffff !important;
          color: #111827 !important;
          margin: 0 auto !important;
          padding: 0 !important;
          box-shadow: none !important;
          overflow: visible !important;
          font-size: 11pt !important;
          line-height: 1.6 !important;
        }

        #${STAGE_ELEMENT_ID} #${CLONED_EPUB_CONTAINER_ID},
        #${STAGE_ELEMENT_ID} .rbv-chapter-content {
          position: static !important;
          display: block !important;
          width: 100% !important;
          height: auto !important;
          margin: 0 auto !important;
          padding: 0 !important;
          overflow: visible !important;
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

  /**
   * Cleans up the isolated print stage and restores page to completely normal state
   */
  restoreStyles(): void {
    logger.info('Restoring page: removing isolated print stage...');

    const stageEl = document.getElementById(STAGE_ELEMENT_ID);
    if (stageEl && stageEl.parentNode) {
      stageEl.parentNode.removeChild(stageEl);
    }

    const styleEl = document.getElementById(STYLE_ELEMENT_ID);
    if (styleEl && styleEl.parentNode) {
      styleEl.parentNode.removeChild(styleEl);
    }

    this.isApplied = false;
    logger.info('Isolated print stage removed. Page completely intact.');
  }

  isStyleApplied(): boolean {
    return this.isApplied;
  }

  isFixedLayoutActive(): boolean {
    return this.lastIsFixedLayout;
  }
}
