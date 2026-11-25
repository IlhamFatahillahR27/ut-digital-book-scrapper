import widgetCss from './widget.css?inline';
import { DomDetector } from '../content/dom-detector';
import { TocParser } from '../content/toc-parser';
import { logger } from '../utils/logger';
import { loadWidgetPreferences, saveWidgetPreferences } from '../utils/storage';
import {
  computeSelectedChapterRange,
  findDefaultTocIndex,
  getSelectableTocModules,
  getTocItemState,
  matchSelectionFromChapterRange,
  selectAllTocItems,
  toggleTocItemSelection,
  type ContiguousTocSelection
} from './toc-selection';
import {
  DEFAULT_EXPORTER_CONFIG,
  type BookStructureInfo,
  type BatchExportSummary,
  type ExportProgress,
  type ModuleRange
} from '../types/exporter';
import type {
  ExportCompleteMessage,
  ExportErrorMessage,
  StartExportMessage,
  StartTestPrintMessage,
  StopExportMessage,
  StatusResponseMessage
} from '../types/messages';

const LARGE_RANGE_ADVISORY_THRESHOLD = 100;

export class FloatingWidget {
  private shadowRoot: ShadowRoot;
  private isExporting = false;
  private isMinimized = false;
  private currentTitle = '';
  private pollIntervalId: number | null = null;
  private keepAlivePort: chrome.runtime.Port | null = null;
  private bookStructure: BookStructureInfo | null = null;
  private selectableModules: ModuleRange[] = [];
  private tocSelection: ContiguousTocSelection | null = null;
  private pendingResumeChapter: number | null = null;
  private appVersion = '1.1.0';

  constructor(shadowRoot: ShadowRoot) {
    this.shadowRoot = shadowRoot;
    try {
      this.appVersion = chrome.runtime.getManifest?.().version || '1.1.0';
    } catch {
      this.appVersion = '1.1.0';
    }
    this.init();
  }

  private init(): void {
    this.currentTitle = DomDetector.detectBookTitle();
    this.render();
    this.bindEvents();
    this.setupDraggable();
    this.refreshBookStructure(true);
    void this.restorePreferences();
    void this.rehydrateActiveExportStatus();

    // Re-scan TOC shortly after initial mount in case Kotobee SPA finishes hydrating asynchronously
    window.setTimeout(() => {
      if (!this.isExporting && (!this.bookStructure || this.bookStructure.modules.length === 0)) {
        this.refreshBookStructure(true);
      }
    }, 2500);

    window.setTimeout(() => {
      if (!this.isExporting && (!this.bookStructure || this.bookStructure.modules.length === 0)) {
        this.refreshBookStructure(true);
      }
    }, 6000);
  }

  private render(): void {
    const iconUrl = chrome.runtime.getURL('icons/icon-48.png');

    this.shadowRoot.innerHTML = `
      <style>${widgetCss}</style>
      <div class="rbv-card" id="rbv-card">
        <div class="rbv-header" id="rbv-header">
          <div class="rbv-title">
            <img src="${iconUrl}" width="20" height="20" style="border-radius: 4px; object-fit: contain; background: #ffffff; padding: 1px;" alt="UT" />
            <span>RBV-UT Exporter</span>
          </div>
          <div class="rbv-header-actions">
            <span class="rbv-header-pct" id="rbv-header-pct">0%</span>
            <span class="rbv-badge">MV3</span>
            <button class="rbv-icon-btn" id="rbv-btn-toggle" title="Perkecil / Perbesar panel">−</button>
          </div>
          <div class="rbv-mini-progress">
            <div class="rbv-mini-progress-fill" id="rbv-mini-progress-fill"></div>
          </div>
        </div>
        <div class="rbv-body">
          <div class="rbv-book-info">
            <div class="rbv-book-label">Buku Terdeteksi</div>
            <div class="rbv-book-title" id="rbv-title-display" title="${this.escapeHtml(this.currentTitle)}">
              ${this.escapeHtml(this.currentTitle)}
            </div>
          </div>

          <div class="rbv-range-panel">
            <div class="rbv-range-header">
              <span class="rbv-book-label">Modul / Rentang Halaman</span>
              <button class="rbv-refresh-btn" id="rbv-btn-refresh-toc" type="button" title="Pindai ulang Daftar Isi (TOC) Kotobee">↻ Pindai TOC</button>
            </div>
            <div class="rbv-toc-toolbar" id="rbv-toc-toolbar">
              <span class="rbv-toc-summary is-manual" id="rbv-toc-summary">Memindai TOC...</span>
              <div class="rbv-toc-actions">
                <button class="rbv-toc-mini-btn" id="rbv-btn-toc-all" type="button" title="Pilih seluruh TOC dari awal hingga akhir buku" disabled>Semua</button>
                <button class="rbv-toc-mini-btn" id="rbv-btn-toc-reset" type="button" title="Kosongkan pilihan TOC agar bisa memilih mulai dari bagian mana pun" disabled>Reset</button>
              </div>
            </div>
            <div class="rbv-toc-list" id="rbv-toc-list" role="group" aria-label="Daftar Isi (TOC) Berurutan">
              <div class="rbv-toc-empty">Memindai Daftar Isi Kotobee...</div>
            </div>
            <div class="rbv-toc-rule-hint" id="rbv-toc-rule-hint">
              Pilih 1 atau beberapa TOC berurutan (atas/bawah) agar halaman tidak lompat.
            </div>
            <div class="rbv-range-inputs">
              <div class="rbv-input-group">
                <span class="rbv-input-label">Dari Ch</span>
                <input type="number" min="0" value="0" class="rbv-num-input" id="rbv-start-ch" />
              </div>
              <span class="rbv-range-sep">–</span>
              <div class="rbv-input-group">
                <span class="rbv-input-label">Sampai Ch</span>
                <input type="number" min="0" value="0" class="rbv-num-input" id="rbv-end-ch" />
              </div>
              <span class="rbv-page-pill" id="rbv-page-count-pill">1 hal</span>
            </div>
            <div class="rbv-advisory-tip" id="rbv-advisory-tip">
              💡 Tip: Untuk buku &gt;${LARGE_RANGE_ADVISORY_THRESHOLD} halaman, mengekspor per Modul lebih cepat &amp; lebih hemat memori.
            </div>
          </div>

          <div class="rbv-progress-card" id="rbv-progress-card">
            <div class="rbv-progress-top">
              <span class="rbv-phase-badge" id="rbv-phase-badge">Siap</span>
              <span class="rbv-progress-pct" id="rbv-progress-pct">0%</span>
            </div>
            <div class="rbv-progress-track">
              <div class="rbv-progress-fill" id="rbv-progress-fill"></div>
            </div>
            <div class="rbv-progress-headline" id="rbv-progress-headline">Menyiapkan ekspor...</div>
            <div class="rbv-progress-sub" id="rbv-progress-sub"></div>
            <div class="rbv-telemetry-row">
              <span id="rbv-telemetry-left">0.00 MB</span>
              <span class="rbv-skip-pill" id="rbv-skip-pill">⚠ 0 dilewati</span>
              <span id="rbv-telemetry-right">Estimasi: —</span>
            </div>
          </div>

          <div class="rbv-resume-banner" id="rbv-resume-banner">
            <div id="rbv-resume-text">Ekspor terhenti di tengah proses.</div>
            <button class="rbv-btn-resume" id="rbv-btn-resume">▶ Lanjutkan dari Ch 0</button>
          </div>

          <div class="rbv-status-row">
            <span class="rbv-status-dot" id="rbv-status-dot"></span>
            <span id="rbv-status-text">Siap. Pilih modul atau rentang chapter di atas.</span>
          </div>

          <div class="rbv-actions">
            <button class="rbv-btn rbv-btn-primary" id="rbv-btn-start" title="Ekspor rentang terpilih menjadi 1 file PDF utuh dengan Bookmarks/Daftar Isi">
              🚀 Ekspor ke 1 File PDF
            </button>
            <button class="rbv-btn rbv-btn-danger" id="rbv-btn-stop" style="display: none;">
              ⏹ Berhenti &amp; Simpan Parsial
            </button>
            <button class="rbv-btn rbv-btn-secondary" id="rbv-btn-test-print" title="Cetak halaman yang sedang Anda buka saat ini menjadi 1 file PDF">
              📄 Cetak Halaman Aktif
            </button>
          </div>

          <details class="rbv-advanced" id="rbv-advanced-drawer">
            <summary class="rbv-advanced-summary">
              <span>⚙ Alat Lanjutan &amp; Diagnostik</span>
              <span class="rbv-advanced-caret">▼</span>
            </summary>
            <div class="rbv-advanced-body">
              <div class="rbv-adv-grid">
                <div class="rbv-input-group">
                  <span class="rbv-input-label">Maks Retry / hal</span>
                  <input type="number" min="0" max="4" value="${DEFAULT_EXPORTER_CONFIG.maxRetriesPerChapter}" class="rbv-num-input" id="rbv-adv-retries" />
                </div>
                <div class="rbv-input-group">
                  <span class="rbv-input-label">Timeout (dtk)</span>
                  <input type="number" min="10" max="60" value="${Math.round(DEFAULT_EXPORTER_CONFIG.chapterNavigationTimeoutMs / 1000)}" class="rbv-num-input" id="rbv-adv-timeout" />
                </div>
              </div>
              <label class="rbv-checkbox-row" title="Selain menghasilkan 1 PDF gabungan ber-bookmark, simpan juga salinan PDF terpisah untuk setiap halaman">
                <input type="checkbox" id="rbv-chk-save-per-page" />
                <span>Simpan salinan PDF per halaman (Debug)</span>
              </label>
              <button class="rbv-btn rbv-btn-outline" id="rbv-btn-diag" title="Salin struktur DOM & TOC Kotobee ke clipboard untuk analisis">
                🔍 Salin Diagnostik DOM
              </button>
            </div>
          </details>
        </div>
        <div class="rbv-footer">
          Optimized for NotebookLM • v${this.escapeHtml(this.appVersion)}
        </div>
      </div>
    `;
  }

  private bindEvents(): void {
    const testPrintBtn = this.shadowRoot.querySelector('#rbv-btn-test-print') as HTMLButtonElement | null;
    const startBtn = this.shadowRoot.querySelector('#rbv-btn-start') as HTMLButtonElement | null;
    const stopBtn = this.shadowRoot.querySelector('#rbv-btn-stop') as HTMLButtonElement | null;
    const toggleBtn = this.shadowRoot.querySelector('#rbv-btn-toggle') as HTMLButtonElement | null;
    const diagBtn = this.shadowRoot.querySelector('#rbv-btn-diag') as HTMLButtonElement | null;
    const refreshTocBtn = this.shadowRoot.querySelector('#rbv-btn-refresh-toc') as HTMLButtonElement | null;
    const resumeBtn = this.shadowRoot.querySelector('#rbv-btn-resume') as HTMLButtonElement | null;
    const selectAllTocBtn = this.shadowRoot.querySelector('#rbv-btn-toc-all') as HTMLButtonElement | null;
    const resetTocBtn = this.shadowRoot.querySelector('#rbv-btn-toc-reset') as HTMLButtonElement | null;
    const startInput = this.shadowRoot.querySelector('#rbv-start-ch') as HTMLInputElement | null;
    const endInput = this.shadowRoot.querySelector('#rbv-end-ch') as HTMLInputElement | null;
    const saveChk = this.shadowRoot.querySelector('#rbv-chk-save-per-page') as HTMLInputElement | null;
    const retriesInput = this.shadowRoot.querySelector('#rbv-adv-retries') as HTMLInputElement | null;
    const timeoutInput = this.shadowRoot.querySelector('#rbv-adv-timeout') as HTMLInputElement | null;

    testPrintBtn?.addEventListener('click', () => this.handleTestPrint());
    startBtn?.addEventListener('click', () => this.handleStart());
    stopBtn?.addEventListener('click', () => this.handleStop());
    diagBtn?.addEventListener('click', () => this.handleCopyDiagnostics());
    refreshTocBtn?.addEventListener('click', () => this.refreshBookStructure(false));
    resumeBtn?.addEventListener('click', () => this.handleApplyResume());
    selectAllTocBtn?.addEventListener('click', () => this.handleSelectAllToc());
    resetTocBtn?.addEventListener('click', () => this.handleResetTocSelection());

    startInput?.addEventListener('input', () => this.handleManualRangeEdit());
    endInput?.addEventListener('input', () => this.handleManualRangeEdit());

    saveChk?.addEventListener('change', () => {
      void saveWidgetPreferences({ savePerPageDebug: !!saveChk.checked });
    });
    retriesInput?.addEventListener('change', () => {
      const val = this.clampInt(retriesInput.value, 0, 4, DEFAULT_EXPORTER_CONFIG.maxRetriesPerChapter);
      retriesInput.value = String(val);
      void saveWidgetPreferences({ maxRetriesPerChapter: val });
    });
    timeoutInput?.addEventListener('change', () => {
      const sec = this.clampInt(timeoutInput.value, 10, 60, 20);
      timeoutInput.value = String(sec);
      void saveWidgetPreferences({ chapterNavigationTimeoutMs: sec * 1000 });
    });

    toggleBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMinimize();
    });
  }

  /**
   * Restores saved widget position, minimized state, and advanced settings from chrome.storage.local
   */
  private async restorePreferences(): Promise<void> {
    const prefs = await loadWidgetPreferences();
    const host = this.shadowRoot.host as HTMLElement | null;

    if (host && typeof prefs.left === 'number' && typeof prefs.top === 'number') {
      const maxLeft = Math.max(10, window.innerWidth - 340);
      const maxTop = Math.max(10, window.innerHeight - 80);
      const clampedLeft = Math.max(10, Math.min(maxLeft, prefs.left));
      const clampedTop = Math.max(10, Math.min(maxTop, prefs.top));
      host.style.setProperty('right', 'auto', 'important');
      host.style.setProperty('bottom', 'auto', 'important');
      host.style.setProperty('left', `${clampedLeft}px`, 'important');
      host.style.setProperty('top', `${clampedTop}px`, 'important');
    }

    if (typeof prefs.minimized === 'boolean' && prefs.minimized !== this.isMinimized) {
      this.setMinimized(prefs.minimized, false);
    }

    const saveChk = this.shadowRoot.querySelector('#rbv-chk-save-per-page') as HTMLInputElement | null;
    if (saveChk && typeof prefs.savePerPageDebug === 'boolean') {
      saveChk.checked = prefs.savePerPageDebug;
    }

    const retriesInput = this.shadowRoot.querySelector('#rbv-adv-retries') as HTMLInputElement | null;
    if (retriesInput && typeof prefs.maxRetriesPerChapter === 'number') {
      retriesInput.value = String(
        this.clampInt(prefs.maxRetriesPerChapter, 0, 4, DEFAULT_EXPORTER_CONFIG.maxRetriesPerChapter)
      );
    }

    const timeoutInput = this.shadowRoot.querySelector('#rbv-adv-timeout') as HTMLInputElement | null;
    if (timeoutInput && typeof prefs.chapterNavigationTimeoutMs === 'number') {
      const sec = this.clampInt(Math.round(prefs.chapterNavigationTimeoutMs / 1000), 10, 60, 20);
      timeoutInput.value = String(sec);
    }
  }

  /**
   * Rehydrates live progress if widget was re-mounted during an already active export
   */
  private async rehydrateActiveExportStatus(): Promise<void> {
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'GET_STATUS' })) as StatusResponseMessage;
      if (res?.type === 'STATUS_RESPONSE' && res.payload) {
        const s = res.payload.status;
        if (
          s === 'INITIALIZING' ||
          s === 'NAVIGATING' ||
          s === 'CAPTURING_PAGE' ||
          s === 'RETRYING' ||
          s === 'WAITING_NEXT' ||
          s === 'STITCHING'
        ) {
          this.isExporting = true;
          this.setExportingVisualState(true);
          this.openKeepAlivePort();
          this.renderProgressCard(res.payload);
          this.startProgressPolling();
        }
      }
    } catch {
      // Ignore transient startup IPC error
    }
  }

  /**
   * Called by content/index.ts when user clicks the browser extension toolbar icon
   */
  toggleVisibilityOrExpand(): void {
    if (this.isMinimized) {
      this.setMinimized(false, true);
    } else {
      this.setMinimized(true, true);
    }
  }

  /**
   * Scans Kotobee TOC and populates the Module dropdown & Start/End inputs
   */
  private refreshBookStructure(silent: boolean): void {
    try {
      const structure = TocParser.getBookStructure();
      this.bookStructure = structure;

      if (structure.bookTitle && structure.bookTitle !== this.currentTitle) {
        this.currentTitle = structure.bookTitle;
        const titleEl = this.shadowRoot.querySelector('#rbv-title-display') as HTMLElement | null;
        if (titleEl) {
          titleEl.textContent = this.currentTitle;
          titleEl.title = this.currentTitle;
        }
      }

      const startInput = this.shadowRoot.querySelector('#rbv-start-ch') as HTMLInputElement | null;
      const endInput = this.shadowRoot.querySelector('#rbv-end-ch') as HTMLInputElement | null;

      if (!startInput || !endInput) return;

      const maxCh = structure.totalChapters > 0 ? structure.totalChapters - 1 : 9999;
      startInput.max = String(maxCh);
      endInput.max = String(maxCh);

      this.selectableModules = getSelectableTocModules(structure.modules);

      if (this.selectableModules.length > 0) {
        const defaultIdx = findDefaultTocIndex(this.selectableModules, structure.currentChapter);
        this.tocSelection = defaultIdx >= 0 ? { startIndex: defaultIdx, endIndex: defaultIdx } : null;

        const computed = computeSelectedChapterRange(this.selectableModules, this.tocSelection);
        if (computed) {
          startInput.value = String(computed.startChapter);
          endInput.value = String(computed.endChapter);
        }

        this.renderTocList(true);
        this.updatePageCountPill();

        if (!silent) {
          this.updateStatus(
            'idle',
            `TOC terdeteksi: ${this.selectableModules.length} bagian, total ${structure.totalChapters} halaman.`
          );
        }
      } else {
        this.tocSelection = null;
        this.renderTocList(false);
        startInput.value = String(structure.currentChapter);
        endInput.value = String(structure.currentChapter);
        this.updatePageCountPill();

        if (!silent) {
          this.updateStatus(
            'idle',
            'TOC belum terbaca. Gunakan input Dari/Sampai Ch atau klik Pindai TOC lagi.'
          );
        }
      }
    } catch (err) {
      logger.warn('FloatingWidget: Failed to refresh book structure:', err);
    }
  }

  private renderTocList(scrollSelectedIntoView = false): void {
    const listEl = this.shadowRoot.querySelector('#rbv-toc-list') as HTMLElement | null;
    if (!listEl) return;

    while (listEl.firstChild) {
      listEl.removeChild(listEl.firstChild);
    }

    if (this.selectableModules.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'rbv-toc-empty';
      emptyEl.textContent = 'TOC belum termuat. Gunakan input Dari/Sampai Ch atau klik Pindai TOC.';
      listEl.appendChild(emptyEl);
      this.syncTocListUi();
      return;
    }

    for (let i = 0; i < this.selectableModules.length; i++) {
      const mod = this.selectableModules[i];
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'rbv-toc-checkbox';
      checkbox.setAttribute('data-toc-index', String(i));
      checkbox.addEventListener('change', () => {
        this.handleTocItemToggle(i);
      });

      const titleSpan = document.createElement('span');
      titleSpan.className = 'rbv-toc-title';
      titleSpan.textContent = mod.title;

      const metaSpan = document.createElement('span');
      metaSpan.className = 'rbv-toc-meta';
      metaSpan.textContent =
        mod.startChapter === mod.endChapter
          ? `ch ${mod.startChapter} • 1h`
          : `ch ${mod.startChapter}–${mod.endChapter} • ${mod.pageCount}h`;

      const row = document.createElement('label');
      row.className = 'rbv-toc-item';
      row.setAttribute('data-toc-index', String(i));
      if (typeof mod.level === 'number' && mod.level >= 2) {
        row.classList.add('is-sublevel-deep');
      } else if (typeof mod.level === 'number' && mod.level === 1) {
        row.classList.add('is-sublevel');
      }

      row.appendChild(checkbox);
      row.appendChild(titleSpan);
      row.appendChild(metaSpan);
      listEl.appendChild(row);
    }

    this.syncTocListUi();

    if (scrollSelectedIntoView && this.tocSelection !== null) {
      const activeRow = listEl.querySelector(
        `.rbv-toc-item[data-toc-index="${this.tocSelection.startIndex}"]`
      ) as HTMLElement | null;
      activeRow?.scrollIntoView({ block: 'nearest' });
    }
  }

  private syncTocListUi(): void {
    const listEl = this.shadowRoot.querySelector('#rbv-toc-list') as HTMLElement | null;
    const summaryEl = this.shadowRoot.querySelector('#rbv-toc-summary') as HTMLElement | null;
    const allBtn = this.shadowRoot.querySelector('#rbv-btn-toc-all') as HTMLButtonElement | null;
    const resetBtn = this.shadowRoot.querySelector('#rbv-btn-toc-reset') as HTMLButtonElement | null;
    const ruleHint = this.shadowRoot.querySelector('#rbv-toc-rule-hint') as HTMLElement | null;

    const total = this.selectableModules.length;
    const computed = computeSelectedChapterRange(this.selectableModules, this.tocSelection);

    if (listEl) {
      listEl.classList.toggle('is-exporting', this.isExporting);
      const rows = listEl.querySelectorAll('.rbv-toc-item');

      rows.forEach((rowNode) => {
        const row = rowNode as HTMLElement;
        const idx = parseInt(row.getAttribute('data-toc-index') ?? '-1', 10);
        const mod = this.selectableModules[idx];
        const checkbox = row.querySelector('.rbv-toc-checkbox') as HTMLInputElement | null;
        if (!mod || !checkbox) return;

        const state = getTocItemState(idx, total, this.tocSelection);
        const isSelected = state === 'selected-edge' || state === 'selected-middle';
        const isLockedMiddle = state === 'selected-middle';
        const isAdjacent = state === 'adjacent-available';
        const isDisabledGap = state === 'disabled-gap';

        checkbox.checked = isSelected;
        checkbox.disabled = this.isExporting || isLockedMiddle || isDisabledGap;

        row.classList.toggle('is-selected', isSelected);
        row.classList.toggle(
          'is-range-start',
          isSelected && this.tocSelection !== null && idx === this.tocSelection.startIndex
        );
        row.classList.toggle(
          'is-range-end',
          isSelected && this.tocSelection !== null && idx === this.tocSelection.endIndex
        );
        row.classList.toggle('is-middle-locked', isLockedMiddle);
        row.classList.toggle('is-adjacent', isAdjacent);
        row.classList.toggle('is-disabled-gap', isDisabledGap);
        row.classList.toggle('is-exporting', this.isExporting);

        const baseMeta = `${mod.title} (ch ${mod.startChapter}–${mod.endChapter} • ${mod.pageCount} hal)`;
        if (isLockedMiddle) {
          row.title = `${baseMeta} — Terkunci di tengah rentang terpilih. Lepas dari ujung atas/bawah terlebih dahulu.`;
        } else if (isDisabledGap) {
          row.title = `${baseMeta} — Hanya bisa memilih TOC tepat di atas/bawah rentang terpilih. Klik Reset untuk mulai dari bagian lain.`;
        } else if (isAdjacent) {
          row.title = `${baseMeta} — Klik untuk menambahkan ke rentang terpilih.`;
        } else if (isSelected && this.tocSelection && this.tocSelection.startIndex === this.tocSelection.endIndex) {
          row.title = `${baseMeta} — Klik lagi untuk melepas pilihan.`;
        } else if (isSelected) {
          row.title = `${baseMeta} — Klik untuk melepas dari ujung rentang.`;
        } else {
          row.title = baseMeta;
        }
      });
    }

    if (summaryEl) {
      if (total === 0 || !computed) {
        summaryEl.textContent = 'Rentang Manual';
        summaryEl.classList.add('is-manual');
      } else if (computed.isFullBook) {
        summaryEl.textContent = `Seluruh Buku (${computed.selectedCount} TOC)`;
        summaryEl.classList.remove('is-manual');
      } else if (computed.selectedCount === 1) {
        summaryEl.textContent = '1 TOC dipilih';
        summaryEl.classList.remove('is-manual');
      } else {
        summaryEl.textContent = `${computed.selectedCount} TOC dipilih`;
        summaryEl.classList.remove('is-manual');
      }
    }

    const isAllSelected =
      total > 0 &&
      this.tocSelection !== null &&
      this.tocSelection.startIndex === 0 &&
      this.tocSelection.endIndex === total - 1;

    if (allBtn) {
      allBtn.disabled = this.isExporting || total === 0 || isAllSelected;
    }
    if (resetBtn) {
      resetBtn.disabled = this.isExporting || total === 0 || this.tocSelection === null;
    }

    if (ruleHint) {
      if (total === 0) {
        ruleHint.textContent = 'Isi Dari/Sampai Ch secara manual atau klik Pindai TOC.';
      } else if (this.tocSelection === null) {
        ruleHint.textContent = 'Semua TOC terbuka — klik TOC mana pun untuk mulai rentang baru.';
      } else {
        ruleHint.textContent = 'Hanya TOC tepat di atas/bawah yang bisa ditambah (1 kesatuan tanpa lompat).';
      }
    }
  }

  private handleTocItemToggle(index: number): void {
    if (this.isExporting) return;

    const result = toggleTocItemSelection(this.tocSelection, index, this.selectableModules.length);
    if (!result.changed) {
      this.syncTocListUi();
      return;
    }

    this.tocSelection = result.selection;
    const computed = computeSelectedChapterRange(this.selectableModules, this.tocSelection);

    if (computed) {
      const startInput = this.shadowRoot.querySelector('#rbv-start-ch') as HTMLInputElement | null;
      const endInput = this.shadowRoot.querySelector('#rbv-end-ch') as HTMLInputElement | null;
      if (startInput) startInput.value = String(computed.startChapter);
      if (endInput) endInput.value = String(computed.endChapter);
      this.updatePageCountPill();
    }

    this.syncTocListUi();
  }

  private handleSelectAllToc(): void {
    if (this.isExporting || this.selectableModules.length === 0) return;

    this.tocSelection = selectAllTocItems(this.selectableModules.length);
    const computed = computeSelectedChapterRange(this.selectableModules, this.tocSelection);
    if (computed) {
      const startInput = this.shadowRoot.querySelector('#rbv-start-ch') as HTMLInputElement | null;
      const endInput = this.shadowRoot.querySelector('#rbv-end-ch') as HTMLInputElement | null;
      if (startInput) startInput.value = String(computed.startChapter);
      if (endInput) endInput.value = String(computed.endChapter);
      this.updatePageCountPill();
    }
    this.syncTocListUi();
  }

  private handleResetTocSelection(): void {
    if (this.isExporting) return;
    this.tocSelection = null;
    this.syncTocListUi();
  }

  private handleManualRangeEdit(): void {
    const startInput = this.shadowRoot.querySelector('#rbv-start-ch') as HTMLInputElement | null;
    const endInput = this.shadowRoot.querySelector('#rbv-end-ch') as HTMLInputElement | null;
    const start = parseInt(startInput?.value ?? '', 10);
    const end = parseInt(endInput?.value ?? '', 10);

    this.tocSelection = matchSelectionFromChapterRange(this.selectableModules, start, end);
    this.syncTocListUi();
    this.updatePageCountPill();
  }

  private updatePageCountPill(): void {
    const startInput = this.shadowRoot.querySelector('#rbv-start-ch') as HTMLInputElement | null;
    const endInput = this.shadowRoot.querySelector('#rbv-end-ch') as HTMLInputElement | null;
    const pill = this.shadowRoot.querySelector('#rbv-page-count-pill') as HTMLElement | null;
    const advisory = this.shadowRoot.querySelector('#rbv-advisory-tip') as HTMLElement | null;
    if (!startInput || !endInput || !pill) return;

    const start = parseInt(startInput.value, 10);
    const end = parseInt(endInput.value, 10);

    if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end < start) {
      pill.textContent = 'Invalid';
      pill.style.background = '#fee2e2';
      pill.style.color = '#dc2626';
      advisory?.classList.remove('visible');
      return;
    }

    const count = end - start + 1;
    pill.textContent = `${count} hal`;
    pill.style.background = '#e0f2fe';
    pill.style.color = '#0369a1';

    if (advisory) {
      advisory.classList.toggle('visible', count > LARGE_RANGE_ADVISORY_THRESHOLD);
    }
  }

  private toggleMinimize(): void {
    this.setMinimized(!this.isMinimized, true);
  }

  private setMinimized(minimized: boolean, persist: boolean): void {
    const card = this.shadowRoot.querySelector('#rbv-card');
    const toggleBtn = this.shadowRoot.querySelector('#rbv-btn-toggle') as HTMLButtonElement | null;

    this.isMinimized = minimized;
    if (this.isMinimized) {
      card?.classList.add('minimized');
      if (toggleBtn) toggleBtn.textContent = '+';
    } else {
      card?.classList.remove('minimized');
      if (toggleBtn) toggleBtn.textContent = '−';
    }

    if (persist) {
      void saveWidgetPreferences({ minimized });
    }
  }

  private setupDraggable(): void {
    const header = this.shadowRoot.querySelector('#rbv-header') as HTMLElement | null;
    const host = this.shadowRoot.host as HTMLElement;

    if (!header || !host) return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;
    let lastLeft = 0;
    let lastTop = 0;

    header.addEventListener('mousedown', (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.rbv-icon-btn')) {
        return;
      }

      e.preventDefault();

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = host.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      lastLeft = initialLeft;
      lastTop = initialTop;

      host.style.setProperty('right', 'auto', 'important');
      host.style.setProperty('bottom', 'auto', 'important');
      host.style.setProperty('left', `${initialLeft}px`, 'important');
      host.style.setProperty('top', `${initialTop}px`, 'important');

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!isDragging) return;
        const deltaX = moveEvent.clientX - startX;
        const deltaY = moveEvent.clientY - startY;

        let newLeft = initialLeft + deltaX;
        let newTop = initialTop + deltaY;

        const maxLeft = Math.max(0, window.innerWidth - host.offsetWidth - 10);
        const maxTop = Math.max(0, window.innerHeight - host.offsetHeight - 10);

        newLeft = Math.max(10, Math.min(maxLeft, newLeft));
        newTop = Math.max(10, Math.min(maxTop, newTop));

        lastLeft = newLeft;
        lastTop = newTop;

        host.style.setProperty('left', `${newLeft}px`, 'important');
        host.style.setProperty('top', `${newTop}px`, 'important');
      };

      const onMouseUp = () => {
        isDragging = false;
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        void saveWidgetPreferences({ left: Math.round(lastLeft), top: Math.round(lastTop) });
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
  }

  /**
   * Action: Copies detailed DOM diagnostic report to clipboard
   */
  private async handleCopyDiagnostics(): Promise<void> {
    try {
      const report = DomDetector.getDiagnosticReport();
      const structure = TocParser.getBookStructure();
      const combined = { ...report, bookStructure: structure };
      const json = JSON.stringify(combined, null, 2);
      console.log('%c[RBV-UT Diagnostic Report]', 'color: #0284c7; font-weight: bold;', combined);

      await navigator.clipboard.writeText(json);
      this.updateStatus('idle', '✅ Diagnostik DOM + TOC berhasil disalin ke clipboard.');
    } catch (err) {
      logger.error('Failed to copy diagnostics:', err);
      this.updateStatus('idle', 'Diagnostik dicetak di DevTools Console (F12).');
    }
  }

  /**
   * Action: Single active page clean PDF export
   */
  private async handleTestPrint(): Promise<void> {
    if (this.isExporting) return;

    this.hideResumeBanner();
    this.isExporting = true;
    this.setExportingVisualState(true);
    this.openKeepAlivePort();
    this.renderProgressCard({
      status: 'INITIALIZING',
      currentChapter: 1,
      totalChaptersEstimated: 1,
      chapterTitle: DomDetector.detectChapterTitle(),
      moduleLabel: 'Halaman Aktif',
      phaseLabel: 'Inisialisasi',
      percent: 10,
      message: 'Menyiapkan cetak halaman aktif...'
    });
    this.startProgressPolling();

    const chapterTitle = DomDetector.detectChapterTitle();
    const bookTitle = DomDetector.detectBookTitle();

    const message: StartTestPrintMessage = {
      type: 'START_TEST_PRINT',
      payload: {
        bookTitle,
        chapterTitle
      }
    };

    try {
      const response = await chrome.runtime.sendMessage(message);
      logger.info('Single page print response:', response);

      this.finishExportSession();

      if (response?.success) {
        this.renderProgressCard({
          status: 'COMPLETED',
          currentChapter: 1,
          totalChaptersEstimated: 1,
          chapterTitle,
          moduleLabel: 'Halaman Aktif',
          phaseLabel: 'Selesai',
          percent: 100,
          message: `✅ Berhasil! ${response.filename || 'PDF'} (${response.fileSizeMb || '0'} MB) diunduh.`
        });
      } else {
        this.renderProgressCard({
          status: 'ERROR',
          currentChapter: 0,
          totalChaptersEstimated: 1,
          chapterTitle,
          moduleLabel: 'Halaman Aktif',
          phaseLabel: 'Error',
          percent: 0,
          message: `❌ Gagal: ${response?.error || 'Cetak halaman aktif gagal.'}`
        });
      }
    } catch (err) {
      logger.error('Failed to execute single page print:', err);
      this.finishExportSession();
      this.updateStatus('error', 'Gagal berkomunikasi dengan background service worker.');
    }
  }

  /**
   * Action: Multi-chapter module / page-range export into 1 stitched PDF with Bookmarks
   */
  private async handleStart(): Promise<void> {
    if (this.isExporting) return;

    const startInput = this.shadowRoot.querySelector('#rbv-start-ch') as HTMLInputElement | null;
    const endInput = this.shadowRoot.querySelector('#rbv-end-ch') as HTMLInputElement | null;
    const savePerPageChk = this.shadowRoot.querySelector('#rbv-chk-save-per-page') as HTMLInputElement | null;
    const retriesInput = this.shadowRoot.querySelector('#rbv-adv-retries') as HTMLInputElement | null;
    const timeoutInput = this.shadowRoot.querySelector('#rbv-adv-timeout') as HTMLInputElement | null;

    const startChapter = parseInt(startInput?.value ?? '0', 10);
    const endChapter = parseInt(endInput?.value ?? '0', 10);

    if (Number.isNaN(startChapter) || Number.isNaN(endChapter) || startChapter < 0 || endChapter < startChapter) {
      this.updateStatus('error', 'Rentang chapter tidak valid. Pastikan "Sampai Ch" ≥ "Dari Ch".');
      return;
    }

    const structure = TocParser.getBookStructure();
    this.bookStructure = structure;
    const latestSelectable = getSelectableTocModules(structure.modules);
    const computedFromState = computeSelectedChapterRange(this.selectableModules, this.tocSelection);
    const resolvedRange =
      computedFromState &&
      computedFromState.startChapter === startChapter &&
      computedFromState.endChapter === endChapter
        ? computedFromState
        : computeSelectedChapterRange(
            latestSelectable,
            matchSelectionFromChapterRange(latestSelectable, startChapter, endChapter)
          );
    const label = resolvedRange ? resolvedRange.label : `Rentang Ch ${startChapter}–${endChapter}`;

    const chapterTitles: Record<number, string> = {};
    for (const item of structure.tocItems) {
      chapterTitles[item.chapterIndex] = item.title;
    }
    const filteredTocItems = structure.tocItems.filter(
      (item) => item.chapterIndex >= startChapter && item.chapterIndex <= endChapter
    );

    const bookTitle = DomDetector.detectBookTitle();
    const bookAuthor = DomDetector.detectBookAuthor();
    this.currentTitle = bookTitle;

    const maxRetriesPerChapter = this.clampInt(
      retriesInput?.value,
      0,
      4,
      DEFAULT_EXPORTER_CONFIG.maxRetriesPerChapter
    );
    const navTimeoutSec = this.clampInt(
      timeoutInput?.value,
      10,
      60,
      Math.round(DEFAULT_EXPORTER_CONFIG.chapterNavigationTimeoutMs / 1000)
    );

    this.hideResumeBanner();
    this.isExporting = true;
    this.setExportingVisualState(true);
    this.openKeepAlivePort();
    this.renderProgressCard({
      status: 'INITIALIZING',
      currentChapter: 0,
      totalChaptersEstimated: endChapter - startChapter + 1,
      chapterTitle: label,
      moduleLabel: label,
      phaseLabel: 'Inisialisasi',
      percent: 0,
      totalBytes: 0,
      failedCount: 0,
      etaSeconds: null,
      message: `Memulai ${label} (${endChapter - startChapter + 1} halaman)...`
    });

    const message: StartExportMessage = {
      type: 'START_EXPORT',
      payload: {
        bookTitle,
        config: {
          maxRetriesPerChapter,
          chapterNavigationTimeoutMs: navTimeoutSec * 1000
        },
        range: {
          startChapter,
          endChapter,
          label,
          bookId: structure.bookId,
          bookTitle,
          bookAuthor,
          savePerPageDebug: !!savePerPageChk?.checked,
          chapterTitles,
          tocItems: filteredTocItems
        }
      }
    };

    try {
      const response = await chrome.runtime.sendMessage(message);
      logger.info('Start export response:', response);

      if (response?.success) {
        this.startProgressPolling();
      } else {
        this.finishExportSession();
        this.renderProgressCard({
          status: 'ERROR',
          currentChapter: 0,
          totalChaptersEstimated: endChapter - startChapter + 1,
          chapterTitle: label,
          moduleLabel: label,
          phaseLabel: 'Error',
          percent: 0,
          message: `Error: ${response?.error || 'Gagal memulai ekspor'}`
        });
      }
    } catch (err) {
      logger.error('Failed to send START_EXPORT message:', err);
      this.finishExportSession();
      this.updateStatus('error', 'Gagal berkomunikasi dengan background service worker.');
    }
  }

  private async handleStop(): Promise<void> {
    this.updateStatus('busy', 'Mengirim sinyal berhenti & menyelamatkan halaman...');

    const message: StopExportMessage = {
      type: 'STOP_EXPORT',
      reason: 'User manual stop'
    };

    try {
      await chrome.runtime.sendMessage(message);
    } catch (err) {
      logger.error('Failed to send STOP_EXPORT message:', err);
      this.finishExportSession();
      this.updateStatus('idle', 'Proses dihentikan.');
    }
  }

  private handleApplyResume(): void {
    if (this.pendingResumeChapter === null) return;

    const startInput = this.shadowRoot.querySelector('#rbv-start-ch') as HTMLInputElement | null;
    const endInput = this.shadowRoot.querySelector('#rbv-end-ch') as HTMLInputElement | null;
    if (startInput) {
      startInput.value = String(this.pendingResumeChapter);
    }
    const end = parseInt(endInput?.value ?? '', 10);
    this.tocSelection = matchSelectionFromChapterRange(
      this.selectableModules,
      this.pendingResumeChapter,
      end
    );
    this.syncTocListUi();
    this.updatePageCountPill();
    this.hideResumeBanner();
    void this.handleStart();
  }

  /**
   * Called by content/index.ts when Background pushes real-time EXPORT_PROGRESS
   */
  handleExportProgressNotification(progress: ExportProgress): void {
    this.renderProgressCard(progress);

    if (progress.status === 'COMPLETED' || progress.status === 'STOPPED' || progress.status === 'ERROR') {
      if (this.isExporting) {
        this.finishExportSession();
      }
    }
  }

  /**
   * Called by content/index.ts when Background pushes EXPORT_COMPLETE
   */
  handleExportCompleteNotification(payload: ExportCompleteMessage['payload']): void {
    this.finishExportSession();

    const summary: BatchExportSummary | undefined = payload.summary;
    const filename = summary?.outputFilename || payload.filename;
    const outputBytes = summary?.outputBytes ?? payload.outputBytes ?? summary?.totalBytes ?? 0;
    const sizeMb = (outputBytes / 1024 / 1024).toFixed(2);
    const pdfPages =
      summary?.totalPdfPages ?? payload.totalPdfPages ?? summary?.capturedCount ?? payload.totalChapters;
    const bookmarks = summary?.bookmarkCount ?? payload.bookmarkCount ?? 0;
    const failedCount = summary?.failedCount ?? 0;
    const totalReq = summary?.totalRequested ?? pdfPages;

    if (summary?.status === 'STOPPED') {
      const pct = totalReq > 0 ? Math.round((summary.capturedCount / totalReq) * 100) : 0;
      const msg = summary.outputFilename
        ? `⏹ Dihentikan. PDF parsial diunduh: ${filename} (${pdfPages} hal, ${sizeMb} MB, ${bookmarks} bookmarks).`
        : `⏹ Dihentikan. ${summary.capturedCount}/${totalReq} hal selesai.`;

      this.renderProgressCard({
        status: 'STOPPED',
        currentChapter: summary.capturedCount,
        totalChaptersEstimated: totalReq,
        chapterTitle: filename,
        moduleLabel: summary.label,
        phaseLabel: 'Parsial',
        percent: pct,
        capturedCount: summary.capturedCount,
        failedCount,
        totalBytes: outputBytes,
        etaSeconds: null,
        message: msg
      });

      if (summary.resumeFromChapter !== null && summary.resumeFromChapter !== undefined) {
        this.showResumeBanner(
          summary.resumeFromChapter,
          `Ekspor berhenti di ch/${summary.lastChapterIndex ?? summary.startChapter}. Anda bisa melanjutkan sisa halaman:`
        );
      }
      return;
    }

    const skipInfo =
      failedCount > 0 && summary?.failedChapters?.length
        ? ` • ⚠ ${failedCount} hal dilewati (${summary.failedChapters.map((f) => `ch/${f.chapterIndex}`).join(', ')})`
        : '';

    this.renderProgressCard({
      status: 'COMPLETED',
      currentChapter: summary?.capturedCount ?? pdfPages,
      totalChaptersEstimated: totalReq,
      chapterTitle: filename,
      moduleLabel: summary?.label,
      phaseLabel: failedCount > 0 ? 'Selesai (Skip)' : 'Selesai',
      percent: 100,
      capturedCount: summary?.capturedCount ?? pdfPages,
      failedCount,
      totalBytes: outputBytes,
      etaSeconds: 0,
      message: `✅ Selesai! ${filename} (${pdfPages} hal, ${sizeMb} MB, ${bookmarks} bookmarks)${skipInfo}`
    });
  }

  /**
   * Called by content/index.ts when Background pushes EXPORT_ERROR
   */
  handleExportErrorNotification(payload: ExportErrorMessage['payload']): void {
    this.finishExportSession();

    const summary = payload.summary;
    const totalReq = summary?.totalRequested ?? 0;
    const captured = summary?.capturedCount ?? 0;
    const pct = totalReq > 0 ? Math.round((captured / totalReq) * 100) : 0;
    const suffix = payload.details ? ` — ${payload.details}` : '';

    this.renderProgressCard({
      status: 'ERROR',
      currentChapter: captured,
      totalChaptersEstimated: totalReq || undefined,
      chapterTitle: payload.partialFilename || summary?.label || 'Error',
      moduleLabel: summary?.label,
      phaseLabel: payload.partialFilename ? 'Error (Parsial)' : 'Error',
      percent: pct,
      capturedCount: captured,
      failedCount: summary?.failedCount ?? 0,
      totalBytes: summary?.outputBytes ?? summary?.totalBytes ?? 0,
      etaSeconds: null,
      message: `❌ ${payload.message}${suffix}`
    });

    if (summary && summary.resumeFromChapter !== null && summary.resumeFromChapter !== undefined) {
      const reasonPrefix = summary.circuitBreakerTriggered
        ? 'Circuit breaker aktif (3 gagal beruntun).'
        : 'Ekspor terhenti karena error.';
      this.showResumeBanner(
        summary.resumeFromChapter,
        `${reasonPrefix} ${payload.partialFilename ? 'PDF parsial sudah tersimpan.' : ''}`
      );
    }
  }

  private renderProgressCard(progress: ExportProgress): void {
    const card = this.shadowRoot.querySelector('#rbv-progress-card') as HTMLElement | null;
    const phaseBadge = this.shadowRoot.querySelector('#rbv-phase-badge') as HTMLElement | null;
    const pctEl = this.shadowRoot.querySelector('#rbv-progress-pct') as HTMLElement | null;
    const fillEl = this.shadowRoot.querySelector('#rbv-progress-fill') as HTMLElement | null;
    const headlineEl = this.shadowRoot.querySelector('#rbv-progress-headline') as HTMLElement | null;
    const subEl = this.shadowRoot.querySelector('#rbv-progress-sub') as HTMLElement | null;
    const leftEl = this.shadowRoot.querySelector('#rbv-telemetry-left') as HTMLElement | null;
    const rightEl = this.shadowRoot.querySelector('#rbv-telemetry-right') as HTMLElement | null;
    const skipPill = this.shadowRoot.querySelector('#rbv-skip-pill') as HTMLElement | null;
    const headerPct = this.shadowRoot.querySelector('#rbv-header-pct') as HTMLElement | null;
    const miniFill = this.shadowRoot.querySelector('#rbv-mini-progress-fill') as HTMLElement | null;

    const pct = Math.max(0, Math.min(100, Math.round(progress.percent ?? 0)));

    if (card) {
      card.classList.add('visible');
    }

    if (pctEl) pctEl.textContent = `${pct}%`;
    if (headerPct) headerPct.textContent = `${pct}%`;
    if (miniFill) miniFill.style.width = `${pct}%`;

    const isBusy =
      progress.status === 'INITIALIZING' ||
      progress.status === 'NAVIGATING' ||
      progress.status === 'CAPTURING_PAGE' ||
      progress.status === 'RETRYING' ||
      progress.status === 'WAITING_NEXT' ||
      progress.status === 'STITCHING';

    if (fillEl) {
      fillEl.style.width = `${pct}%`;
      fillEl.className = 'rbv-progress-fill';
      if (isBusy) fillEl.classList.add('animated');
      if (progress.status === 'RETRYING') fillEl.classList.add('retrying');
      else if (progress.status === 'STITCHING') fillEl.classList.add('stitching');
      else if (progress.status === 'COMPLETED') fillEl.classList.add('success');
      else if (progress.status === 'STOPPED') fillEl.classList.add('partial');
      else if (progress.status === 'ERROR') fillEl.classList.add('error');
    }

    if (phaseBadge) {
      phaseBadge.textContent = progress.phaseLabel || this.defaultPhaseLabel(progress.status);
      phaseBadge.className = 'rbv-phase-badge';
      if (progress.status === 'RETRYING') phaseBadge.classList.add('retrying');
      else if (progress.status === 'STITCHING') phaseBadge.classList.add('stitching');
      else if (progress.status === 'COMPLETED') phaseBadge.classList.add('success');
      else if (progress.status === 'STOPPED') phaseBadge.classList.add('partial');
      else if (progress.status === 'ERROR') phaseBadge.classList.add('error');
    }

    if (headlineEl) {
      const total = progress.totalChaptersEstimated;
      const modSuffix = progress.moduleLabel ? ` (${progress.moduleLabel})` : '';
      if (total && total > 0 && progress.currentChapter > 0) {
        headlineEl.textContent = `Halaman ${progress.currentChapter} dari ${total}${modSuffix}`;
      } else if (progress.moduleLabel) {
        headlineEl.textContent = progress.moduleLabel;
      } else {
        headlineEl.textContent = progress.chapterTitle || 'Memproses...';
      }
    }

    if (subEl) {
      subEl.textContent = progress.chapterTitle || '';
    }

    if (leftEl) {
      const mb = ((progress.totalBytes ?? 0) / 1024 / 1024).toFixed(2);
      leftEl.textContent = `${mb} MB`;
    }

    if (skipPill) {
      const failed = progress.failedCount ?? 0;
      if (failed > 0) {
        skipPill.textContent = `⚠ ${failed} dilewati`;
        skipPill.classList.add('visible');
      } else {
        skipPill.classList.remove('visible');
      }
    }

    if (rightEl) {
      if (progress.status === 'COMPLETED') {
        rightEl.textContent = 'Selesai';
      } else if (progress.status === 'STITCHING') {
        rightEl.textContent = 'Menyusun PDF...';
      } else if (typeof progress.etaSeconds === 'number' && progress.etaSeconds > 0) {
        rightEl.textContent = `Sisa ~${this.formatDuration(progress.etaSeconds)}`;
      } else if (isBusy) {
        rightEl.textContent = 'Menghitung ETA...';
      } else {
        rightEl.textContent = '—';
      }
    }

    const dotState: 'idle' | 'busy' | 'error' =
      progress.status === 'ERROR' ? 'error' : isBusy ? 'busy' : 'idle';
    this.updateStatus(dotState, progress.message);
  }

  private showResumeBanner(resumeFromChapter: number, description: string): void {
    this.pendingResumeChapter = resumeFromChapter;
    const banner = this.shadowRoot.querySelector('#rbv-resume-banner') as HTMLElement | null;
    const text = this.shadowRoot.querySelector('#rbv-resume-text') as HTMLElement | null;
    const btn = this.shadowRoot.querySelector('#rbv-btn-resume') as HTMLButtonElement | null;

    if (text) text.textContent = description;
    if (btn) btn.textContent = `▶ Lanjutkan dari Ch ${resumeFromChapter}`;
    banner?.classList.add('visible');
  }

  private hideResumeBanner(): void {
    this.pendingResumeChapter = null;
    const banner = this.shadowRoot.querySelector('#rbv-resume-banner') as HTMLElement | null;
    banner?.classList.remove('visible');
  }

  /**
   * Lightweight 2s fallback safety poll in case a push notification is dropped during tab transitions
   */
  private startProgressPolling(): void {
    if (this.pollIntervalId) return;

    this.pollIntervalId = window.setInterval(async () => {
      try {
        const res = (await chrome.runtime.sendMessage({ type: 'GET_STATUS' })) as StatusResponseMessage;
        if (res?.type === 'STATUS_RESPONSE' && res.payload) {
          this.handleExportProgressNotification(res.payload);
        }
      } catch {
        // Suppress transient polling errors during tab transitions
      }
    }, 2000);
  }

  private stopProgressPolling(): void {
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
  }

  private openKeepAlivePort(): void {
    if (this.keepAlivePort) return;
    try {
      this.keepAlivePort = chrome.runtime.connect({ name: 'rbv-export-keepalive' });
      this.keepAlivePort.onDisconnect.addListener(() => {
        this.keepAlivePort = null;
      });
    } catch {
      this.keepAlivePort = null;
    }
  }

  private closeKeepAlivePort(): void {
    if (!this.keepAlivePort) return;
    try {
      this.keepAlivePort.disconnect();
    } catch {
      // Ignore already disconnected port
    }
    this.keepAlivePort = null;
  }

  private finishExportSession(): void {
    this.stopProgressPolling();
    this.closeKeepAlivePort();
    this.isExporting = false;
    this.setExportingVisualState(false);
  }

  private updateStatus(state: 'idle' | 'busy' | 'error', message: string): void {
    const dot = this.shadowRoot.querySelector('#rbv-status-dot');
    const text = this.shadowRoot.querySelector('#rbv-status-text');

    if (dot) {
      dot.className = 'rbv-status-dot';
      if (state === 'busy') dot.classList.add('busy');
      if (state === 'error') dot.classList.add('error');
    }

    if (text) {
      text.textContent = message;
    }
  }

  private setExportingVisualState(exporting: boolean): void {
    const card = this.shadowRoot.querySelector('#rbv-card');
    card?.classList.toggle('is-exporting', exporting);

    const testPrintBtn = this.shadowRoot.querySelector('#rbv-btn-test-print') as HTMLButtonElement | null;
    const startBtn = this.shadowRoot.querySelector('#rbv-btn-start') as HTMLButtonElement | null;
    const stopBtn = this.shadowRoot.querySelector('#rbv-btn-stop') as HTMLButtonElement | null;
    const diagBtn = this.shadowRoot.querySelector('#rbv-btn-diag') as HTMLButtonElement | null;
    const refreshBtn = this.shadowRoot.querySelector('#rbv-btn-refresh-toc') as HTMLButtonElement | null;
    const startInput = this.shadowRoot.querySelector('#rbv-start-ch') as HTMLInputElement | null;
    const endInput = this.shadowRoot.querySelector('#rbv-end-ch') as HTMLInputElement | null;
    const saveChk = this.shadowRoot.querySelector('#rbv-chk-save-per-page') as HTMLInputElement | null;
    const retriesInput = this.shadowRoot.querySelector('#rbv-adv-retries') as HTMLInputElement | null;
    const timeoutInput = this.shadowRoot.querySelector('#rbv-adv-timeout') as HTMLInputElement | null;

    if (testPrintBtn) testPrintBtn.disabled = exporting;
    if (diagBtn) diagBtn.disabled = exporting;
    if (refreshBtn) refreshBtn.disabled = exporting;
    if (startInput) startInput.disabled = exporting;
    if (endInput) endInput.disabled = exporting;
    if (saveChk) saveChk.disabled = exporting;
    if (retriesInput) retriesInput.disabled = exporting;
    if (timeoutInput) timeoutInput.disabled = exporting;
    this.syncTocListUi();

    if (startBtn) startBtn.style.display = exporting ? 'none' : 'flex';
    if (stopBtn) stopBtn.style.display = exporting ? 'flex' : 'none';
  }

  private defaultPhaseLabel(status: ExportProgress['status']): string {
    switch (status) {
      case 'INITIALIZING':
        return 'Inisialisasi';
      case 'NAVIGATING':
        return 'Navigasi';
      case 'CAPTURING_PAGE':
        return 'Cetak PDF';
      case 'RETRYING':
        return 'Mengulang';
      case 'WAITING_NEXT':
        return 'Berikutnya';
      case 'STITCHING':
        return 'Menggabungkan';
      case 'COMPLETED':
        return 'Selesai';
      case 'STOPPED':
        return 'Parsial';
      case 'ERROR':
        return 'Error';
      default:
        return 'Siap';
    }
  }

  private formatDuration(totalSeconds: number): string {
    const secs = Math.max(1, Math.round(totalSeconds));
    if (secs < 60) return `${secs}d`;
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return rem > 0 ? `${mins}m ${rem}d` : `${mins}m`;
  }

  private clampInt(raw: string | number | undefined, min: number, max: number, fallback: number): number {
    const parsed = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
    if (Number.isNaN(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(parsed)));
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
