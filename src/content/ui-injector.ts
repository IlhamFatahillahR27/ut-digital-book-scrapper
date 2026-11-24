import { FloatingWidget } from '../ui/widget';
import { logger } from '../utils/logger';

const ROOT_ELEMENT_ID = 'rbv-ut-exporter-root';

export class UiInjector {
  private static instance: UiInjector | null = null;
  private rootElement: HTMLElement | null = null;
  private widget: FloatingWidget | null = null;

  static getInstance(): UiInjector {
    if (!UiInjector.instance) {
      UiInjector.instance = new UiInjector();
    }
    return UiInjector.instance;
  }

  inject(): boolean {
    if (document.getElementById(ROOT_ELEMENT_ID)) {
      logger.info('UI root element already exists in DOM.');
      return false;
    }

    try {
      this.rootElement = document.createElement(ROOT_ELEMENT_ID);
      this.rootElement.id = ROOT_ELEMENT_ID;
      this.rootElement.style.cssText = `
        position: fixed;
        top: 80px;
        right: 24px;
        z-index: 2147483647;
        display: block;
        width: auto;
        pointer-events: auto;
        margin: 0;
        padding: 0;
      `;
      
      const shadowRoot = this.rootElement.attachShadow({ mode: 'open' });
      this.widget = new FloatingWidget(shadowRoot);

      // Append to document.body or documentElement if body is not yet ready
      const target = document.body || document.documentElement;
      target.appendChild(this.rootElement);
      logger.info('Floating widget successfully mounted in Shadow DOM.');
      return true;
    } catch (err) {
      logger.error('Failed to inject UI widget into DOM:', err);
      return false;
    }
  }

  remove(): void {
    if (this.rootElement && this.rootElement.parentNode) {
      this.rootElement.parentNode.removeChild(this.rootElement);
      this.rootElement = null;
      this.widget = null;
      logger.info('UI widget removed from DOM.');
    }
  }

  getWidget(): FloatingWidget | null {
    return this.widget;
  }
}
