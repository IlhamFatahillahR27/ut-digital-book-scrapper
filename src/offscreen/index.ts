import type { ExtensionMessage } from '../types/messages';

interface BlobAssemblyJob {
  mimeType: string;
  parts: BlobPart[];
}

const jobs = new Map<string, BlobAssemblyJob>();

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (!message || !('target' in message) || message.target !== 'offscreen') {
    return false;
  }

  try {
    switch (message.type) {
      case 'OFFSCREEN_BLOB_INIT': {
        const { jobId, mimeType } = message.payload;
        jobs.set(jobId, {
          mimeType: mimeType || 'application/pdf',
          parts: []
        });
        sendResponse({ success: true });
        return false;
      }

      case 'OFFSCREEN_BLOB_CHUNK': {
        const { jobId, base64Chunk } = message.payload;
        const job = jobs.get(jobId);
        if (!job) {
          sendResponse({ success: false, error: `Unknown offscreen blob job: ${jobId}` });
          return false;
        }
        job.parts.push(base64ToUint8Array(base64Chunk) as unknown as BlobPart);
        sendResponse({ success: true });
        return false;
      }

      case 'OFFSCREEN_BLOB_FINALIZE': {
        const { jobId } = message.payload;
        const job = jobs.get(jobId);
        if (!job) {
          sendResponse({ success: false, error: `Unknown offscreen blob job: ${jobId}` });
          return false;
        }
        const blob = new Blob(job.parts, { type: job.mimeType });
        jobs.delete(jobId);
        const blobUrl = URL.createObjectURL(blob);
        sendResponse({ success: true, blobUrl, byteLength: blob.size });
        return false;
      }

      case 'OFFSCREEN_BLOB_REVOKE': {
        const { blobUrl } = message.payload;
        if (blobUrl) {
          URL.revokeObjectURL(blobUrl);
        }
        sendResponse({ success: true });
        return false;
      }

      default:
        return false;
    }
  } catch (err) {
    sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
});
