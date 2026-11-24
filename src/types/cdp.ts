/**
 * Chrome DevTools Protocol (CDP) types for Page.printToPDF
 * Based on Chrome DevTools Protocol Page domain specifications
 */

export interface PrintToPdfOptions {
  /** Paper orientation. Defaults to false (portrait). */
  landscape?: boolean;

  /** Display header and footer. Defaults to false. */
  displayHeaderFooter?: boolean;

  /** Print background graphics. Defaults to false. Set true to preserve colors/styles. */
  printBackground?: boolean;

  /** Scale of the webpage rendering. Defaults to 1 (100%). */
  scale?: number;

  /** Paper width in inches. Defaults to 8.5 (Letter) or 8.27 (A4). */
  paperWidth?: number;

  /** Paper height in inches. Defaults to 11 (Letter) or 11.69 (A4). */
  paperHeight?: number;

  /** Top margin in inches. Defaults to 1cm (~0.4 in). */
  marginTop?: number;

  /** Bottom margin in inches. Defaults to 1cm (~0.4 in). */
  marginBottom?: number;

  /** Left margin in inches. Defaults to 1cm (~0.4 in). */
  marginLeft?: number;

  /** Right margin in inches. Defaults to 1cm (~0.4 in). */
  marginRight?: number;

  /** Paper ranges to print, e.g., '1-5, 8, 11-13'. Defaults to empty string (all pages). */
  pageRanges?: string;

  /** Whether to prefer page size as defined by CSS. Defaults to false. */
  preferCSSPageSize?: boolean;

  /**
   * Whether to generate tagged (accessible) PDF. Defaults to true.
   * Crucial for NotebookLM and modern screen readers to understand text structure.
   */
  generateTaggedPDF?: boolean;

  /** Whether to embed document outline (bookmarks) if supported. */
  generateDocumentOutline?: boolean;
}

export interface PrintToPdfResponse {
  /** Base64-encoded PDF data. */
  data: string;
}

/** Standard A4 dimensions in inches */
export const A4_DIMENSIONS = {
  width: 8.27,
  height: 11.69
} as const;

/** Standard margins in inches (~10mm) */
export const DEFAULT_PDF_MARGINS = {
  top: 0.39,
  bottom: 0.39,
  left: 0.39,
  right: 0.39
} as const;
