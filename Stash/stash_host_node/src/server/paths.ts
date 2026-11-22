import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ProjectPaths {
  projectRoot: string;
  publicDir: string;
  envFile: string;
  version: string;
}

const FALLBACK_VERSION = '0.1.0';

function readVersion(packageJsonPath: string): string {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    if (parsed !== null && typeof parsed === 'object') {
      const version = (parsed as Record<string, unknown>)['version'];
      if (typeof version === 'string' && version.trim() !== '') {
        return version.trim();
      }
    }
  } catch {
    return FALLBACK_VERSION;
  }
  return FALLBACK_VERSION;
}

export function resolveProjectPaths(): ProjectPaths {
  const projectRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
  return {
    projectRoot,
    publicDir: path.join(projectRoot, 'public'),
    envFile: path.join(projectRoot, '.env'),
    version: readVersion(path.join(projectRoot, 'package.json')),
  };
}
