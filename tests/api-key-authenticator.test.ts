import { describe, expect, test } from "bun:test";

import { ApiKeyAuthenticator } from "../src/services/api-key-authenticator";

const firstApiKey = "first-api-key-0123456789-abcdefgh";
const secondApiKey = "second-api-key-0123456789-abcdefg";

describe("ApiKeyAuthenticator", () => {
  test("authenticates every configured key", () => {
    const authenticator = new ApiKeyAuthenticator([firstApiKey, secondApiKey]);

    expect(authenticator.authenticate(firstApiKey)).toMatch(/^key_[0-9a-f]{12}$/);
    expect(authenticator.authenticate(secondApiKey)).toMatch(/^key_[0-9a-f]{12}$/);
  });

  test("returns different safe identifiers without exposing keys", () => {
    const authenticator = new ApiKeyAuthenticator([firstApiKey, secondApiKey]);
    const firstIdentifier = authenticator.authenticate(firstApiKey);
    const secondIdentifier = authenticator.authenticate(secondApiKey);

    expect(firstIdentifier).not.toBe(secondIdentifier);
    expect(firstIdentifier).not.toContain(firstApiKey);
    expect(secondIdentifier).not.toContain(secondApiKey);
  });

  test("rejects invalid keys of any length", () => {
    const authenticator = new ApiKeyAuthenticator([firstApiKey]);

    expect(authenticator.authenticate("wrong")).toBeNull();
    expect(authenticator.authenticate(`${firstApiKey}-wrong`)).toBeNull();
  });

  test("requires at least one configured key", () => {
    expect(() => new ApiKeyAuthenticator([])).toThrow("At least one API key is required");
  });
});
