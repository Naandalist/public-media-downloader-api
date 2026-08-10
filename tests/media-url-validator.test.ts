import { describe, expect, test } from "bun:test";

import {
  MediaUrlValidator,
  UrlValidationError,
  type AddressResolver,
  type RedirectResolver,
} from "../src/services/media-url-validator";

const publicAddressResolver: AddressResolver = async () => [{ address: "8.8.8.8", family: 4 }];
const noRedirect: RedirectResolver = async () => null;

const createValidator = (
  addressResolver: AddressResolver = publicAddressResolver,
  redirectResolver: RedirectResolver = noRedirect,
  maximumRedirects = 5,
) => new MediaUrlValidator({ addressResolver, maximumRedirects, redirectResolver });

const expectRejection = async (
  promise: Promise<unknown>,
  expectedCode: UrlValidationError["code"],
) => {
  try {
    await promise;
    throw new Error("Expected URL validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(UrlValidationError);
    expect((error as UrlValidationError).code).toBe(expectedCode);
  }
};

describe("MediaUrlValidator", () => {
  test.each([
    ["https://www.youtube.com/watch?v=owned", "youtube"],
    ["https://youtu.be/owned", "youtube"],
    ["https://x.com/user/status/1", "twitter"],
    ["https://mobile.twitter.com/user/status/1", "twitter"],
    ["https://t.co/example", "twitter"],
    ["https://www.facebook.com/watch/?v=1", "facebook"],
    ["https://fb.watch/example", "facebook"],
    ["https://www.tiktok.com/@user/video/1", "tiktok"],
    ["https://vm.tiktok.com/example", "tiktok"],
    ["https://www.instagram.com/reel/example", "instagram"],
    ["https://instagr.am/p/example", "instagram"],
  ])("accepts supported public URL %s", async (url, platform) => {
    await expect(createValidator().validate(url)).resolves.toMatchObject({ platform });
  });

  test("normalizes host casing and trailing dots", async () => {
    const result = await createValidator().validate("https://WWW.YouTube.COM./watch?v=owned");

    expect(result.url).toBe("https://www.youtube.com/watch?v=owned");
  });

  test.each([
    "not-a-url",
    "http://youtube.com/watch?v=owned",
    "https://user:password@youtube.com/watch?v=owned",
    "https://youtube.com:8443/watch?v=owned",
  ])("rejects invalid URL structure %s", async (url) => {
    await expectRejection(createValidator().validate(url), "INVALID_URL");
  });

  test.each([
    "https://youtube.com.attacker.example/watch?v=owned",
    "https://notyoutube.com/watch?v=owned",
    "https://twitter.com.attacker.example/user/status/1",
    "https://2130706433/watch?v=owned",
    "https://[::1]/watch?v=owned",
  ])("rejects unsupported or deceptive host %s", async (url) => {
    await expectRejection(createValidator().validate(url), "UNSUPPORTED_URL");
  });

  test.each([
    { address: "127.0.0.1", family: 4 as const },
    { address: "10.0.0.1", family: 4 as const },
    { address: "169.254.169.254", family: 4 as const },
    { address: "192.168.1.10", family: 4 as const },
    { address: "::1", family: 6 as const },
    { address: "fe80::1", family: 6 as const },
    { address: "fc00::1", family: 6 as const },
    { address: "::ffff:127.0.0.1", family: 6 as const },
  ])("rejects blocked resolved address $address", async (resolvedAddress) => {
    const addressResolver: AddressResolver = async () => [resolvedAddress];

    await expectRejection(
      createValidator(addressResolver).validate("https://youtube.com/watch?v=1"),
      "UNSAFE_URL",
    );
  });

  test("rejects a host when any resolved address is unsafe", async () => {
    const addressResolver: AddressResolver = async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];

    await expectRejection(
      createValidator(addressResolver).validate("https://youtube.com/watch?v=1"),
      "UNSAFE_URL",
    );
  });

  test("rejects empty and failed DNS results", async () => {
    const emptyResolver: AddressResolver = async () => [];
    const failedResolver: AddressResolver = async () => Promise.reject(new Error("DNS details"));

    await expectRejection(
      createValidator(emptyResolver).validate("https://youtube.com/watch?v=1"),
      "UNSAFE_URL",
    );
    await expectRejection(
      createValidator(failedResolver).validate("https://youtube.com/watch?v=1"),
      "UNSAFE_URL",
    );
  });

  test("accepts a safe redirect and returns its normalized platform", async () => {
    const redirectResolver: RedirectResolver = async (url) =>
      url.hostname === "youtu.be" ? "https://www.youtube.com/watch?v=owned" : null;
    const result = await createValidator(publicAddressResolver, redirectResolver).validate(
      "https://youtu.be/owned",
    );

    expect(result).toEqual({
      platform: "youtube",
      url: "https://www.youtube.com/watch?v=owned",
    });
  });

  test("rejects redirects to unsupported hosts", async () => {
    const redirectResolver: RedirectResolver = async () =>
      "https://attacker.example/private-target";

    await expectRejection(
      createValidator(publicAddressResolver, redirectResolver).validate("https://t.co/example"),
      "UNSUPPORTED_URL",
    );
  });

  test("rejects redirects that resolve to private addresses", async () => {
    const addressResolver: AddressResolver = async (hostname) => [
      {
        address: hostname === "x.com" ? "127.0.0.1" : "8.8.8.8",
        family: 4,
      },
    ];
    const redirectResolver: RedirectResolver = async (url) =>
      url.hostname === "t.co" ? "https://x.com/user/status/1" : null;

    await expectRejection(
      createValidator(addressResolver, redirectResolver).validate("https://t.co/example"),
      "UNSAFE_URL",
    );
  });

  test("rejects redirect loops and excessive redirects", async () => {
    const loopResolver: RedirectResolver = async (url) =>
      url.searchParams.has("next") ? "https://youtu.be/owned" : "https://youtu.be/owned?next=true";
    const chainResolver: RedirectResolver = async (url) => {
      const count = Number(url.searchParams.get("count") ?? "0");
      return `https://youtu.be/owned?count=${count + 1}`;
    };

    await expectRejection(
      createValidator(publicAddressResolver, loopResolver).validate("https://youtu.be/owned"),
      "UNSAFE_URL",
    );
    await expectRejection(
      createValidator(publicAddressResolver, chainResolver, 2).validate("https://youtu.be/owned"),
      "REDIRECT_LIMIT_EXCEEDED",
    );
  });

  test.each([
    "https://www.youtube.com/playlist?list=owned",
    "https://www.youtube.com/watch?v=owned&list=playlist",
    "https://www.tiktok.com/@user/playlist/example-1",
  ])("rejects playlist URL %s", async (url) => {
    await expectRejection(createValidator().validate(url), "PLAYLIST_NOT_SUPPORTED");
  });
});
