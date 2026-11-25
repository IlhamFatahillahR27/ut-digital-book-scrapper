import assert from 'node:assert/strict';
import { TocParser } from '../src/content/toc-parser';
import {
  computeSelectedChapterRange,
  findDefaultTocIndex,
  getSelectableTocModules,
  getTocItemState,
  matchSelectionFromChapterRange,
  selectAllTocItems,
  toggleTocItemSelection,
  type ContiguousTocSelection
} from '../src/ui/toc-selection';
import type { ModuleRange, TocItem } from '../src/types/exporter';

const SAMPLE_MODULES: ModuleRange[] = [
  { id: 'm0', title: 'Daftar Isi', startChapter: 0, endChapter: 1, pageCount: 2, level: 0 },
  { id: 'm1', title: 'Tinjauan Pustaka', startChapter: 2, endChapter: 4, pageCount: 3, level: 0 },
  { id: 'm2', title: 'Modul 1', startChapter: 5, endChapter: 7, pageCount: 3, level: 0 },
  { id: 'm3', title: 'KB 1', startChapter: 8, endChapter: 19, pageCount: 12, level: 1 },
  { id: 'm4', title: 'KB 2', startChapter: 20, endChapter: 35, pageCount: 16, level: 1 },
  { id: 'm5', title: 'Modul 2', startChapter: 36, endChapter: 50, pageCount: 15, level: 0 },
  { id: 'full', title: 'Seluruh Buku', startChapter: 0, endChapter: 50, pageCount: 51, isFullBook: true }
];

function testSelectableFilteringAndDefault(): void {
  const selectable = getSelectableTocModules(SAMPLE_MODULES);
  assert.equal(selectable.length, 6);
  assert.equal(selectable.some((m) => m.isFullBook), false);

  // Fallback when only Seluruh Buku exists
  const onlyFull = getSelectableTocModules([SAMPLE_MODULES[6]]);
  assert.equal(onlyFull.length, 1);
  assert.equal(onlyFull[0].isFullBook, true);

  // Default chapter lookup
  assert.equal(findDefaultTocIndex(selectable, 6), 2); // Modul 1
  assert.equal(findDefaultTocIndex(selectable, 12), 3); // KB 1
  assert.equal(findDefaultTocIndex(selectable, 999), 0); // fallback first

  console.log('✅ Scenario 1 (Selectable Filtering & Default Active Index) PASSED');
}

function testContiguousExtendUpAndDown(): void {
  const selectable = getSelectableTocModules(SAMPLE_MODULES);
  const count = selectable.length;

  // Start from empty -> pick Modul 1 (index 2)
  let res = toggleTocItemSelection(null, 2, count);
  assert.equal(res.changed, true);
  assert.deepEqual(res.selection, { startIndex: 2, endIndex: 2 });

  // Verify states around Modul 1
  assert.equal(getTocItemState(0, count, res.selection), 'disabled-gap');
  assert.equal(getTocItemState(1, count, res.selection), 'adjacent-available'); // Tinjauan Pustaka (above)
  assert.equal(getTocItemState(2, count, res.selection), 'selected-edge');      // Modul 1
  assert.equal(getTocItemState(3, count, res.selection), 'adjacent-available'); // KB 1 (below)
  assert.equal(getTocItemState(4, count, res.selection), 'disabled-gap');       // KB 2 (jump -> blocked)

  // Extend upward: select Tinjauan Pustaka (index 1)
  res = toggleTocItemSelection(res.selection, 1, count);
  assert.equal(res.changed, true);
  assert.deepEqual(res.selection, { startIndex: 1, endIndex: 2 });

  // Extend downward: select KB 1 (index 3), then KB 2 (index 4)
  res = toggleTocItemSelection(res.selection, 3, count);
  assert.equal(res.changed, true);
  assert.deepEqual(res.selection, { startIndex: 1, endIndex: 3 });

  res = toggleTocItemSelection(res.selection, 4, count);
  assert.equal(res.changed, true);
  assert.deepEqual(res.selection, { startIndex: 1, endIndex: 4 });

  const computed = computeSelectedChapterRange(selectable, res.selection);
  assert.ok(computed);
  assert.equal(computed.startChapter, 2);  // Tinjauan Pustaka start
  assert.equal(computed.endChapter, 35);   // KB 2 end
  assert.equal(computed.pageCount, 34);
  assert.equal(computed.selectedCount, 4);
  assert.equal(computed.isFullBook, false);
  assert.equal(computed.label, 'Tinjauan Pustaka - KB 2');

  console.log('✅ Scenario 2 (Contiguous Extend Up & Down: Tinjauan Pustaka + Modul 1 + KB 1 + KB 2) PASSED');
}

function testBlockJumpAndMiddleLock(): void {
  const selectable = getSelectableTocModules(SAMPLE_MODULES);
  const count = selectable.length;
  const sel: ContiguousTocSelection = { startIndex: 1, endIndex: 3 }; // Tinjauan Pustaka .. KB 1

  // Reject jumping to Modul 2 (index 5)
  const jumpDown = toggleTocItemSelection(sel, 5, count);
  assert.equal(jumpDown.changed, false);
  assert.equal(jumpDown.reason, 'non-adjacent');
  assert.deepEqual(jumpDown.selection, sel);

  // Reject unchecking middle item Modul 1 (index 2) to prevent split
  assert.equal(getTocItemState(2, count, sel), 'selected-middle');
  const splitMiddle = toggleTocItemSelection(sel, 2, count);
  assert.equal(splitMiddle.changed, false);
  assert.equal(splitMiddle.reason, 'middle-locked');
  assert.deepEqual(splitMiddle.selection, sel);

  // Out-of-bounds rejection
  const oob = toggleTocItemSelection(sel, 99, count);
  assert.equal(oob.changed, false);
  assert.equal(oob.reason, 'out-of-bounds');

  console.log('✅ Scenario 3 (Block Non-Adjacent Jump & Lock Middle Item) PASSED');
}

function testShrinkEdgesAndClearToUnlockAll(): void {
  const selectable = getSelectableTocModules(SAMPLE_MODULES);
  const count = selectable.length;

  let sel: ContiguousTocSelection | null = { startIndex: 1, endIndex: 3 };

  // Shrink from top (uncheck Tinjauan Pustaka)
  let res = toggleTocItemSelection(sel, 1, count);
  assert.equal(res.changed, true);
  assert.deepEqual(res.selection, { startIndex: 2, endIndex: 3 });
  sel = res.selection;

  // Shrink from bottom (uncheck KB 1)
  res = toggleTocItemSelection(sel, 3, count);
  assert.equal(res.changed, true);
  assert.deepEqual(res.selection, { startIndex: 2, endIndex: 2 });
  sel = res.selection;

  // Uncheck last remaining item (Modul 1) -> null (all items become selectable-any)
  res = toggleTocItemSelection(sel, 2, count);
  assert.equal(res.changed, true);
  assert.equal(res.selection, null);

  for (let i = 0; i < count; i++) {
    assert.equal(getTocItemState(i, count, res.selection), 'selectable-any');
  }

  // Now user can jump directly to Modul 2 (index 5)
  res = toggleTocItemSelection(res.selection, 5, count);
  assert.equal(res.changed, true);
  assert.deepEqual(res.selection, { startIndex: 5, endIndex: 5 });

  console.log('✅ Scenario 4 (Shrink Top/Bottom Edges & Clear Last Item to Unlock All) PASSED');
}

function testSelectAllAndManualRangeSync(): void {
  const selectable = getSelectableTocModules(SAMPLE_MODULES);
  const allSel = selectAllTocItems(selectable.length);
  assert.deepEqual(allSel, { startIndex: 0, endIndex: 5 });

  const allComputed = computeSelectedChapterRange(selectable, allSel);
  assert.ok(allComputed);
  assert.equal(allComputed.isFullBook, true);
  assert.equal(allComputed.label, 'Seluruh Buku');
  assert.equal(allComputed.startChapter, 0);
  assert.equal(allComputed.endChapter, 50);
  assert.equal(allComputed.pageCount, 51);

  // Exact match manual range -> syncs back to contiguous TOC slice
  assert.deepEqual(matchSelectionFromChapterRange(selectable, 5, 19), { startIndex: 2, endIndex: 3 });
  assert.deepEqual(matchSelectionFromChapterRange(selectable, 2, 4), { startIndex: 1, endIndex: 1 });
  // Non-aligned manual range -> returns null (Custom)
  assert.equal(matchSelectionFromChapterRange(selectable, 3, 10), null);
  assert.equal(matchSelectionFromChapterRange(selectable, 10, 5), null);

  console.log('✅ Scenario 5 (Select All & Manual Range Synchronization) PASSED');
}

function testTocParserContiguousModulesAndLevels(): void {
  const hierarchicalToc: TocItem[] = [
    { chapterIndex: 0, title: 'Daftar Isi', href: '#/book/1/reader/chapter/0', level: 1, isParent: false },
    { chapterIndex: 2, title: 'Tinjauan Pustaka', href: '#/book/1/reader/chapter/2', level: 1, isParent: false },
    { chapterIndex: 5, title: 'Modul 1', href: '#/book/1/reader/chapter/5', level: 1, isParent: true },
    { chapterIndex: 6, title: 'Pendahuluan', href: '#/book/1/reader/chapter/6', level: 2, isParent: false },
    { chapterIndex: 8, title: 'KB 1', href: '#/book/1/reader/chapter/8', level: 2, isParent: true },
    { chapterIndex: 10, title: 'Latihan 1', href: '#/book/1/reader/chapter/10', level: 3, isParent: false },
    { chapterIndex: 20, title: 'Modul 2', href: '#/book/1/reader/chapter/20', level: 1, isParent: true }
  ];

  const modules = TocParser.buildModuleRanges(hierarchicalToc, 30);
  const selectable = getSelectableTocModules(modules);

  assert.equal(selectable.length, 5);
  assert.deepEqual(
    selectable.map((m) => ({ title: m.title, start: m.startChapter, end: m.endChapter, level: m.level })),
    [
      { title: 'Daftar Isi', start: 0, end: 1, level: 0 },
      { title: 'Tinjauan Pustaka', start: 2, end: 4, level: 0 },
      { title: 'Modul 1', start: 5, end: 7, level: 0 },
      { title: 'KB 1', start: 8, end: 19, level: 1 },
      { title: 'Modul 2', start: 20, end: 30, level: 0 }
    ]
  );

  // Verify zero page gaps between consecutive selectable modules
  for (let i = 0; i < selectable.length - 1; i++) {
    assert.equal(
      selectable[i].endChapter + 1,
      selectable[i + 1].startChapter,
      `Gap detected between ${selectable[i].title} and ${selectable[i + 1].title}`
    );
  }

  // Flat small TOC (all same level, no .parent) should also produce selectable items
  const flatToc: TocItem[] = [
    { chapterIndex: 0, title: 'Daftar Isi', href: '#/book/1/reader/chapter/0', level: 1, isParent: false },
    { chapterIndex: 2, title: 'Modul 1', href: '#/book/1/reader/chapter/2', level: 1, isParent: false },
    { chapterIndex: 10, title: 'Modul 2', href: '#/book/1/reader/chapter/10', level: 1, isParent: false }
  ];
  const flatSelectable = getSelectableTocModules(TocParser.buildModuleRanges(flatToc, 20));
  assert.equal(flatSelectable.length, 3);
  assert.equal(flatSelectable[0].endChapter, 1);
  assert.equal(flatSelectable[1].startChapter, 2);
  assert.equal(flatSelectable[1].endChapter, 9);
  assert.equal(flatSelectable[2].startChapter, 10);
  assert.equal(flatSelectable[2].endChapter, 20);

  console.log('✅ Scenario 6 (TocParser Contiguous Ranges, Hierarchy Level & Flat TOC) PASSED');
}

function main(): void {
  console.log('🧪 Running Contiguous Multi-TOC Selection Test Suite...\n');
  testSelectableFilteringAndDefault();
  testContiguousExtendUpAndDown();
  testBlockJumpAndMiddleLock();
  testShrinkEdgesAndClearToUnlockAll();
  testSelectAllAndManualRangeSync();
  testTocParserContiguousModulesAndLevels();
  console.log('\n🎉 All 6 Contiguous Multi-TOC Selection scenarios PASSED!');
}

main();
