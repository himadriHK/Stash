import { createDefaultIncludePatterns } from './mediaPatterns';
import { uuid } from '../utils/id';

/**
 * A user-configured folder that the scanner should watch.
 * Mirrors Stash.Maui.Data/Entities/FolderConfig.cs.
 */
export interface FolderConfig {
  id: string;
  folderPath: string;
  folderName: string;
  isEnabled: boolean;
  addedAt: string;
  lastScannedAt?: string | null;
  includePatterns: string[];
  excludePatterns: string[];
  includeSubfolders: boolean;
}

export type FolderConfigDraft = Partial<FolderConfig> & Pick<FolderConfig, 'folderPath'>;

export function folderNameFromPath(folderPath: string): string {
  const normalized = folderPath.replace(/[\\/]+$/, '');
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : normalized;
}

export function createFolderConfig(draft: FolderConfigDraft): FolderConfig {
  return {
    id: draft.id ?? uuid(),
    folderPath: draft.folderPath,
    folderName: draft.folderName ?? folderNameFromPath(draft.folderPath),
    isEnabled: draft.isEnabled ?? true,
    addedAt: draft.addedAt ?? new Date().toISOString(),
    lastScannedAt: draft.lastScannedAt ?? null,
    includePatterns: draft.includePatterns ?? createDefaultIncludePatterns(),
    excludePatterns: draft.excludePatterns ?? [],
    includeSubfolders: draft.includeSubfolders ?? true,
  };
}
