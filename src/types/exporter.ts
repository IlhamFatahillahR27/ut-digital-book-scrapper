export type ExporterStatus =
  | 'IDLE'
  | 'INITIALIZING'
  | 'NAVIGATING'
  | 'CAPTURING_PAGE'
  | 'WAITING_NEXT'
  | 'STITCHING'
  | 'COMPLETED'
  | 'STOPPED'
  | 'ERROR';

export interface ChapterInfo {
  index: number;
  title: string;
  url?: string;
  elementSelector?: string;
}

export interface TocItem {
  chapterIndex: number;
  title: string;
  href: string;
  dataUrl?: string;
  level: number;
  isParent: boolean;
}

export interface ModuleRange {
  id: string;
  title: string;
  startChapter: number;
  endChapter: number;
  pageCount: number;
  isFullBook?: boolean;
}

export interface BookStructureInfo {
  bookId: string | null;
  bookTitle: string;
  currentChapter: number;
  totalChapters: number;
  isSpreadMode: boolean;
  tocItems: TocItem[];
  modules: ModuleRange[];
}

export interface ExportRangeRequest {
  startChapter: number;
  endChapter: number;
  label: string;
  bookId?: string | null;
  bookTitle?: string;
  /** Debug option in Phase 3: download each captured chapter PDF individually */
  savePerPageDebug?: boolean;
  /** Optional chapter title lookup map (chapterIndex -> title from TOC) */
  chapterTitles?: Record<number, string>;
}

export interface CapturedChapterMeta {
  chapterIndex: number;
  sequenceNumber: number;
  title: string;
  byteLength: number;
  isFixedLayout: boolean;
  durationMs: number;
  validPdfHeader: boolean;
}

export interface BatchExportSummary {
  status: 'COMPLETED' | 'STOPPED' | 'ERROR';
  label: string;
  startChapter: number;
  endChapter: number;
  totalRequested: number;
  capturedCount: number;
  failedCount: number;
  totalBytes: number;
  lastChapterIndex: number | null;
  chapters: CapturedChapterMeta[];
  errorMessage?: string;
}

export interface ExportProgress {
  status: ExporterStatus;
  currentChapter: number;
  currentChapterIndex?: number;
  totalChaptersEstimated?: number;
  chapterTitle: string;
  message: string;
  percent?: number;
  capturedCount?: number;
  totalBytes?: number;
}

export interface ExporterConfig {
  autoScrollDelayMs: number;
  renderWaitMs: number;
  paperFormat: 'A4' | 'Letter';
  printBackground: boolean;
  chapterNavigationTimeoutMs: number;
  domQuiescenceMs: number;
  maxRetriesPerChapter: number;
}

export const DEFAULT_EXPORTER_CONFIG: ExporterConfig = {
  autoScrollDelayMs: 1500,
  renderWaitMs: 2000,
  paperFormat: 'A4',
  printBackground: true,
  chapterNavigationTimeoutMs: 20000,
  domQuiescenceMs: 450,
  maxRetriesPerChapter: 1
};
