import { lookup } from "node:dns/promises";
import { BlockList } from "node:net";

const redirectTimeoutMilliseconds = 5_000;
const defaultMaximumRedirects = 5;

const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();

const blockedIpv4Ranges = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const;

const blockedIpv6Ranges = [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const;

for (const [network, prefix] of blockedIpv4Ranges) {
  blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of blockedIpv6Ranges) {
  blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

export type MediaPlatform = "facebook" | "instagram" | "tiktok" | "twitter" | "youtube";

const platformHosts: ReadonlyArray<{
  readonly exactHosts: readonly string[];
  readonly platform: MediaPlatform;
  readonly rootHosts: readonly string[];
}> = [
  {
    exactHosts: ["youtu.be"],
    platform: "youtube",
    rootHosts: ["youtube.com"],
  },
  {
    exactHosts: ["t.co"],
    platform: "twitter",
    rootHosts: ["twitter.com", "x.com"],
  },
  {
    exactHosts: ["fb.watch"],
    platform: "facebook",
    rootHosts: ["facebook.com", "fb.com"],
  },
  {
    exactHosts: [],
    platform: "tiktok",
    rootHosts: ["tiktok.com"],
  },
  {
    exactHosts: ["instagr.am"],
    platform: "instagram",
    rootHosts: ["instagram.com"],
  },
];

export type UrlValidationErrorCode =
  | "INVALID_URL"
  | "PLAYLIST_NOT_SUPPORTED"
  | "REDIRECT_LIMIT_EXCEEDED"
  | "UNSAFE_URL"
  | "UNSUPPORTED_URL";

export class UrlValidationError extends Error {
  override readonly name = "UrlValidationError";

  constructor(
    readonly code: UrlValidationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type AddressResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;
export type RedirectResolver = (url: URL) => Promise<string | null>;

export interface MediaUrlValidatorOptions {
  readonly addressResolver?: AddressResolver;
  readonly maximumRedirects?: number;
  readonly redirectResolver?: RedirectResolver;
}

export interface ValidatedMediaUrl {
  readonly platform: MediaPlatform;
  readonly url: string;
}

const resolveAddresses: AddressResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });

  return addresses.map(({ address, family }) => {
    if (family !== 4 && family !== 6) {
      throw new Error("Unsupported address family");
    }

    return { address, family };
  });
};

const resolveRedirect: RedirectResolver = async (url) => {
  const response = await fetch(url, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(redirectTimeoutMilliseconds),
  });

  await response.body?.cancel();

  if (response.status < 300 || response.status >= 400) {
    return null;
  }

  const location = response.headers.get("Location");

  if (location === null) {
    throw new UrlValidationError("UNSAFE_URL", "The redirect destination is invalid.");
  }

  return new URL(location, url).toString();
};

const normalizeHostname = (hostname: string) => hostname.toLowerCase().replace(/\.+$/u, "");

const identifyPlatform = (hostname: string): MediaPlatform | null => {
  for (const entry of platformHosts) {
    if (entry.exactHosts.includes(hostname)) {
      return entry.platform;
    }

    if (entry.rootHosts.some((root) => hostname === root || hostname.endsWith(`.${root}`))) {
      return entry.platform;
    }
  }

  return null;
};

const isPlaylistUrl = (url: URL, platform: MediaPlatform) => {
  const pathname = url.pathname.toLowerCase();

  if (platform === "youtube") {
    return pathname === "/playlist" || url.searchParams.has("list");
  }

  if (platform === "tiktok") {
    return pathname.includes("/playlist/");
  }

  return false;
};

const parseAndValidateStructure = (input: string) => {
  let url: URL;

  try {
    url = new URL(input);
  } catch {
    throw new UrlValidationError("INVALID_URL", "A valid absolute URL is required.");
  }

  if (url.protocol !== "https:") {
    throw new UrlValidationError("INVALID_URL", "Only HTTPS URLs are accepted.");
  }

  if (url.username !== "" || url.password !== "") {
    throw new UrlValidationError("INVALID_URL", "Credentials are not allowed in URLs.");
  }

  if (url.port !== "") {
    throw new UrlValidationError("INVALID_URL", "Nonstandard ports are not allowed.");
  }

  const hostname = normalizeHostname(url.hostname);
  const platform = identifyPlatform(hostname);

  if (platform === null) {
    throw new UrlValidationError("UNSUPPORTED_URL", "The URL host is not supported.");
  }

  url.hostname = hostname;

  if (isPlaylistUrl(url, platform)) {
    throw new UrlValidationError("PLAYLIST_NOT_SUPPORTED", "Playlist downloads are not supported.");
  }

  return { platform, url };
};

const isBlockedAddress = ({ address, family }: ResolvedAddress) =>
  family === 4
    ? blockedIpv4Addresses.check(address, "ipv4")
    : blockedIpv6Addresses.check(address, "ipv6");

export class MediaUrlValidator {
  private readonly addressResolver: AddressResolver;
  private readonly maximumRedirects: number;
  private readonly redirectResolver: RedirectResolver;

  constructor(options: MediaUrlValidatorOptions = {}) {
    this.addressResolver = options.addressResolver ?? resolveAddresses;
    this.maximumRedirects = options.maximumRedirects ?? defaultMaximumRedirects;
    this.redirectResolver = options.redirectResolver ?? resolveRedirect;

    if (!Number.isInteger(this.maximumRedirects) || this.maximumRedirects < 0) {
      throw new Error("maximumRedirects must be a non-negative integer");
    }
  }

  async validate(input: string): Promise<ValidatedMediaUrl> {
    let current = parseAndValidateStructure(input);
    const visitedUrls = new Set<string>();

    for (let redirectCount = 0; ; redirectCount += 1) {
      if (visitedUrls.has(current.url.href)) {
        throw new UrlValidationError("UNSAFE_URL", "A redirect loop was detected.");
      }

      visitedUrls.add(current.url.href);
      await this.assertPublicAddresses(current.url.hostname);

      let redirect: string | null;

      try {
        redirect = await this.redirectResolver(current.url);
      } catch (error) {
        if (error instanceof UrlValidationError) {
          throw error;
        }

        throw new UrlValidationError("UNSAFE_URL", "The URL destination could not be verified.");
      }

      if (redirect === null) {
        return Object.freeze({
          platform: current.platform,
          url: current.url.toString(),
        });
      }

      if (redirectCount >= this.maximumRedirects) {
        throw new UrlValidationError(
          "REDIRECT_LIMIT_EXCEEDED",
          "The URL contains too many redirects.",
        );
      }

      current = parseAndValidateStructure(redirect);
    }
  }

  private async assertPublicAddresses(hostname: string) {
    let addresses: readonly ResolvedAddress[];

    try {
      addresses = await this.addressResolver(hostname);
    } catch {
      throw new UrlValidationError("UNSAFE_URL", "The URL host could not be verified.");
    }

    if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
      throw new UrlValidationError("UNSAFE_URL", "The URL resolves to an unsafe address.");
    }
  }
}
