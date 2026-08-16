import { describe, expect, it, vi } from "vitest";
import {
  isQuietHours,
  parseHHMM,
  publish,
  truncate,
  type NtfyConfig,
} from "./ntfy.js";

describe("truncate", () => {
  it("collapses whitespace and trims", () => {
    expect(truncate("  hello\n\n  world  ", 100)).toBe("hello world");
  });

  it("ellipsizes past the limit", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });

  it("keeps short text untouched", () => {
    expect(truncate("hi", 5)).toBe("hi");
  });
});

describe("parseHHMM", () => {
  it("parses 24h times to minutes", () => {
    expect(parseHHMM("00:00")).toBe(0);
    expect(parseHHMM("07:30")).toBe(450);
    expect(parseHHMM("23:59")).toBe(1439);
    expect(parseHHMM("9:05")).toBe(545);
  });

  it("rejects invalid input", () => {
    expect(parseHHMM("")).toBeNull();
    expect(parseHHMM("24:00")).toBeNull();
    expect(parseHHMM("7:60")).toBeNull();
    expect(parseHHMM("noon")).toBeNull();
  });
});

describe("isQuietHours", () => {
  it("is false when either bound is empty", () => {
    expect(isQuietHours("", "", new Date("2026-01-01T12:00:00"))).toBe(false);
    expect(isQuietHours("22:00", "", new Date("2026-01-01T12:00:00"))).toBe(
      false,
    );
  });

  it("applies a same-day window", () => {
    const start = "22:00";
    const end = "07:00";
    // 07:00 is excluded (half-open), 06:59 is included via midnight wrap.
    expect(isQuietHours(start, end, new Date("2026-01-01T21:59:00"))).toBe(
      false,
    );
    expect(isQuietHours(start, end, new Date("2026-01-01T22:00:00"))).toBe(
      true,
    );
    expect(isQuietHours(start, end, new Date("2026-01-01T23:30:00"))).toBe(
      true,
    );
    expect(isQuietHours(start, end, new Date("2026-01-01T06:59:00"))).toBe(
      true,
    );
    expect(isQuietHours(start, end, new Date("2026-01-01T07:00:00"))).toBe(
      false,
    );
    expect(isQuietHours(start, end, new Date("2026-01-01T12:00:00"))).toBe(
      false,
    );
  });

  it("applies a non-wrapping window", () => {
    expect(isQuietHours("13:00", "14:00", new Date("2026-01-01T13:30:00"))).toBe(
      true,
    );
    expect(isQuietHours("13:00", "14:00", new Date("2026-01-01T14:00:00"))).toBe(
      false,
    );
  });
});

describe("publish", () => {
  const config: NtfyConfig = {
    server: "https://ntfy.example",
    topic: "my topic",
    token: "tk",
  };

  it("POSTs to the topic with ntfy headers and returns the id", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ id: "abc" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publish(config, {
      title: "Hello",
      message: "World",
      priority: 3,
      tags: ["bell"],
      click: "https://bb.local/threads/t1",
    });

    expect(result).toEqual({ ok: true, id: "abc" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://ntfy.example/my%20topic");
    const headers = init.headers as Record<string, string>;
    expect(headers.Title).toBe("Hello");
    expect(headers.Priority).toBe("3");
    expect(headers.Tags).toBe("bell");
    expect(headers.Click).toBe("https://bb.local/threads/t1");
    expect(headers.Authorization).toBe("Bearer tk");
    expect(init.body).toBe("World");
    vi.unstubAllGlobals();
  });

  it("reports HTTP errors with a detail body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: "bad topic" }), {
          status: 400,
        });
      }),
    );
    const result = await publish(config, {
      title: "T",
      message: "M",
      priority: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.detail).toContain("bad topic");
    }
    vi.unstubAllGlobals();
  });

  it("never throws on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const result = await publish(config, {
      title: "T",
      message: "M",
      priority: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(0);
      expect(result.detail).toContain("ECONNREFUSED");
    }
    vi.unstubAllGlobals();
  });
});
