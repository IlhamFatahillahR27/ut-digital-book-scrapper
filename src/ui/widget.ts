import widgetCss from './widget.css?inline';
import { DomDetector } from '../content/dom-detector';
import { logger } from '../utils/logger';
import type { StartExportMessage, StopExportMessage } from '../types/messages';

export class FloatingWidget {
  private shadowRoot: ShadowRoot;
  private isExporting = false;
  private currentTitle = '';

  constructor(shadowRoot: ShadowRoot) {
    this.shadowRoot = shadowRoot;
    this.init();
  }

  private init(): void {
    this.currentTitle = DomDetector.detectBookTitle();
    this.render();
    this.bindEvents();
  }

  private render(): void {
    const iconUrl = chrome.runtime.getURL('icons/icon-48.png');

    this.shadowRoot.innerHTML = `
      <style>${widgetCss}</style>
      <div class="rbv-card" id="rbv-card">
        <div class="rbv-header">
          <div class="rbv-title">
            <img src="${iconUrl}" width="22" height="22" style="border-radius: 4px; object-fit: contain; background: #ffffff; padding: 1px;" alt="UT" />
            <span>RBV-UT Exporter</span>
          </div>
          <span class="rbv-badge">MV3 Beta</span>
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
            <span id="rbv-status-text">Ekstensi siap. Tekan Mulai.</span>
          </div>
          <div class="rbv-actions">
            <button class="rbv-btn rbv-btn-primary" id="rbv-btn-start">
              <span>Mulai Ekspor</span>
            </button>
            <button class="rbv-btn rbv-btn-danger" id="rbv-btn-stop" style="display: none;">
              <span>Berhenti</span>
            </button>
          </div>
        </div>
        <div class="rbv-footer">
          Optimized for NotebookLM • v0.1.0
        </div>
      </div>
    `;
  }

  private bindEvents(): void {
    const startBtn = this.shadowRoot.querySelector('#rbv-btn-start') as HTMLButtonElement | null;
    const stopBtn = this.shadowRoot.querySelector('#rbv-btn-stop') as HTMLButtonElement | null;

    startBtn?.addEventListener('click', () => this.handleStart());
    stopBtn?.addEventListener('click', () => this.handleStop());
  }

  private async handleStart(): Promise<void> {
    if (this.isExporting) {
      return;
    }
    this.isExporting = true;
    this.updateStatus('busy', 'Menginisialisasi sesi ekspor...');
    this.toggleButtons(true);

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
        this.updateStatus('error', `Error: ${response?.error || 'Gagal memulai'}`);
        this.toggleButtons(false);
      }
    } catch (err) {
      logger.error('Failed to send START_EXPORT message:', err);
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
      this.isExporting = false;
      this.updateStatus('idle', 'Ekspor dihentikan.');
      this.toggleButtons(false);
    } catch (err) {
      logger.error('Failed to send STOP_EXPORT message:', err);
      this.isExporting = false;
      this.toggleButtons(false);
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
    const startBtn = this.shadowRoot.querySelector('#rbv-btn-start') as HTMLButtonElement | null;
    const stopBtn = this.shadowRoot.querySelector('#rbv-btn-stop') as HTMLButtonElement | null;

    if (startBtn && stopBtn) {
      if (exporting) {
        startBtn.style.display = 'none';
        stopBtn.style.display = 'flex';
      } else {
        startBtn.style.display = 'flex';
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
