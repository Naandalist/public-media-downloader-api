import { describe, expect, test } from "bun:test";

import { ApplicationError } from "../src/domain/errors";
import { MediaInfoService } from "../src/services/media-info";
import { MediaUrlValidator } from "../src/services/media-url-validator";
import type { ExtractedMediaInfo, MediaExtractor } from "../src/services/yt-dlp";

const format = (
  values: Partial<ExtractedMediaInfo["formats"][number]>,
): ExtractedMediaInfo["formats"][number] => ({
  audioBitrate: null,
  audioCodec: null,
  extension: null,
  formatId: "test-format",
  hasAudio: false,
  hasVideo: false,
  height: null,
  totalBitrate: null,
  videoBitrate: null,
  ...values,
});

const createValidator = () =>
  new MediaUrlValidator({
    addressResolver: async () => [{ address: "8.8.8.8", family: 4 }],
    redirectResolver: async () => null,
  });

const extractedVideo: ExtractedMediaInfo = {
  durationSeconds: 125.5,
  formats: [
    format({ formatId: "audio", hasAudio: true }),
    format({ formatId: "video-1080", hasVideo: true, height: 1_080 }),
    format({ formatId: "video-720", hasVideo: true, height: 720 }),
    format({ formatId: "video-360", hasVideo: true, height: 360 }),
    format({ formatId: "video-144", hasVideo: true, height: 144 }),
  ],
  isPlaylist: false,
  thumbnail: "https://images.example/owned-video.jpg",
  title: "Owned test video",
};

const extractorReturning = (result: ExtractedMediaInfo): MediaExtractor => ({
  extract: async () => result,
});

const expectApplicationError = async (
  promise: Promise<unknown>,
  expectedCode: ApplicationError["code"],
) => {
  try {
    await promise;
    throw new Error("Expected media inspection to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ApplicationError);
    expect((error as ApplicationError).code).toBe(expectedCode);
  }
};

describe("MediaInfoService", () => {
  test("normalizes platform, modes, qualities, duration, and thumbnail", async () => {
    const service = new MediaInfoService(
      createValidator(),
      extractorReturning(extractedVideo),
      1_800,
    );

    await expect(service.inspect("https://www.youtube.com/watch?v=owned")).resolves.toEqual({
      durationSeconds: 125.5,
      isPlaylist: false,
      modes: ["video_audio", "video_only", "audio_only"],
      platform: "youtube",
      qualities: ["best", "720p", "480p", "180p"],
      thumbnail: "https://images.example/owned-video.jpg",
      title: "Owned test video",
    });
  });

  test("returns only audio mode and best quality for audio-only media", async () => {
    const service = new MediaInfoService(
      createValidator(),
      extractorReturning({
        durationSeconds: null,
        formats: [format({ hasAudio: true })],
        isPlaylist: false,
        title: "Owned audio",
      }),
      1_800,
    );

    await expect(service.inspect("https://x.com/user/status/1")).resolves.toMatchObject({
      durationSeconds: null,
      modes: ["audio_only"],
      platform: "twitter",
      qualities: ["best"],
    });
  });

  test("returns only video mode when audio is unavailable", async () => {
    const service = new MediaInfoService(
      createValidator(),
      extractorReturning({
        durationSeconds: 30,
        formats: [format({ hasVideo: true, height: 480 })],
        isPlaylist: false,
        title: "Silent owned video",
      }),
      1_800,
    );

    await expect(service.inspect("https://www.tiktok.com/@user/video/1")).resolves.toMatchObject({
      modes: ["video_only"],
      platform: "tiktok",
      qualities: ["best", "720p", "480p"],
    });
  });

  test("rejects media over the configured duration", async () => {
    const service = new MediaInfoService(
      createValidator(),
      extractorReturning({ ...extractedVideo, durationSeconds: 1_801 }),
      1_800,
    );

    await expectApplicationError(
      service.inspect("https://youtube.com/watch?v=owned"),
      "LIMIT_EXCEEDED",
    );
  });

  test("rejects extractor output without playable streams", async () => {
    const service = new MediaInfoService(
      createValidator(),
      extractorReturning({
        ...extractedVideo,
        formats: [format({})],
      }),
      1_800,
    );

    await expectApplicationError(
      service.inspect("https://youtube.com/watch?v=owned"),
      "DOWNLOAD_FAILED",
    );
  });

  test("maps unsupported and unsafe URLs to public request errors", async () => {
    const service = new MediaInfoService(
      createValidator(),
      extractorReturning(extractedVideo),
      1_800,
    );

    await expectApplicationError(
      service.inspect("https://attacker.example/video"),
      "UNSUPPORTED_URL",
    );
    await expectApplicationError(
      service.inspect("http://youtube.com/watch?v=owned"),
      "INVALID_REQUEST",
    );
  });
});
