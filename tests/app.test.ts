import { describe, expect, test } from "bun:test";

import { app } from "../src/app";

describe("application", () => {
  test("returns the service identity", async () => {
    const response = await app.request("/");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name: "media-downloader",
      status: "ok",
    });
  });
});
