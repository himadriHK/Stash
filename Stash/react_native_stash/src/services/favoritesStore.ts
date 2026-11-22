/**
 * Local favorites for the Gallery's "Favorites" filter.
 *
 * Favorites are a per-install UI preference keyed by content hash (the same
 * identity the dedup pipeline uses), so the SQLite schema is untouched and a
 * renamed file keeps its favorite state. Values are not synced to the host.
 */
import type { FileEntity } from '../models/fileEntity';
import { getAsync, setAsync } from '../utils/storage';

const FAVORITES_KEY = 'stash.ui.favorites';

let cache: Set<string> | null = null;

function favoriteKey(file: FileEntity): string {
  return file.contentHash.toLowerCase();
}

export async function loadFavoritesAsync(): Promise<Set<string>> {
  if (cache) {
    return new Set(cache);
  }
  try {
    const raw = await getAsync(FAVORITES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cache = new Set(
      Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [],
    );
  } catch {
    cache = new Set();
  }
  return new Set(cache);
}

export async function toggleFavoriteAsync(file: FileEntity): Promise<Set<string>> {
  const current = await loadFavoritesAsync();
  const key = favoriteKey(file);
  if (current.has(key)) {
    current.delete(key);
  } else {
    current.add(key);
  }
  cache = current;
  await setAsync(FAVORITES_KEY, JSON.stringify([...current])).catch(() => {
    // The in-memory set still applies for this session.
  });
  return new Set(current);
}

export function isFavorite(favorites: Set<string>, file: FileEntity): boolean {
  return favorites.has(favoriteKey(file));
}
