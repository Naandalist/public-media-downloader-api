import { ApplicationError } from "../domain/errors";
import type {
  DownloadMode,
  MediaInfoInspector,
  MediaQuality,
  PublicMediaInfo,
} from "../domain/media";
import { MediaUrlValidator, UrlValidationError } from "./media-url-validator";
import type { MediaExtractor } from "./yt-dlp";

const selectableHeights = [720, 480, 180] as const;

const qualityForHeight = (height: (typeof selectableHeights)[number]): MediaQuality => `${height}p`;

export class MediaInfoService implements MediaInfoInspector {
  constructor(
    private readonly urlValidator: MediaUrlValidator,
    private readonly extractor: MediaExtractor,
    private readonly maximumDurationSeconds: number,
  ) {}

  async inspect(inputUrl: string, signal?: AbortSignal): Promise<PublicMediaInfo> {
    let validatedUrl: Awaited<ReturnType<MediaUrlValidator["validate"]>>;

    try {
      validatedUrl = await this.urlValidator.validate(inputUrl);
    } catch (error) {
      if (error instanceof UrlValidationError) {
        if (error.code === "UNSUPPORTED_URL") {
          throw new ApplicationError("UNSUPPORTED_URL", 400, error.message);
        }

        throw new ApplicationError("INVALID_REQUEST", 400, error.message);
      }

      throw error;
    }

    const extracted = await this.extractor.extract(validatedUrl.url, signal);

    if (
      extracted.durationSeconds !== null &&
      extracted.durationSeconds > this.maximumDurationSeconds
    ) {
      throw new ApplicationError(
        "LIMIT_EXCEEDED",
        413,
        `Media duration exceeds the ${this.maximumDurationSeconds}-second limit.`,
      );
    }

    const videoFormats = extracted.formats.filter((format) => format.hasVideo);
    const hasVideo = videoFormats.length > 0;
    const hasAudio = extracted.formats.some((format) => format.hasAudio);

    if (!hasVideo && !hasAudio) {
      throw new ApplicationError(
        "DOWNLOAD_FAILED",
        502,
        "The media extractor returned no playable streams.",
      );
    }

    const modes: DownloadMode[] = [];

    if (hasVideo && hasAudio) {
      modes.push("video_audio");
    }

    if (hasVideo) {
      modes.push("video_only");
    }

    if (hasAudio) {
      modes.push("audio_only");
    }

    const videoHeights = videoFormats
      .map((format) => format.height)
      .filter((height): height is number => height !== null);
    const qualities: MediaQuality[] = ["best"];

    for (const height of selectableHeights) {
      if (videoHeights.some((availableHeight) => availableHeight <= height)) {
        qualities.push(qualityForHeight(height));
      }
    }

    return Object.freeze({
      durationSeconds: extracted.durationSeconds,
      isPlaylist: false as const,
      modes: Object.freeze(modes),
      platform: validatedUrl.platform,
      qualities: Object.freeze(qualities),
      ...(extracted.thumbnail === undefined ? {} : { thumbnail: extracted.thumbnail }),
      title: extracted.title,
    });
  }
}
