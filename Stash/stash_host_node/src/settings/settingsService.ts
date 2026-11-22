import fs from 'node:fs';
import path from 'node:path';

import type { Logger } from 'pino';

import type { AppEnv } from '../config/env';
import { envSchema } from '../config/env';
import type { SettingDefinition, SettingGroup } from '../config/settingsCatalog';
import { SETTINGS, SETTING_GROUPS, getSetting } from '../config/settingsCatalog';
import type { WriteEnvFileResult } from './envFile';
import { readEnvFile, writeEnvFileAtomic } from './envFile';

export type SettingSource = 'environment' | 'env-file' | 'default';

export interface SettingsRuntimeValue {
  key: string;
  value: string | number | boolean | null;
  isSet: boolean;
  source: SettingSource;
  overriddenByEnvironment: boolean;
}

export interface SettingsSnapshot {
  envFile: string;
  backupFile: string | null;
  groups: Array<SettingGroup & { fields: Array<SettingDefinition & SettingsRuntimeValue> }>;
  pendingRestartKeys: string[];
  environmentOverrides: string[];
  restartNote: string;
}

export interface SettingsUpdateInput {
  values: Record<string, string | number | boolean | null>;
}

export interface SettingsUpdateResult {
  updated: string[];
  applied: string[];
  restartRequired: boolean;
  restartKeys: string[];
  pendingRestartKeys: string[];
  warnings: string[];
  envFile: string;
  backupFile: string | null;
}

export class SettingsValidationError extends Error {
  readonly fields: Record<string, string>;
  readonly statusCode = 400;

  constructor(message: string, fields: Record<string, string>) {
    super(message);
    this.name = 'SettingsValidationError';
    this.fields = fields;
  }
}

export class SettingsWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsWriteError';
  }
}

export interface SettingsServiceOptions {
  envPath: string;
  environment?: NodeJS.ProcessEnv;
  runtimeEnv?: NodeJS.ProcessEnv;
  logger: Logger;
}

const RESTART_NOTE =
  'All settings except Log level require a host restart. The .env file is loaded at startup; saved changes take effect after the host restarts.';

function coerceInputValue(value: string | number | boolean | null): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return value;
}

function convertValue(
  definition: SettingDefinition,
  raw: string | null,
): string | number | boolean | null {
  if (raw === null) return null;

  if (definition.type === 'number') {
    const parsed = Number(raw.trim());
    return Number.isInteger(parsed) ? parsed : null;
  }

  if (definition.type === 'boolean') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
    return null;
  }

  return raw;
}

export class SettingsService {
  private readonly envPath: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly runtimeEnv: NodeJS.ProcessEnv;
  private readonly logger: Logger;
  private readonly pendingRestart = new Set<string>();
  private fileValues: Record<string, string>;

  constructor(options: SettingsServiceOptions) {
    this.envPath = options.envPath;
    this.environment = { ...(options.environment ?? process.env) };
    this.runtimeEnv = options.runtimeEnv ?? process.env;
    this.logger = options.logger;
    this.fileValues = readEnvFile(options.envPath)?.values ?? {};
  }

  snapshot(): SettingsSnapshot {
    const groups = SETTING_GROUPS.map((group) => ({
      ...group,
      fields: SETTINGS.filter((setting) => setting.group === group.id).map((definition) => ({
        ...definition,
        ...this.runtimeValue(definition),
      })),
    }));

    return {
      envFile: path.basename(this.envPath),
      backupFile: this.backupFile(),
      groups,
      pendingRestartKeys: this.pendingRestartKeys(),
      environmentOverrides: this.environmentOverrideKeys(),
      restartNote: RESTART_NOTE,
    };
  }

  async update(input: SettingsUpdateInput): Promise<SettingsUpdateResult> {
    const fieldErrors: Record<string, string> = {};
    const stringUpdates: Record<string, string> = {};

    for (const [key, value] of Object.entries(input.values)) {
      const definition = getSetting(key);
      if (!definition) {
        fieldErrors[key] = 'Unknown setting';
        continue;
      }
      stringUpdates[key] = coerceInputValue(value);
    }

    if (Object.keys(fieldErrors).length > 0) {
      throw new SettingsValidationError('Unknown settings', fieldErrors);
    }

    const candidate: NodeJS.ProcessEnv = {
      ...this.runtimeEnv,
      ...this.fileValues,
      ...stringUpdates,
    };
    const parsed = envSchema.safeParse(candidate);
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.length > 0 ? String(issue.path[0]) : '_';
        if (!(key in fields)) fields[key] = issue.message;
      }
      throw new SettingsValidationError('Invalid settings', fields);
    }

    const changedUpdates: Record<string, string> = {};
    for (const [key, value] of Object.entries(stringUpdates)) {
      const current = this.fileValues[key];
      if (current === value) continue;
      if (value === '' && current === undefined) continue;
      changedUpdates[key] = value;
    }

    let writeResult: WriteEnvFileResult = { backupPath: null, changed: [] };
    if (Object.keys(changedUpdates).length > 0) {
      try {
        writeResult = writeEnvFileAtomic(this.envPath, changedUpdates);
      } catch {
        throw new SettingsWriteError('Failed to write the environment file');
      }
    }

    for (const key of writeResult.changed) {
      const value = changedUpdates[key] ?? '';
      if (value === '') delete this.fileValues[key];
      else this.fileValues[key] = value;
    }

    const defaultLogLevel = (getSetting('LOG_LEVEL')?.defaultValue ?? 'info') as AppEnv['LOG_LEVEL'];
    const submittedLogLevel = stringUpdates['LOG_LEVEL'];
    const nextLogLevel =
      submittedLogLevel === undefined
        ? undefined
        : submittedLogLevel === ''
          ? defaultLogLevel
          : (submittedLogLevel as AppEnv['LOG_LEVEL']);

    const applied: string[] = [];
    if (nextLogLevel !== undefined && this.logger.level !== nextLogLevel) {
      this.logger.level = nextLogLevel;
      applied.push('LOG_LEVEL');
    }

    for (const key of writeResult.changed) {
      const definition = getSetting(key);
      if (definition?.requiresRestart) this.pendingRestart.add(key);
    }

    const warnings: string[] = [];
    for (const key of writeResult.changed) {
      if (this.environment[key] !== undefined) {
        warnings.push(
          `${key} is set in the process environment and overrides the .env file; remove it from the environment to apply the saved value.`,
        );
      }
    }

    const restartKeys = this.pendingRestartKeys();

    return {
      updated: writeResult.changed,
      applied,
      restartRequired: restartKeys.length > 0,
      restartKeys,
      pendingRestartKeys: restartKeys,
      warnings,
      envFile: path.basename(this.envPath),
      backupFile: writeResult.backupPath === null ? null : path.basename(writeResult.backupPath),
    };
  }

  private runtimeValue(definition: SettingDefinition): SettingsRuntimeValue {
    const envValue = this.environment[definition.key];
    const envSet = envValue !== undefined && envValue !== '';
    const fileValue = this.fileValues[definition.key];
    const fileSet = fileValue !== undefined && fileValue !== '';

    let raw: string | null = null;
    let source: SettingSource = 'default';
    if (envSet) {
      raw = envValue;
      source = 'environment';
    } else if (fileSet) {
      raw = fileValue;
      source = 'env-file';
    }

    const isSet = raw !== null;
    const overriddenByEnvironment = envValue !== undefined;

    if (definition.secret) {
      return {
        key: definition.key,
        value: null,
        isSet,
        source,
        overriddenByEnvironment,
      };
    }

    const effective = raw ?? definition.defaultValue;
    return {
      key: definition.key,
      value: convertValue(definition, effective),
      isSet,
      source,
      overriddenByEnvironment,
    };
  }

  private backupFile(): string | null {
    const backupPath = `${this.envPath}.bak`;
    return fs.existsSync(backupPath) ? path.basename(backupPath) : null;
  }

  private pendingRestartKeys(): string[] {
    return SETTINGS.filter((setting) => this.pendingRestart.has(setting.key)).map(
      (setting) => setting.key,
    );
  }

  private environmentOverrideKeys(): string[] {
    return SETTINGS.filter((setting) => this.environment[setting.key] !== undefined).map(
      (setting) => setting.key,
    );
  }
}
