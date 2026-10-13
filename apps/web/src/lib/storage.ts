/**
 * localStorage that never throws. Private windows, blocked site data and
 * sandboxed previews all make it throw or vanish; nothing here is critical.
 */
export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Not persisted this time; the user signs in again next visit.
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing to clean up if storage is unavailable.
    }
  },
};
