import { logger } from './logger';

export const KOTOBEE_HOST_ORIGIN = 'https://univterbuka.kotobee.com/*';

/**
 * Firefox MV3 WebExtensions API shape with safe fallback for test environments.
 * Uses the native Promise-based `browser` namespace in Firefox.
 */
export type FirefoxBrowserApi = typeof browser;

export function getBrowserApi(): FirefoxBrowserApi {
  const g = globalThis as unknown as {
    browser?: FirefoxBrowserApi;
    chrome?: FirefoxBrowserApi;
  };
  if (g.browser) {
    return g.browser;
  }
  if (g.chrome) {
    return g.chrome;
  }
  throw new Error('WebExtension browser API is not available in this context.');
}

export function hasBrowserApi(): boolean {
  const g = globalThis as unknown as { browser?: unknown; chrome?: unknown };
  return !!(g.browser || g.chrome);
}

/**
 * Checks whether Firefox has granted host access to https://univterbuka.kotobee.com/*
 * (In Firefox MV3, host_permissions are user-controllable and may not be auto-granted on install.)
 */
export async function hasKotobeeHostPermission(): Promise<boolean> {
  try {
    const api = getBrowserApi();
    if (!api.permissions?.contains) {
      return true;
    }
    return await api.permissions.contains({
      origins: [KOTOBEE_HOST_ORIGIN]
    });
  } catch (err) {
    logger.warn('BrowserAPI: Failed checking host permission:', err);
    return true;
  }
}

/**
 * Requests host permission for https://univterbuka.kotobee.com/* inside a user gesture
 * (such as clicking the extension toolbar action icon in Firefox MV3).
 */
export async function requestKotobeeHostPermission(): Promise<boolean> {
  try {
    const api = getBrowserApi();
    if (!api.permissions?.request) {
      return true;
    }
    return await api.permissions.request({
      origins: [KOTOBEE_HOST_ORIGIN]
    });
  } catch (err) {
    logger.warn('BrowserAPI: Failed requesting host permission:', err);
    return false;
  }
}
