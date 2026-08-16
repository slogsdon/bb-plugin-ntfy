import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";

const NOW = 1_800_000_000_000;

function makeHost(options: {
  topic?: string | null;
  overrides?: Record<string, string | boolean>;
} = {}): FakePluginHost {
  const settings: Record<string, string | boolean> = {
    server: "https://ntfy.example",
    ...options.overrides,
  };
  // `null` omits the topic (unconfigured plugin); default or a string sets it.
  if (options.topic !== null) {
    settings.topic = options.topic ?? "test-topic";
  }
  return createFakePluginHost({
    pluginId: "ntfy",
    settings,
    sdk: {
      threads: {
        interactions: {
          list: async () => [],
        },
      },
    },
  });
}

function stubFetch(host: FakePluginHost): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/api/v1/plugins/connect/rpc/status")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { paired: false, url: null },
          }),
          { status: 200 },
        );
      }
      return fetchMock(input, init);
    }),
  );
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("thread.idle", () => {
  it("notifies once per attention moment when the turn is unread", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const host = makeHost();
    await plugin(host.bb);
    const fetchMock = stubFetch(host);

    const thread = makeThreadResponse({
      id: "th_1",
      title: "Fix the flaky test",
      latestAttentionAt: NOW,
      lastReadAt: NOW - 60_000,
    });

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: "Done — here is the fix.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Same attention moment again → deduped.
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: "Done — here is the fix.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await host.harness.lifecycle.dispose();
  });

  it("skips a turn the user has read recently (grace window)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const host = makeHost();
    await plugin(host.bb);
    const fetchMock = stubFetch(host);

    const thread = makeThreadResponse({
      id: "th_1",
      latestAttentionAt: NOW,
      lastReadAt: NOW - 5_000, // read 5s ago; min unread default is 30s
    });

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: "done",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await host.harness.lifecycle.dispose();
  });

  it("skips hidden threads by default and includes them when enabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const host = makeHost();
    await plugin(host.bb);
    const fetchMock = stubFetch(host);

    const thread = makeThreadResponse({
      id: "th_hidden",
      visibility: "hidden",
      latestAttentionAt: NOW,
      lastReadAt: NOW - 60_000,
    });

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await host.harness.behavior.setSettings({ notifyHidden: true });
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await host.harness.lifecycle.dispose();
  });

  it("sends a high-priority ping when a pending interaction is waiting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const host = makeHost();
    await plugin(host.bb);
    const fetchMock = stubFetch(host);

    host.harness.sdk.stub("threads.interactions.list", async () => [
      {
        id: "int_1",
        threadId: "th_1",
        status: "pending",
        statusReason: null,
        createdAt: NOW,
        turnId: "turn_1",
        providerId: "test",
        providerThreadId: "pt",
        providerRequestId: "pr",
        payload: { kind: "approval" },
      },
    ]);

    const thread = makeThreadResponse({
      id: "th_1",
      latestAttentionAt: NOW,
      lastReadAt: NOW - 60_000,
    });

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: "I need approval to continue.",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Priority).toBe("4");
    expect(headers.Tags).toBe("raising_hand");
    expect(String(init.body)).toContain("Needs approval");
    await host.harness.lifecycle.dispose();
  });

  it("respects quiet hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T23:00:00"));
    const host = makeHost({
      overrides: { quietStart: "22:00", quietEnd: "07:00" },
    });
    await plugin(host.bb);
    const fetchMock = stubFetch(host);

    const thread = makeThreadResponse({
      id: "th_1",
      latestAttentionAt: Date.now(),
      lastReadAt: Date.now() - 60_000,
    });

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: "done",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await host.harness.lifecycle.dispose();
  });
});

describe("thread.failed", () => {
  it("notifies with high priority and the error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const host = makeHost();
    await plugin(host.bb);
    const fetchMock = stubFetch(host);

    const thread = makeThreadResponse({
      id: "th_1",
      title: "Nightly job",
      status: "error",
      latestAttentionAt: NOW,
      lastReadAt: NOW - 60_000,
    });

    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread,
      error: "rate limit exceeded",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Priority).toBe("4");
    expect(headers.Tags).toBe("rotating_light");
    expect(headers.Click).toBe(
      "http://127.0.0.1:38886/projects/project-1/threads/th_1",
    );
    expect(String(init.body)).toContain("rate limit exceeded");
    await host.harness.lifecycle.dispose();
  });

  it("dedupes repeated failures of the same thread", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const host = makeHost();
    await plugin(host.bb);
    const fetchMock = stubFetch(host);

    const thread = makeThreadResponse({
      id: "th_1",
      status: "error",
      latestAttentionAt: NOW,
      lastReadAt: NOW - 60_000,
    });

    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread,
      error: "boom",
    });
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread,
      error: "boom",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await host.harness.lifecycle.dispose();
  });
});

describe("notification deeplinks", () => {
  it("uses the bb connect URL when remote control is paired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const host = makeHost();
    await plugin(host.bb);
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      if (String(input).endsWith("/api/v1/plugins/connect/rpc/status")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              paired: true,
              url: "https://shane.getbb.app",
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const thread = makeThreadResponse({
      id: "th_1",
      projectId: "proj_1",
      status: "error",
      latestAttentionAt: NOW,
      lastReadAt: NOW - 60_000,
    });

    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread,
      error: "boom",
    });

    const ntfyRequest = fetchMock.mock.calls.find(([input]) =>
      String(input).startsWith("https://ntfy.example/"),
    );
    expect(ntfyRequest).toBeDefined();
    const init = ntfyRequest?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Click).toBe(
      "https://shane.getbb.app/projects/proj_1/threads/th_1",
    );
    await host.harness.lifecycle.dispose();
  });
});

describe("settings gating", () => {
  it("does not notify without a configured topic", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const host = makeHost({ topic: null });
    await plugin(host.bb);
    const fetchMock = stubFetch(host);

    const thread = makeThreadResponse({
      id: "th_1",
      latestAttentionAt: NOW,
      lastReadAt: NOW - 60_000,
    });
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await host.harness.lifecycle.dispose();
  });

  it("reports needs-configuration when the topic is missing", async () => {
    const host = makeHost({ topic: null });
    await plugin(host.bb);
    expect(host.harness.needsConfigurationMessages.length).toBeGreaterThan(0);
    await host.harness.lifecycle.dispose();
  });
});
