import widgetCss from './widget.css?inline';
import { DomDetector } from '../content/dom-detector';
import { logger } from '../utils/logger';
import type {
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

  constructor(shadowRoot: ShadowRoot) {
    this.shadowRoot = shadowRoot;
    this.init();
  }

  private init(): void {
    this.currentTitle = DomDetector.detectBookTitle();
    this.render();
    this.bindEvents();
    this.setupDraggable();
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
            <div class="rbv-book-title" id="rbv-title-display" title="${this.currentTitle}">
              ${this.escapeHtml(this.currentTitle)}
            </div>
          </div>
          <div class="rbv-status-row">
            <span class="rbv-status-dot" id="rbv-status-dot"></span>
            <span id="rbv-status-text">Siap. Pilih aksi di bawah.</span>
          </div>
          <div class="rbv-actions">
            <button class="rbv-btn rbv-btn-secondary" id="rbv-btn-test-print" title="Cetak bab aktif saja untuk menguji format & kelengkapan halaman">
              📄 Uji Cetak 1 Bab (Fase 2)
            </button>
            <button class="rbv-btn rbv-btn-primary" id="rbv-btn-start" title="Mulai mengekspor buku secara berurutan">
              🚀 Mulai Ekspor Buku
            </button>
            <button class="rbv-btn rbv-btn-danger" id="rbv-btn-stop" style="display: none;">
              ⏹ Berhenti
            </button>
            <button class="rbv-btn rbv-btn-outline" id="rbv-btn-diag" title="Salin struktur DOM Kotobee ke clipboard untuk analisis jika layout bermasalah">
              🔍 Salin Diagnostik DOM
            </button>
          </div>
        </div>
        <div class="rbv-footer">
          Optimized for NotebookLM • v0.1.0 (Fase 2)
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

    testPrintBtn?.addEventListener('click', () => this.handleTestPrint());
    startBtn?.addEventListener('click', () => this.handleStart());
    stopBtn?.addEventListener('click', () => this.handleStop());
    diagBtn?.addEventListener('click', () => this.handleCopyDiagnostics());

    toggleBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMinimize();
    });
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
      const json = JSON.stringify(report, null, 2);
      console.log('%c[RBV-UT Diagnostic Report]', 'color: #0284c7; font-weight: bold;', report);

      await navigator.clipboard.writeText(json);
      this.updateStatus('idle', '✅ Diagnostik DOM berhasil disalin ke clipboard! Tekan Ctrl+V untuk mengirimkan.');
    } catch (err) {
      logger.error('Failed to copy diagnostics:', err);
      this.updateStatus('idle', 'Diagnostik dicetak di DevTools Console (F12).');
    }
  }

  /**
   * Action: Phase 2 single chapter test print
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

  private async handleStart(): Promise<void> {
    if (this.isExporting) return;

    this.isExporting = true;
    this.updateStatus('busy', 'Menginisialisasi sesi ekspor...');
    this.toggleButtons(true);
    this.startProgressPolling();

    const message: StartExportMessage = {
      type: 'START_EXPORT',
      payload: {
        bookTitle: this.currentTitle
      }
    };

    try {
      const response = await chrome.runtime.sendMessage(message);
      logger.info('Start export response:', response);
      if (response?.success) {
        this.updateStatus('busy', 'Debugger terhubung. Menunggu capture...');
      } else {
        this.stopProgressPolling();
        this.isExporting = false;
        this.updateStatus('error', `Error: ${response?.error || 'Gagal memulai'}`);
        this.toggleButtons(false);
      }
    } catch (err) {
      logger.error('Failed to send START_EXPORT message:', err);
      this.stopProgressPolling();
      this.isExporting = false;
      this.updateStatus('error', 'Gagal berkomunikasi dengan background service worker.');
      this.toggleButtons(false);
    }
  }

  private async handleStop(): Promise<void> {
    this.updateStatus('busy', 'Menghentikan proses ekspor...');

    const message: StopExportMessage = {
      type: 'STOP_EXPORT',
      reason: 'User manual stop'
    };

    try {
      await chrome.runtime.sendMessage(message);
    } catch (err) {
      logger.error('Failed to send STOP_EXPORT message:', err);
    } finally {
      this.stopProgressPolling();
      this.isExporting = false;
      this.updateStatus('idle', 'Proses dihentikan.');
      this.toggleButtons(false);
    }
  }

  private startProgressPolling(): void {
    if (this.pollIntervalId) return;

    this.pollIntervalId = window.setInterval(async () => {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'GET_STATUS' }) as StatusResponseMessage;
        if (res?.type === 'STATUS_RESPONSE' && res.payload) {
          const progress = res.payload;
          if (progress.status === 'ERROR') {
            this.updateStatus('error', progress.message);
          } else if (progress.status === 'IDLE' || progress.status === 'COMPLETED') {
            this.updateStatus('idle', progress.message);
          } else {
            this.updateStatus('busy', progress.message);
          }
        }
      } catch {
        // Suppress polling error during tab transitions
      }
    }, 1000);
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

    if (testPrintBtn) testPrintBtn.disabled = exporting;
    if (diagBtn) diagBtn.disabled = exporting;

    if (startBtn) {
      if (exporting) {
        startBtn.style.display = 'none';
      } else {
        startBtn.style.display = 'flex';
      }
    }
    if (stopBtn) {
      if (exporting) {
        stopBtn.style.display = 'flex';
      } else {
        stopBtn.style.display = 'none';
      }
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
