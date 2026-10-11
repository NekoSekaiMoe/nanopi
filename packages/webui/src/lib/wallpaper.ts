// User wallpaper: a data-URL image stored in localStorage (this browser only)
// and applied to <html> as a CSS custom property + data attribute. The theme
// stylesheet does the actual painting (body background + scrim + translucent
// panels); this module only owns persistence and application.

const KEY = 'nanopi.wallpaper';
/** localStorage is capped around 5 MB; keep a safety margin below it. */
export const MAX_WALLPAPER_BYTES = 4 * 1024 * 1024;

export function loadWallpaper(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveWallpaper(dataUrl: string | null): void {
  try {
    if (dataUrl) localStorage.setItem(KEY, dataUrl);
    else localStorage.removeItem(KEY);
  } catch {
    /* quota exceeded or storage unavailable: keep the previous value */
  }
}

/** Paint (or unpaint) the wallpaper on the document root. */
export function applyWallpaper(dataUrl: string | null): void {
  const root = document.documentElement;
  if (dataUrl) {
    root.setAttribute('data-wallpaper', 'on');
    root.style.setProperty('--app-background-image', `url("${dataUrl}")`);
  } else {
    root.removeAttribute('data-wallpaper');
    root.style.removeProperty('--app-background-image');
  }
}

/** Persist + paint in one step. */
export function setWallpaper(dataUrl: string | null): void {
  saveWallpaper(dataUrl);
  applyWallpaper(dataUrl);
}

/** Read a picked image file into a data URL, size-capped. */
export function fileToWallpaperDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('not an image'));
      return;
    }
    if (file.size > MAX_WALLPAPER_BYTES) {
      reject(new Error('too large'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}
