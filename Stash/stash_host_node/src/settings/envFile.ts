import fs from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';

export interface ParsedEnvFile {
  values: Record<string, string>;
  lines: string[];
}

export interface WriteEnvFileResult {
  backupPath: string | null;
  changed: string[];
}

const UNSAFE_RAW_VALUE = /[\s#'"\\]/;

function splitLines(text: string): string[] {
  return text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

export function parseEnvFile(text: string): ParsedEnvFile {
  return {
    values: dotenv.parse(text),
    lines: splitLines(text),
  };
}

export function readEnvFile(filePath: string): ParsedEnvFile | null {
  try {
    return parseEnvFile(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function formatEnvValue(value: string): string {
  if (value === '') return '';
  if (!UNSAFE_RAW_VALUE.test(value)) return value;

  if (!value.includes("'")) return `'${value}'`;

  if (!value.includes('"') && !/\\[nr]/.test(value) && !value.endsWith('\\')) {
    return `"${value}"`;
  }

  if (!value.includes('`')) return `\`${value}\``;

  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export function renderEnvFile(originalText: string, updates: Record<string, string>): string {
  const { lines } = parseEnvFile(originalText);
  const newline = originalText.includes('\r\n') ? '\r\n' : '\n';
  const assignment = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
  const replaced = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;

    const match = assignment.exec(line);
    if (!match) continue;

    const key = match[3];
    if (!key || replaced.has(key)) continue;

    const next = updates[key];
    if (next === undefined) continue;

    const indent = match[1] ?? '';
    const exportPrefix = match[2] ?? '';
    lines[index] = `${indent}${exportPrefix}${key}=${formatEnvValue(next)}`;
    replaced.add(key);
  }

  const missing = Object.keys(updates).filter((key) => !replaced.has(key));
  if (missing.length === 0) return lines.join(newline);

  const block = [
    '# added by dashboard settings',
    ...missing.map((key) => `${key}=${formatEnvValue(updates[key] ?? '')}`),
  ];
  const endsWithNewline = originalText.endsWith('\n');
  const base = endsWithNewline ? lines.slice(0, -1) : lines.slice();
  const content = base.length === 1 && base[0] === '' ? [] : base;

  if (content.length === 0) return `${block.join(newline)}${newline}`;

  return `${[...content, '', ...block].join(newline)}${newline}`;
}

export function writeEnvFileAtomic(
  filePath: string,
  updates: Record<string, string>,
): WriteEnvFileResult {
  const existingText = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  const existingValues = existingText === null ? {} : parseEnvFile(existingText).values;

  const changed = Object.keys(updates).filter((key) => {
    const next = updates[key];
    if (next === undefined) return false;
    const current = existingValues[key];
    if (current === next) return false;
    if (next === '' && current === undefined) return false;
    return true;
  });

  if (changed.length === 0) return { backupPath: null, changed: [] };

  const changedUpdates: Record<string, string> = {};
  for (const key of changed) changedUpdates[key] = updates[key] ?? '';

  const rendered = renderEnvFile(existingText ?? '', changedUpdates);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let backupPath: string | null = null;
  if (existingText !== null) {
    backupPath = `${filePath}.bak`;
    fs.copyFileSync(filePath, backupPath);
  }

  const tempPath = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tempPath, rendered, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(tempPath, filePath);
    } catch {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // The retry below reports a hard failure if the replace still cannot proceed.
      }
      fs.renameSync(tempPath, filePath);
    }
  } catch {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best effort cleanup.
    }
    if (backupPath !== null && fs.existsSync(backupPath)) {
      try {
        fs.copyFileSync(backupPath, filePath);
      } catch {
        // Best effort restore.
      }
    }
    throw new Error('Failed to write environment file');
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best effort cleanup.
    }
  }

  return { backupPath, changed };
}
