import type { Db } from './database';

export const COMPONENT_STATUSES = ['ok', 'degraded', 'down', 'unknown'] as const;

export type ComponentStatus = (typeof COMPONENT_STATUSES)[number];

export interface ComponentCheckRow {
  component: string;
  status: ComponentStatus;
  latency_ms: number | null;
  message: string | null;
  checked_at: string;
  details_json: string | null;
}

export interface UpsertComponentCheckInput {
  component: string;
  status: ComponentStatus;
  latencyMs?: number | null;
  message?: string | null;
  checkedAt?: string;
  details?: unknown;
}

export class ComponentCheckRepository {
  constructor(private readonly db: Db) {}

  upsert(input: UpsertComponentCheckInput): ComponentCheckRow {
    const checkedAt = input.checkedAt ?? new Date().toISOString();
    const detailsJson = input.details === undefined ? null : JSON.stringify(input.details);
    this.db
      .prepare(
        `INSERT INTO component_checks (component, status, latency_ms, message, checked_at, details_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(component) DO UPDATE SET
           status = excluded.status,
           latency_ms = excluded.latency_ms,
           message = excluded.message,
           checked_at = excluded.checked_at,
           details_json = excluded.details_json`,
      )
      .run(
        input.component,
        input.status,
        input.latencyMs ?? null,
        input.message ?? null,
        checkedAt,
        detailsJson,
      );
    return this.get(input.component) as ComponentCheckRow;
  }

  get(component: string): ComponentCheckRow | null {
    const row = this.db
      .prepare('SELECT * FROM component_checks WHERE component = ?')
      .get(component) as ComponentCheckRow | undefined;
    return row ?? null;
  }

  list(): ComponentCheckRow[] {
    return this.db
      .prepare('SELECT * FROM component_checks ORDER BY component ASC')
      .all() as ComponentCheckRow[];
  }
}
