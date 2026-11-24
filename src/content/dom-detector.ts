import { logger } from '../utils/logger';

export interface DomDiagnosticReport {
  url: string;
  hash: string;
  hasKotobeeGlobal: boolean;
  kotobeeKeys?: string[];
  epubContainer?: {
    id: string;
    className: string;
    rect: { width: number; height: number; top: number; left: number };
    children: Array<{
      tag: string;
      id: string;
      className: string;
      rect: { width: number; height: number; top: number; left: number };
      style: string;
    }>;
  };
  iframes: Array<{
    index: number;
    id: string;
    className: string;
    src: string;
    rect: { width: number; height: number; top: number; left: number };
    docAccessible: boolean;
    innerLen: number;
    innerTextSnippet: string;
    bodyScrollHeight?: number;
    bodyScrollWidth?: number;
    computedDisplay?: string;
    computedVisibility?: string;
  }>;
  keyContainers: Array<{
    tag: string;
    id: string;
    className: string;
    display: string;
    visibility: string;
    position: string;
    rect: { width: number; height: number; top: number; left: number };
  }>;
}

export class DomDetector {
  /**
   * Checks if current page is within Kotobee Reader UT
   */
  static isKotobeeReader(): boolean {
    const isDomain = window.location.hostname.includes('univterbuka.kotobee.com') ||
      window.location.hostname.includes('kotobee.com');
    return isDomain;
  }

  /**
   * Attempts to detect the book title from page header or document title
   */
  static detectBookTitle(): string {
    const titleCandidates = [
      document.querySelector('.book-title')?.textContent,
      document.querySelector('#bookTitle')?.textContent,
      document.querySelector('.reader-book-title')?.textContent,
      document.querySelector('header h1')?.textContent,
      document.querySelector('.header-title')?.textContent,
      document.title
    ];

    for (const candidate of titleCandidates) {
      if (candidate && candidate.trim().length > 0) {
        const cleaned = candidate.trim().replace(/\s+/g, ' ');
        if (!cleaned.toLowerCase().includes('kotobee reader') && cleaned.length > 2) {
          return cleaned;
        }
      }
    }

    return document.title || 'Buku_Materi_Pokok_UT';
  }

  /**
   * Attempts to detect the book author from Kotobee's left sidebar metadata
   */
  static detectBookAuthor(): string | null {
    const authorCandidates = [
      document.querySelector('.ion-side-menu.menu-left .book-author')?.textContent,
      document.querySelector('.ion-side-menu.menu-left .author')?.textContent,
      document.querySelector('.ion-side-menu.menu-left [class*="author"]')?.textContent,
      document.querySelector('.book-author')?.textContent,
      document.querySelector('#bookAuthor')?.textContent
    ];

    for (const candidate of authorCandidates) {
      if (candidate && candidate.trim().length > 1) {
        const cleaned = candidate.trim().replace(/\s+/g, ' ');
        if (!cleaned.toLowerCase().includes('kotobee')) {
          return cleaned;
        }
      }
    }

    // Kotobee UT often renders cover thumbnail + title + author in the top header of .menu-left
    const leftHeader = document.querySelector(
      '.ion-side-menu.menu-left .book-info, .ion-side-menu.menu-left .bookInfo, .ion-side-menu.menu-left header, .ion-side-menu.menu-left .bar-header'
    );
    if (leftHeader) {
      const bookTitle = this.detectBookTitle().toLowerCase();
      const lines = (leftHeader.textContent || '')
        .split('\n')
        .map((l) => l.trim().replace(/\s+/g, ' '))
        .filter((l) => l.length > 2 && l.toLowerCase() !== bookTitle && !/table of contents/i.test(l));
      if (lines.length > 0) {
        return lines[0];
      }
    }

    return null;
  }

  /**
   * Normalizes text for robust chapter title matching:
   * - Converts to lowercase
   * - Normalizes leading zeros (e.g. 'modul 01' -> 'modul 1')
   * - Removes non-alphanumeric punctuation while preserving single spaces
   */
  static normalizeText(str: string): string {
    return str
      .toLowerCase()
      .replace(/\b0+([1-9])/g, '$1')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Identifies whether an iframe is the Table of Contents (TOC) navigation list
   * rather than an actual reading book page.
   */
  static isTocFrame(f: HTMLIFrameElement): boolean {
    try {
      // 1. Ancestor check: Inside sidebar, menu-left, or TOC container
      if (f.closest('.ion-side-menu, .menu-left, .toc-container, #toc, [class*="toc"]')) {
        return true;
      }

      // If the iframe is inside the reader's book container (#epubContainer, #readerBody, .ebook-content),
      // it is a real book reading slide (even if the chapter itself is the printed "Daftar Isi").
      if (f.closest('#epubContainer, #readerBody, .ebook-content')) {
        return false;
      }

      const fDoc = f.contentDocument;
      if (!fDoc || !fDoc.body) return false;

      // 2. Element check: Has nav[epub:type="toc"], nav#toc, or ol/ul with class toc
      if (fDoc.querySelector('nav[epub\\:type="toc"], nav#toc, .toc-list, ol.toc, ul.toc')) {
        return true;
      }

      // 3. Density of chapter links (> 8 links pointing to chapters or book pages)
      const chapterLinks = fDoc.querySelectorAll('a[href*="chapter"], a[href*="ch"], li a');
      if (chapterLinks.length > 8) {
        return true;
      }

      // 4. Content check: Contains list of multiple consecutive modules (e.g. MODUL 1, MODUL 2, MODUL 3)
      const bodyText = (fDoc.body.innerText || '').toLowerCase();
      if (bodyText.includes('modul 1') && bodyText.includes('modul 2') && bodyText.includes('modul 3')) {
        return true;
      }

      // 5. Title / Heading check: Is explicitly "DAFTAR ISI" or "Table of Contents" with multiple list items
      const title = (fDoc.title || '').toLowerCase();
      if (
        (title.includes('table of contents') || title.includes('daftar isi')) &&
        fDoc.querySelectorAll('li').length > 5
      ) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Fast raw detection of the current chapter title from top bar, TOC, or URL hash
   */
  static detectRawChapterTitle(): string {
    // 1. Try finding title from header element (Kotobee's top bar)
    const headerTitleEl = document.querySelector('.readerheader, .reader-header, .header-title, .bar-header .title');
    if (headerTitleEl && headerTitleEl.textContent) {
      let cleaned = headerTitleEl.textContent.trim().replace(/\s+/g, ' ');
      // Strip leading '< Library' or 'Library' navigation prefix
      cleaned = cleaned.replace(/^[<«\s]*Library[\s\-_|]*/i, '').trim();
      if (cleaned.length > 1 && !cleaned.toLowerCase().includes('kotobee')) {
        return cleaned;
      }
    }

    // 2. Try finding active chapter in Kotobee TOC / sidebar
    const tocActiveCandidates = [
      document.querySelector('.ion-side-menu.menu-left .currentChapter')?.textContent,
      document.querySelector('.ion-side-menu.menu-left .item.selected')?.textContent,
      document.querySelector('.currentChapter')?.textContent,
      document.querySelector('.ion-side-menu.menu-left .active')?.textContent,
      document.querySelector('.ion-side-menu.menu-left [selected="true"]')?.textContent,
      document.querySelector('.toc-item.active')?.textContent,
      document.querySelector('.chapter-item.active')?.textContent,
      document.querySelector('.active-chapter')?.textContent,
      document.querySelector('#currentChapterTitle')?.textContent,
      document.querySelector('.chapter-title')?.textContent,
      document.querySelector('[selected="true"]')?.textContent
    ];

    for (const candidate of tocActiveCandidates) {
      if (candidate && candidate.trim().length > 0) {
        const cleaned = candidate.trim().replace(/\s+/g, ' ');
        if (cleaned.length > 1 && !cleaned.toLowerCase().includes('kotobee')) {
          return cleaned;
        }
      }
    }

    // 3. Fallback based on URL hash (e.g. #/book/123/reader/chapter/2)
    const hash = window.location.hash;
    const match = hash.match(/chapter\/(\d+)/i);
    if (match && match[1]) {
      const chapterNum = parseInt(match[1], 10) + 1;
      return `Halaman_${chapterNum}`;
    }

    return 'Bab_Aktif';
  }

  /**
   * Checks if Kotobee is rendering via direct DOM in #epubContent / #epubInner (FXL mode)
   */
  static getActiveDirectReadingContainer(): HTMLElement | null {
    const epubContent = document.getElementById('epubContent');
    if (epubContent && epubContent.innerHTML.trim().length > 50) {
      return epubContent;
    }
    const epubInner = document.getElementById('epubInner');
    if (epubInner && epubInner.innerHTML.trim().length > 50) {
      return epubInner;
    }
    return null;
  }

  /**
   * Identifies the currently active reading iframe that is visible to the user on screen.
   * NOTE: Kotobee renders preloaded flip buffers in #nextPage and #prevPage with hidden visibility.
   * These animation buffer iframes MUST be strictly excluded.
   */
  static findActiveReadingFrame(): HTMLIFrameElement | null {
    const allIframes = Array.from(document.querySelectorAll('iframe'));

    // Strictly exclude animation flip buffers (#nextPage and #prevPage)
    const nonBufferIframes = allIframes.filter((f) => {
      if (f.closest('#nextPage, #prevPage, [id*="nextPage"], [id*="prevPage"]')) {
        logger.debug('Filtered out animation buffer iframe (#nextPage / #prevPage).');
        return false;
      }
      return true;
    });

    // Prefer iframes inside #epubContainer, #readerBody, or .ebook-content
    const containerIframes = nonBufferIframes.filter((f) =>
      f.closest('#epubContainer, #readerBody, .ebook-content')
    );

    const candidatePool = containerIframes.length > 0 ? containerIframes : nonBufferIframes;

    // Filter out unaccessible frames and Table of Contents frames
    const accessibleReadingFrames = candidatePool.filter((f) => {
      try {
        if (!f.contentDocument?.body) return false;
        if (f.contentDocument.body.innerHTML.trim().length < 20) return false;
        if (this.isTocFrame(f)) {
          logger.info('Filtered out Table of Contents iframe from reading candidate frames.');
          return false;
        }
        return true;
      } catch {
        return false;
      }
    });

    if (accessibleReadingFrames.length === 0) {
      const fallback = allIframes.filter(f => !this.isTocFrame(f) && f.contentDocument?.body);
      return fallback[0] || allIframes[0] || null;
    }

    if (accessibleReadingFrames.length === 1) {
      logger.info('Found exactly 1 active reading iframe.');
      return accessibleReadingFrames[0];
    }

    logger.info(`Evaluating ${accessibleReadingFrames.length} candidate reading iframes in Ionic slider...`);

    // Extract target chapter index from URL hash (e.g. #/book/57062/reader/chapter/6)
    const hash = window.location.hash;
    const chapterMatch = hash.match(/chapter\/(\d+)/i);
    const targetChapterIdx = chapterMatch ? parseInt(chapterMatch[1], 10) : null;
    const rawChapterTitle = this.detectRawChapterTitle();
    const normTitle = this.normalizeText(rawChapterTitle);

    let bestFrame = accessibleReadingFrames[0];
    let maxScore = -99999;

    for (let i = 0; i < accessibleReadingFrames.length; i++) {
      const f = accessibleReadingFrames[i];
      let score = 0;

      try {
        const fRect = f.getBoundingClientRect();
        const parent = f.parentElement;
        const pRect = parent ? parent.getBoundingClientRect() : null;

        // Find the slide wrapper in Ionic/Swiper carousel
        const slideWrapper = f.closest('.slider-slide, [class*="slide"], .scroll, .pane') || parent;
        const sRect = slideWrapper ? slideWrapper.getBoundingClientRect() : null;
        const sTransform = slideWrapper ? window.getComputedStyle(slideWrapper).transform : '';

        // Determine effective horizontal position on screen
        const left = sRect && sRect.width > 50 ? sRect.left : (pRect && pRect.width > 50 ? pRect.left : fRect.left);
        const width = sRect && sRect.width > 50 ? sRect.width : (pRect && pRect.width > 50 ? pRect.width : fRect.width);

        // 1. CAROUSEL POSITIONING SCORE (Crucial for Ionic triple-buffer)
        if (left >= -80 && left < window.innerWidth * 0.75 && width > 100) {
          // This slide is squarely rendered in the active reading viewport
          score += 500;
          logger.debug(`Iframe #${i}: ON-SCREEN active viewport (left: ${left}, width: ${width}) (+500)`);
        } else if (left < -150) {
          // Previous slide translated off-screen to the left
          score -= 500;
          logger.debug(`Iframe #${i}: OFF-SCREEN LEFT previous slide (left: ${left}) (-500)`);
        } else if (left > window.innerWidth * 0.8) {
          // Next slide translated off-screen to the right
          score -= 500;
          logger.debug(`Iframe #${i}: OFF-SCREEN RIGHT next slide (left: ${left}) (-500)`);
        }

        // 2. Check CSS Transform: translate3d(0, ...) or none indicates the active slide
        if (!sTransform || sTransform === 'none' || sTransform.includes('(0,') || sTransform.includes('(0px,')) {
          score += 100;
        }

        // 3. Check active classes on slide wrapper or iframe
        if (
          (slideWrapper &&
            (slideWrapper.classList.contains('active') ||
              slideWrapper.classList.contains('current') ||
              slideWrapper.classList.contains('selected') ||
              slideWrapper.classList.contains('swiper-slide-active'))) ||
          f.classList.contains('active')
        ) {
          score += 150;
        }

        // 4. Content length check (a valid reading page has substantial text or markup)
        const docLen = f.contentDocument?.body?.innerHTML?.length || 0;
        if (docLen > 100) {
          score += 50;
        }

        // 5. Target chapter match from URL hash
        if (targetChapterIdx !== null) {
          const src = (f.src || '').toLowerCase();
          const id = (f.id || '').toLowerCase();
          const chPattern = new RegExp(`(?:chapter[_-]?|ch[_-]?|\\/)0*${targetChapterIdx}(?:\\.[a-z]+|\\/|$)`, 'i');
          if (chPattern.test(src) || chPattern.test(id)) {
            score += 2000;
            logger.debug(`Iframe #${i}: Exact chapter index ${targetChapterIdx} matched in src/id (+2000)`);
          }
        }

        // 6. Chapter title content match
        if (normTitle && normTitle !== 'bab aktif' && !normTitle.startsWith('halaman')) {
          const bodyText = this.normalizeText(f.contentDocument?.body?.innerText || '');
          const frameDocTitle = this.normalizeText(f.contentDocument?.title || '');
          if (bodyText.includes(normTitle) || frameDocTitle.includes(normTitle)) {
            score += 2500;
            logger.debug(`Iframe #${i}: Document content/title matches "${normTitle}" (+2500)`);
          }
        }

        // 7. Two-page spread preference: Left-hand page is primary for active chapter
        if (left >= -80 && left < window.innerWidth * 0.45) {
          score += 300;
          logger.debug(`Iframe #${i}: Left-hand page in two-page spread (+300)`);
        }

        console.log(`[RBV-UT] Evaluated Reading Slide #${i}:`, {
          score,
          left,
          width,
          transform: sTransform,
          docLen
        });
      } catch (err) {
        logger.warn(`Error scoring reading iframe #${i}:`, err);
      }

      if (score > maxScore) {
        maxScore = score;
        bestFrame = f;
      }
    }

    logger.info(`Selected active on-screen reading iframe (score: ${maxScore})`);
    return bestFrame;
  }

  /**
   * Attempts to detect the title of the currently active chapter
   */
  static detectChapterTitle(): string {
    // 1. Raw chapter title from top bar or TOC is the primary source of truth for current reading page
    const rawTitle = this.detectRawChapterTitle();
    if (rawTitle && rawTitle !== 'Bab_Aktif' && !rawTitle.startsWith('Halaman_')) {
      return rawTitle;
    }

    // 2. Check if the active iframe has an explicit heading
    const activeFrame = this.findActiveReadingFrame();
    if (activeFrame && activeFrame.contentDocument) {
      try {
        const frameDoc = activeFrame.contentDocument;
        const frameTitleCandidates = [
          frameDoc.querySelector('h1')?.textContent,
          frameDoc.querySelector('h2')?.textContent,
          frameDoc.querySelector('.chapter-title')?.textContent,
          frameDoc.querySelector('.title')?.textContent,
          frameDoc.title
        ];

        for (const candidate of frameTitleCandidates) {
          if (candidate && candidate.trim().length > 0) {
            const cleaned = candidate.trim().replace(/\s+/g, ' ');
            if (cleaned.length > 2 && !cleaned.toLowerCase().includes('kotobee')) {
              return cleaned;
            }
          }
        }
      } catch {
        // Cross-origin fallback
      }
    }

    return rawTitle;
  }

  /**
   * Finds the reading content iframe or container
   */
  static findReadingFrame(): HTMLIFrameElement | null {
    return this.findActiveReadingFrame();
  }

  /**
   * Estimates page count based on A4 pixel height (~1050px at 96 DPI)
   */
  static estimatePageCount(): number {
    const iframe = this.findActiveReadingFrame();
    let scrollHeight = 0;

    if (iframe && iframe.contentDocument) {
      try {
        scrollHeight = Math.max(
          iframe.contentDocument.body.scrollHeight,
          iframe.contentDocument.documentElement.scrollHeight
        );
      } catch {
        scrollHeight = 0;
      }
    }

    if (!scrollHeight) {
      scrollHeight = document.documentElement.scrollHeight || 1000;
    }

    return Math.max(1, Math.ceil(scrollHeight / 1000));
  }

  /**
   * Generates a comprehensive diagnostic report of Kotobee's DOM structure
   */
  static getDiagnosticReport(): DomDiagnosticReport {
    const iframes = Array.from(document.querySelectorAll('iframe')).map((f, i) => {
      let innerLen = 0;
      let innerTextSnippet = '';
      let docAccessible = false;
      let bodyScrollHeight: number | undefined;
      let bodyScrollWidth: number | undefined;
      let computedDisplay: string | undefined;
      let computedVisibility: string | undefined;

      try {
        const style = window.getComputedStyle(f);
        computedDisplay = style.display;
        computedVisibility = style.visibility;

        if (f.contentDocument && f.contentDocument.body) {
          docAccessible = true;
          innerLen = f.contentDocument.body.innerHTML.length;
          innerTextSnippet = (f.contentDocument.body.innerText || '')
            .substring(0, 200)
            .replace(/\s+/g, ' ');
          bodyScrollHeight = f.contentDocument.body.scrollHeight;
          bodyScrollWidth = f.contentDocument.body.scrollWidth;
        }
      } catch {
        docAccessible = false;
      }

      const rect = f.getBoundingClientRect();
      return {
        index: i,
        id: f.id,
        className: f.className,
        src: f.src ? f.src.substring(0, 100) : '',
        rect: {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          top: Math.round(rect.top),
          left: Math.round(rect.left)
        },
        docAccessible,
        innerLen,
        innerTextSnippet,
        bodyScrollHeight,
        bodyScrollWidth,
        computedDisplay,
        computedVisibility
      };
    });

    // Inspect #epubContainer and its internal tree
    const epubEl = document.getElementById('epubContainer');
    let epubContainerData: DomDiagnosticReport['epubContainer'];

    if (epubEl) {
      const rect = epubEl.getBoundingClientRect();
      const children = Array.from(epubEl.querySelectorAll('*')).slice(0, 25).map((child) => {
        const cRect = child.getBoundingClientRect();
        return {
          tag: child.tagName.toLowerCase(),
          id: child.id,
          className: child.className ? String(child.className).substring(0, 50) : '',
          rect: {
            width: Math.round(cRect.width),
            height: Math.round(cRect.height),
            top: Math.round(cRect.top),
            left: Math.round(cRect.left)
          },
          style: (child.getAttribute('style') || '').substring(0, 100)
        };
      });

      epubContainerData = {
        id: epubEl.id,
        className: epubEl.className,
        rect: {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          top: Math.round(rect.top),
          left: Math.round(rect.left)
        },
        children
      };
    }

    let kotobeeKeys: string[] | undefined;
    try {
      const kb = (window as unknown as { kotobee?: Record<string, unknown> }).kotobee;
      if (kb && typeof kb === 'object') {
        kotobeeKeys = Object.keys(kb).slice(0, 25);
      }
    } catch {
      // Ignore
    }

    const keySelectors = [
      'ion-app',
      'ion-side-menus',
      'ion-side-menu',
      '#readerBody',
      '#epubContainer',
      '#book',
      '.book',
      '.page',
      '[class*="zoom"]',
      '[id*="zoom"]'
    ];

    const keyContainers: DomDiagnosticReport['keyContainers'] = [];
    const seen = new Set<Element>();

    for (const sel of keySelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of Array.from(els)) {
        if (seen.has(el)) continue;
        seen.add(el);

        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        keyContainers.push({
          tag: el.tagName.toLowerCase(),
          id: el.id,
          className: el.className ? String(el.className).substring(0, 80) : '',
          display: style.display,
          visibility: style.visibility,
          position: style.position,
          rect: {
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            top: Math.round(rect.top),
            left: Math.round(rect.left)
          }
        });
      }
    }

    return {
      url: window.location.href,
      hash: window.location.hash,
      hasKotobeeGlobal: typeof (window as unknown as { kotobee?: unknown }).kotobee !== 'undefined',
      kotobeeKeys,
      epubContainer: epubContainerData,
      iframes,
      keyContainers
    };
  }
}
