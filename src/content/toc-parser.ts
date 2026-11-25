import { DomDetector } from './dom-detector';
import { logger } from '../utils/logger';
import type { BookStructureInfo, ModuleRange, TocItem } from '../types/exporter';

export interface ParsedKotobeeRoute {
  bookId: string | null;
  chapterIndex: number | null;
}

export class TocParser {
  /**
   * Parses Kotobee SPA hash route such as "#/book/57062/reader/chapter/3"
   */
  static parseRouteHash(hash: string = window.location.hash): ParsedKotobeeRoute {
    const bookMatch = hash.match(/book\/([^/?#]+)/i);
    const chapterMatch = hash.match(/chapter\/(\d+)/i);

    return {
      bookId: bookMatch ? bookMatch[1] : null,
      chapterIndex: chapterMatch ? parseInt(chapterMatch[1], 10) : null
    };
  }

  /**
   * Detects whether Kotobee is currently displaying Two-Page Spread mode
   */
  static isSpreadModeActive(): boolean {
    const epubContainer = document.getElementById('epubContainer');
    const spreadR = document.getElementById('spreadR');

    if (spreadR) {
      const style = window.getComputedStyle(spreadR);
      const rect = spreadR.getBoundingClientRect();
      if (style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 50) {
        return true;
      }
    }

    if (epubContainer) {
      if (epubContainer.classList.contains('double') && !epubContainer.classList.contains('single')) {
        return true;
      }
    }

    return false;
  }

  /**
   * Extracts ordered TOC entries from Kotobee's left side menu (.ion-side-menu.menu-left)
   */
  static extractTocItems(): TocItem[] {
    const leftMenu =
      document.querySelector('.ion-side-menu.menu-left') ||
      document.querySelector('.menu-left');

    if (!leftMenu) {
      logger.warn('TocParser: Left side menu (.ion-side-menu.menu-left) not found in DOM.');
      return [];
    }

    const anchors = Array.from(leftMenu.querySelectorAll('a[href*="/chapter/"]')) as HTMLAnchorElement[];
    if (anchors.length === 0) {
      logger.warn('TocParser: No chapter links found in left side menu.');
      return [];
    }

    const getUlDepth = (el: Element): number => {
      let depth = 0;
      let parent = el.parentElement;
      while (parent && parent !== leftMenu) {
        if (parent.tagName === 'UL' || parent.tagName === 'OL') {
          depth++;
        }
        parent = parent.parentElement;
      }
      return depth;
    };

    const byChapter = new Map<number, TocItem>();

    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') || '';
      const match = href.match(/chapter\/(\d+)/i);
      if (!match) continue;

      const chapterIndex = parseInt(match[1], 10);
      const rawTitle = (anchor.textContent || '').trim().replace(/\s+/g, ' ');
      const title = rawTitle || `Halaman ${chapterIndex + 1}`;
      const li = anchor.closest('li');
      const isParent = !!li?.classList.contains('parent');
      const level = getUlDepth(anchor);
      const dataUrl = anchor.getAttribute('data-url') || undefined;

      const existing = byChapter.get(chapterIndex);
      if (!existing) {
        byChapter.set(chapterIndex, {
          chapterIndex,
          title,
          href,
          dataUrl,
          level,
          isParent
        });
      } else if (isParent && !existing.isParent) {
        // Prefer parent/top-level metadata if duplicate chapter link exists
        byChapter.set(chapterIndex, {
          chapterIndex,
          title,
          href,
          dataUrl,
          level: Math.min(level, existing.level),
          isParent: true
        });
      }
    }

    const sorted = Array.from(byChapter.values()).sort((a, b) => a.chapterIndex - b.chapterIndex);
    logger.info(`TocParser: Extracted ${sorted.length} unique TOC entries.`);
    return sorted;
  }

  /**
   * Groups TOC entries into selectable Module/Section chapter ranges.
   * Each top-level section spans [startChapter .. nextSection.startChapter - 1]
   * so intermediate pages are never skipped.
   */
  static buildModuleRanges(tocItems: TocItem[], maxChapterIndex: number): ModuleRange[] {
    if (tocItems.length === 0) {
      return [];
    }

    const modules: ModuleRange[] = [];

    // 1. Identify top-level section markers (verified on Kotobee UT: level === 0 or li.parent)
    const minLevel = Math.min(...tocItems.map((item) => item.level));
    let sectionStarts = tocItems.filter((item) => item.isParent || item.level === minLevel);

    // 2. Fallback heuristic if TOC is completely flat (all items at same level and none marked .parent)
    if (sectionStarts.length === tocItems.length && tocItems.length > 12) {
      const regexMatched = tocItems.filter((item) =>
        /^(modul\s*\d+|bab\s*\d+|tinjauan|daftar\s*isi|pendahuluan|glosarium|daftar\s*pustaka)/i.test(
          item.title
        )
      );
      if (regexMatched.length >= 2) {
        sectionStarts = regexMatched;
      }
    }

    // 3. Build contiguous ranges for each top-level section
    if (sectionStarts.length > 0 && (sectionStarts.length < tocItems.length || sectionStarts.length <= 50)) {
      // If first section starts after chapter 0, add an initial front-matter range
      if (sectionStarts[0].chapterIndex > 0) {
        const end = sectionStarts[0].chapterIndex - 1;
        modules.push({
          id: `section-0-${end}`,
          title: tocItems[0]?.title || 'Halaman Awal',
          startChapter: 0,
          endChapter: end,
          pageCount: end + 1,
          level: 0
        });
      }

      for (let i = 0; i < sectionStarts.length; i++) {
        const current = sectionStarts[i];
        const next = sectionStarts[i + 1];
        const startChapter = current.chapterIndex;
        const endChapter = next ? Math.max(startChapter, next.chapterIndex - 1) : maxChapterIndex;

        modules.push({
          id: `module-${i}-${startChapter}-${endChapter}`,
          title: current.title,
          startChapter,
          endChapter,
          pageCount: endChapter - startChapter + 1,
          level: Math.max(0, current.level - minLevel)
        });
      }
    }

    // 4. Always provide a "Seluruh Buku" option at the end
    const firstCh = tocItems[0].chapterIndex;
    const totalPages = maxChapterIndex - firstCh + 1;
    modules.push({
      id: `full-book-${firstCh}-${maxChapterIndex}`,
      title: 'Seluruh Buku',
      startChapter: firstCh,
      endChapter: maxChapterIndex,
      pageCount: totalPages,
      isFullBook: true
    });

    return modules;
  }

  /**
   * Builds a complete snapshot of the book's structure, current position, and module ranges
   */
  static getBookStructure(): BookStructureInfo {
    const route = this.parseRouteHash();
    const bookTitle = DomDetector.detectBookTitle();
    const tocItems = this.extractTocItems();

    // Determine bookId from TOC link if not in current hash
    let bookId = route.bookId;
    if (!bookId && tocItems.length > 0) {
      const m = tocItems[0].href.match(/book\/([^/?#]+)/i);
      if (m) bookId = m[1];
    }

    const currentChapter = route.chapterIndex ?? 0;
    const maxTocChapter =
      tocItems.length > 0 ? tocItems[tocItems.length - 1].chapterIndex : currentChapter;
    const maxChapterIndex = Math.max(maxTocChapter, currentChapter);
    const totalChapters = tocItems.length > 0 ? maxChapterIndex + 1 : 0;

    const modules = this.buildModuleRanges(tocItems, maxChapterIndex);
    const isSpreadMode = this.isSpreadModeActive();

    return {
      bookId,
      bookTitle,
      currentChapter,
      totalChapters,
      isSpreadMode,
      tocItems,
      modules
    };
  }
}
