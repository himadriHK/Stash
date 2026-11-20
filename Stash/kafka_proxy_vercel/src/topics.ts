/** Topic allowlists: the app may only produce/consume the Stash topics. */
import { HttpError } from './http.ts';

export function parseTopicList(raw: string | undefined, fallback: string[]): Set<string> {
  const value = (raw ?? '').trim();
  const topics = value
    ? value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : fallback;
  return new Set(topics);
}

export function assertTopicAllowed(
  topic: string,
  allowed: Set<string>,
  action: 'produce' | 'consume',
): void {
  if (!allowed.has(topic)) {
    throw new HttpError(403, 'topic_not_allowed', `Topic "${topic}" is not allowed for ${action}.`);
  }
}
