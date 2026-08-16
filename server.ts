// bb-plugin-ntfy — push notifications via ntfy.sh whenever a thread needs
// your attention.
//
// Signals watched:
//   - thread.idle   — a turn finished and the thread is unread by bb's own
//                     attention rule (latestAttentionAt > lastReadAt), or a
//                     pending interaction (approval/question) is waiting.
//   - thread.failed — a thread errored; always urgent.
//
// Dedup: one notification per (thread, attention moment); a global cooldown
// between idle pings; quiet hours suppress everything.

import {
  type BbPluginApi,
  type PluginThreadEventPayloads,
} from "@get-bb/plugin-sdk";
import {
  isQuietHours,
  publish,
  truncate,
  type NtfyMessage,
} from "./src/ntfy.js";

const DEFAULT_MIN_UNREAD_SECONDS = 30;
const DEFAULT_COOLDOWN_SECONDS = 30;
const SENT_PREFIX = "sent:";
const LAST_SENT_KEY = "last-sent";
const SENT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // prune records after 14 days

/** The thread DTO delivered on lifecycle events (ThreadResponse). */
type ThreadDto = PluginThreadEventPayloads["thread.idle"]["thread"];

/** Per-thread dedupe record keyed by attention moment or interaction id. */
interface SentRecord {
  at: number; // thread.latestAttentionAt (or interaction createdAt)
  kind: "idle" | "failed" | "interaction";
  id?: string; // interaction id when kind === "interaction"
  ts: number; // when we notified
}

function threadTitle(thread: ThreadDto): string {
  return thread.title ?? thread.titleFallback ?? "Untitled thread";
}

function parseSeconds(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function interactionLabel(kind: string): string {
  switch (kind) {
    case "approval":
      return "Needs approval";
    case "command":
      return "Awaiting your input";
    default:
      return "Provider interaction pending";
  }
}

/** Prefer bb connect's remote origin when this server is paired. */
async function resolveDeeplinkBaseUrl(
  loopbackBaseUrl: string,
): Promise<string> {
  try {
    const response = await fetch(
      `${loopbackBaseUrl}/api/v1/plugins/connect/rpc/status`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      },
    );
    if (!response.ok) return loopbackBaseUrl;

    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null) return loopbackBaseUrl;
    const rpcResponse = payload as { ok?: unknown; result?: unknown };
    if (rpcResponse.ok !== true) return loopbackBaseUrl;
    const result = rpcResponse.result;
    if (typeof result !== "object" || result === null) return loopbackBaseUrl;
    const { paired, url } = result as { paired?: unknown; url?: unknown };
    if (paired === true && typeof url === "string" && url.length > 0) {
      return url.replace(/\/+$/, "");
    }
  } catch {
    // bb connect may be disabled or unavailable; preserve local deeplinks.
  }
  return loopbackBaseUrl;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    topic: {
      type: "string",
      label: "ntfy topic",
      description:
        "Topic to publish to, e.g. shane-bb. Private topics also need the access token below.",
    },
    server: {
      type: "string",
      label: "ntfy server",
      description: "ntfy.sh or a self-hosted server URL.",
      default: "https://ntfy.sh",
    },
    token: {
      type: "string",
      label: "Access token",
      secret: true,
      description:
        "Optional. Required for private/authenticated topics. Set with `bb plugin config ntfy set token <secret>`.",
    },
    notifyOnIdle: {
      type: "boolean",
      label: "Notify when a turn finishes unread",
      default: true,
    },
    notifyOnFailure: {
      type: "boolean",
      label: "Notify on thread failure",
      default: true,
    },
    notifyInteractions: {
      type: "boolean",
      label: "Notify on pending approval / input",
      default: true,
    },
    notifyHidden: {
      type: "boolean",
      label: "Include hidden (background) threads",
      default: false,
    },
    minUnreadSeconds: {
      type: "string",
      label: "Min unread time (seconds)",
      description:
        "Only ping when a finished turn has been unread this long. 0 = strict; 30 = skip pings while you are actively watching.",
      default: String(DEFAULT_MIN_UNREAD_SECONDS),
    },
    cooldownSeconds: {
      type: "string",
      label: "Cooldown between pings (seconds)",
      description:
        "Minimum gap between idle pings across all threads. Failures bypass this.",
      default: String(DEFAULT_COOLDOWN_SECONDS),
    },
    quietStart: {
      type: "string",
      label: "Quiet hours start (HH:MM, 24h)",
      description: "Empty = no quiet hours.",
      default: "",
    },
    quietEnd: {
      type: "string",
      label: "Quiet hours end (HH:MM, 24h)",
      description: "Empty = no quiet hours.",
      default: "",
    },
  });

  const initial = await settings.get();
  if (!initial.topic) {
    bb.status.needsConfiguration(
      "Set the topic with `bb plugin config ntfy set topic <name>`, then reload.",
    );
  }

  // --- dedupe helpers ------------------------------------------------------

  async function recordSent(
    thread: ThreadDto,
    kind: SentRecord["kind"],
    opts: { at?: number; id?: string } = {},
  ): Promise<void> {
    const record: SentRecord = {
      at: opts.at ?? thread.latestAttentionAt,
      kind,
      ts: Date.now(),
    };
    if (opts.id) record.id = opts.id;
    await bb.storage.kv.set(`${SENT_PREFIX}${thread.id}`, record);
  }

  async function alreadySent(
    thread: ThreadDto,
    kind: SentRecord["kind"],
    opts: { at?: number; id?: string } = {},
  ): Promise<boolean> {
    const record = await bb.storage.kv.get<SentRecord>(
      `${SENT_PREFIX}${thread.id}`,
    );
    if (!record || record.kind !== kind) return false;
    if (opts.id !== undefined) return record.id === opts.id;
    return record.at === (opts.at ?? thread.latestAttentionAt);
  }

  async function pruneSentRecords(): Promise<void> {
    const cutoff = Date.now() - SENT_TTL_MS;
    for (const key of await bb.storage.kv.list(SENT_PREFIX)) {
      const record = await bb.storage.kv.get<SentRecord>(key);
      if (record && record.ts < cutoff) await bb.storage.kv.delete(key);
    }
  }

  // --- send ----------------------------------------------------------------

  async function send(
    thread: ThreadDto,
    message: NtfyMessage,
    record: { kind: SentRecord["kind"]; at?: number; id?: string },
  ): Promise<void> {
    const cfg = await settings.get();
    if (!cfg.topic) return;

    const click = await (async () => {
      try {
        const baseUrl = await resolveDeeplinkBaseUrl(bb.server.loopbackBaseUrl);
        return `${baseUrl}/projects/${encodeURIComponent(
          thread.projectId,
        )}/threads/${encodeURIComponent(thread.id)}`;
      } catch {
        return undefined; // loopbackBaseUrl is bind-gated (tests, early load)
      }
    })();

    const result = await publish(
      {
        server: cfg.server ?? "https://ntfy.sh",
        topic: cfg.topic,
        token: cfg.token,
      },
      { ...message, ...(click ? { click } : {}) },
    );

    if (result.ok) {
      await bb.storage.kv.set(LAST_SENT_KEY, Date.now());
      await recordSent(thread, record.kind, { at: record.at, id: record.id });
      await pruneSentRecords();
      bb.log.info(`notified: ${message.title}`);
    } else {
      bb.log.error(
        `ntfy publish failed (${result.status}): ${result.detail}`,
      );
    }
  }

  function visible(
    thread: ThreadDto,
    includeHidden: boolean,
  ): boolean {
    if (thread.archivedAt !== null) return false;
    if (thread.visibility === "hidden" && !includeHidden) return false;
    return true;
  }

  async function quiet(): Promise<boolean> {
    const cfg = await settings.get();
    const quiet = isQuietHours(cfg.quietStart ?? "", cfg.quietEnd ?? "");
    if (quiet) bb.log.debug("quiet hours active — skipping notification");
    return quiet;
  }

  // --- events --------------------------------------------------------------

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const cfg = await settings.get();
    if (!cfg.topic || !cfg.notifyOnIdle || !visible(thread, cfg.notifyHidden)) {
      return;
    }
    if (await quiet()) return;

    // A pending interaction (approval, question, …) always needs you.
    let interaction: {
      id: string;
      createdAt: number;
      payloadKind: string;
    } | null = null;
    try {
      const pending = await bb.sdk.threads.interactions.list({
        threadId: thread.id,
      });
      const found = pending.find((item) => item.status === "pending");
      if (found) {
        interaction = {
          id: found.id,
          createdAt: found.createdAt,
          payloadKind: found.payload.kind,
        };
      }
    } catch (error) {
      bb.log.warn(
        `interactions lookup failed for ${thread.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (interaction) {
      if (!cfg.notifyInteractions) return;
      if (
        await alreadySent(thread, "interaction", {
          id: interaction.id,
        })
      ) {
        return;
      }
      await send(
        thread,
        {
          title: `bb: ${truncate(threadTitle(thread), 80)}`,
          message: `${interactionLabel(interaction.payloadKind)} — respond in bb.`,
          priority: 4,
          tags: ["raising_hand"],
        },
        {
          kind: "interaction",
          at: interaction.createdAt,
          id: interaction.id,
        },
      );
      return;
    }

    // Plain finished-turn ping, gated by bb's own unread rule.
    const unreadSeconds =
      (thread.latestAttentionAt - (thread.lastReadAt ?? 0)) / 1000;
    if (unreadSeconds < parseSeconds(cfg.minUnreadSeconds, DEFAULT_MIN_UNREAD_SECONDS)) {
      return;
    }
    const cooldownMs =
      parseSeconds(cfg.cooldownSeconds, DEFAULT_COOLDOWN_SECONDS) * 1000;
    const lastSent = (await bb.storage.kv.get<number>(LAST_SENT_KEY)) ?? 0;
    if (Date.now() - lastSent < cooldownMs) return;
    if (await alreadySent(thread, "idle")) return;

    const snippet = lastAssistantText
      ? truncate(lastAssistantText, 400)
      : null;
    await send(
      thread,
      {
        title: `bb: ${truncate(threadTitle(thread), 80)}`,
        message: snippet
          ? `Turn finished — needs your attention.\n\n${snippet}`
          : "Turn finished — thread needs your attention.",
        priority: 3,
        tags: ["bell"],
      },
      { kind: "idle" },
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
        message: error
          ? `Thread failed.\n\n${truncate(error, 500)}`
          : "Thread failed.",
        priority: 4,
        tags: ["rotating_light"],
      },
      { kind: "failed" },
    );
  });

  // --- CLI ----------------------------------------------------------------

  bb.cli.register({
    name: "ntfy",
    summary: "ntfy.sh push notifications when a bb thread needs your attention",
    commands: [
      {
        name: "test",
        summary: "Send a test notification",
        usage: "bb ntfy test [--title <text>] [--priority 1-5]",
      },
      {
        name: "status",
        summary: "Show notification configuration",
        usage: "bb ntfy status",
      },
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
            DEFAULT_MIN_UNREAD_SECONDS,
          )}s`,
          `cooldown:   ${parseSeconds(
            cfg.cooldownSeconds,
            DEFAULT_COOLDOWN_SECONDS,
          )}s`,
          `quiet:      ${
            cfg.quietStart && cfg.quietEnd
              ? `${cfg.quietStart}–${cfg.quietEnd}`
              : "(off)"
          }`,
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
            stderr:
              "topic is not set — run `bb plugin config ntfy set topic <name>` first\n",
          };
        }
        const result = await publish(
          {
            server: cfg.server ?? "https://ntfy.sh",
            topic: cfg.topic,
            token: cfg.token,
          },
          {
            title,
            message: "Test notification from bb-plugin-ntfy.",
            priority: priority as 1 | 2 | 3 | 4 | 5,
            tags: ["white_check_mark"],
          },
        );
        if (result.ok) {
          return {
            exitCode: 0,
            stdout: `published to ${cfg.server ?? "https://ntfy.sh"}/${cfg.topic} (id ${result.id})\n`,
          };
        }
        return {
          exitCode: 1,
          stderr: `publish failed (${result.status}): ${result.detail}\n`,
        };
      }

      return {
        exitCode: 1,
        stderr: "usage: bb ntfy test|status\n",
      };
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
