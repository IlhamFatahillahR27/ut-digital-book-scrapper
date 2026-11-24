export type ExporterStatus =
  | 'IDLE'
  | 'INITIALIZING'
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

export interface ExportProgress {
  status: ExporterStatus;
  currentChapter: number;
  totalChaptersEstimated?: number;
  chapterTitle: string;
  message: string;
  percent?: number;
}

export interface ExporterConfig {
  autoScrollDelayMs: number;
  renderWaitMs: number;
  paperFormat: 'A4' | 'Letter';
  printBackground: boolean;
}

export const DEFAULT_EXPORTER_CONFIG: ExporterConfig = {
  autoScrollDelayMs: 1500,
  renderWaitMs: 2000,
  paperFormat: 'A4',
  printBackground: true
};
