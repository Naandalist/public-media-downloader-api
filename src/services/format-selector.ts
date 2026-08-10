import { z } from "zod";

import { ApplicationError } from "../domain/errors";
import {
  DOWNLOAD_MODES,
  MEDIA_QUALITIES,
  type DownloadMode,
  type MediaQuality,
} from "../domain/media";
import type { ExtractedFormat } from "./yt-dlp";

const downloadModeSchema = z.enum(DOWNLOAD_MODES);
const mediaQualitySchema = z.enum(MEDIA_QUALITIES);
const safeFormatIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

const requestedHeights: Readonly<Record<Exclude<MediaQuality, "best">, number>> = {
  "180p": 180,
  "480p": 480,
  "720p": 720,
};

const audioMimeTypes: Readonly<Record<string, string>> = {
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mka: "audio/x-matroska",
  mp3: "audio/mpeg",
  mp4: "audio/mp4",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  weba: "audio/webm",
  webm: "audio/webm",
};

export interface SelectedAudioSource {
  readonly codec: string | null;
  readonly extension: string | null;
  readonly mimeType: string | null;
}

export interface FormatSelection {
  readonly audioSource: SelectedAudioSource | null;
  readonly includesAudio: boolean;
  readonly includesVideo: boolean;
  readonly knownOutputBytes: number | null;
  readonly mode: DownloadMode;
  readonly preserveAudioSource: boolean;
  readonly quality: MediaQuality;
  readonly requiresAudioRemoval: boolean;
  readonly requiresMerge: boolean;
  readonly requiresVideoRemoval: boolean;
  readonly selectedVideoHeight: number | null;
  readonly selector: string;
}

const audioBitrate = (format: ExtractedFormat) => format.audioBitrate ?? format.totalBitrate ?? 0;

const videoBitrate = (format: ExtractedFormat) => format.videoBitrate ?? format.totalBitrate ?? 0;

const bestByBitrate = (formats: readonly ExtractedFormat[]) =>
  formats.toSorted((left, right) => audioBitrate(right) - audioBitrate(left))[0];

const selectVideo = (
  formats: readonly ExtractedFormat[],
  quality: MediaQuality,
): ExtractedFormat | undefined => {
  const videos = formats.filter((format) => format.hasVideo);

  if (quality === "best") {
    return videos.toSorted(
      (left, right) =>
        (right.height ?? 0) - (left.height ?? 0) || videoBitrate(right) - videoBitrate(left),
    )[0];
  }

  const requestedHeight = requestedHeights[quality];
  const eligible = videos.filter(
    (format) => format.height !== null && format.height <= requestedHeight,
  );
  const selectedHeight = Math.max(...eligible.map((format) => format.height ?? 0));

  return eligible
    .filter((format) => format.height === selectedHeight)
    .toSorted((left, right) => videoBitrate(right) - videoBitrate(left))[0];
};

const unavailable = () =>
  new ApplicationError(
    "QUALITY_UNAVAILABLE",
    422,
    "No suitable media stream is available at or below the requested quality.",
  );

const assertSafeFormat = (format: ExtractedFormat | undefined): ExtractedFormat => {
  if (format === undefined || !safeFormatIdPattern.test(format.formatId)) {
    throw unavailable();
  }

  return format;
};

const audioSourceFor = (format: ExtractedFormat): SelectedAudioSource => ({
  codec: format.audioCodec,
  extension: format.extension,
  mimeType: format.extension === null ? null : (audioMimeTypes[format.extension] ?? null),
});

const combinedSize = (...formats: readonly ExtractedFormat[]): number | null => {
  if (formats.some((format) => format.fileSizeBytes === null)) {
    return null;
  }

  const total = formats.reduce((sum, format) => sum + (format.fileSizeBytes ?? 0), 0);
  return Number.isSafeInteger(total) ? total : null;
};

export class FormatSelector {
  select(
    formats: readonly ExtractedFormat[],
    inputMode: DownloadMode,
    inputQuality: MediaQuality,
  ): FormatSelection {
    const mode = downloadModeSchema.parse(inputMode);
    const quality = mediaQualitySchema.parse(inputQuality);
    const audioOnlyFormats = formats.filter((format) => format.hasAudio && !format.hasVideo);
    const bestAudio = bestByBitrate(audioOnlyFormats);

    if (mode === "audio_only") {
      const audio = assertSafeFormat(
        bestAudio ?? bestByBitrate(formats.filter((format) => format.hasAudio)),
      );

      return Object.freeze({
        audioSource: Object.freeze(audioSourceFor(audio)),
        includesAudio: true,
        includesVideo: false,
        knownOutputBytes: combinedSize(audio),
        mode,
        preserveAudioSource: true,
        quality,
        requiresAudioRemoval: false,
        requiresMerge: false,
        requiresVideoRemoval: audio.hasVideo,
        selectedVideoHeight: null,
        selector: audio.formatId,
      });
    }

    const allVideo = assertSafeFormat(selectVideo(formats, quality));
    const videoOnly = selectVideo(
      formats.filter((format) => !format.hasAudio),
      quality,
    );
    const combinedVideo = selectVideo(
      formats.filter((format) => format.hasAudio),
      quality,
    );

    if (mode === "video_only") {
      const video = assertSafeFormat(videoOnly?.height === allVideo.height ? videoOnly : allVideo);

      return Object.freeze({
        audioSource: null,
        includesAudio: false,
        includesVideo: true,
        knownOutputBytes: combinedSize(video),
        mode,
        preserveAudioSource: false,
        quality,
        requiresAudioRemoval: video.hasAudio,
        requiresMerge: false,
        requiresVideoRemoval: false,
        selectedVideoHeight: video.height,
        selector: video.formatId,
      });
    }

    if (
      bestAudio !== undefined &&
      videoOnly !== undefined &&
      (combinedVideo === undefined || (videoOnly.height ?? 0) >= (combinedVideo.height ?? 0))
    ) {
      const video = assertSafeFormat(videoOnly);
      const audio = assertSafeFormat(bestAudio);

      return Object.freeze({
        audioSource: Object.freeze(audioSourceFor(audio)),
        includesAudio: true,
        includesVideo: true,
        knownOutputBytes: combinedSize(video, audio),
        mode,
        preserveAudioSource: true,
        quality,
        requiresAudioRemoval: false,
        requiresMerge: true,
        requiresVideoRemoval: false,
        selectedVideoHeight: video.height,
        selector: `${video.formatId}+${audio.formatId}`,
      });
    }

    if (combinedVideo === undefined) {
      throw unavailable();
    }

    const combined = assertSafeFormat(combinedVideo);

    return Object.freeze({
      audioSource: Object.freeze(audioSourceFor(combined)),
      includesAudio: true,
      includesVideo: true,
      knownOutputBytes: combinedSize(combined),
      mode,
      preserveAudioSource: true,
      quality,
      requiresAudioRemoval: false,
      requiresMerge: false,
      requiresVideoRemoval: false,
      selectedVideoHeight: combined.height,
      selector: combined.formatId,
    });
  }
}
