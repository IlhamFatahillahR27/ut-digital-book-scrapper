import { PDFDocument } from 'pdf-lib';
import { logger } from '../utils/logger';
import { attachOutlinesToPdf, buildOutlineTree } from './pdf-outlines';
import type { CapturedChapterMeta, TocItem } from '../types/exporter';

export interface PdfAssemblyMetadata {
  bookTitle: string;
  label: string;
  author?: string | null;
  isPartial?: boolean;
}

export interface PdfAssemblyResult {
  bytes: Uint8Array;
  totalPages: number;
  bookmarkCount: number;
}

/**
 * Incremental PDF Assembler powered by pdf-lib.
 * Ingests each captured chapter buffer as soon as it arrives and discards the source document
 * immediately so memory usage stays bounded during large module or full-book exports.
 */
export class PdfAssembler {
  private masterDoc: PDFDocument | null = null;
  private chapterPageMap = new Map<number, number>();
  private ingestedChapters: CapturedChapterMeta[] = [];
  private totalPages = 0;
  private metadata: PdfAssemblyMetadata | null = null;

  async init(metadata: PdfAssemblyMetadata): Promise<void> {
    this.dispose();
    this.metadata = metadata;
    this.masterDoc = await PDFDocument.create();

    const docTitle = this.formatDocumentTitle(metadata);
    this.masterDoc.setTitle(docTitle, { showInWindowTitleBar: true });
    this.masterDoc.setAuthor(metadata.author?.trim() || 'Universitas Terbuka');
    this.masterDoc.setSubject(`Buku Materi Pokok (BMP) Universitas Terbuka — ${metadata.label}`);
    this.masterDoc.setKeywords(['Universitas Terbuka', 'BMP', 'RBV-UT', 'NotebookLM', metadata.bookTitle]);
    this.masterDoc.setCreator('RBV-UT to PDF Exporter');
    this.masterDoc.setProducer('RBV-UT to PDF Exporter (pdf-lib)');
    this.masterDoc.setCreationDate(new Date());
    this.masterDoc.setModificationDate(new Date());

    logger.info(`PdfAssembler: Initialized master PDFDocument ("${docTitle}").`);
  }

  /**
   * Incrementally loads a single captured chapter PDF buffer and copies its pages into masterDoc.
   */
  async appendChapter(buffer: Uint8Array, meta: CapturedChapterMeta): Promise<number> {
    if (!this.masterDoc) {
      throw new Error('PdfAssembler.init() must be called before appendChapter().');
    }

    if (!buffer || buffer.byteLength < 100) {
      throw new Error(`Buffer PDF tidak valid untuk chapter/${meta.chapterIndex} (${buffer?.byteLength ?? 0} bytes).`);
    }

    if (!meta.validPdfHeader) {
      logger.warn(`PdfAssembler: Chapter/${meta.chapterIndex} missing standard %PDF- header; attempting load anyway.`);
    }

    const srcDoc = await PDFDocument.load(buffer, {
      ignoreEncryption: true,
      updateMetadata: false
    });

    const pageIndices = srcDoc.getPageIndices();
    if (pageIndices.length === 0) {
      logger.warn(`PdfAssembler: Chapter/${meta.chapterIndex} contains 0 pages; skipping.`);
      return 0;
    }

    const startPageIndex = this.totalPages;
    const copiedPages = await this.masterDoc.copyPages(srcDoc, pageIndices);
    for (const page of copiedPages) {
      this.masterDoc.addPage(page);
    }

    if (!this.chapterPageMap.has(meta.chapterIndex)) {
      this.chapterPageMap.set(meta.chapterIndex, startPageIndex);
    }
    this.ingestedChapters.push(meta);
    this.totalPages += copiedPages.length;

    logger.debug(
      `PdfAssembler: Appended ch/${meta.chapterIndex} ("${meta.title}") -> ` +
        `${copiedPages.length} page(s) at pageIdx ${startPageIndex} (total: ${this.totalPages} pages).`
    );

    return copiedPages.length;
  }

  getTotalPages(): number {
    return this.totalPages;
  }

  getIngestedChapterCount(): number {
    return this.ingestedChapters.length;
  }

  /**
   * Builds and attaches hierarchical PDF Bookmarks/Outlines, then serializes the merged PDF.
   */
  async finalize(tocItems?: TocItem[], options?: { isPartial?: boolean }): Promise<PdfAssemblyResult> {
    if (!this.masterDoc) {
      throw new Error('PdfAssembler is not initialized.');
    }

    if (this.totalPages === 0) {
      throw new Error('Tidak ada halaman PDF yang berhasil digabungkan.');
    }

    if (options?.isPartial && this.metadata) {
      const partialTitle = `${this.formatDocumentTitle(this.metadata)} (Partial)`;
      this.masterDoc.setTitle(partialTitle, { showInWindowTitleBar: true });
    }

    const outlineRoots = buildOutlineTree(tocItems, this.ingestedChapters, this.chapterPageMap);
    const bookmarkCount = attachOutlinesToPdf(this.masterDoc, outlineRoots);

    logger.info(
      `PdfAssembler: Attached ${bookmarkCount} bookmark(s) across ${outlineRoots.length} top-level group(s). Saving PDF...`
    );

    const startMs = Date.now();
    const bytes = await this.masterDoc.save({
      useObjectStreams: true
    });
    const elapsedMs = Date.now() - startMs;

    logger.info(
      `PdfAssembler: Finalized PDF (${this.totalPages} pages, ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB, ` +
        `${bookmarkCount} bookmarks) in ${elapsedMs}ms.`
    );

    return {
      bytes,
      totalPages: this.totalPages,
      bookmarkCount
    };
  }

  dispose(): void {
    this.masterDoc = null;
    this.chapterPageMap.clear();
    this.ingestedChapters = [];
    this.totalPages = 0;
    this.metadata = null;
  }

  private formatDocumentTitle(meta: PdfAssemblyMetadata): string {
    const book = meta.bookTitle.trim();
    const label = meta.label.trim();
    if (!label || label.toLowerCase() === book.toLowerCase()) {
      return book || 'Buku Materi Pokok UT';
    }
    return `${book} — ${label}`;
  }
}
