import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef
} from 'pdf-lib';
import type { CapturedChapterMeta, TocItem } from '../types/exporter';

export interface OutlineNode {
  title: string;
  pageIndex: number;
  chapterIndex: number;
  level: number;
  children: OutlineNode[];
}

/**
 * Builds a clean, normalized hierarchical tree of PDF outline nodes from Kotobee TOC items.
 * - Filters TOC items to chapters actually present in chapterPageMap.
 * - Preserves Kotobee parent/child hierarchy (e.g. MODUL 1 -> Kegiatan Belajar 1).
 * - Automatically promotes orphan deeper-level items to root when exporting partial/custom ranges.
 * - Falls back to deduplicated flat bookmarks from capturedChapters when TOC has no entries in range.
 */
export function buildOutlineTree(
  tocItems: TocItem[] | undefined,
  capturedChapters: CapturedChapterMeta[],
  chapterPageMap: Map<number, number>
): OutlineNode[] {
  const validToc = (tocItems ?? [])
    .filter((item) => chapterPageMap.has(item.chapterIndex))
    .sort((a, b) => a.chapterIndex - b.chapterIndex);

  if (validToc.length > 0) {
    const roots: OutlineNode[] = [];
    const stack: Array<{ node: OutlineNode; level: number }> = [];

    for (const item of validToc) {
      const pageIndex = chapterPageMap.get(item.chapterIndex);
      if (pageIndex === undefined) continue;

      const cleanTitle = sanitizeBookmarkTitle(item.title, `Halaman ${item.chapterIndex + 1}`);
      const node: OutlineNode = {
        title: cleanTitle,
        pageIndex,
        chapterIndex: item.chapterIndex,
        level: item.level,
        children: []
      };

      // Pop any stack entries at the same or deeper level so the top of stack is the true parent
      while (stack.length > 0 && stack[stack.length - 1].level >= item.level) {
        stack.pop();
      }

      if (stack.length === 0) {
        roots.push(node);
      } else {
        stack[stack.length - 1].node.children.push(node);
      }

      stack.push({ node, level: item.level });
    }

    if (roots.length > 0) {
      return roots;
    }
  }

  // Fallback: flat outline from captured chapters (skip consecutive identical titles)
  const fallbackRoots: OutlineNode[] = [];
  let lastTitle = '';

  for (const ch of capturedChapters) {
    const pageIndex = chapterPageMap.get(ch.chapterIndex);
    if (pageIndex === undefined) continue;

    const cleanTitle = sanitizeBookmarkTitle(ch.title, `Halaman ${ch.chapterIndex + 1}`);
    if (fallbackRoots.length > 0 && cleanTitle.toLowerCase() === lastTitle.toLowerCase()) {
      continue;
    }

    fallbackRoots.push({
      title: cleanTitle,
      pageIndex,
      chapterIndex: ch.chapterIndex,
      level: 0,
      children: []
    });
    lastTitle = cleanTitle;
  }

  return fallbackRoots;
}

/**
 * Attaches an ISO 32000-1 Section 12.3.3 compliant hierarchical Outline (Bookmarks) tree
 * directly into a pdf-lib PDFDocument catalog, with UTF-16BE Unicode titles and /Fit page destinations.
 *
 * Returns total number of bookmark entries written across all levels.
 */
export function attachOutlinesToPdf(pdfDoc: PDFDocument, roots: OutlineNode[]): number {
  const pages = pdfDoc.getPages();
  if (pages.length === 0 || roots.length === 0) {
    return 0;
  }

  const context = pdfDoc.context;
  const outlinesRef = context.nextRef();

  // Pre-allocate PDFRefs for every node so Prev/Next/First/Last/Parent links can be built cleanly
  interface AllocatedNode {
    node: OutlineNode;
    ref: PDFRef;
    children: AllocatedNode[];
    visibleDescendantCount: number;
  }

  const allocateTree = (nodes: OutlineNode[]): AllocatedNode[] => {
    return nodes.map((node) => {
      const allocatedChildren = allocateTree(node.children);
      let visibleDescendantCount = 0;
      for (const child of allocatedChildren) {
        visibleDescendantCount += 1 + child.visibleDescendantCount;
      }
      return {
        node,
        ref: context.nextRef(),
        children: allocatedChildren,
        visibleDescendantCount
      };
    });
  };

  const allocatedRoots = allocateTree(roots);
  let totalCount = 0;

  const writeSiblings = (siblings: AllocatedNode[], parentRef: PDFRef): void => {
    for (let i = 0; i < siblings.length; i++) {
      const current = siblings[i];
      const prev = i > 0 ? siblings[i - 1] : null;
      const next = i < siblings.length - 1 ? siblings[i + 1] : null;

      const clampedPageIdx = Math.max(0, Math.min(pages.length - 1, current.node.pageIndex));
      const targetPageRef = pages[clampedPageIdx].ref;

      const dictEntries: Record<string, PDFObject> = {
        Title: PDFHexString.fromText(current.node.title),
        Parent: parentRef,
        Dest: context.obj([targetPageRef, PDFName.of('Fit')])
      };

      if (prev) {
        dictEntries.Prev = prev.ref;
      }
      if (next) {
        dictEntries.Next = next.ref;
      }
      if (current.children.length > 0) {
        dictEntries.First = current.children[0].ref;
        dictEntries.Last = current.children[current.children.length - 1].ref;
        // Positive Count = open/expanded by default per ISO 32000-1 Table 153
        dictEntries.Count = PDFNumber.of(current.visibleDescendantCount);
      }

      context.assign(current.ref, context.obj(dictEntries));
      totalCount++;

      if (current.children.length > 0) {
        writeSiblings(current.children, current.ref);
      }
    }
  };

  writeSiblings(allocatedRoots, outlinesRef);

  // Write Root Outlines dictionary (ISO 32000-1 Table 152)
  const rootDict = context.obj({
    Type: PDFName.of('Outlines'),
    First: allocatedRoots[0].ref,
    Last: allocatedRoots[allocatedRoots.length - 1].ref,
    Count: PDFNumber.of(totalCount)
  });
  context.assign(outlinesRef, rootDict);

  // Register Outlines in Document Catalog & instruct viewers to open bookmarks pane
  pdfDoc.catalog.set(PDFName.of('Outlines'), outlinesRef);
  pdfDoc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));

  return totalCount;
}

function sanitizeBookmarkTitle(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const cleaned = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return fallback;
  return cleaned.length > 180 ? `${cleaned.slice(0, 177)}...` : cleaned;
}
