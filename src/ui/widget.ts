import widgetCss from './widget.css?inline';
import { DomDetector } from '../content/dom-detector';
import { TocParser } from '../content/toc-parser';
import { logger } from '../utils/logger';
import type {
  BookStructureInfo,
  BatchExportSummary,
  ModuleRange
} from '../types/exporter';
import type {
  ExportCompleteMessage,
  ExportErrorMessage,
  StartExportMessage,
  StartTestPrintMessage,
  StopExportMessage,
  StatusResponseMessage
} from '../types/messages';

export class FloatingWidget {
  private shadowRoot: ShadowRoot;
  private isExporting = false;
  private isMinimized = false;
  private currentTitle = '';
  private pollIntervalId: number | null = null;
  private bookStructure: BookStructureInfo | null = null;

  constructor(shadowRoot: ShadowRoot) {
    this.shadowRoot = shadowRoot;
    this.init();
  }

  private init(): void {
    this.currentTitle = DomDetector.detectBookTitle();
    this.render();
    this.bindEvents();
    this.setupDraggable();
    this.refreshBookStructure(true);

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
            <span class="rbv-badge">MV3</span>
            <button class="rbv-icon-btn" id="rbv-btn-toggle" title="Perkecil / Perbesar panel">−</button>
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
              <button class="rbv-refresh-btn" id="rbv-btn-refresh-toc" title="Pindai ulang Daftar Isi (TOC) Kotobee">↻ Pindai TOC</button>
            </div>
            <select class="rbv-select" id="rbv-module-select">
              <option value="custom">Memindai Daftar Isi Kotobee...</option>
            </select>
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
            <label class="rbv-checkbox-row" title="Selain menghasilkan 1 PDF gabungan ber-bookmark, simpan juga salinan PDF terpisah untuk setiap halaman">
              <input type="checkbox" id="rbv-chk-save-per-page" />
              <span>Simpan salinan PDF per halaman (Debug)</span>
            </label>
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
            <button class="rbv-btn rbv-btn-secondary" id="rbv-btn-test-print" title="Cetak bab aktif saja untuk menguji format & kelengkapan halaman">
              📄 Uji Cetak 1 Bab (Fase 2)
            </button>
            <button class="rbv-btn rbv-btn-outline" id="rbv-btn-diag" title="Salin struktur DOM Kotobee ke clipboard untuk analisis jika layout bermasalah">
              🔍 Salin Diagnostik DOM
            </button>
          </div>
        </div>
        <div class="rbv-footer">
          Optimized for NotebookLM • v0.3.0 (Fase 4)
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
    const moduleSelect = this.shadowRoot.querySelector('#rbv-module-select') as HTMLSelectElement | null;
    const startInput = this.shadowRoot.querySelector('#rbv-start-ch') as HTMLInputElement | null;
    const endInput = this.shadowRoot.querySelector('#rbv-end-ch') as HTMLInputElement | null;

    testPrintBtn?.addEventListener('click', () => this.handleTestPrint());
    startBtn?.addEventListener('click', () => this.handleStart());
    stopBtn?.addEventListener('click', () => this.handleStop());
    diagBtn?.addEventListener('click', () => this.handleCopyDiagnostics());
    refreshTocBtn?.addEventListener('click', () => this.refreshBookStructure(false));

    moduleSelect?.addEventListener('change', () => this.handleModuleSelectionChange());
    startInput?.addEventListener('input', () => this.handleManualRangeEdit());
    endInput?.addEventListener('input', () => this.handleManualRangeEdit());

    toggleBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMinimize();
    });
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

      const selectEl = this.shadowRoot.querySelector('#rbv-module-select') as HTMLSelectElement | null;
      const startInput = this.shadowRoot.querySelector('#rbv-start-ch') as HTMLInputElement | null;
      const endInput = this.shadowRoot.querySelector('#rbv-end-ch') as HTMLInputElement | null;

      if (!selectEl || !startInput || !endInput) return;

      const maxCh = structure.totalChapters > 0 ? structure.totalChapters - 1 : 9999;
      startInput.max = String(maxCh);
      endInput.max = String(maxCh);

      selectEl.innerHTML = '';

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

        // Auto-select the module containing the user's current reading chapter
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
            `TOC terdeteksi: ${structure.modules.length - 1} bagian, total ${structure.totalChapters} halaman.`
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
    if (!startInput || !endInput || !pill) return;

    const start = parseInt(startInput.value, 10);
    const end = parseInt(endInput.value, 10);

    if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end < start) {
      pill.textContent = 'Invalid';
      pill.style.background = '#fee2e2';
      pill.style.color = '#dc2626';
      return;
    }

    const count = end - start + 1;
    pill.textContent = `${count} hal`;
    pill.style.background = '#e0f2fe';
    pill.style.color = '#0369a1';
  }

  private toggleMinimize(): void {
    const card = this.shadowRoot.querySelector('#rbv-card');
    const toggleBtn = this.shadowRoot.querySelector('#rbv-btn-toggle') as HTMLButtonElement | null;

    this.isMinimized = !this.isMinimized;
    if (this.isMinimized) {
      card?.classList.add('minimized');
      if (toggleBtn) toggleBtn.textContent = '+';
    } else {
      card?.classList.remove('minimized');
      if (toggleBtn) toggleBtn.textContent = '−';
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

        host.style.setProperty('left', `${newLeft}px`, 'important');
        host.style.setProperty('top', `${newTop}px`, 'important');
      };

      const onMouseUp = () => {
        isDragging = false;
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
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
      this.updateStatus('idle', '✅ Diagnostik DOM + TOC berhasil disalin ke clipboard!');
    } catch (err) {
      logger.error('Failed to copy diagnostics:', err);
      this.updateStatus('idle', 'Diagnostik dicetak di DevTools Console (F12).');
    }
  }

  /**
   * Action: Phase 2 single chapter test print (preserved for regression testing)
   */
  private async handleTestPrint(): Promise<void> {
    if (this.isExporting) return;

    this.isExporting = true;
    this.toggleButtons(true);
    this.updateStatus('busy', 'Menyiapkan uji coba cetak bab aktif...');
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
      logger.info('Test print response:', response);

      this.stopProgressPolling();
      this.isExporting = false;
      this.toggleButtons(false);

      if (response?.success) {
        this.updateStatus('idle', `✅ Berhasil! File diunduh (${response.fileSizeMb || ''} MB).`);
      } else {
        this.updateStatus('error', `❌ Gagal: ${response?.error || 'Uji cetak gagal'}`);
      }
    } catch (err) {
      logger.error('Failed to execute test print:', err);
      this.stopProgressPolling();
      this.isExporting = false;
      this.toggleButtons(false);
      this.updateStatus('error', 'Gagal berkomunikasi dengan background service worker.');
    }
  }

  /**
   * Action: Phase 3 multi-chapter module / page-range auto-navigation export
   */
  private async handleStart(): Promise<void> {
    if (this.isExporting) return;

    const startInput = this.shadowRoot.querySelector('#rbv-start-ch') as HTMLInputElement | null;
    const endInput = this.shadowRoot.querySelector('#rbv-end-ch') as HTMLInputElement | null;
    const selectEl = this.shadowRoot.querySelector('#rbv-module-select') as HTMLSelectElement | null;
    const savePerPageChk = this.shadowRoot.querySelector('#rbv-chk-save-per-page') as HTMLInputElement | null;

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

    // Build chapter title map & filtered hierarchical TOC entries for Phase 4 PDF Bookmarks
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

    this.isExporting = true;
    this.toggleButtons(true);
    this.updateStatus('busy', `Memulai ${label} (${endChapter - startChapter + 1} halaman)...`);

    const message: StartExportMessage = {
      type: 'START_EXPORT',
      payload: {
        bookTitle,
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
        this.stopProgressPolling();
        this.isExporting = false;
        this.toggleButtons(false);
        this.updateStatus('error', `Error: ${response?.error || 'Gagal memulai ekspor'}`);
      }
    } catch (err) {
      logger.error('Failed to send START_EXPORT message:', err);
      this.stopProgressPolling();
      this.isExporting = false;
      this.toggleButtons(false);
      this.updateStatus('error', 'Gagal berkomunikasi dengan background service worker.');
    }
  }

  private async handleStop(): Promise<void> {
    this.updateStatus('busy', 'Mengirim sinyal berhenti...');

    const message: StopExportMessage = {
      type: 'STOP_EXPORT',
      reason: 'User manual stop'
    };

    try {
      await chrome.runtime.sendMessage(message);
    } catch (err) {
      logger.error('Failed to send STOP_EXPORT message:', err);
      this.stopProgressPolling();
      this.isExporting = false;
      this.toggleButtons(false);
      this.updateStatus('idle', 'Proses dihentikan.');
    }
  }

  /**
   * Called by content/index.ts when Background pushes EXPORT_COMPLETE
   */
  handleExportCompleteNotification(payload: ExportCompleteMessage['payload']): void {
    this.stopProgressPolling();
    this.isExporting = false;
    this.toggleButtons(false);

    const summary: BatchExportSummary | undefined = payload.summary;
    const filename = summary?.outputFilename || payload.filename;
    const outputBytes = summary?.outputBytes ?? payload.outputBytes ?? summary?.totalBytes ?? 0;
    const sizeMb = (outputBytes / 1024 / 1024).toFixed(2);
    const pdfPages = summary?.totalPdfPages ?? payload.totalPdfPages ?? summary?.capturedCount ?? payload.totalChapters;
    const bookmarks = summary?.bookmarkCount ?? payload.bookmarkCount ?? 0;

    if (summary) {
      if (summary.status === 'STOPPED') {
        if (summary.outputFilename) {
          this.updateStatus(
            'idle',
            `⏹ Dihentikan. PDF parsial diunduh: ${filename} (${pdfPages} hal, ${sizeMb} MB, ${bookmarks} bookmarks).`
          );
        } else {
          this.updateStatus(
            'idle',
            `⏹ Dihentikan. ${summary.capturedCount}/${summary.totalRequested} hal selesai.`
          );
        }
      } else {
        this.updateStatus(
          'idle',
          `✅ Selesai! ${filename} (${pdfPages} hal, ${sizeMb} MB, ${bookmarks} bookmarks) diunduh.`
        );
      }
    } else {
      this.updateStatus('idle', `✅ Selesai! ${filename} (${pdfPages} halaman) diunduh.`);
    }
  }

  /**
   * Called by content/index.ts when Background pushes EXPORT_ERROR
   */
  handleExportErrorNotification(payload: ExportErrorMessage['payload']): void {
    this.stopProgressPolling();
    this.isExporting = false;
    this.toggleButtons(false);
    const suffix = payload.details ? ` (${payload.details})` : '';
    this.updateStatus('error', `❌ ${payload.message}${suffix}`);
  }

  private startProgressPolling(): void {
    if (this.pollIntervalId) return;

    this.pollIntervalId = window.setInterval(async () => {
      try {
        const res = (await chrome.runtime.sendMessage({ type: 'GET_STATUS' })) as StatusResponseMessage;
        if (res?.type === 'STATUS_RESPONSE' && res.payload) {
          const progress = res.payload;
          if (progress.status === 'ERROR') {
            this.updateStatus('error', progress.message);
            if (this.isExporting) {
              this.stopProgressPolling();
              this.isExporting = false;
              this.toggleButtons(false);
            }
          } else if (progress.status === 'COMPLETED' || progress.status === 'STOPPED') {
            this.updateStatus('idle', progress.message);
            if (this.isExporting) {
              this.stopProgressPolling();
              this.isExporting = false;
              this.toggleButtons(false);
            }
          } else if (progress.status === 'IDLE') {
            this.updateStatus('idle', progress.message);
          } else {
            this.updateStatus('busy', progress.message);
          }
        }
      } catch {
        // Suppress polling error during transient tab transitions
      }
    }, 800);
  }

  private stopProgressPolling(): void {
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
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

  private toggleButtons(exporting: boolean): void {
    const testPrintBtn = this.shadowRoot.querySelector('#rbv-btn-test-print') as HTMLButtonElement | null;
    const startBtn = this.shadowRoot.querySelector('#rbv-btn-start') as HTMLButtonElement | null;
    const stopBtn = this.shadowRoot.querySelector('#rbv-btn-stop') as HTMLButtonElement | null;
    const diagBtn = this.shadowRoot.querySelector('#rbv-btn-diag') as HTMLButtonElement | null;
    const refreshBtn = this.shadowRoot.querySelector('#rbv-btn-refresh-toc') as HTMLButtonElement | null;
    const moduleSelect = this.shadowRoot.querySelector('#rbv-module-select') as HTMLSelectElement | null;
    const startInput = this.shadowRoot.querySelector('#rbv-start-ch') as HTMLInputElement | null;
    const endInput = this.shadowRoot.querySelector('#rbv-end-ch') as HTMLInputElement | null;
    const saveChk = this.shadowRoot.querySelector('#rbv-chk-save-per-page') as HTMLInputElement | null;

    if (testPrintBtn) testPrintBtn.disabled = exporting;
    if (diagBtn) diagBtn.disabled = exporting;
    if (refreshBtn) refreshBtn.disabled = exporting;
    if (moduleSelect) moduleSelect.disabled = exporting;
    if (startInput) startInput.disabled = exporting;
    if (endInput) endInput.disabled = exporting;
    if (saveChk) saveChk.disabled = exporting;

    if (startBtn) {
      startBtn.style.display = exporting ? 'none' : 'flex';
    }
    if (stopBtn) {
      stopBtn.style.display = exporting ? 'flex' : 'none';
    }
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
