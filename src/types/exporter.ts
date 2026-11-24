export type ExporterStatus =
  | 'IDLE'
  | 'INITIALIZING'
  | 'NAVIGATING'
  | 'CAPTURING_PAGE'
  | 'RETRYING'
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
  bookAuthor?: string | null;
  /** Debug option: also download each captured chapter PDF individually */
  savePerPageDebug?: boolean;
  /** Optional chapter title lookup map (chapterIndex -> title from TOC) */
  chapterTitles?: Record<number, string>;
  /** Filtered TOC items within this export range for hierarchical PDF bookmarks */
  tocItems?: TocItem[];
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

export interface FailedChapterMeta {
  chapterIndex: number;
  sequenceNumber: number;
  title: string;
  stage: 'NAVIGATE' | 'PREPARE' | 'PRINT' | 'ASSEMBLE';
  attempts: number;
  error: string;
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
  failedChapters?: FailedChapterMeta[];
  circuitBreakerTriggered?: boolean;
  resumeFromChapter?: number | null;
  elapsedMs?: number;
  errorMessage?: string;
  /** Phase 4 stitched PDF output details */
  outputFilename?: string;
  outputBytes?: number;
  totalPdfPages?: number;
  bookmarkCount?: number;
  isPartial?: boolean;
  downloadId?: number;
}

export interface ExportProgress {
  status: ExporterStatus;
  currentChapter: number;
  currentChapterIndex?: number;
  totalChaptersEstimated?: number;
  chapterTitle: string;
  moduleLabel?: string;
  startChapter?: number;
  endChapter?: number;
  phaseLabel?: string;
  message: string;
  percent?: number;
  capturedCount?: number;
  failedCount?: number;
  consecutiveFailures?: number;
  retryAttempt?: number;
  maxRetries?: number;
  totalBytes?: number;
  startedAt?: number;
  etaSeconds?: number | null;
}

export interface ExporterConfig {
  autoScrollDelayMs: number;
  renderWaitMs: number;
  paperFormat: 'A4' | 'Letter';
  printBackground: boolean;
  chapterNavigationTimeoutMs: number;
  domQuiescenceMs: number;
  maxRetriesPerChapter: number;
  cdpPrintTimeoutMs: number;
  preparePrintTimeoutMs: number;
  retryBaseDelayMs: number;
  maxConsecutiveFailures: number;
  skipFailedChapters: boolean;
}

export const DEFAULT_EXPORTER_CONFIG: ExporterConfig = {
  autoScrollDelayMs: 1500,
  renderWaitMs: 2000,
  paperFormat: 'A4',
  printBackground: true,
  chapterNavigationTimeoutMs: 20000,
  domQuiescenceMs: 450,
  maxRetriesPerChapter: 2,
  cdpPrintTimeoutMs: 35000,
  preparePrintTimeoutMs: 15000,
  retryBaseDelayMs: 1200,
  maxConsecutiveFailures: 3,
  skipFailedChapters: true
};

export interface WidgetPreferences {
  left?: number;
  top?: number;
  minimized?: boolean;
  savePerPageDebug?: boolean;
  maxRetriesPerChapter?: number;
  chapterNavigationTimeoutMs?: number;
}
