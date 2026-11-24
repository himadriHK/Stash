import type Database from 'better-sqlite3';

export interface Migration {
  readonly version: number;
  readonly name: string;
  up(db: Database.Database): void;
}

const V1_SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL UNIQUE,
  message_id TEXT,
  file_id TEXT,
  request_file_id TEXT,
  file_name TEXT,
  file_size INTEGER,
  downloaded_size INTEGER,
  mime_type TEXT,
  storage_provider TEXT,
  storage_temp_path TEXT,
  storage_key TEXT,
  user_id TEXT,
  device_id TEXT,
  metadata_json TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  stage TEXT NOT NULL DEFAULT 'queued' CHECK (stage IN ('queued','download','verify','deduplicate','convert','thumbnails','store','respond','delete_temp','done')),
  failed_stage TEXT,
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 4,
  stage_attempts_json TEXT NOT NULL DEFAULT '{}',
  next_attempt_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  deduplicated INTEGER NOT NULL DEFAULT 0,
  permanent_path TEXT,
  thumbnails_json TEXT NOT NULL DEFAULT '{}',
  converted_format TEXT,
  temp_dir TEXT,
  error_code TEXT,
  error_message TEXT,
  processing_time_ms INTEGER,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_next_attempt ON jobs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status_stage ON jobs(status, stage);
CREATE INDEX IF NOT EXISTS idx_jobs_lease_expires ON jobs(lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_jobs_file_user ON jobs(file_id, user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_finished_at ON jobs(finished_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_device_created ON jobs(device_id, created_at DESC);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  level TEXT,
  stage TEXT,
  event TEXT NOT NULL,
  message TEXT,
  data_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, id);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'response',
  topic TEXT NOT NULL,
  key TEXT,
  payload TEXT NOT NULL,
  headers_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE (job_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_outbox_status_next_attempt ON outbox(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS component_checks (
  component TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  message TEXT,
  checked_at TEXT NOT NULL,
  details_json TEXT
);
`;

/**
 * The request `file_id` is a client identifier, so the content hash the host
 * verifies the download with needs its own column.
 */
const V2_CONTENT_HASH = `
ALTER TABLE jobs ADD COLUMN content_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_jobs_content_hash ON jobs(content_hash);
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up(db) {
      db.exec(V1_SCHEMA);
    },
  },
  {
    version: 2,
    name: 'host-computed content hash',
    up(db) {
      db.exec(V2_CONTENT_HASH);
    },
  },
];

export function migrate(db: Database.Database): number {
  let current = Number(db.pragma('user_version', { simple: true }) ?? 0);
  if (!Number.isInteger(current) || current < 0) current = 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
    current = migration.version;
  }

  return Number(db.pragma('user_version', { simple: true }) ?? current);
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
