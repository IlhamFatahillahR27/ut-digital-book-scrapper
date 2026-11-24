import type { WidgetPreferences } from '../types/exporter';
import { logger } from './logger';

const STORAGE_KEY = 'rbv_ut_widget_prefs_v1';

/**
 * Safely reads saved widget UI preferences (position, minimized state, advanced export config)
 * from chrome.storage.local. Never throws if storage is unavailable.
 */
export async function loadWidgetPreferences(): Promise<WidgetPreferences> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      return {};
    }
    const result = await chrome.storage.local.get(STORAGE_KEY);
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
 * Merges and persists partial widget preferences to chrome.storage.local.
 */
export async function saveWidgetPreferences(partial: Partial<WidgetPreferences>): Promise<void> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      return;
    }
    const current = await loadWidgetPreferences();
    const merged: WidgetPreferences = { ...current, ...partial };
    await chrome.storage.local.set({ [STORAGE_KEY]: merged });
  } catch (err) {
    logger.debug('Storage: Failed to save widget preferences:', err);
  }
}
