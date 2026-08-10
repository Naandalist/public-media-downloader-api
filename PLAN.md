# Media Downloader Backend — Implementation Plan

## 1. Goal

Build a Bun and Hono service that downloads publicly accessible media from:

- YouTube
- X/Twitter
- Facebook
- TikTok
- Instagram

The service exposes a versioned REST API and a simple web interface. Downloads are returned directly to the client. Files exist only in an isolated temporary directory while `yt-dlp` and `ffmpeg` download, merge, select streams, or remove metadata.

This plan covers public media only. Private posts, authenticated sessions, DRM bypass, cookies, and account scraping are out of scope.

## 2. Confirmed product decisions

| Area                  | Decision                                                        |
| --------------------- | --------------------------------------------------------------- |
| Runtime               | Bun                                                             |
| HTTP framework        | Hono                                                            |
| Download engine       | `yt-dlp`                                                        |
| Media processing      | `ffmpeg` and `ffprobe`                                          |
| Delivery              | Direct HTTP download response                                   |
| Persistent storage    | None for MVP                                                    |
| Temporary storage     | Per-job directory on local ephemeral disk                       |
| Default mode          | Best/original video with audio                                  |
| Other modes           | Video only; audio only                                          |
| Quality choices       | Best, 720p, 480p, 180p                                          |
| Missing exact quality | Select closest available quality at or below request            |
| Audio-only default    | Original/best source audio; no forced MP3 conversion            |
| Metadata removal      | Optional; preserve valid/playable media                         |
| Access                | API-key protected                                               |
| Initial environment   | Local development, then Docker/VPS                              |
| UI                    | Simple server-rendered interface using same application service |
| Database              | None for MVP                                                    |

## 3. Proposed architecture

```text
Web UI / Android app / API client
                |
                v
       Hono request boundary
   auth -> validation -> rate limit
                |
                v
      Download orchestration service
      |          |             |
      v          v             v
   yt-dlp     ffprobe       ffmpeg
      |                        |
      +---- isolated temp dir -+
                |
                v
        streamed HTTP response
                |
                v
       cleanup in finally/abort
```

Keep Hono route handlers thin. Media selection, subprocess execution, cleanup, and response construction belong in services so the REST API and web interface share behavior.

### Proposed source layout

```text
src/
  index.ts
  app.ts
  config.ts
  routes/
    api.ts
    health.ts
    web.ts
  middleware/
    api-key.ts
    error-handler.ts
    rate-limit.ts
    request-id.ts
  schemas/
    download.ts
  services/
    downloader.ts
    metadata.ts
    media-info.ts
    process-runner.ts
    temp-files.ts
  domain/
    errors.ts
    media.ts
  utils/
    filenames.ts
    urls.ts
  web/
    page.ts
tests/
  unit/
  integration/
Dockerfile
compose.yaml
.dockerignore
.env.example
```

## 4. API contract

Base path: `/api/v1`

### `GET /health`

Unauthenticated liveness endpoint. Must not disclose secrets, paths, versions, or process output.

Response:

```json
{
  "status": "ok"
}
```

### `GET /ready`

Readiness endpoint. Verifies that the configured temporary directory is writable and that `yt-dlp`, `ffmpeg`, and `ffprobe` can execute.

### `POST /api/v1/info`

Reads public metadata and available formats without downloading the media.

Request:

```json
{
  "url": "https://example.com/public-media"
}
```

Response fields:

```json
{
  "title": "Example title",
  "durationSeconds": 123,
  "platform": "youtube",
  "thumbnail": "https://example.com/thumbnail.jpg",
  "qualities": ["best", "720p", "480p", "180p"],
  "modes": ["video_audio", "video_only", "audio_only"]
}
```

Unavailable or unsuitable qualities may be omitted. Do not expose raw extractor responses.

### `POST /api/v1/download`

Downloads, optionally sanitizes, and streams one file.

Headers:

```text
X-API-Key: <key>
Content-Type: application/json
```

Request:

```json
{
  "url": "https://example.com/public-media",
  "mode": "video_audio",
  "quality": "best",
  "stripMetadata": false
}
```

Fields:

| Field           | Type    | Required | Default       | Allowed values                            |
| --------------- | ------- | -------- | ------------- | ----------------------------------------- |
| `url`           | string  | yes      | —             | Supported public media URL                |
| `mode`          | string  | no       | `video_audio` | `video_audio`, `video_only`, `audio_only` |
| `quality`       | string  | no       | `best`        | `best`, `720p`, `480p`, `180p`            |
| `stripMetadata` | boolean | no       | `false`       | `true`, `false`                           |

For `audio_only`, `quality` is ignored. The original/best audio format is retained. Format conversion can be added later as a separate explicit option.

Successful response:

```text
HTTP/1.1 200 OK
Content-Type: <detected media type>
Content-Disposition: attachment; filename="<safe filename>"
Content-Length: <bytes when known>
X-Request-Id: <id>
```

Errors use JSON before response streaming starts:

```json
{
  "error": {
    "code": "UNSUPPORTED_URL",
    "message": "The URL is not supported.",
    "requestId": "..."
  }
}
```

Initial error codes:

- `INVALID_REQUEST` — `400`
- `UNAUTHORIZED` — `401`
- `UNSUPPORTED_URL` — `400`
- `MEDIA_UNAVAILABLE` — `404`
- `QUALITY_UNAVAILABLE` — `422`
- `LIMIT_EXCEEDED` — `413`
- `RATE_LIMITED` — `429`
- `DOWNLOAD_FAILED` — `502`
- `PROCESSING_FAILED` — `500`
- `SERVICE_BUSY` — `503`
- `INTERNAL_ERROR` — `500`

Once streaming begins, the server may only terminate the connection on failure. Clients must treat incomplete responses as failed downloads.

## 5. Format-selection rules

### Video with audio (`video_audio`)

- `best`: choose the best source streams and merge when necessary.
- Fixed quality: prefer a video stream at the requested height plus best compatible audio.
- If exact height is missing, choose the closest lower height.
- If no lower height exists, return `QUALITY_UNAVAILABLE`; do not silently upscale.
- Prefer stream copy during merge. Transcode only when required for a valid requested result.

### Video only (`video_only`)

- Select best or requested-height video.
- Explicitly exclude audio.
- Apply the same lower-quality fallback rule.

### Audio only (`audio_only`)

- Select the best source audio stream.
- Preserve its source codec/container by default.
- Do not label non-MP3 audio as MP3.

Selection expressions must be generated internally from enums. Never accept raw `yt-dlp` format expressions or command-line arguments from clients.

## 6. Safe metadata removal

“Strip metadata” means remove unnecessary embedded metadata while keeping the output structurally valid and playable. It never means modifying magic bytes or corrupting the file signature.

General requirements:

- Detect the actual output container with `ffprobe`.
- Write to a new file, never process in place.
- Remove global and stream metadata where supported.
- Remove chapters and attached artwork where appropriate.
- Preserve codec data, dimensions, frame rate, audio parameters, synchronization, and required container timing.
- Validate the processed output with `ffprobe` before serving it.
- If safe sanitization is unsupported for a container, fail clearly instead of returning a damaged file.

Expected behavior:

| Media                                   | Removal behavior                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| MP4/MOV/MKV/WebM                        | Remove descriptive/global metadata, comments, chapters, and unnecessary tags; stream-copy when container permits |
| MP3                                     | Remove ID3 tags and embedded artwork while retaining audio frames                                                |
| M4A/Opus/Ogg                            | Remove optional tags while retaining valid audio/container structure                                             |
| Images encountered from supported posts | Remove EXIF/XMP/IPTC; normalize orientation into pixels before removing orientation metadata                     |

Metadata stripping does not guarantee anonymity. Visible watermarks, audio fingerprints, platform-side logs, encoded pixels, codec characteristics, and network records remain outside its scope.

## 7. Temporary-file lifecycle

Each request receives a random server-generated job ID and private directory:

```text
${TEMP_DIR}/<job-id>/
```

Rules:

- Never use a client filename as a path.
- Sanitize the final download filename separately.
- Permit files only inside the resolved job directory.
- Delete the directory after success, processing failure, client disconnect, timeout, or shutdown.
- Run a startup janitor to remove stale directories left by crashes.
- Never log file contents, signed media URLs, API keys, or full query strings.
- Reject playlists in MVP; one request produces one downloadable file.

Direct response still requires temporary disk because many sites expose separate audio/video streams that must be downloaded and merged. Metadata removal also requires a complete validated output before response headers are committed.

## 8. Limits and reliability

Initial configurable defaults:

```text
MAX_CONCURRENT_JOBS=2
MAX_DURATION_SECONDS=1800
MAX_OUTPUT_BYTES=1073741824
JOB_TIMEOUT_SECONDS=900
TEMP_FILE_MAX_AGE_SECONDS=3600
```

Implementation requirements:

- Reject known over-limit duration before download.
- Enforce a byte limit while subprocess output is written; metadata may be missing or incorrect.
- Kill the whole subprocess tree on timeout or client abort.
- Bound stdout/stderr capture to avoid memory exhaustion.
- Use no shell; spawn commands with argument arrays.
- Use backpressure-aware file streaming.
- Reserve a concurrency slot for the whole download/process/stream lifecycle.
- Return `503` with `Retry-After` when capacity is exhausted.
- Track active jobs for graceful shutdown.

## 9. Security plan

### Input and network safety

- Accept only `https` URLs.
- Maintain an explicit hostname allowlist for supported platforms and their known short-link hosts.
- Reject credentials in URLs and nonstandard ports.
- Resolve redirects carefully and reject unsupported/private-network destinations.
- Block loopback, link-local, private, multicast, and metadata-service IP ranges.
- Set request, extraction, processing, and total-job timeouts.
- Never expose raw process errors to clients.

### API keys

- Read hashed API-key records or keys from environment/configuration; never commit secrets.
- Compare secrets using timing-safe comparison.
- Allow key rotation and multiple named keys later.
- Apply per-key and per-IP rate limits.
- Require TLS at the reverse proxy on VPS.
- Do not place a permanent privileged API key inside the Android app; APK secrets are extractable.

MVP local development may use one `X-API-Key`. Before public Android release, replace embedded master keys with user/device authentication and short-lived tokens. Consider Google Play Integrity as one signal, not the sole authentication mechanism.

### Legal and platform constraints

- Support only public, non-DRM media.
- Require users to download only media they own or are authorized to copy.
- Do not imply affiliation with supported platforms or use their branding without permission.
- Add Terms of Service, Privacy Policy, abuse controls, and a takedown/contact process before public deployment.
- Review each platform’s current terms and Google Play policies before launch.

Google Play specifically identifies apps that enable unauthorized local copies of copyrighted content as potential intellectual-property violations:

- <https://support.google.com/googleplay/android-developer/answer/9888072>
- <https://developers.google.com/youtube/terms/api-services-terms-of-service>

## 10. Web interface

MVP page:

- URL input.
- Media preview/info action.
- Mode selector.
- Quality selector hidden/disabled for audio-only mode.
- Metadata-removal checkbox, off by default.
- Download button.
- Visible validation, progress/waiting state, and actionable errors.
- Responsive layout suitable for phone and desktop browsers.
- No third-party analytics.

The UI must call the same domain services as the REST API. Do not duplicate download logic. For VPS deployment, protect the interface and never inject the server’s privileged API key into public HTML or JavaScript.

## 11. Docker and VPS plan

Container contents:

- Bun runtime.
- Pinned `yt-dlp` version.
- `ffmpeg` and `ffprobe`.
- Non-root application user.
- Writable mounted or ephemeral `/tmp/downloader` only.
- Read-only root filesystem where the deployment platform permits it.
- Health check against `/health`.

Deployment shape:

```text
Internet
   |
Reverse proxy (TLS, body/header/time limits)
   |
Downloader container (non-root, bounded CPU/RAM/temp disk)
```

Do not expose Bun directly to the public internet. Use Caddy, Nginx, or another TLS reverse proxy. Configure container memory, CPU, PID, and disk limits because `yt-dlp` and `ffmpeg` process untrusted remote media.

Cloudinary is not required. Add private object storage only if the product later needs async jobs, resumable/retryable delivery, shared multi-instance state, or cached downloads. Stored media needs automatic expiration and private signed access.

## 12. Observability

Use structured JSON logs in production:

- Request ID.
- API-key identifier, never the secret.
- Platform name.
- Requested mode and quality.
- Sanitization enabled/disabled.
- Timings for extraction, download, processing, and streaming.
- Result status and normalized error code.
- Byte count.

Do not log full media URLs by default because they may contain identifiers or tokens. Record metrics for active jobs, queue rejection, duration, output bytes, failures by category, and stale-file cleanup.

## 13. Testing strategy

### Unit tests

- Request schema validation.
- Host allowlist and private-network rejection.
- Format-expression generation.
- Quality fallback rules.
- Safe filename generation.
- API-key middleware.
- Error normalization.
- Temp-path containment.

### Integration tests

- Stub `yt-dlp`, `ffmpeg`, and `ffprobe` executables for deterministic success, timeout, oversized output, corrupt output, and subprocess failure cases.
- Verify response headers and streamed bytes.
- Verify cleanup after success, failure, timeout, and client abort.
- Verify metadata-free fixtures remain playable/readable.
- Verify process arguments cannot be injected.

### Optional network smoke tests

Run manually or on a scheduled private environment using small, owned test media. Do not make CI depend on third-party pages because extractors and pages change.

## 14. Delivery phases

### Phase 1 — Foundation

- Convert package to Bun/TypeScript project.
- Add Hono app, configuration validation, health routes, request IDs, and normalized errors.
- Add unit-test setup and lint/type-check scripts.
- Add Docker image and Compose configuration.

Exit criteria: app starts locally and in Docker; health/readiness work; missing configuration fails fast.

### Phase 2 — Safe media inspection

- Add URL validation and platform detection.
- Add safe subprocess runner.
- Implement `yt-dlp` info extraction.
- Implement `/api/v1/info`.

Exit criteria: supported public URLs return normalized metadata; unsupported/private-network inputs are rejected.

### Phase 3 — Download modes

- Implement isolated job directories.
- Implement all three modes and quality rules.
- Add limits, concurrency control, abort handling, direct streaming, and guaranteed cleanup.
- Implement `/api/v1/download`.

Exit criteria: fixtures cover best/fixed-quality video+audio, video-only, and original audio-only downloads.

### Phase 4 — Metadata sanitization

- Detect containers with `ffprobe`.
- Implement per-container safe cleanup.
- Validate processed outputs before delivery.
- Add sanitized fixture tests.

Exit criteria: supported outputs remain valid and optional metadata is absent; unsupported sanitization fails safely.

### Phase 5 — Interface and hardening

- Build responsive web interface.
- Add API-key middleware and rate limiting.
- Add structured logs, readiness checks, stale-file janitor, graceful shutdown, and security headers.
- Document local, Docker, and VPS operation.

Exit criteria: end-to-end browser and API flows work; security and cleanup tests pass.

### Phase 6 — Public/API product readiness

- Replace master mobile key with user/device authentication and short-lived tokens.
- Add distributed rate limiting if running multiple instances.
- Add Terms, Privacy Policy, abuse handling, and operational monitoring.
- Review platform and Play Store policy compliance.
- Decide whether async jobs/object storage are justified by real usage.

## 15. Definition of done for MVP

- Bun/Hono service runs locally and through Docker.
- Public URLs from all five target platforms are recognized.
- Default, fixed-quality, video-only, and audio-only modes work.
- Optional metadata removal produces valid verified output.
- Files stream as attachments and temporary data is always cleaned.
- API-key, allowlist, limits, rate limiting, request IDs, and safe errors are active.
- Web interface and REST API share one implementation.
- Unit and integration tests pass.
- README matches the implemented commands and API behavior.
