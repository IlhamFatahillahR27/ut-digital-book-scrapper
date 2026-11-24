import { logger } from '../utils/logger';

/** 4 MB raw bytes per IPC chunk (~5.33 MB base64, safely far under Chromium's 64 MiB message cap) */
const CHUNK_BYTE_SIZE = 4 * 1024 * 1024;
/** Max PDF size eligible for direct data: URI fallback when offscreen is unavailable */
const MAX_DATA_URI_BYTES = 10 * 1024 * 1024;
/** Safety timeout before force-revoking an offscreen Blob URL (5 minutes) */
const BLOB_REVOKE_SAFETY_MS = 5 * 60 * 1000;

export interface PdfDownloadResult {
  downloadId?: number;
  method: 'offscreen-blob' | 'data-uri' | 'content-script-blob';
}

/**
 * Reliable MV3 PDF Downloader supporting files from kilobytes up to hundreds of megabytes.
 * Primary path: Streams Uint8Array in 4MB chunks to an MV3 Offscreen Document (reason: BLOBS),
 * obtains a blob:chrome-extension:// URL, downloads via chrome.downloads.download(), and revokes
 * the Blob URL once the download completes.
 */
export class PdfDownloader {
  private pendingRevocations = new Map<number, { blobUrl: string; timerId: ReturnType<typeof setTimeout> }>();
  private downloadListenerRegistered = false;

  constructor() {
    this.ensureDownloadCleanupListener();
  }

  async downloadBytes(
    tabId: number,
    bytes: Uint8Array,
    filename: string
  ): Promise<PdfDownloadResult> {
    // 1. Primary path: MV3 Offscreen Document Blob URL + chrome.downloads
    if (typeof chrome.offscreen?.createDocument === 'function') {
      try {
        const downloadId = await this.downloadViaOffscreen(bytes, filename);
        return { downloadId, method: 'offscreen-blob' };
      } catch (err) {
        logger.warn('PdfDownloader: Offscreen download failed, falling back:', err);
      }
    }

    // 2. Secondary path (small files <= 10MB): direct data URI via chrome.downloads
    if (bytes.byteLength <= MAX_DATA_URI_BYTES) {
      try {
        const base64 = this.uint8ArrayToBase64(bytes);
        const downloadId = await chrome.downloads.download({
          url: `data:application/pdf;base64,${base64}`,
          filename,
          saveAs: false
        });
        logger.info(`PdfDownloader: Initiated data-URI download #${downloadId} for ${filename}`);
        return { downloadId, method: 'data-uri' };
      } catch (err) {
        logger.warn('PdfDownloader: Direct data-URI download failed, falling back to content script:', err);
      }
    }

    // 3. Tertiary path: chunked Blob download inside the active Kotobee tab
    await this.downloadViaContentScriptChunks(tabId, bytes, filename);
    return { method: 'content-script-blob' };
  }

  private async downloadViaOffscreen(bytes: Uint8Array, filename: string): Promise<number> {
    await this.ensureOffscreenDocument();

    const jobId = `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const initRes = (await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_BLOB_INIT',
      target: 'offscreen',
      payload: { jobId, mimeType: 'application/pdf' }
    })) as { success?: boolean; error?: string };

    if (!initRes?.success) {
      throw new Error(initRes?.error || 'OFFSCREEN_BLOB_INIT failed');
    }

    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTE_SIZE) {
      const slice = bytes.subarray(offset, Math.min(offset + CHUNK_BYTE_SIZE, bytes.byteLength));
      const base64Chunk = this.uint8ArrayToBase64(slice);
      const chunkRes = (await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_BLOB_CHUNK',
        target: 'offscreen',
        payload: { jobId, base64Chunk }
      })) as { success?: boolean; error?: string };

      if (!chunkRes?.success) {
        throw new Error(chunkRes?.error || `OFFSCREEN_BLOB_CHUNK failed at offset ${offset}`);
      }
    }

    const finRes = (await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_BLOB_FINALIZE',
      target: 'offscreen',
      payload: { jobId }
    })) as { success?: boolean; blobUrl?: string; error?: string };

    if (!finRes?.success || !finRes.blobUrl) {
      throw new Error(finRes?.error || 'OFFSCREEN_BLOB_FINALIZE did not return a blobUrl');
    }

    const blobUrl = finRes.blobUrl;
    try {
      const downloadId = await chrome.downloads.download({
        url: blobUrl,
        filename,
        saveAs: false
      });

      this.scheduleBlobRevocation(downloadId, blobUrl);
      logger.info(
        `PdfDownloader: Initiated Offscreen Blob download #${downloadId} for ${filename} ` +
          `(${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB)`
      );
      return downloadId;
    } catch (err) {
      await this.revokeBlobUrl(blobUrl);
      throw err;
    }
  }

  private async downloadViaContentScriptChunks(
    tabId: number,
    bytes: Uint8Array,
    filename: string
  ): Promise<void> {
    const jobId = `tab-pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const initRes = (await chrome.tabs.sendMessage(tabId, {
      type: 'DOWNLOAD_PDF_CHUNK_INIT',
      payload: { jobId, filename }
    })) as { success?: boolean; error?: string };

    if (!initRes?.success) {
      throw new Error(initRes?.error || 'DOWNLOAD_PDF_CHUNK_INIT failed');
    }

    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTE_SIZE) {
      const slice = bytes.subarray(offset, Math.min(offset + CHUNK_BYTE_SIZE, bytes.byteLength));
      const base64Chunk = this.uint8ArrayToBase64(slice);
      const chunkRes = (await chrome.tabs.sendMessage(tabId, {
        type: 'DOWNLOAD_PDF_CHUNK_APPEND',
        payload: { jobId, base64Chunk }
      })) as { success?: boolean; error?: string };

      if (!chunkRes?.success) {
        throw new Error(chunkRes?.error || `DOWNLOAD_PDF_CHUNK_APPEND failed at offset ${offset}`);
      }
    }

    const finRes = (await chrome.tabs.sendMessage(tabId, {
      type: 'DOWNLOAD_PDF_CHUNK_FINALIZE',
      payload: { jobId }
    })) as { success?: boolean; error?: string };

    if (!finRes?.success) {
      throw new Error(finRes?.error || 'DOWNLOAD_PDF_CHUNK_FINALIZE failed');
    }

    logger.info(
      `PdfDownloader: Initiated chunked in-page Blob download for ${filename} ` +
        `(${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB)`
    );
  }

  private async ensureOffscreenDocument(): Promise<void> {
    const offscreenUrl = chrome.runtime.getURL('offscreen.html');

    // Use chrome.runtime.getContexts when available (Chrome/Edge 116+)
    const runtimeAny = chrome.runtime as unknown as {
      getContexts?: (filter: { contextTypes: string[]; documentUrls: string[] }) => Promise<unknown[]>;
    };

    if (typeof runtimeAny.getContexts === 'function') {
      const existing = await runtimeAny.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [offscreenUrl]
      });
      if (existing.length > 0) {
        return;
      }
    }

    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: 'Create Blob URL for large merged PDF download via chrome.downloads'
      });
      logger.info('PdfDownloader: Created MV3 Offscreen Document for Blob URL handling.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('only a single offscreen document')) {
        return;
      }
      throw err;
    }
  }

  private ensureDownloadCleanupListener(): void {
    if (this.downloadListenerRegistered || !chrome.downloads?.onChanged) return;
    this.downloadListenerRegistered = true;

    chrome.downloads.onChanged.addListener((delta) => {
      const pending = this.pendingRevocations.get(delta.id);
      if (!pending) return;

      const state = delta.state?.current;
      if (state === 'complete' || state === 'interrupted') {
        clearTimeout(pending.timerId);
        this.pendingRevocations.delete(delta.id);
        this.revokeBlobUrl(pending.blobUrl).catch(() => {});
      }
    });
  }

  private scheduleBlobRevocation(downloadId: number, blobUrl: string): void {
    const timerId = setTimeout(() => {
      this.pendingRevocations.delete(downloadId);
      this.revokeBlobUrl(blobUrl).catch(() => {});
    }, BLOB_REVOKE_SAFETY_MS);

    this.pendingRevocations.set(downloadId, { blobUrl, timerId });
  }

  private async revokeBlobUrl(blobUrl: string): Promise<void> {
    try {
      await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_BLOB_REVOKE',
        target: 'offscreen',
        payload: { blobUrl }
      });
      logger.debug('PdfDownloader: Revoked Offscreen Blob URL.');
    } catch {
      // Offscreen document may already have been closed by the browser
    }
  }

  /**
   * Stack-safe Uint8Array -> base64 converter (processes 32KB sub-slices to avoid call-stack overflow)
   */
  private uint8ArrayToBase64(bytes: Uint8Array): string {
    const SLICE = 0x8000;
    const chunks: string[] = [];
    for (let i = 0; i < bytes.length; i += SLICE) {
      const sub = bytes.subarray(i, Math.min(i + SLICE, bytes.length));
      chunks.push(String.fromCharCode.apply(null, Array.from(sub)));
    }
    return btoa(chunks.join(''));
  }
}
