import { describe, expect, test } from "bun:test";

import { ApplicationError } from "../src/domain/errors";
import type { DownloadMode, MediaQuality } from "../src/domain/media";
import { FormatSelector } from "../src/services/format-selector";
import type { ExtractedFormat } from "../src/services/yt-dlp";

const format = (values: Partial<ExtractedFormat>): ExtractedFormat => ({
  audioBitrate: null,
  audioCodec: null,
  extension: null,
  formatId: "format",
  hasAudio: false,
  hasVideo: false,
  height: null,
  totalBitrate: null,
  videoBitrate: null,
  ...values,
});

const formats: readonly ExtractedFormat[] = [
  format({
    audioBitrate: 128,
    audioCodec: "opus",
    extension: "webm",
    formatId: "audio-webm",
    hasAudio: true,
  }),
  format({
    audioBitrate: 96,
    audioCodec: "aac",
    extension: "m4a",
    formatId: "audio-m4a",
    hasAudio: true,
  }),
  format({ formatId: "video-1080", hasVideo: true, height: 1_080, videoBitrate: 4_000 }),
  format({ formatId: "video-720", hasVideo: true, height: 720, videoBitrate: 2_500 }),
  format({ formatId: "video-360", hasVideo: true, height: 360, videoBitrate: 1_000 }),
  format({ formatId: "video-144", hasVideo: true, height: 144, videoBitrate: 300 }),
];

const expectedVideo: Readonly<Record<MediaQuality, readonly [string, number]>> = {
  best: ["video-1080", 1_080],
  "720p": ["video-720", 720],
  "480p": ["video-360", 360],
  "180p": ["video-144", 144],
};

describe("FormatSelector", () => {
  const selector = new FormatSelector();

  test.each(["best", "720p", "480p", "180p"] as const)(
    "selects video with audio for %s quality",
    (quality) => {
      const [videoId, height] = expectedVideo[quality];
      const result = selector.select(formats, "video_audio", quality);

      expect(result.selector).toBe(`${videoId}+audio-webm`);
      expect(result.selectedVideoHeight).toBe(height);
      expect(result.requiresMerge).toBe(true);
      expect(result.includesAudio).toBe(true);
      expect(result.includesVideo).toBe(true);
    },
  );

  test.each(["best", "720p", "480p", "180p"] as const)(
    "selects video without audio for %s quality",
    (quality) => {
      const [videoId, height] = expectedVideo[quality];
      const result = selector.select(formats, "video_only", quality);

      expect(result.selector).toBe(videoId);
      expect(result.selectedVideoHeight).toBe(height);
      expect(result.includesAudio).toBe(false);
      expect(result.includesVideo).toBe(true);
      expect(result.requiresAudioRemoval).toBe(false);
    },
  );

  test.each(["best", "720p", "480p", "180p"] as const)(
    "ignores %s quality and preserves original audio",
    (quality) => {
      const result = selector.select(formats, "audio_only", quality);

      expect(result.selector).toBe("audio-webm");
      expect(result.includesAudio).toBe(true);
      expect(result.includesVideo).toBe(false);
      expect(result.preserveAudioSource).toBe(true);
      expect(result.audioSource).toEqual({
        codec: "opus",
        extension: "webm",
        mimeType: "audio/webm",
      });
    },
  );

  test("prefers exact height, then closest lower height, and never upscales", () => {
    expect(selector.select(formats, "video_only", "720p").selectedVideoHeight).toBe(720);
    expect(selector.select(formats, "video_only", "480p").selectedVideoHeight).toBe(360);

    expect(() =>
      selector.select(
        [format({ formatId: "video-360", hasVideo: true, height: 360 })],
        "video_only",
        "180p",
      ),
    ).toThrow(ApplicationError);

    try {
      selector.select(
        [format({ formatId: "video-360", hasVideo: true, height: 360 })],
        "video_only",
        "180p",
      );
    } catch (error) {
      expect((error as ApplicationError).code).toBe("QUALITY_UNAVAILABLE");
      expect((error as ApplicationError).status).toBe(422);
    }
  });

  test("allows unknown video height only for best quality", () => {
    const unknownHeight = format({
      formatId: "unknown-height",
      hasVideo: true,
      videoBitrate: 500,
    });

    expect(selector.select([unknownHeight], "video_only", "best").selector).toBe("unknown-height");
    expect(() => selector.select([unknownHeight], "video_only", "720p")).toThrow(ApplicationError);
  });

  test("marks audio or video removal when only a combined source exists", () => {
    const combined = format({
      audioCodec: "aac",
      extension: "mp4",
      formatId: "combined-720",
      hasAudio: true,
      hasVideo: true,
      height: 720,
    });

    expect(selector.select([combined], "video_only", "best")).toMatchObject({
      includesAudio: false,
      requiresAudioRemoval: true,
      selector: "combined-720",
    });
    expect(selector.select([combined], "audio_only", "best")).toMatchObject({
      includesVideo: false,
      requiresVideoRemoval: true,
      selector: "combined-720",
    });
  });

  test("rejects raw mode, quality, and unsafe extractor selectors", () => {
    expect(() => selector.select(formats, "bestvideo" as DownloadMode, "best")).toThrow();
    expect(() => selector.select(formats, "video_only", "1080p" as MediaQuality)).toThrow();
    expect(() =>
      selector.select(
        [format({ formatId: "video+audio", hasVideo: true, height: 720 })],
        "video_only",
        "best",
      ),
    ).toThrow(ApplicationError);
  });
});
