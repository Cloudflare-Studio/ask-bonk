import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "../github/script/http";

describe("GitHub Action script HTTP retry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries on transient failures", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("server error", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await fetchWithRetry(
      "https://example.com",
      { method: "GET" },
      { retries: 1, baseDelayMs: 1, timeoutMs: 1000 },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-transient status codes", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("bad request", { status: 400 }));

    const response = await fetchWithRetry(
      "https://example.com",
      { method: "GET" },
      { retries: 2, baseDelayMs: 1, timeoutMs: 1000 },
    );

    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
