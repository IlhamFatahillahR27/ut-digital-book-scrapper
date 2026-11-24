import { logger } from '../utils/logger';

export class DomDetector {
  /**
   * Checks if current page is within Kotobee Reader UT
   */
  static isKotobeeReader(): boolean {
    const isDomain = window.location.hostname.includes('univterbuka.kotobee.com');
    return isDomain;
  }

  /**
   * Attempts to detect the book title from page header or document title
   */
  static detectBookTitle(): string {
    // 1. Try finding book title from header element
    const titleCandidates = [
      document.querySelector('.book-title')?.textContent,
      document.querySelector('#bookTitle')?.textContent,
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
   * Finds the reading content iframe or container
   */
  static findReadingFrame(): HTMLIFrameElement | null {
    // Kotobee often uses an iframe for reading chapters
    const iframes = Array.from(document.querySelectorAll('iframe'));
    for (const frame of iframes) {
      try {
        if (frame.contentDocument?.body) {
          return frame;
        }
      } catch {
        // Cross-origin iframe, ignore
      }
    }
    logger.debug(`Found ${iframes.length} iframes on page.`);
    return iframes[0] || null;
  }
}
