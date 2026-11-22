import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import dotenv from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

import {
  formatEnvValue,
  parseEnvFile,
  readEnvFile,
  renderEnvFile,
  writeEnvFileAtomic,
} from '../../src/settings/envFile';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-env-file-test-'));

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function roundTrip(value: string): string | undefined {
  return dotenv.parse(`KEY=${formatEnvValue(value)}\n`)['KEY'];
}

describe('parseEnvFile and readEnvFile', () => {
  it('parses values and keeps raw lines without carriage returns', () => {
    const parsed = parseEnvFile(
      '# comment\r\nHOST=127.0.0.1\r\nEMPTY=\r\nQUOTED="two words"\n',
    );

    expect(parsed.values).toMatchObject({
      HOST: '127.0.0.1',
      EMPTY: '',
      QUOTED: 'two words',
    });
    expect(parsed.lines).toEqual([
      '# comment',
      'HOST=127.0.0.1',
      'EMPTY=',
      'QUOTED="two words"',
      '',
    ]);
    expect(parsed.lines.some((line) => line.endsWith('\r'))).toBe(false);
  });

  it('returns null for a missing file and parses an existing file', () => {
    const filePath = path.join(root, 'read.env');
    expect(readEnvFile(filePath)).toBeNull();

    fs.writeFileSync(filePath, 'HOST=0.0.0.0\n', 'utf8');
    expect(readEnvFile(filePath)?.values['HOST']).toBe('0.0.0.0');
  });
});

describe('formatEnvValue', () => {
  it('leaves safe values raw and keeps empty values empty', () => {
    expect(formatEnvValue('')).toBe('');
    expect(formatEnvValue('plain')).toBe('plain');
    expect(formatEnvValue('a=b')).toBe('a=b');
    expect(formatEnvValue('$HOME')).toBe('$HOME');
  });

  it('quotes whitespace, hashes, quotes, and backslashes', () => {
    expect(formatEnvValue('two words')).toBe("'two words'");
    expect(formatEnvValue('a#b')).toBe("'a#b'");
    expect(formatEnvValue('a"b')).toBe("'a\"b'");
    expect(formatEnvValue('C:\\StashLibrary')).toBe("'C:\\StashLibrary'");
    expect(formatEnvValue("it's fine")).toBe("\"it's fine\"");
  });

  it('round-trips values through dotenv', () => {
    const values = [
      'plain',
      'two words',
      'a#b',
      'a#b c',
      'a"b',
      "it's fine",
      "both' and \"quotes\"",
      'C:\\StashLibrary',
      'C:\\Program Files\\Stash',
      "C:\\it's here",
      "C:\\Users\\O'Brien\\Stash",
      'back\\slash',
      'line\nbreak',
      ' leading',
      'trailing ',
      "'",
      '"',
      '\\',
      '$HOME',
      'foo=bar',
    ];

    for (const value of values) {
      expect(roundTrip(value), JSON.stringify(value)).toBe(value);
    }
  });
});

describe('renderEnvFile', () => {
  it('preserves comments, blanks, unknown keys, duplicates, and ordering', () => {
    const original = [
      '# runtime',
      'HOST=127.0.0.1',
      'PORT=8080 # inline',
      'UNKNOWN=keep',
      '',
      'export S3_PREFIX=old',
      'HOST=duplicate',
      '',
    ].join('\n');

    const rendered = renderEnvFile(original, {
      HOST: '0.0.0.0',
      PORT: '9090',
      S3_PREFIX: 'stash',
      NEW_KEY: 'new value',
    });

    expect(rendered).toContain('# runtime');
    expect(rendered).toContain('UNKNOWN=keep');
    expect(rendered).toContain('export S3_PREFIX=stash');
    expect(rendered).toContain('HOST=0.0.0.0');
    expect(rendered).toContain('HOST=duplicate');
    expect(rendered).toContain('PORT=9090');
    expect(rendered).not.toContain('# inline');
    expect(rendered).toContain('# added by dashboard settings');
    expect(rendered).toContain("NEW_KEY='new value'");

    expect(rendered.indexOf('# runtime')).toBeLessThan(rendered.indexOf('UNKNOWN=keep'));
    expect(rendered.indexOf('UNKNOWN=keep')).toBeLessThan(
      rendered.indexOf('# added by dashboard settings'),
    );
  });

  it('appends missing keys in a labeled section without duplicating existing keys', () => {
    const rendered = renderEnvFile('HOST=127.0.0.1\n', { HOST: '0.0.0.0', PORT: '9090' });

    expect(rendered.match(/HOST=/g)).toHaveLength(1);
    expect(rendered).toContain('# added by dashboard settings\nPORT=9090');
  });

  it('preserves CRLF newlines and a trailing newline', () => {
    expect(renderEnvFile('A=1\r\nB=2\r\n', { B: '3' })).toBe('A=1\r\nB=3\r\n');
    expect(renderEnvFile('A=1\r\n', { C: '3' })).toBe(
      'A=1\r\n\r\n# added by dashboard settings\r\nC=3\r\n',
    );
  });

  it('returns the original text when there is nothing to update', () => {
    const original = '# comment\nA=1\n';
    expect(renderEnvFile(original, {})).toBe(original);
  });
});

describe('writeEnvFileAtomic', () => {
  it('creates parent directories and writes without a backup for a new file', () => {
    const filePath = path.join(root, 'nested', '.env');
    const result = writeEnvFileAtomic(filePath, { HOST: '0.0.0.0', PORT: '9090' });

    expect(result.backupPath).toBeNull();
    expect([...result.changed].sort()).toEqual(['HOST', 'PORT']);
    expect(readEnvFile(filePath)?.values).toMatchObject({ HOST: '0.0.0.0', PORT: '9090' });
    expect(fs.readdirSync(path.dirname(filePath)).some((entry) => entry.includes('.tmp-'))).toBe(
      false,
    );
  });

  it('backs up an existing file before replacing it', () => {
    const filePath = path.join(root, 'existing.env');
    const original = '# comment\nHOST=127.0.0.1\n';
    fs.writeFileSync(filePath, original, 'utf8');

    const result = writeEnvFileAtomic(filePath, { HOST: '0.0.0.0' });

    expect(result.changed).toEqual(['HOST']);
    expect(result.backupPath).toBe(`${filePath}.bak`);
    expect(fs.readFileSync(`${filePath}.bak`, 'utf8')).toBe(original);

    const updated = fs.readFileSync(filePath, 'utf8');
    expect(updated).toContain('# comment');
    expect(updated).toContain('HOST=0.0.0.0');
  });

  it('does nothing when no values change', () => {
    const filePath = path.join(root, 'unchanged.env');
    const original = 'HOST=0.0.0.0\n';
    fs.writeFileSync(filePath, original, 'utf8');

    const result = writeEnvFileAtomic(filePath, { HOST: '0.0.0.0' });

    expect(result.changed).toEqual([]);
    expect(result.backupPath).toBeNull();
    expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
  });

  it('clears a key by writing an empty value', () => {
    const filePath = path.join(root, 'clear.env');
    fs.writeFileSync(filePath, 'S3_ENDPOINT=https://example.com\n', 'utf8');

    const result = writeEnvFileAtomic(filePath, { S3_ENDPOINT: '' });

    expect(result.changed).toEqual(['S3_ENDPOINT']);
    expect(readEnvFile(filePath)?.values['S3_ENDPOINT']).toBe('');
  });

  it('writes the file with owner-only permissions where supported', () => {
    if (process.platform === 'win32') return;

    const filePath = path.join(root, 'mode.env');
    writeEnvFileAtomic(filePath, { HOST: '127.0.0.1' });
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });
});
