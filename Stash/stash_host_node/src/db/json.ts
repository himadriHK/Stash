export function parseJsonValue<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  const parsed = parseJsonValue<unknown>(raw, {});
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

export function parseStringRecord(raw: string | null | undefined): Record<string, string> {
  const parsed = parseJsonObject(raw);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}
