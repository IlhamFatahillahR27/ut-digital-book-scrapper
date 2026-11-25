import type { WidgetPreferences } from '../types/exporter';
import { getBrowserApi, hasBrowserApi } from './browser-api';
import { logger } from './logger';

const STORAGE_KEY = 'rbv_ut_widget_prefs_v1';

/**
 * Safely reads saved widget UI preferences (position, minimized state, export mode,
 * and advanced export config) from browser.storage.local. Never throws if storage is unavailable.
 */
export async function loadWidgetPreferences(): Promise<WidgetPreferences> {
  try {
    if (!hasBrowserApi()) {
      return {};
    }
    const api = getBrowserApi();
    if (!api.storage?.local) {
      return {};
    }
    const result = await api.storage.local.get(STORAGE_KEY);
    const raw = result?.[STORAGE_KEY];
    if (raw && typeof raw === 'object') {
      return raw as WidgetPreferences;
    }
    return {};
  } catch (err) {
    logger.debug('Storage: Failed to load widget preferences:', err);
    return {};
  }
}

/**
 * Merges and persists partial widget preferences to browser.storage.local.
 */
export async function saveWidgetPreferences(partial: Partial<WidgetPreferences>): Promise<void> {
  try {
    if (!hasBrowserApi()) {
      return;
    }
    const api = getBrowserApi();
    if (!api.storage?.local) {
      return;
    }
    const current = await loadWidgetPreferences();
    const merged: WidgetPreferences = { ...current, ...partial };
    await api.storage.local.set({ [STORAGE_KEY]: merged });
  } catch (err) {
    logger.debug('Storage: Failed to save widget preferences:', err);
  }
}
