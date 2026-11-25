import type { ModuleRange } from '../types/exporter';

/**
 * Inclusive index range [startIndex .. endIndex] within the ordered list of selectable TOC items.
 * Null represents an empty TOC selection (e.g. after Reset or custom non-aligned manual range).
 */
export interface ContiguousTocSelection {
  startIndex: number;
  endIndex: number;
}

export type TocItemInteractionState =
  | 'selected-edge'
  | 'selected-middle'
  | 'adjacent-available'
  | 'selectable-any'
  | 'disabled-gap';

export type ToggleRejectionReason = 'out-of-bounds' | 'middle-locked' | 'non-adjacent';

export interface ToggleTocResult {
  selection: ContiguousTocSelection | null;
  changed: boolean;
  reason?: ToggleRejectionReason;
}

export interface ComputedTocRange {
  startChapter: number;
  endChapter: number;
  pageCount: number;
  selectedCount: number;
  isFullBook: boolean;
  label: string;
}

/**
 * Extracts ordered selectable TOC section ranges, omitting the synthetic `Seluruh Buku` entry
 * whenever individual sections exist (since a dedicated "Semua" action selects all sections).
 */
export function getSelectableTocModules(modules: ModuleRange[]): ModuleRange[] {
  if (!modules || modules.length === 0) {
    return [];
  }
  const regular = modules.filter((m) => !m.isFullBook);
  return regular.length > 0 ? regular : modules.slice();
}

/**
 * Finds the best default TOC index matching the currently open chapter.
 */
export function findDefaultTocIndex(items: ModuleRange[], currentChapter: number): number {
  if (items.length === 0) return -1;
  const idx = items.findIndex(
    (m) => currentChapter >= m.startChapter && currentChapter <= m.endChapter
  );
  return idx >= 0 ? idx : 0;
}

/**
 * Computes the interaction state for a given TOC item index under the contiguous selection rules.
 */
export function getTocItemState(
  index: number,
  itemCount: number,
  selection: ContiguousTocSelection | null
): TocItemInteractionState {
  if (index < 0 || index >= itemCount) {
    return 'disabled-gap';
  }
  if (selection === null) {
    return 'selectable-any';
  }
  if (index >= selection.startIndex && index <= selection.endIndex) {
    if (index === selection.startIndex || index === selection.endIndex) {
      return 'selected-edge';
    }
    return 'selected-middle';
  }
  if (index === selection.startIndex - 1 || index === selection.endIndex + 1) {
    return 'adjacent-available';
  }
  return 'disabled-gap';
}

/**
 * Applies a click/toggle on `index` while strictly enforcing contiguous selection:
 * - Empty selection: selects [index .. index].
 * - Immediately above (startIndex - 1) or below (endIndex + 1): extends selection contiguously.
 * - Top or bottom edge of current selection: shrinks selection (or clears to null if sole item).
 * - Strictly inside [startIndex + 1 .. endIndex - 1]: rejected (`middle-locked`) to prevent gaps.
 * - Far outside selection: rejected (`non-adjacent`) to prevent jumping pages.
 */
export function toggleTocItemSelection(
  current: ContiguousTocSelection | null,
  index: number,
  itemCount: number
): ToggleTocResult {
  if (itemCount <= 0 || index < 0 || index >= itemCount) {
    return { selection: current, changed: false, reason: 'out-of-bounds' };
  }

  if (current === null) {
    return {
      selection: { startIndex: index, endIndex: index },
      changed: true
    };
  }

  // Extend upward by 1
  if (index === current.startIndex - 1) {
    return {
      selection: { startIndex: index, endIndex: current.endIndex },
      changed: true
    };
  }

  // Extend downward by 1
  if (index === current.endIndex + 1) {
    return {
      selection: { startIndex: current.startIndex, endIndex: index },
      changed: true
    };
  }

  // Uncheck the sole selected item -> clear selection so user can start anywhere
  if (index === current.startIndex && index === current.endIndex) {
    return {
      selection: null,
      changed: true
    };
  }

  // Shrink from top edge
  if (index === current.startIndex) {
    return {
      selection: { startIndex: current.startIndex + 1, endIndex: current.endIndex },
      changed: true
    };
  }

  // Shrink from bottom edge
  if (index === current.endIndex) {
    return {
      selection: { startIndex: current.startIndex, endIndex: current.endIndex - 1 },
      changed: true
    };
  }

  // Strictly inside the selected range -> locked
  if (index > current.startIndex && index < current.endIndex) {
    return {
      selection: current,
      changed: false,
      reason: 'middle-locked'
    };
  }

  // Non-adjacent outside current range -> blocked
  return {
    selection: current,
    changed: false,
    reason: 'non-adjacent'
  };
}

/**
 * Selects the entire TOC list as one contiguous range.
 */
export function selectAllTocItems(itemCount: number): ContiguousTocSelection | null {
  if (itemCount <= 0) return null;
  return { startIndex: 0, endIndex: itemCount - 1 };
}

/**
 * Computes unified chapter bounds, page count, and export label for the selected contiguous TOC range.
 */
export function computeSelectedChapterRange(
  items: ModuleRange[],
  selection: ContiguousTocSelection | null
): ComputedTocRange | null {
  if (!selection || items.length === 0) {
    return null;
  }

  const startIndex = Math.max(0, Math.min(items.length - 1, selection.startIndex));
  const endIndex = Math.max(startIndex, Math.min(items.length - 1, selection.endIndex));

  const first = items[startIndex];
  const last = items[endIndex];
  const startChapter = first.startChapter;
  const endChapter = Math.max(startChapter, last.endChapter);
  const pageCount = endChapter - startChapter + 1;
  const selectedCount = endIndex - startIndex + 1;
  const isFullBook =
    startIndex === 0 && endIndex === items.length - 1 && (items.length > 1 || !!first.isFullBook);

  let label: string;
  if (isFullBook) {
    label = 'Seluruh Buku';
  } else if (selectedCount === 1) {
    label = first.title;
  } else {
    label = `${first.title} - ${last.title}`;
  }

  return {
    startChapter,
    endChapter,
    pageCount,
    selectedCount,
    isFullBook,
    label
  };
}

/**
 * Attempts to match a manually entered [startChapter .. endChapter] range back to an exact
 * contiguous slice of TOC items. Returns null when the manual range does not align with TOC bounds.
 */
export function matchSelectionFromChapterRange(
  items: ModuleRange[],
  startChapter: number,
  endChapter: number
): ContiguousTocSelection | null {
  if (items.length === 0 || Number.isNaN(startChapter) || Number.isNaN(endChapter) || endChapter < startChapter) {
    return null;
  }

  const startIndex = items.findIndex((m) => m.startChapter === startChapter);
  if (startIndex < 0) return null;

  let endIndex = -1;
  for (let i = startIndex; i < items.length; i++) {
    if (items[i].endChapter === endChapter) {
      endIndex = i;
      break;
    }
  }

  if (endIndex < startIndex) {
    return null;
  }

  return { startIndex, endIndex };
}
