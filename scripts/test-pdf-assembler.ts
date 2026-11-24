import fs from 'fs';
import path from 'path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PdfAssembler } from '../src/background/pdf-assembler';
import type { CapturedChapterMeta, TocItem } from '../src/types/exporter';

async function createDummyChapterPdf(lines: string[], pageCount = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (let p = 0; p < pageCount; p++) {
    const page = doc.addPage([595.28, 841.89]); // A4 in points
    page.drawText(`${lines[0] || 'Page'} [subpage ${p + 1}/${pageCount}]`, {
      x: 50,
      y: 760,
      size: 16,
      font
    });
    for (let i = 1; i < lines.length; i++) {
      page.drawText(lines[i], {
        x: 50,
        y: 760 - i * 24,
        size: 12,
        font
      });
    }
  }

  return doc.save();
}

function makeMeta(chapterIndex: number, seq: number, title: string, bytes: Uint8Array): CapturedChapterMeta {
  return {
    chapterIndex,
    sequenceNumber: seq,
    title,
    byteLength: bytes.byteLength,
    isFixedLayout: true,
    durationMs: 250,
    validPdfHeader: true
  };
}

async function runTests(outDir: string): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });

  // =========================================================================
  // CASE 1: Hierarchical TOC + Multi-Page Chapter + Unicode Bookmark Titles
  // =========================================================================
  const assembler1 = new PdfAssembler();
  await assembler1.init({
    bookTitle: 'MSIM430301',
    label: 'MODUL 1',
    author: 'Rosa Ariani Sukamto'
  });

  // ch 3 (1 page), ch 4 (2 pages! tests accurate pageIndex offset), ch 5 (1 page), ch 6 (1 page), ch 7 (1 page)
  const ch3 = await createDummyChapterPdf(['Chapter 3 - MODUL 1', 'Pengantar Rekayasa Perangkat Lunak'], 1);
  const ch4 = await createDummyChapterPdf(['Chapter 4 - Pendahuluan', 'Halaman 1.2 multi-page'], 2);
  const ch5 = await createDummyChapterPdf(['Chapter 5 - Peta Konsep', 'Halaman 1.3'], 1);
  const ch6 = await createDummyChapterPdf(['Chapter 6 - Kegiatan Belajar 1', 'Proses Perangkat Lunak'], 1);
  const ch7 = await createDummyChapterPdf(['Chapter 7 - Tes Formatif 1', 'Soal evaluasi KB 1'], 1);

  await assembler1.appendChapter(ch3, makeMeta(3, 1, 'MODUL 1', ch3));
  await assembler1.appendChapter(ch4, makeMeta(4, 2, 'Halaman 1.2', ch4));
  await assembler1.appendChapter(ch5, makeMeta(5, 3, 'Halaman 1.3', ch5));
  await assembler1.appendChapter(ch6, makeMeta(6, 4, 'Kegiatan Belajar 1', ch6));
  await assembler1.appendChapter(ch7, makeMeta(7, 5, 'Tes Formatif 1', ch7));

  const toc1: TocItem[] = [
    { chapterIndex: 3, title: 'MODUL 1 — Konsep Dasar RPL', href: '#/book/57062/reader/chapter/3', level: 1, isParent: true },
    { chapterIndex: 4, title: 'Pendahuluan', href: '#/book/57062/reader/chapter/4', level: 2, isParent: false },
    { chapterIndex: 6, title: 'Kegiatan Belajar 1: Siklus Hidup', href: '#/book/57062/reader/chapter/6', level: 2, isParent: true },
    { chapterIndex: 7, title: 'Tes Formatif 1 • Evaluasi', href: '#/book/57062/reader/chapter/7', level: 3, isParent: false }
  ];

  const res1 = await assembler1.finalize(toc1);
  fs.writeFileSync(path.join(outDir, 'case1_hierarchical.pdf'), res1.bytes);
  console.log('CASE 1 OK:', { totalPages: res1.totalPages, bookmarkCount: res1.bookmarkCount, bytes: res1.bytes.byteLength });
  assembler1.dispose();

  // =========================================================================
  // CASE 2: Orphan Sub-Level Custom Range (Partial Save)
  // =========================================================================
  const assembler2 = new PdfAssembler();
  await assembler2.init({
    bookTitle: 'MSIM430301',
    label: 'Rentang Ch 6-7',
    author: null
  });

  await assembler2.appendChapter(ch6, makeMeta(6, 1, 'Kegiatan Belajar 1', ch6));
  await assembler2.appendChapter(ch7, makeMeta(7, 2, 'Tes Formatif 1', ch7));

  const toc2 = toc1.filter((t) => t.chapterIndex >= 6 && t.chapterIndex <= 7);
  const res2 = await assembler2.finalize(toc2, { isPartial: true });
  fs.writeFileSync(path.join(outDir, 'case2_orphan_partial.pdf'), res2.bytes);
  console.log('CASE 2 OK:', { totalPages: res2.totalPages, bookmarkCount: res2.bookmarkCount, bytes: res2.bytes.byteLength });
  assembler2.dispose();

  // =========================================================================
  // CASE 3: Empty TOC Fallback (with consecutive duplicate chapter titles)
  // =========================================================================
  const assembler3 = new PdfAssembler();
  await assembler3.init({
    bookTitle: 'MSIM430301',
    label: 'Custom No TOC'
  });

  await assembler3.appendChapter(ch3, makeMeta(3, 1, 'MODUL 1', ch3));
  await assembler3.appendChapter(ch4, makeMeta(4, 2, 'MODUL 1', ch4));
  await assembler3.appendChapter(ch6, makeMeta(6, 3, 'Kegiatan Belajar 1', ch6));

  const res3 = await assembler3.finalize([]);
  fs.writeFileSync(path.join(outDir, 'case3_empty_toc_fallback.pdf'), res3.bytes);
  console.log('CASE 3 OK:', { totalPages: res3.totalPages, bookmarkCount: res3.bookmarkCount, bytes: res3.bytes.byteLength });
  assembler3.dispose();
}

const targetOutDir = process.argv[2] || path.resolve('tmp-pdf-test');
runTests(targetOutDir).catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
