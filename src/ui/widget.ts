import widgetCss from './widget.css?inline';
import { DomDetector } from '../content/dom-detector';
import { TocParser } from '../content/toc-parser';
import { getBrowserApi } from '../utils/browser-api';
import { logger } from '../utils/logger';
import { loadWidgetPreferences, saveWidgetPreferences } from '../utils/storage';
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

/**
 * Safe DOM element builder (zero `.innerHTML`) for Mozilla AMO `addons-linter` compliance.
 */
function createEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  children?: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, v);
    }
  }
  if (children) {
    for (const child of children) {
      if (typeof child === 'string') {
        el.appendChild(document.createTextNode(child));
      } else {
        el.appendChild(child);
      }
    }
  }
  return el;
}

export class FloatingWidget {
  private shadowRoot: ShadowRoot;
  private isExporting = false;
  private isMinimized = false;
  private currentTitle = '';
  private pollIntervalId: number | null = null;
  private keepAlivePort: browser.runtime.Port | null = null;
  private bookStructure: BookStructureInfo | null = null;
  private pendingResumeChapter: number | null = null;
  private appVersion = '1.0.0';

  constructor(shadowRoot: ShadowRoot) {
    this.shadowRoot = shadowRoot;
    try {
      this.appVersion = getBrowserApi().runtime.getManifest?.().version || '1.0.0';
    } catch {
      this.appVersion = '1.0.0';
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
    const iconUrl = getBrowserApi().runtime.getURL('icons/icon-48.png');

    while (this.shadowRoot.firstChild) {
      this.shadowRoot.removeChild(this.shadowRoot.firstChild);
    }

    const styleEl = document.createElement('style');
    styleEl.textContent = widgetCss;

    const iconImg = createEl('img', {
      src: iconUrl,
      width: '20',
      height: '20',
      alt: 'UT',
      style: 'border-radius: 4px; object-fit: contain; background: #ffffff; padding: 1px;'
    });

    const header = createEl('div', { class: 'rbv-header', id: 'rbv-header' }, [
      createEl('div', { class: 'rbv-title' }, [iconImg, createEl('span', undefined, ['RBV-UT Exporter'])]),
      createEl('div', { class: 'rbv-header-actions' }, [
        createEl('span', { class: 'rbv-header-pct', id: 'rbv-header-pct' }, ['0%']),
        createEl('span', { class: 'rbv-badge' }, ['Firefox']),
        createEl('button', { class: 'rbv-icon-btn', id: 'rbv-btn-toggle', title: 'Perkecil / Perbesar panel' }, ['−'])
      ]),
      createEl('div', { class: 'rbv-mini-progress' }, [
        createEl('div', { class: 'rbv-mini-progress-fill', id: 'rbv-mini-progress-fill' })
      ])
    ]);

    const bookInfo = createEl('div', { class: 'rbv-book-info' }, [
      createEl('div', { class: 'rbv-book-label' }, ['Buku Terdeteksi']),
      createEl(
        'div',
        { class: 'rbv-book-title', id: 'rbv-title-display', title: this.currentTitle },
        [this.currentTitle]
      )
    ]);

    const moduleSelect = createEl('select', { class: 'rbv-select', id: 'rbv-module-select' }, [
      createEl('option', { value: 'custom' }, ['Memindai Daftar Isi Kotobee...'])
    ]);

    const rangePanel = createEl('div', { class: 'rbv-range-panel' }, [
      createEl('div', { class: 'rbv-range-header' }, [
        createEl('span', { class: 'rbv-book-label' }, ['Modul / Rentang Halaman']),
        createEl(
          'button',
          { class: 'rbv-refresh-btn', id: 'rbv-btn-refresh-toc', title: 'Pindai ulang Daftar Isi (TOC) Kotobee' },
          ['↻ Pindai TOC']
        )
      ]),
      moduleSelect,
      createEl('div', { class: 'rbv-range-inputs' }, [
        createEl('div', { class: 'rbv-input-group' }, [
          createEl('span', { class: 'rbv-input-label' }, ['Dari Ch']),
          createEl('input', { type: 'number', min: '0', value: '0', class: 'rbv-num-input', id: 'rbv-start-ch' })
        ]),
        createEl('span', { class: 'rbv-range-sep' }, ['–']),
        createEl('div', { class: 'rbv-input-group' }, [
          createEl('span', { class: 'rbv-input-label' }, ['Sampai Ch']),
          createEl('input', { type: 'number', min: '0', value: '0', class: 'rbv-num-input', id: 'rbv-end-ch' })
        ]),
        createEl('span', { class: 'rbv-page-pill', id: 'rbv-page-count-pill' }, ['1 hal'])
      ]),
      createEl('div', { class: 'rbv-advisory-tip', id: 'rbv-advisory-tip' }, [
        `💡 Tip: Untuk buku >${LARGE_RANGE_ADVISORY_THRESHOLD} halaman, mengekspor per Modul lebih cepat & lebih hemat memori.`
      ])
    ]);

    const modeInfo = createEl('div', { class: 'rbv-mode-panel' }, [
      createEl('span', { class: 'rbv-book-label' }, ['Mode Ekspor: Vektor Native Firefox']),
      createEl('div', { class: 'rbv-mode-hint vector-note' }, [
        'Teks vektor tajam & searchable (NotebookLM) dengan 1x dialog Save As di akhir.'
      ])
    ]);

    const progressCard = createEl('div', { class: 'rbv-progress-card', id: 'rbv-progress-card' }, [
      createEl('div', { class: 'rbv-progress-top' }, [
        createEl('span', { class: 'rbv-phase-badge', id: 'rbv-phase-badge' }, ['Siap']),
        createEl('span', { class: 'rbv-progress-pct', id: 'rbv-progress-pct' }, ['0%'])
      ]),
      createEl('div', { class: 'rbv-progress-track' }, [
        createEl('div', { class: 'rbv-progress-fill', id: 'rbv-progress-fill' })
      ]),
      createEl('div', { class: 'rbv-progress-headline', id: 'rbv-progress-headline' }, ['Menyiapkan ekspor...']),
      createEl('div', { class: 'rbv-progress-sub', id: 'rbv-progress-sub' }),
      createEl('div', { class: 'rbv-telemetry-row' }, [
        createEl('span', { id: 'rbv-telemetry-left' }, ['0 hal']),
        createEl('span', { class: 'rbv-skip-pill', id: 'rbv-skip-pill' }, ['⚠ 0 dilewati']),
        createEl('span', { id: 'rbv-telemetry-right' }, ['Estimasi: —'])
      ])
    ]);

    const resumeBanner = createEl('div', { class: 'rbv-resume-banner', id: 'rbv-resume-banner' }, [
      createEl('div', { id: 'rbv-resume-text' }, ['Ekspor terhenti di tengah proses.']),
      createEl('button', { class: 'rbv-btn-resume', id: 'rbv-btn-resume' }, ['▶ Lanjutkan dari Ch 0'])
    ]);

    const statusRow = createEl('div', { class: 'rbv-status-row' }, [
      createEl('span', { class: 'rbv-status-dot', id: 'rbv-status-dot' }),
      createEl('span', { id: 'rbv-status-text' }, ['Siap. Pilih modul atau rentang chapter di atas.'])
    ]);

    const stopBtn = createEl(
      'button',
      { class: 'rbv-btn rbv-btn-danger', id: 'rbv-btn-stop', style: 'display: none;' },
      ['⏹ Berhenti & Simpan Parsial']
    );

    const actions = createEl('div', { class: 'rbv-actions' }, [
      createEl(
        'button',
        {
          class: 'rbv-btn rbv-btn-primary',
          id: 'rbv-btn-start',
          title: 'Kumpulkan seluruh rentang terpilih menjadi 1 file PDF vektor utuh (1x dialog Save As)'
        },
        ['🚀 Ekspor ke 1 File PDF']
      ),
      stopBtn,
      createEl(
        'button',
        {
          class: 'rbv-btn rbv-btn-secondary',
          id: 'rbv-btn-test-print',
          title: 'Cetak halaman yang sedang Anda buka saat ini menjadi 1 file PDF vektor'
        },
        ['📄 Cetak Halaman Aktif']
      )
    ]);

    const advDrawer = createEl('details', { class: 'rbv-advanced', id: 'rbv-advanced-drawer' }, [
      createEl('summary', { class: 'rbv-advanced-summary' }, [
        createEl('span', undefined, ['⚙ Alat Lanjutan & Diagnostik']),
        createEl('span', { class: 'rbv-advanced-caret' }, ['▼'])
      ]),
      createEl('div', { class: 'rbv-advanced-body' }, [
        createEl('div', { class: 'rbv-adv-grid' }, [
          createEl('div', { class: 'rbv-input-group' }, [
            createEl('span', { class: 'rbv-input-label' }, ['Maks Retry / hal']),
            createEl('input', {
              type: 'number',
              min: '0',
              max: '4',
              value: String(DEFAULT_EXPORTER_CONFIG.maxRetriesPerChapter),
              class: 'rbv-num-input',
              id: 'rbv-adv-retries'
            })
          ]),
          createEl('div', { class: 'rbv-input-group' }, [
            createEl('span', { class: 'rbv-input-label' }, ['Timeout (dtk)']),
            createEl('input', {
              type: 'number',
              min: '10',
              max: '60',
              value: String(Math.round(DEFAULT_EXPORTER_CONFIG.chapterNavigationTimeoutMs / 1000)),
              class: 'rbv-num-input',
              id: 'rbv-adv-timeout'
            })
          ])
        ]),
        createEl(
          'button',
          {
            class: 'rbv-btn rbv-btn-outline',
            id: 'rbv-btn-diag',
            title: 'Salin struktur DOM & TOC Kotobee ke clipboard untuk analisis'
          },
          ['🔍 Salin Diagnostik DOM']
        )
      ])
    ]);

    const body = createEl('div', { class: 'rbv-body' }, [
      bookInfo,
      rangePanel,
      modeInfo,
      progressCard,
      resumeBanner,
      statusRow,
      actions,
      advDrawer
    ]);

    const footer = createEl('div', { class: 'rbv-footer' }, [
      `Optimized for NotebookLM • Firefox v${this.appVersion}`
    ]);

    const card = createEl('div', { class: 'rbv-card', id: 'rbv-card' }, [header, body, footer]);

    this.shadowRoot.appendChild(styleEl);
    this.shadowRoot.appendChild(card);
  }

  private bindEvents(): void {
    const testPrintBtn = this.shadowRoot.querySelector('#rbv-btn-test-print') as HTMLButtonElement | null;
    const startBtn = this.shadowRoot.querySelector('#rbv-btn-start') as HTMLButtonElement | null;
    const stopBtn = this.shadowRoot.querySelector('#rbv-btn-stop') as HTMLButtonElement | null;
    const toggleBtn = this.shadowRoot.querySelector('#rbv-btn-toggle') as HTMLButtonElement | null;
    const diagBtn = this.shadowRoot.querySelector('#rbv-btn-diag') as HTMLButtonElement | null;
    const refreshTocBtn = this.shadowRoot.querySelector('#rbv-btn-refresh-toc') as HTMLButtonElement | null;
    const resumeBtn = this.shadowRoot.querySelector('#rbv-btn-resume') as HTMLButtonElement | null;
    const moduleSelect = this.shadowRoot.querySelector('#rbv-module-select') as HTMLSelectElement | null;
    const startInput = this.shadowRoot.querySelector('#rbv-start-ch') as HTMLInputElement | null;
    const endInput = this.shadowRoot.querySelector('#rbv-end-ch') as HTMLInputElement | null;
    const retriesInput = this.shadowRoot.querySelector('#rbv-adv-retries') as HTMLInputElement | null;
    const timeoutInput = this.shadowRoot.querySelector('#rbv-adv-timeout') as HTMLInputElement | null;

    testPrintBtn?.addEventListener('click', () => void this.handleTestPrint());
    startBtn?.addEventListener('click', () => void this.handleStart());
    stopBtn?.addEventListener('click', () => void this.handleStop());
    diagBtn?.addEventListener('click', () => void this.handleCopyDiagnostics());
    refreshTocBtn?.addEventListener('click', () => this.refreshBookStructure(false));
    resumeBtn?.addEventListener('click', () => this.handleApplyResume());

    moduleSelect?.addEventListener('change', () => this.handleModuleSelectionChange());
    startInput?.addEventListener('input', () => this.handleManualRangeEdit());
    endInput?.addEventListener('input', () => this.handleManualRangeEdit());

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

  private async rehydrateActiveExportStatus(): Promise<void> {
    try {
      const res = (await getBrowserApi().runtime.sendMessage({
        type: 'GET_STATUS'
      })) as StatusResponseMessage;
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

  toggleVisibilityOrExpand(): void {
    if (this.isMinimized) {
      this.setMinimized(false, true);
    } else {
      this.setMinimized(true, true);
    }
  }

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

      const selectEl = this.shadowRoot.querySelector('#rbv-module-select') as HTMLSelectElement | null;
      const startInput = this.shadowRoot.querySelector('#rbv-start-ch') as HTMLInputElement | null;
      const endInput = this.shadowRoot.querySelector('#rbv-end-ch') as HTMLInputElement | null;

      if (!selectEl || !startInput || !endInput) return;

      const maxCh = structure.totalChapters > 0 ? structure.totalChapters - 1 : 9999;
      startInput.max = String(maxCh);
      endInput.max = String(maxCh);

      while (selectEl.firstChild) {
        selectEl.removeChild(selectEl.firstChild);
      }

      if (structure.modules.length > 0) {
        for (const mod of structure.modules) {
          const opt = document.createElement('option');
          opt.value = mod.id;
          opt.textContent = `${mod.title} (ch ${mod.startChapter}–${mod.endChapter} • ${mod.pageCount} hal)`;
          selectEl.appendChild(opt);
        }

        const customOpt = document.createElement('option');
        customOpt.value = 'custom';
        customOpt.textContent = 'Rentang Manual (Custom)';
        selectEl.appendChild(customOpt);

        const activeModule = this.findModuleForChapter(structure.modules, structure.currentChapter);
        if (activeModule) {
          selectEl.value = activeModule.id;
          startInput.value = String(activeModule.startChapter);
          endInput.value = String(activeModule.endChapter);
        } else {
          selectEl.value = structure.modules[0].id;
          startInput.value = String(structure.modules[0].startChapter);
          endInput.value = String(structure.modules[0].endChapter);
        }

        this.updatePageCountPill();

        if (!silent) {
          this.updateStatus(
            'idle',
            `TOC terdeteksi: ${Math.max(1, structure.modules.length - 1)} bagian, total ${structure.totalChapters} halaman.`
          );
        }
      } else {
        const fallbackOpt = document.createElement('option');
        fallbackOpt.value = 'custom';
        fallbackOpt.textContent = 'Rentang Manual (TOC belum termuat)';
        selectEl.appendChild(fallbackOpt);
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

  private findModuleForChapter(modules: ModuleRange[], currentChapter: number): ModuleRange | null {
    const specific = modules.find(
      (m) => !m.isFullBook && currentChapter >= m.startChapter && currentChapter <= m.endChapter
    );
    return specific || modules[0] || null;
  }

  private handleModuleSelectionChange(): void {
    const selectEl = this.shadowRoot.querySelector('#rbv-module-select') as HTMLSelectElement | null;
    const startInput = this.shadowRoot.querySelector('#rbv-start-ch') as HTMLInputElement | null;
    const endInput = this.shadowRoot.querySelector('#rbv-end-ch') as HTMLInputElement | null;
    if (!selectEl || !startInput || !endInput || !this.bookStructure) return;

    const selected = this.bookStructure.modules.find((m) => m.id === selectEl.value);
    if (selected) {
      startInput.value = String(selected.startChapter);
      endInput.value = String(selected.endChapter);
      this.updatePageCountPill();
    }
  }

  private handleManualRangeEdit(): void {
    const selectEl = this.shadowRoot.querySelector('#rbv-module-select') as HTMLSelectElement | null;
    if (selectEl && selectEl.querySelector('option[value="custom"]')) {
      selectEl.value = 'custom';
    }
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
      this.updateStatus('idle', 'Diagnostik dicetak di Web Console (F12).');
    }
  }

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
      message: 'Menyiapkan cetak vektor halaman aktif...'
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
      const response = (await getBrowserApi().runtime.sendMessage(message)) as {
        success?: boolean;
        filename?: string;
        vectorSaveStatus?: string;
        error?: string;
        message?: string;
      };
      logger.info('Single page print response:', response);

      this.finishExportSession();

      if (response?.success) {
        const msg =
          response.vectorSaveStatus === 'fallback-print'
            ? '✅ Dialog cetak sistem dibuka — pilih "Save to PDF".'
            : `✅ Berhasil! ${response.filename || 'PDF'} (Vektor) tersimpan.`;
        this.renderProgressCard({
          status: 'COMPLETED',
          currentChapter: 1,
          totalChaptersEstimated: 1,
          capturedCount: 1,
          chapterTitle,
          moduleLabel: 'Halaman Aktif',
          phaseLabel: 'Selesai',
          percent: 100,
          message: msg
        });
      } else if (response?.vectorSaveStatus === 'canceled') {
        this.renderProgressCard({
          status: 'STOPPED',
          currentChapter: 0,
          totalChaptersEstimated: 1,
          chapterTitle,
          moduleLabel: 'Halaman Aktif',
          phaseLabel: 'Dibatalkan',
          percent: 0,
          message: '⏹ Penyimpanan PDF dibatalkan pengguna.'
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
          message: `❌ ${response?.error || response?.message || 'Cetak halaman aktif gagal.'}`
        });
      }
    } catch (err) {
      logger.error('Failed to execute single page print:', err);
      this.finishExportSession();
      this.updateStatus('error', 'Gagal berkomunikasi dengan background script ekstensi.');
    }
  }

  private async handleStart(): Promise<void> {
    if (this.isExporting) return;

    const startInput = this.shadowRoot.querySelector('#rbv-start-ch') as HTMLInputElement | null;
    const endInput = this.shadowRoot.querySelector('#rbv-end-ch') as HTMLInputElement | null;
    const selectEl = this.shadowRoot.querySelector('#rbv-module-select') as HTMLSelectElement | null;
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
    const selectedModule = structure.modules.find((m) => m.id === selectEl?.value);
    const label = selectedModule ? selectedModule.title : `Rentang Ch ${startChapter}–${endChapter}`;

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
      capturedCount: 0,
      failedCount: 0,
      etaSeconds: null,
      message: `Memulai ${label} (${endChapter - startChapter + 1} halaman)...`
    });

    const message: StartExportMessage = {
      type: 'START_EXPORT',
      payload: {
        bookTitle,
        config: {
          exportMode: 'native-vector',
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
          exportMode: 'native-vector',
          chapterTitles,
          tocItems: filteredTocItems
        }
      }
    };

    try {
      const response = (await getBrowserApi().runtime.sendMessage(message)) as {
        success?: boolean;
        error?: string;
      };
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
      this.updateStatus('error', 'Gagal berkomunikasi dengan background script ekstensi.');
    }
  }

  private async handleStop(): Promise<void> {
    this.updateStatus('busy', 'Mengirim sinyal berhenti & menyelamatkan halaman...');

    const message: StopExportMessage = {
      type: 'STOP_EXPORT',
      reason: 'User manual stop'
    };

    try {
      await getBrowserApi().runtime.sendMessage(message);
    } catch (err) {
      logger.error('Failed to send STOP_EXPORT message:', err);
      this.finishExportSession();
      this.updateStatus('idle', 'Proses dihentikan.');
    }
  }

  private handleApplyResume(): void {
    if (this.pendingResumeChapter === null) return;

    const startInput = this.shadowRoot.querySelector('#rbv-start-ch') as HTMLInputElement | null;
    const selectEl = this.shadowRoot.querySelector('#rbv-module-select') as HTMLSelectElement | null;
    if (startInput) {
      startInput.value = String(this.pendingResumeChapter);
    }
    if (selectEl && selectEl.querySelector('option[value="custom"]')) {
      selectEl.value = 'custom';
    }
    this.updatePageCountPill();
    this.hideResumeBanner();
    void this.handleStart();
  }

  handleExportProgressNotification(progress: ExportProgress): void {
    this.renderProgressCard(progress);

    if (progress.status === 'COMPLETED' || progress.status === 'STOPPED' || progress.status === 'ERROR') {
      if (this.isExporting) {
        this.finishExportSession();
      }
    }
  }

  handleExportCompleteNotification(payload: ExportCompleteMessage['payload']): void {
    this.finishExportSession();

    const summary: BatchExportSummary | undefined = payload.summary;
    const filename = summary?.outputFilename || payload.filename;
    const pdfPages =
      summary?.totalPdfPages ?? payload.totalPdfPages ?? summary?.capturedCount ?? payload.totalChapters;
    const failedCount = summary?.failedCount ?? 0;
    const totalReq = summary?.totalRequested ?? pdfPages;

    if (summary?.status === 'STOPPED' || payload.vectorSaveStatus === 'canceled') {
      const pct = totalReq > 0 ? Math.round(((summary?.capturedCount ?? 0) / totalReq) * 100) : 0;
      const msg =
        payload.vectorSaveStatus === 'canceled'
          ? `⏹ Dialog simpan PDF vektor dibatalkan (${pdfPages} hal sempat dikumpulkan).`
          : summary?.outputFilename
            ? `⏹ Dihentikan. PDF vektor parsial disimpan: ${filename} (${pdfPages} hal).`
            : `⏹ Dihentikan. ${summary?.capturedCount ?? 0}/${totalReq} hal selesai.`;

      this.renderProgressCard({
        status: 'STOPPED',
        currentChapter: summary?.capturedCount ?? pdfPages,
        totalChaptersEstimated: totalReq,
        chapterTitle: filename,
        moduleLabel: summary?.label,
        phaseLabel: payload.vectorSaveStatus === 'canceled' ? 'Dibatalkan' : 'Parsial',
        percent: pct,
        capturedCount: summary?.capturedCount ?? pdfPages,
        failedCount,
        etaSeconds: null,
        message: msg
      });

      if (summary?.resumeFromChapter !== null && summary?.resumeFromChapter !== undefined) {
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

    const completeMsg =
      payload.vectorSaveStatus === 'fallback-print'
        ? `✅ Dialog cetak dibuka (${pdfPages} hal) — pilih "Save to PDF"${skipInfo}`
        : `✅ Selesai! PDF Vektor disimpan: ${filename} (${pdfPages} hal)${skipInfo}`;

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
      etaSeconds: 0,
      message: completeMsg
    });
  }

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

    card?.classList.add('visible');

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
      const captured = progress.capturedCount ?? progress.currentChapter ?? 0;
      leftEl.textContent = `${captured} hal terkumpul`;
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
        rightEl.textContent = 'Menyiapkan Save As...';
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

  private startProgressPolling(): void {
    if (this.pollIntervalId) return;

    this.pollIntervalId = window.setInterval(async () => {
      try {
        const res = (await getBrowserApi().runtime.sendMessage({
          type: 'GET_STATUS'
        })) as StatusResponseMessage;
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
      this.keepAlivePort = getBrowserApi().runtime.connect({ name: 'rbv-export-keepalive' });
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
    const moduleSelect = this.shadowRoot.querySelector('#rbv-module-select') as HTMLSelectElement | null;
    const startInput = this.shadowRoot.querySelector('#rbv-start-ch') as HTMLInputElement | null;
    const endInput = this.shadowRoot.querySelector('#rbv-end-ch') as HTMLInputElement | null;
    const retriesInput = this.shadowRoot.querySelector('#rbv-adv-retries') as HTMLInputElement | null;
    const timeoutInput = this.shadowRoot.querySelector('#rbv-adv-timeout') as HTMLInputElement | null;

    if (testPrintBtn) testPrintBtn.disabled = exporting;
    if (diagBtn) diagBtn.disabled = exporting;
    if (refreshBtn) refreshBtn.disabled = exporting;
    if (moduleSelect) moduleSelect.disabled = exporting;
    if (startInput) startInput.disabled = exporting;
    if (endInput) endInput.disabled = exporting;
    if (retriesInput) retriesInput.disabled = exporting;
    if (timeoutInput) timeoutInput.disabled = exporting;

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
        return 'Snapshot DOM';
      case 'RETRYING':
        return 'Mengulang';
      case 'WAITING_NEXT':
        return 'Berikutnya';
      case 'STITCHING':
        return 'Simpan Vektor';
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
}
