import type { MediaPlatform } from "../services/media-url-validator";
import type { ExtractedMediaInfo } from "../services/yt-dlp";

export const DOWNLOAD_MODES = ["video_audio", "video_only", "audio_only"] as const;
export const MEDIA_QUALITIES = ["best", "720p", "480p", "180p"] as const;

export type DownloadMode = (typeof DOWNLOAD_MODES)[number];
export type MediaQuality = (typeof MEDIA_QUALITIES)[number];

export interface PublicMediaInfo {
  readonly durationSeconds: number | null;
  readonly isPlaylist: false;
  readonly modes: readonly DownloadMode[];
  readonly platform: MediaPlatform;
  readonly qualities: readonly MediaQuality[];
  readonly thumbnail?: string;
  readonly title: string;
}

export interface MediaInfoInspector {
  inspect(url: string, signal?: AbortSignal): Promise<PublicMediaInfo>;
}

export interface InspectedMediaSource {
  readonly extracted: ExtractedMediaInfo;
  readonly platform: MediaPlatform;
  readonly url: string;
}

export interface MediaSourceInspector {
  inspectSource(url: string, signal?: AbortSignal): Promise<InspectedMediaSource>;
}

export interface MediaDownloadRequest {
  readonly mode: DownloadMode;
  readonly quality: MediaQuality;
  readonly stripMetadata: boolean;
  readonly url: string;
}

export interface PreparedMediaDownload {
  readonly extension: string;
  readonly filePath: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly title: string;
  cleanup(): Promise<void>;
}

export interface MediaDownloader {
  prepare(
    request: MediaDownloadRequest,
    context: import("../services/job-limiter").JobContext,
  ): Promise<PreparedMediaDownload>;
}
