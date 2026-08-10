import type { MediaPlatform } from "../services/media-url-validator";

export type DownloadMode = "audio_only" | "video_audio" | "video_only";
export type MediaQuality = "180p" | "480p" | "720p" | "best";

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
