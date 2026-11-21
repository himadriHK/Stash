import fs from 'node:fs/promises';
import path from 'node:path';

import type { AppEnv } from '../config/env';
import { summarizeEnv } from '../config/env';
import type { Db } from '../db/database';
import type { ComponentStatus } from '../db/checks';

export type { ComponentStatus } from '../db/checks';

export interface ComponentHealth {
  component: string;
  status: ComponentStatus;
  latencyMs: number | null;
  message: string | null;
  checkedAt: string;
  details?: Record<string, unknown> | null;
}

export type HealthCheckResult = Omit<ComponentHealth, 'component' | 'checkedAt'>;

export interface HealthCheckDefinition {
  component: string;
  run: () => Promise<HealthCheckResult> | HealthCheckResult;
}

export interface HealthReport {
  status: ComponentStatus;
  checkedAt: string;
  components: ComponentHealth[];
}

export class HealthRegistry {
  private readonly checks = new Map<string, HealthCheckDefinition>();

  register(component: string, run: HealthCheckDefinition['run']): this {
    this.checks.set(component, { component, run });
    return this;
  }

  list(): string[] {
    return [...this.checks.keys()];
  }

  async check(component: string): Promise<ComponentHealth> {
    const definition = this.checks.get(component);
    if (!definition) {
      return {
        component,
        status: 'unknown',
        latencyMs: null,
        message: 'Unknown component',
        checkedAt: new Date().toISOString(),
      };
    }
    return runCheck(definition);
  }

  async checkAll(): Promise<HealthReport> {
    const components = await Promise.all([...this.checks.values()].map(runCheck));
    return {
      status: aggregateStatus(components.map((entry) => entry.status)),
      checkedAt: new Date().toISOString(),
      components,
    };
  }
}

async function runCheck(definition: HealthCheckDefinition): Promise<ComponentHealth> {
  const started = performance.now();
  try {
    const result = await definition.run();
    return {
      component: definition.component,
      status: result.status,
      latencyMs: result.latencyMs ?? Math.round(performance.now() - started),
      message: result.message ?? null,
      checkedAt: new Date().toISOString(),
      details: result.details ?? null,
    };
  } catch {
    return {
      component: definition.component,
      status: 'down',
      latencyMs: Math.round(performance.now() - started),
      message: 'Health check failed',
      checkedAt: new Date().toISOString(),
      details: null,
    };
  }
}

export async function checkDatabase(db: Db): Promise<HealthCheckResult> {
  const started = performance.now();
  const row = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
  const latencyMs = Math.round(performance.now() - started);
  if (row?.ok !== 1) {
    return { status: 'down', latencyMs, message: 'SQLite did not return the expected result' };
  }
  return { status: 'ok', latencyMs, message: null };
}

export async function checkTempDir(env: AppEnv): Promise<HealthCheckResult> {
  const started = performance.now();
  await fs.mkdir(env.TEMP_DIR, { recursive: true });
  const probe = path.join(env.TEMP_DIR, `.health-${process.pid}-${Date.now()}`);
  await fs.writeFile(probe, 'ok', 'utf8');
  await fs.unlink(probe);
  return {
    status: 'ok',
    latencyMs: Math.round(performance.now() - started),
    message: null,
    details: { tempDir: env.TEMP_DIR },
  };
}

export function checkConfig(env: AppEnv): HealthCheckResult {
  return {
    status: 'ok',
    latencyMs: 0,
    message: null,
    details: summarizeEnv(env) as unknown as Record<string, unknown>,
  };
}

export function createStubCheck(component: string, message: string): HealthCheckDefinition {
  return {
    component,
    run: () => ({ status: 'unknown', latencyMs: null, message }),
  };
}

export function createBasicHealthRegistry(db: Db, env: AppEnv): HealthRegistry {
  const registry = new HealthRegistry();
  registry.register('database', () => checkDatabase(db));
  registry.register('temp_dir', () => checkTempDir(env));
  registry.register('config', () => checkConfig(env));
  registry.register(
    's3',
    createStubCheck('s3', 'S3 health checks are implemented in phase 4').run,
  );
  registry.register(
    'kafka',
    createStubCheck('kafka', 'Kafka health checks are implemented in phase 4').run,
  );
  return registry;
}

export function aggregateStatus(statuses: readonly ComponentStatus[]): ComponentStatus {
  if (statuses.includes('down')) return 'down';
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.length > 0 && statuses.every((status) => status === 'ok')) return 'ok';
  return 'unknown';
}
