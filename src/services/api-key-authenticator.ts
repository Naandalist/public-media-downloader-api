import { createHash, timingSafeEqual } from "node:crypto";

interface ApiKeyRecord {
  readonly digest: Buffer;
  readonly identifier: string;
}

const digestApiKey = (apiKey: string) => createHash("sha256").update(apiKey, "utf8").digest();

export class ApiKeyAuthenticator {
  private readonly records: readonly ApiKeyRecord[];

  constructor(apiKeys: readonly string[]) {
    if (apiKeys.length === 0) {
      throw new Error("At least one API key is required");
    }

    this.records = apiKeys.map((apiKey) => {
      const digest = digestApiKey(apiKey);

      return Object.freeze({
        digest,
        identifier: `key_${digest.toString("hex").slice(0, 12)}`,
      });
    });
  }

  authenticate(candidate: string): string | null {
    const candidateDigest = digestApiKey(candidate);
    let matchedIdentifier: string | null = null;

    for (const record of this.records) {
      if (timingSafeEqual(candidateDigest, record.digest)) {
        matchedIdentifier = record.identifier;
      }
    }

    return matchedIdentifier;
  }
}
