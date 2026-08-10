# Media Downloader

Planned Bun + Hono backend and web interface for downloading publicly accessible media from YouTube, X/Twitter, Facebook, TikTok, and Instagram.

> Status: early implementation. Workflow Steps 1–8 are complete, including authenticated media
> inspection. Downloading and post-processing are not implemented yet. See [PLAN.md](./PLAN.md) for
> the implementation contract and [WORKFLOW.md](./WORKFLOW.md) for progress.

## Planned capabilities

- Download best/original video with audio by default.
- Download video without audio.
- Download original/best audio without video.
- Select `720p`, `480p`, or `180p`, with `best` as default.
- Fall back to the closest lower resolution when an exact height is unavailable.
- Optionally remove unnecessary metadata while preserving a valid, playable file.
- Return the completed file directly over HTTP.
- Provide a versioned REST API and responsive web interface.
- Run locally or as a non-root Docker container on a VPS.

## Technology

- [Bun](https://bun.sh/) — runtime, package manager, and test runner.
- [Hono](https://hono.dev/) — HTTP application framework.
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — public-media extraction and downloading.
- [FFmpeg](https://ffmpeg.org/) — stream merging and safe metadata removal.

## How downloads will work

```text
client request
  -> authenticate and validate URL/options
  -> inspect media with yt-dlp
  -> download into an isolated temporary directory
  -> merge streams when required
  -> optionally remove metadata and validate with ffprobe
  -> stream file as an HTTP attachment
  -> delete temporary files
```

Cloudinary or permanent object storage is not required for this direct-response design. Temporary local disk is still necessary because many services publish video and audio separately, and sanitized output must be completed and validated before delivery. Private object storage may be added later for async jobs, retries, shared multi-instance delivery, or caching.

## Planned REST API

Base path: `/api/v1`

### Inspect a URL

```http
POST /api/v1/info
X-API-Key: local-development-key
Content-Type: application/json

{
  "url": "https://example.com/public-media"
}
```

Normalized response:

```json
{
  "title": "Owned media",
  "durationSeconds": 125.5,
  "platform": "youtube",
  "thumbnail": "https://example.com/thumbnail.jpg",
  "isPlaylist": false,
  "qualities": ["best", "720p", "480p", "180p"],
  "modes": ["video_audio", "video_only", "audio_only"]
}
```

The endpoint never returns raw extractor formats, signed stream URLs, cookies, or extractor output.

### Download media

```http
POST /api/v1/download
X-API-Key: local-development-key
Content-Type: application/json

{
  "url": "https://example.com/public-media",
  "mode": "video_audio",
  "quality": "best",
  "stripMetadata": false
}
```

Options:

| Property        | Default       | Values                                    |
| --------------- | ------------- | ----------------------------------------- |
| `mode`          | `video_audio` | `video_audio`, `video_only`, `audio_only` |
| `quality`       | `best`        | `best`, `720p`, `480p`, `180p`            |
| `stripMetadata` | `false`       | `true`, `false`                           |

`quality` is ignored for audio-only downloads. Audio keeps its best original source codec/container; MP3 conversion is not part of the initial scope.

On success, the download endpoint returns a media attachment. It does not return a permanent public URL.

### Authentication

Every `/api/v1` endpoint requires an `X-API-Key` header. `/health` and `/ready` remain
unauthenticated for process monitoring. Missing or invalid keys return `401 UNAUTHORIZED` without
exposing configured credentials. Multiple comma-separated keys support rotation through `API_KEYS`.

## Metadata removal

The optional sanitizer removes nonessential container metadata, tags, comments, chapters, embedded artwork, and image metadata where supported. It preserves media streams and container data required for playback.

It does **not** modify file magic bytes, spoof formats, remove visible watermarks, defeat media fingerprinting, or guarantee anonymity. Unsupported sanitization must fail rather than return a corrupt file.

## Initial operational limits

Planned defaults, configurable through environment variables:

| Limit                    | Default    |
| ------------------------ | ---------- |
| Concurrent jobs          | 2          |
| Media duration           | 30 minutes |
| Output size              | 1 GiB      |
| Job timeout              | 15 minutes |
| Stale temporary file age | 1 hour     |

Playlists and private/login-required media are excluded from the MVP.

## Security model

The local API will initially use `X-API-Key`. VPS deployment must add TLS, per-key/IP rate limiting, strict supported-domain validation, private-network blocking, bounded subprocess execution, and container resource limits.

Accepted input URLs must use HTTPS and belong to an explicit YouTube, X/Twitter, Facebook, TikTok,
or Instagram hostname. Validation rejects credentials, custom ports, deceptive lookalike domains,
playlists, DNS results containing private/special-use addresses, unsafe redirect destinations,
redirect loops, and excessive redirects.

External tools run without a shell and receive internally generated argument arrays. The process
runner bounds stdout/stderr memory, enforces timeouts and cancellation, terminates detached process
groups, and returns typed generic failures that omit commands, URLs, output, paths, and secrets.

A permanent API key must not be embedded in a published Android APK because app secrets can be extracted. Android production should use user/device authentication and short-lived backend-issued tokens. Google Play Integrity can be an additional abuse signal.

## Android and public-release note

Users must download only content they own or have permission to copy. Public visibility does not automatically grant download or redistribution rights.

Before publishing an Android client, review platform terms and Google Play policy. Google Play lists apps that enable unauthorized local copies of copyrighted media as an intellectual-property policy concern:

- [Google Play intellectual-property policy](https://support.google.com/googleplay/android-developer/answer/9888072)
- [YouTube API Services Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service)

Public release also needs a Privacy Policy, Terms of Service, abuse controls, and a takedown/contact process.

## Development status

Requirements: Bun 1.3 or newer.

```bash
bun install
cp .env.example .env
# Replace API_KEYS in .env with: openssl rand -hex 32
bun run dev
```

Configuration is validated once during startup. The server refuses to start when a required value
is missing or invalid. `API_KEYS` accepts a comma-separated list of keys; every key must contain at
least 32 characters. See [.env.example](./.env.example) for defaults and supported variables.

Current foundation endpoints:

| Endpoint      | Purpose                                        |
| ------------- | ---------------------------------------------- |
| `GET /health` | Process liveness; returns `{ "status": "ok" }` |
| `GET /ready`  | Temporary-directory and media-tool readiness   |
| `GET /api/v1` | Versioned API identity                         |

`/ready` returns `503` until `yt-dlp`, `ffmpeg`, and `ffprobe` are installed and the configured
temporary directory is writable. Useful commands:

Startup emits one safe JSON dependency diagnostic containing only availability labels. Media routes
return `503 SERVICE_NOT_READY` with `Retry-After` while any required tool or temporary storage is
unavailable; `/health` remains available for liveness monitoring.

```bash
bun run dev       # Start with file watching
bun run start     # Start without file watching
bun run typecheck # Run strict TypeScript checks
bun run lint      # Check code with ESLint
bun run lint:fix  # Apply safe ESLint fixes
bun run format    # Format supported files with Prettier
bun run format:check # Verify formatting without changing files
bun test          # Run tests
bun run check     # Run type-check, lint, format check, and tests
```

Remaining implementation order:

1. Typed configuration, application middleware, and health routes.
2. Safe URL inspection and normalized media info.
3. Download modes, quality selection, streaming, and cleanup.
4. Metadata sanitization and validation.
5. Web interface, authentication, rate limiting, tests, Docker, and deployment hardening.

Detailed requirements, API errors, security rules, test strategy, and completion criteria live in [PLAN.md](./PLAN.md). Follow [WORKFLOW.md](./WORKFLOW.md) during implementation and mark steps complete only after their verification gates pass.
