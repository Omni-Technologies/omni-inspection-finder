export type SavedDataset = { name: string; loadedAt: number; text: string };

const DATA_KEY = 'oif.dataset.v1';
const PREFS_KEY = 'oif.prefs.v1';

export function loadDataset(): SavedDataset | null {
  try {
    const raw = localStorage.getItem(DATA_KEY);
    return raw ? (JSON.parse(raw) as SavedDataset) : null;
  } catch {
    return null;
  }
}

/** Returns false when the browser refused to store it (private mode, quota). */
export function saveDataset(data: SavedDataset): boolean {
  try {
    localStorage.setItem(DATA_KEY, JSON.stringify(data));
    return true;
  } catch {
    try {
      localStorage.removeItem(DATA_KEY);
    } catch {
      /* storage unavailable entirely */
    }
    return false;
  }
}

export function clearSavedData(): void {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith('oif.')) localStorage.removeItem(key);
  } catch {
    /* nothing stored */
  }
}

export function loadPrefs<T extends object>(fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<T>) } : fallback;
  } catch {
    return fallback;
  }
}

export function savePrefs(prefs: object): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* preferences are a convenience only */
  }
}
