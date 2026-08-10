import type { MediaPlatform } from "../services/media-url-validator";

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
