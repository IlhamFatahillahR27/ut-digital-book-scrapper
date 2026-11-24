import type { ExportProgress, ExporterConfig } from './exporter';

export type { ExportProgress, ExporterConfig };

export type MessageType =
  | 'PING'
  | 'PONG'
  | 'GET_STATUS'
  | 'STATUS_RESPONSE'
  | 'START_EXPORT'
  | 'START_TEST_PRINT'
  | 'PRINT_ISOLATED_PAGE'
  | 'STOP_EXPORT'
  | 'PREPARE_FOR_PRINT'
  | 'RESTORE_AFTER_PRINT'
  | 'DOWNLOAD_PDF_BLOB'
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

export interface StartExportMessage {
  type: 'START_EXPORT';
  payload?: {
    config?: Partial<ExporterConfig>;
    bookTitle?: string;
  };
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

export interface ExportProgressMessage {
  type: 'EXPORT_PROGRESS';
  payload: ExportProgress;
}

export interface ExportCompleteMessage {
  type: 'EXPORT_COMPLETE';
  payload: {
    filename: string;
    totalChapters: number;
    downloadId?: number;
  };
}

export interface ExportErrorMessage {
  type: 'EXPORT_ERROR';
  payload: {
    message: string;
    details?: string;
    recoverable?: boolean;
  };
}

export type ExtensionMessage =
  | PingMessage
  | PongMessage
  | GetStatusMessage
  | StatusResponseMessage
  | StartExportMessage
  | StartTestPrintMessage
  | PrintIsolatedPageMessage
  | StopExportMessage
  | PrepareForPrintMessage
  | RestoreAfterPrintMessage
  | DownloadPdfBlobMessage
  | ExportProgressMessage
  | ExportCompleteMessage
  | ExportErrorMessage;
