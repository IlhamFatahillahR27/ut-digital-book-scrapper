import type {
  BatchExportSummary,
  BookStructureInfo,
  ExportProgress,
  ExportRangeRequest,
  ExporterConfig
} from './exporter';

export type {
  BatchExportSummary,
  BookStructureInfo,
  ExportProgress,
  ExportRangeRequest,
  ExporterConfig
};

export type MessageType =
  | 'PING'
  | 'PONG'
  | 'GET_STATUS'
  | 'STATUS_RESPONSE'
  | 'GET_BOOK_STRUCTURE'
  | 'ENSURE_SINGLE_PAGE_MODE'
  | 'RESTORE_PAGE_VIEW_MODE'
  | 'NAVIGATE_TO_CHAPTER'
  | 'ABORT_NAVIGATION'
  | 'CHECK_PAGE_HEALTH'
  | 'TOGGLE_WIDGET'
  | 'START_EXPORT'
  | 'START_TEST_PRINT'
  | 'PRINT_ISOLATED_PAGE'
  | 'STOP_EXPORT'
  | 'PREPARE_FOR_PRINT'
  | 'RESTORE_AFTER_PRINT'
  | 'DOWNLOAD_PDF_BLOB'
  | 'DOWNLOAD_PDF_CHUNK_INIT'
  | 'DOWNLOAD_PDF_CHUNK_APPEND'
  | 'DOWNLOAD_PDF_CHUNK_FINALIZE'
  | 'OFFSCREEN_BLOB_INIT'
  | 'OFFSCREEN_BLOB_CHUNK'
  | 'OFFSCREEN_BLOB_FINALIZE'
  | 'OFFSCREEN_BLOB_REVOKE'
  | 'EXPORT_PROGRESS'
  | 'EXPORT_COMPLETE'
  | 'EXPORT_ERROR';

export interface PingMessage {
  type: 'PING';
}

export interface PongMessage {
  type: 'PONG';
  timestamp: number;
}

export interface GetStatusMessage {
  type: 'GET_STATUS';
}

export interface StatusResponseMessage {
  type: 'STATUS_RESPONSE';
  payload: ExportProgress;
}

export interface GetBookStructureMessage {
  type: 'GET_BOOK_STRUCTURE';
}

export interface GetBookStructureResponse {
  success: boolean;
  data?: BookStructureInfo;
  error?: string;
}

export interface EnsureSinglePageModeMessage {
  type: 'ENSURE_SINGLE_PAGE_MODE';
}

export interface EnsureSinglePageModeResponse {
  success: boolean;
  wasSpreadMode: boolean;
  changed: boolean;
  message?: string;
}

export interface RestorePageViewModeMessage {
  type: 'RESTORE_PAGE_VIEW_MODE';
}

export interface RestorePageViewModeResponse {
  success: boolean;
  restored: boolean;
}

export interface NavigateToChapterMessage {
  type: 'NAVIGATE_TO_CHAPTER';
  payload: {
    targetChapter: number;
    bookId?: string | null;
    previousFingerprint?: string;
    timeoutMs?: number;
    quiescenceMs?: number;
  };
}

export interface NavigateToChapterResponse {
  success: boolean;
  actualChapter: number | null;
  chapterTitle: string;
  fingerprint: string;
  aborted?: boolean;
  error?: string;
}

export interface AbortNavigationMessage {
  type: 'ABORT_NAVIGATION';
}

export interface CheckPageHealthMessage {
  type: 'CHECK_PAGE_HEALTH';
}

export interface CheckPageHealthResponse {
  online: boolean;
  isLoginPage: boolean;
  isKotobeeReader: boolean;
  currentHash: string;
}

export interface ToggleWidgetMessage {
  type: 'TOGGLE_WIDGET';
}

export interface StartExportMessage {
  type: 'START_EXPORT';
  payload?: {
    config?: Partial<ExporterConfig>;
    bookTitle?: string;
    range?: ExportRangeRequest;
  };
}

export interface StartExportResponse {
  success: boolean;
  message?: string;
  summary?: BatchExportSummary;
  error?: string;
}

export interface StartTestPrintMessage {
  type: 'START_TEST_PRINT';
  payload?: {
    bookTitle?: string;
    chapterTitle?: string;
    config?: Partial<ExporterConfig>;
  };
}

export interface PrintIsolatedPageMessage {
  type: 'PRINT_ISOLATED_PAGE';
  payload: {
    html: string;
    headHtml: string;
    baseUri: string;
    chapterTitle: string;
    bookTitle: string;
  };
}

export interface StopExportMessage {
  type: 'STOP_EXPORT';
  reason?: string;
}

export interface PrepareForPrintMessage {
  type: 'PREPARE_FOR_PRINT';
}

export interface PrepareForPrintResponse {
  success: boolean;
  chapterTitle: string;
  estimatedPages?: number;
  isFixedLayout?: boolean;
  error?: string;
}

export interface RestoreAfterPrintMessage {
  type: 'RESTORE_AFTER_PRINT';
}

export interface RestoreAfterPrintResponse {
  success: boolean;
}

export interface DownloadPdfBlobMessage {
  type: 'DOWNLOAD_PDF_BLOB';
  payload: {
    base64Data: string;
    filename: string;
  };
}

export interface DownloadPdfChunkInitMessage {
  type: 'DOWNLOAD_PDF_CHUNK_INIT';
  payload: {
    jobId: string;
    filename: string;
  };
}

export interface DownloadPdfChunkAppendMessage {
  type: 'DOWNLOAD_PDF_CHUNK_APPEND';
  payload: {
    jobId: string;
    base64Chunk: string;
  };
}

export interface DownloadPdfChunkFinalizeMessage {
  type: 'DOWNLOAD_PDF_CHUNK_FINALIZE';
  payload: {
    jobId: string;
  };
}

export interface OffscreenBlobInitMessage {
  type: 'OFFSCREEN_BLOB_INIT';
  target: 'offscreen';
  payload: {
    jobId: string;
    mimeType?: string;
  };
}

export interface OffscreenBlobChunkMessage {
  type: 'OFFSCREEN_BLOB_CHUNK';
  target: 'offscreen';
  payload: {
    jobId: string;
    base64Chunk: string;
  };
}

export interface OffscreenBlobFinalizeMessage {
  type: 'OFFSCREEN_BLOB_FINALIZE';
  target: 'offscreen';
  payload: {
    jobId: string;
  };
}

export interface OffscreenBlobRevokeMessage {
  type: 'OFFSCREEN_BLOB_REVOKE';
  target: 'offscreen';
  payload: {
    blobUrl: string;
  };
}

export interface ExportProgressMessage {
  type: 'EXPORT_PROGRESS';
  payload: ExportProgress;
}

export interface ExportCompleteMessage {
  type: 'EXPORT_COMPLETE';
  payload: {
    filename: string;
    totalChapters: number;
    totalPdfPages?: number;
    bookmarkCount?: number;
    outputBytes?: number;
    isPartial?: boolean;
    downloadId?: number;
    summary?: BatchExportSummary;
  };
}

export interface ExportErrorMessage {
  type: 'EXPORT_ERROR';
  payload: {
    message: string;
    details?: string;
    recoverable?: boolean;
    partialFilename?: string;
    summary?: BatchExportSummary;
  };
}

export type ExtensionMessage =
  | PingMessage
  | PongMessage
  | GetStatusMessage
  | StatusResponseMessage
  | GetBookStructureMessage
  | EnsureSinglePageModeMessage
  | RestorePageViewModeMessage
  | NavigateToChapterMessage
  | AbortNavigationMessage
  | CheckPageHealthMessage
  | ToggleWidgetMessage
  | StartExportMessage
  | StartTestPrintMessage
  | PrintIsolatedPageMessage
  | StopExportMessage
  | PrepareForPrintMessage
  | RestoreAfterPrintMessage
  | DownloadPdfBlobMessage
  | DownloadPdfChunkInitMessage
  | DownloadPdfChunkAppendMessage
  | DownloadPdfChunkFinalizeMessage
  | OffscreenBlobInitMessage
  | OffscreenBlobChunkMessage
  | OffscreenBlobFinalizeMessage
  | OffscreenBlobRevokeMessage
  | ExportProgressMessage
  | ExportCompleteMessage
  | ExportErrorMessage;
