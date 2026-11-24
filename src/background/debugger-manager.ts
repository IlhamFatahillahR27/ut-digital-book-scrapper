import { logger } from '../utils/logger';

export class DebuggerManager {
  private attachedTabId: number | null = null;
  private protocolVersion = '1.3';

  constructor() {
    this.setupListeners();
  }

  private setupListeners(): void {
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (this.attachedTabId && source.tabId === this.attachedTabId) {
        logger.warn(`Debugger detached unexpectedly from tab ${source.tabId}. Reason: ${reason}`);
        this.attachedTabId = null;
      }
    });
  }

  async attach(tabId: number): Promise<void> {
    if (this.attachedTabId === tabId) {
      logger.info(`Debugger already attached to tab ${tabId}`);
      return;
    }

    if (this.attachedTabId !== null) {
      await this.detach();
    }

    try {
      await chrome.debugger.attach({ tabId }, this.protocolVersion);
      this.attachedTabId = tabId;
      logger.info(`Debugger successfully attached to tab ${tabId}`);
    } catch (err) {
      logger.error(`Failed to attach debugger to tab ${tabId}:`, err);
      throw err;
    }
  }

  async detach(): Promise<void> {
    if (!this.attachedTabId) {
      return;
    }

    const tabId = this.attachedTabId;
    this.attachedTabId = null;

    try {
      await chrome.debugger.detach({ tabId });
      logger.info(`Debugger detached from tab ${tabId}`);
    } catch (err) {
      logger.warn(`Error while detaching debugger from tab ${tabId}:`, err);
    }
  }

  async sendCommand<T = unknown>(method: string, params?: object): Promise<T> {
    if (!this.attachedTabId) {
      throw new Error('Cannot send CDP command: Debugger is not attached to any tab.');
    }

    try {
      const result = await chrome.debugger.sendCommand(
        { tabId: this.attachedTabId },
        method,
        params
      );
      return result as T;
    } catch (err) {
      logger.error(`CDP command failed [${method}]:`, err);
      throw err;
    }
  }

  isAttached(): boolean {
    return this.attachedTabId !== null;
  }

  getAttachedTabId(): number | null {
    return this.attachedTabId;
  }
}
