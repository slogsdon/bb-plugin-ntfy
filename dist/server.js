import { createRequire as __createRequire } from "node:module";
import { dirname as __pathDirname } from "node:path";
import { fileURLToPath as __fileURLToPath } from "node:url";
const require = __createRequire(import.meta.url);
var __filename = __fileURLToPath(import.meta.url);
var __dirname = __pathDirname(__filename);

// src/ntfy.ts
var TITLE_MAX = 200;
var MESSAGE_MAX = 4e3;
function truncate(text, max) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}\u2026`;
}
var HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
function parseHHMM(value) {
  const match = HHMM.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
function isQuietHours(start, end, now = /* @__PURE__ */ new Date()) {
  const from = parseHHMM(start);
  const to = parseHHMM(end);
  if (from === null || to === null) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (from <= to) return minutes >= from && minutes < to;
  return minutes >= from || minutes < to;
}
async function publish(config, message, options = {}) {
  const base = config.server.replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(config.topic)}`;
  const timeoutMs = options.timeoutMs ?? 1e4;
  const headers = {
    Title: truncate(message.title, TITLE_MAX),
    Priority: String(message.priority)
  };
  if (message.tags?.length) headers.Tags = message.tags.join(",");
  if (message.click) headers.Click = message.click;
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: truncate(message.message, MESSAGE_MAX),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      return {
        ok: false,
        status: response.status,
        detail: detail || response.statusText
      };
    }
    const json = await response.json().catch(() => null);
    return { ok: true, id: json?.id ?? "unknown" };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

// server.ts
var DEFAULT_MIN_UNREAD_SECONDS = 30;
var DEFAULT_COOLDOWN_SECONDS = 30;
var SENT_PREFIX = "sent:";
var LAST_SENT_KEY = "last-sent";
var SENT_TTL_MS = 14 * 24 * 60 * 60 * 1e3;
function threadTitle(thread) {
  return thread.title ?? thread.titleFallback ?? "Untitled thread";
}
function parseSeconds(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function interactionLabel(kind) {
  switch (kind) {
    case "approval":
      return "Needs approval";
    case "command":
      return "Awaiting your input";
    default:
      return "Provider interaction pending";
  }
}
async function plugin(bb) {
  const settings = bb.settings.define({
    topic: {
      type: "string",
      label: "ntfy topic",
      description: "Topic to publish to, e.g. shane-bb. Private topics also need the access token below."
    },
    server: {
      type: "string",
      label: "ntfy server",
      description: "ntfy.sh or a self-hosted server URL.",
      default: "https://ntfy.sh"
    },
    token: {
      type: "string",
      label: "Access token",
      secret: true,
      description: "Optional. Required for private/authenticated topics. Set with `bb plugin config ntfy set token <secret>`."
    },
    notifyOnIdle: {
      type: "boolean",
      label: "Notify when a turn finishes unread",
      default: true
    },
    notifyOnFailure: {
      type: "boolean",
      label: "Notify on thread failure",
      default: true
    },
    notifyInteractions: {
      type: "boolean",
      label: "Notify on pending approval / input",
      default: true
    },
    notifyHidden: {
      type: "boolean",
      label: "Include hidden (background) threads",
      default: false
    },
    minUnreadSeconds: {
      type: "string",
      label: "Min unread time (seconds)",
      description: "Only ping when a finished turn has been unread this long. 0 = strict; 30 = skip pings while you are actively watching.",
      default: String(DEFAULT_MIN_UNREAD_SECONDS)
    },
    cooldownSeconds: {
      type: "string",
      label: "Cooldown between pings (seconds)",
      description: "Minimum gap between idle pings across all threads. Failures bypass this.",
      default: String(DEFAULT_COOLDOWN_SECONDS)
    },
    quietStart: {
      type: "string",
      label: "Quiet hours start (HH:MM, 24h)",
      description: "Empty = no quiet hours.",
      default: ""
    },
    quietEnd: {
      type: "string",
      label: "Quiet hours end (HH:MM, 24h)",
      description: "Empty = no quiet hours.",
      default: ""
    }
  });
  const initial = await settings.get();
  if (!initial.topic) {
    bb.status.needsConfiguration(
      "Set the topic with `bb plugin config ntfy set topic <name>`, then reload."
    );
  }
  async function recordSent(thread, kind, opts = {}) {
    const record = {
      at: opts.at ?? thread.latestAttentionAt,
      kind,
      ts: Date.now()
    };
    if (opts.id) record.id = opts.id;
    await bb.storage.kv.set(`${SENT_PREFIX}${thread.id}`, record);
  }
  async function alreadySent(thread, kind, opts = {}) {
    const record = await bb.storage.kv.get(
      `${SENT_PREFIX}${thread.id}`
    );
    if (!record || record.kind !== kind) return false;
    if (opts.id !== void 0) return record.id === opts.id;
    return record.at === (opts.at ?? thread.latestAttentionAt);
  }
  async function pruneSentRecords() {
    const cutoff = Date.now() - SENT_TTL_MS;
    for (const key of await bb.storage.kv.list(SENT_PREFIX)) {
      const record = await bb.storage.kv.get(key);
      if (record && record.ts < cutoff) await bb.storage.kv.delete(key);
    }
  }
  async function send(thread, message, record) {
    const cfg = await settings.get();
    if (!cfg.topic) return;
    const click = (() => {
      try {
        return `${bb.server.loopbackBaseUrl}/projects/${encodeURIComponent(
          thread.projectId
        )}/threads/${encodeURIComponent(thread.id)}`;
      } catch {
        return void 0;
      }
    })();
    const result = await publish(
      {
        server: cfg.server ?? "https://ntfy.sh",
        topic: cfg.topic,
        token: cfg.token
      },
      { ...message, ...click ? { click } : {} }
    );
    if (result.ok) {
      await bb.storage.kv.set(LAST_SENT_KEY, Date.now());
      await recordSent(thread, record.kind, { at: record.at, id: record.id });
      await pruneSentRecords();
      bb.log.info(`notified: ${message.title}`);
    } else {
      bb.log.error(
        `ntfy publish failed (${result.status}): ${result.detail}`
      );
    }
  }
  function visible(thread, includeHidden) {
    if (thread.archivedAt !== null) return false;
    if (thread.visibility === "hidden" && !includeHidden) return false;
    return true;
  }
  async function quiet() {
    const cfg = await settings.get();
    const quiet2 = isQuietHours(cfg.quietStart ?? "", cfg.quietEnd ?? "");
    if (quiet2) bb.log.debug("quiet hours active \u2014 skipping notification");
    return quiet2;
  }
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const cfg = await settings.get();
    if (!cfg.topic || !cfg.notifyOnIdle || !visible(thread, cfg.notifyHidden)) {
      return;
    }
    if (await quiet()) return;
    let interaction = null;
    try {
      const pending = await bb.sdk.threads.interactions.list({
        threadId: thread.id
      });
      const found = pending.find((item) => item.status === "pending");
      if (found) {
        interaction = {
          id: found.id,
          createdAt: found.createdAt,
          payloadKind: found.payload.kind
        };
      }
    } catch (error) {
      bb.log.warn(
        `interactions lookup failed for ${thread.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (interaction) {
      if (!cfg.notifyInteractions) return;
      if (await alreadySent(thread, "interaction", {
        id: interaction.id
      })) {
        return;
      }
      await send(
        thread,
        {
          title: `bb: ${truncate(threadTitle(thread), 80)}`,
          message: `${interactionLabel(interaction.payloadKind)} \u2014 respond in bb.`,
          priority: 4,
          tags: ["raising_hand"]
        },
        {
          kind: "interaction",
          at: interaction.createdAt,
          id: interaction.id
        }
      );
      return;
    }
    const unreadSeconds = (thread.latestAttentionAt - (thread.lastReadAt ?? 0)) / 1e3;
    if (unreadSeconds < parseSeconds(cfg.minUnreadSeconds, DEFAULT_MIN_UNREAD_SECONDS)) {
      return;
    }
    const cooldownMs = parseSeconds(cfg.cooldownSeconds, DEFAULT_COOLDOWN_SECONDS) * 1e3;
    const lastSent = await bb.storage.kv.get(LAST_SENT_KEY) ?? 0;
    if (Date.now() - lastSent < cooldownMs) return;
    if (await alreadySent(thread, "idle")) return;
    const snippet = lastAssistantText ? truncate(lastAssistantText, 400) : null;
    await send(
      thread,
      {
        title: `bb: ${truncate(threadTitle(thread), 80)}`,
        message: snippet ? `Turn finished \u2014 needs your attention.

${snippet}` : "Turn finished \u2014 thread needs your attention.",
        priority: 3,
        tags: ["bell"]
      },
      { kind: "idle" }
    );
  });
  bb.events.on("thread.failed", async ({ thread, error }) => {
    const cfg = await settings.get();
    if (!cfg.topic || !cfg.notifyOnFailure || !visible(thread, cfg.notifyHidden)) {
      return;
    }
    if (await quiet()) return;
    if (await alreadySent(thread, "failed")) return;
    await send(
      thread,
      {
        title: `bb: ${truncate(threadTitle(thread), 80)}`,
        message: error ? `Thread failed.

${truncate(error, 500)}` : "Thread failed.",
        priority: 4,
        tags: ["rotating_light"]
      },
      { kind: "failed" }
    );
  });
  bb.cli.register({
    name: "ntfy",
    summary: "ntfy.sh push notifications when a bb thread needs your attention",
    commands: [
      {
        name: "test",
        summary: "Send a test notification",
        usage: "bb ntfy test [--title <text>] [--priority 1-5]"
      },
      {
        name: "status",
        summary: "Show notification configuration",
        usage: "bb ntfy status"
      }
    ],
    async run(argv) {
      const [command, ...rest] = argv;
      const cfg = await settings.get();
      if (command === "status") {
        const lines = [
          `server:     ${cfg.server ?? "https://ntfy.sh"}`,
          `topic:      ${cfg.topic ? `"${cfg.topic}"` : "(not set)"}`,
          `token:      ${cfg.token ? "(set)" : "(not set)"}`,
          `on idle:    ${cfg.notifyOnIdle}`,
          `on failure: ${cfg.notifyOnFailure}`,
          `interactions: ${cfg.notifyInteractions}`,
          `hidden:     ${cfg.notifyHidden}`,
          `min unread: ${parseSeconds(
            cfg.minUnreadSeconds,
            DEFAULT_MIN_UNREAD_SECONDS
          )}s`,
          `cooldown:   ${parseSeconds(
            cfg.cooldownSeconds,
            DEFAULT_COOLDOWN_SECONDS
          )}s`,
          `quiet:      ${cfg.quietStart && cfg.quietEnd ? `${cfg.quietStart}\u2013${cfg.quietEnd}` : "(off)"}`
        ];
        return { exitCode: 0, stdout: lines.join("\n") + "\n" };
      }
      if (command === "test") {
        let title = "bb ntfy test";
        let priority = 3;
        for (let index = 0; index < rest.length; index += 1) {
          const arg = rest[index];
          if (arg === "--title" && rest[index + 1]) {
            title = rest[index + 1];
            index += 1;
          } else if (arg === "--priority" && rest[index + 1]) {
            const parsed = Number(rest[index + 1]);
            if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 5) {
              priority = parsed;
            }
            index += 1;
          }
        }
        if (!cfg.topic) {
          return {
            exitCode: 1,
            stderr: "topic is not set \u2014 run `bb plugin config ntfy set topic <name>` first\n"
          };
        }
        const result = await publish(
          {
            server: cfg.server ?? "https://ntfy.sh",
            topic: cfg.topic,
            token: cfg.token
          },
          {
            title,
            message: "Test notification from bb-plugin-ntfy.",
            priority,
            tags: ["white_check_mark"]
          }
        );
        if (result.ok) {
          return {
            exitCode: 0,
            stdout: `published to ${cfg.server ?? "https://ntfy.sh"}/${cfg.topic} (id ${result.id})
`
          };
        }
        return {
          exitCode: 1,
          stderr: `publish failed (${result.status}): ${result.detail}
`
        };
      }
      return {
        exitCode: 1,
        stderr: "usage: bb ntfy test|status\n"
      };
    }
  });
  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
export {
  plugin as default
};
//# sourceMappingURL=server.js.map
