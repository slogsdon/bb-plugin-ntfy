// Pure ntfy.sh client + helpers. No bb imports — unit-testable in isolation.

export interface NtfyConfig {
  /** Base URL, e.g. "https://ntfy.sh" (trailing slash tolerated). */
  server: string;
  /** Topic to publish to (URL-encoded when sent). */
  topic: string;
  /** Optional access token for private/authenticated topics. */
  token?: string;
}

export interface NtfyMessage {
  title: string;
  message: string;
  /** ntfy priority: 1 min … 5 max. */
  priority: 1 | 2 | 3 | 4 | 5;
  /** ntfy emoji tags, e.g. "bell", "rotating_light". */
  tags?: string[];
  /** URL the phone opens on tap. */
  click?: string;
}

export type PublishResult =
  | { ok: true; id: string }
  | { ok: false; status: number; detail: string };

export const TITLE_MAX = 200;
export const MESSAGE_MAX = 4000;

/** Collapse whitespace to single spaces and ellipsize past `max` chars. */
export function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Parse "HH:MM" (24h) into minutes since midnight; null when invalid. */
export function parseHHMM(value: string): number | null {
  const match = HHMM.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * True when `now` falls inside the quiet window [start, end).
 * Overnight windows (start > end) wrap past midnight. Either end empty or
 * unparseable disables quiet hours entirely.
 */
export function isQuietHours(
  start: string,
  end: string,
  now: Date = new Date(),
): boolean {
  const from = parseHHMM(start);
  const to = parseHHMM(end);
  if (from === null || to === null) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (from <= to) return minutes >= from && minutes < to;
  return minutes >= from || minutes < to; // wraps midnight
}

/**
 * Publish a notification. POSTs to `{server}/{topic}` with ntfy headers.
 * Never throws: network failures come back as `{ ok: false }`.
 */
export async function publish(
  config: NtfyConfig,
  message: NtfyMessage,
  options: { timeoutMs?: number } = {},
): Promise<PublishResult> {
  const base = config.server.replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(config.topic)}`;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const headers: Record<string, string> = {
    Title: truncate(message.title, TITLE_MAX),
    Priority: String(message.priority),
  };
  if (message.tags?.length) headers.Tags = message.tags.join(",");
  if (message.click) headers.Click = message.click;
  if (config.token) headers.Authorization = `Bearer ${config.token}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: truncate(message.message, MESSAGE_MAX),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      return {
        ok: false,
        status: response.status,
        detail: detail || response.statusText,
      };
    }
    const json = (await response.json().catch(() => null)) as {
      id?: string;
    } | null;
    return { ok: true, id: json?.id ?? "unknown" };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
