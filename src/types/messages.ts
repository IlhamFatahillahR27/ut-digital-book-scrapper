import type { ExportProgress, ExporterConfig } from './exporter';

export type { ExportProgress, ExporterConfig };

export type MessageType =
  | 'PING'
  | 'PONG'
  | 'GET_STATUS'
  | 'STATUS_RESPONSE'
  | 'START_EXPORT'
  | 'STOP_EXPORT'
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

export interface StopExportMessage {
  type: 'STOP_EXPORT';
  reason?: string;
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
  | StopExportMessage
  | ExportProgressMessage
  | ExportCompleteMessage
  | ExportErrorMessage;
