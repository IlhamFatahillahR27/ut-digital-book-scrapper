import { DomDetector } from './dom-detector';
import { UiInjector } from './ui-injector';
import { logger } from '../utils/logger';

function initContentScript(): void {
  // Visible highlighted log in DevTools Console
  console.log(
    '%c[RBV-Exporter]%c Content script active on: ' + window.location.href,
    'background: #0284c7; color: #ffffff; font-weight: bold; padding: 3px 8px; border-radius: 4px;',
    'color: #0284c7; font-weight: bold;'
  );

  // Only inject UI in top frame to avoid nested duplicate widgets inside sub-frames
  if (window !== window.top) {
    logger.debug('Running inside sub-frame:', window.location.href);
    return;
  }

  if (DomDetector.isKotobeeReader()) {
    logger.info('Kotobee reader page detected. Mounting exporter UI...');
    
    const mount = () => {
      UiInjector.getInstance().inject();
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount);
    } else {
      mount();
    }

    // Keep UI persistent across Kotobee SPA route changes (e.g. #/book/57062/reader/chapter/0)
    setInterval(() => {
      if (!document.getElementById('rbv-ut-exporter-root')) {
        logger.debug('Re-injecting floating widget after SPA DOM update...');
        UiInjector.getInstance().inject();
      }
    }, 2000);
  }
}

initContentScript();

