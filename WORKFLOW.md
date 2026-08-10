# Media Downloader — Step-by-Step Workflow

This document converts [PLAN.md](./PLAN.md) into an ordered implementation workflow. Complete each step and its verification gate before moving forward.

## Progress legend

- `[ ]` Not started
- `[-]` In progress
- `[x]` Completed and verified

## Step 1 — Initialize Bun and TypeScript

- [x] Confirm Bun is installed with `bun --version`.
- [x] Convert `package.json` from the placeholder CommonJS setup to a private ES module package.
- [x] Add Hono and the chosen schema-validation library.
- [x] Add TypeScript configuration with strict type checking.
- [x] Create `src/index.ts` and `src/app.ts`.
- [x] Add scripts for development, start, type-check, and test.
- [x] Add `.gitignore` entries for dependencies, environment files, build output, coverage, logs, and temporary media.

Verification gate:

```bash
bun install
bun run typecheck
bun test
bun run dev
```

Expected result: Hono starts without type errors and returns a basic response.

## Step 2 — Add typed configuration

- [x] Create `src/config.ts`.
- [x] Read configuration only once during startup.
- [x] Validate required environment variables before accepting traffic.
- [x] Add `.env.example` with safe placeholder values.
- [x] Keep real API keys and secrets out of source control.

Initial configuration:

```dotenv
PORT=3000
HOST=0.0.0.0
API_KEYS=replace-with-a-long-random-key
TEMP_DIR=/tmp/downloader
MAX_CONCURRENT_JOBS=2
MAX_DURATION_SECONDS=1800
MAX_OUTPUT_BYTES=1073741824
JOB_TIMEOUT_SECONDS=900
TEMP_FILE_MAX_AGE_SECONDS=3600
LOG_LEVEL=info
```

Verification gate:

- [x] Application fails fast with a clear message when required configuration is missing.
- [x] Application starts with valid configuration.
- [x] Logs never print API-key values.

## Step 3 — Establish the Hono application boundary

- [x] Add `GET /health` for liveness.
- [x] Add `GET /ready` for dependency and temporary-directory readiness.
- [x] Add request-ID middleware.
- [x] Add security headers.
- [x] Add a central error handler.
- [x] Add a not-found response.
- [x] Mount API routes under `/api/v1`.
- [x] Keep process startup separate from app construction so tests can import the app.

Verification gate:

- [x] `/health` returns `200` and `{ "status": "ok" }`.
- [x] Unknown routes return normalized JSON errors.
- [x] Every response contains `X-Request-Id`.
- [x] Unexpected errors do not expose stack traces or local paths.

## Step 4 — Implement API-key authentication

- [x] Read one or more keys from configuration.
- [x] Require `X-API-Key` on `/api/v1/*`.
- [x] Compare keys with timing-safe logic.
- [x] Return `401 UNAUTHORIZED` for missing or invalid keys.
- [x] Identify keys by safe labels in logs, never by secret value.
- [x] Leave `/health` available without authentication.
- [x] Decide whether `/ready` remains private or is restricted by the reverse proxy.

Verification gate:

```bash
curl http://localhost:3000/api/v1/info
curl -H 'X-API-Key: invalid' http://localhost:3000/api/v1/info
```

Expected result: both requests fail with normalized `401` responses.

## Step 5 — Validate URLs and block SSRF

- [x] Accept only absolute `https` URLs.
- [x] Reject URLs containing usernames, passwords, or nonstandard ports.
- [x] Add an explicit allowlist for supported public platform hosts.
- [x] Include required official short-link hosts such as `youtu.be` and `vm.tiktok.com`.
- [x] Normalize hostnames before comparison.
- [x] Reject loopback, private, link-local, multicast, and cloud metadata IP ranges.
- [x] Validate redirect destinations.
- [x] Reject unsupported domains before launching `yt-dlp`.
- [x] Reject playlists for MVP.

Verification gate:

- [x] Supported public URLs pass.
- [x] `http://` URLs fail.
- [x] Localhost, private IP, encoded IP, credential-bearing, and malicious redirect cases fail.
- [x] Similar-looking attacker domains fail.

## Step 6 — Build a safe subprocess runner

- [x] Use Bun subprocess APIs with argument arrays.
- [x] Never concatenate client input into a shell command.
- [x] Disable shell execution.
- [x] Capture stdout and stderr with strict memory bounds.
- [x] Apply a timeout to every process.
- [x] Terminate the entire subprocess tree on timeout, abort, or shutdown.
- [x] Convert exit failures into internal typed errors.
- [x] Redact URLs, tokens, paths, and secrets from logs and client errors.

Verification gate:

- [x] Arguments containing shell metacharacters remain inert data.
- [x] Hanging fake processes are killed after timeout.
- [x] Large stderr output cannot exhaust application memory.
- [x] Client responses contain normalized errors, not raw process output.

## Step 7 — Check required media tools

- [x] Verify `yt-dlp --version` during readiness checks.
- [x] Verify `ffmpeg -version` during readiness checks.
- [x] Verify `ffprobe -version` during readiness checks.
- [x] Do not accept download traffic when a required executable is unavailable.
- [x] Log safe dependency diagnostics during startup.

Verification gate:

- [x] `/ready` returns `200` when all dependencies work.
- [x] `/ready` returns `503` when any dependency is unavailable.
- [x] `/health` remains `200` while the process itself is alive.

## Step 8 — Implement media inspection

- [ ] Create a `yt-dlp` adapter returning parsed JSON.
- [ ] Reject raw/unexpected extractor output.
- [ ] Normalize title, duration, platform, thumbnail, playlist state, and available formats.
- [ ] Enforce the 30-minute duration limit when duration is known.
- [ ] Map available streams to supported quality options.
- [ ] Create `POST /api/v1/info`.
- [ ] Return only the normalized public response shape.

Request:

```json
{
  "url": "https://example.com/public-media"
}
```

Verification gate:

- [ ] Valid fixtures return normalized metadata.
- [ ] Private, deleted, unavailable, and playlist fixtures return correct errors.
- [ ] Over-duration media returns `LIMIT_EXCEEDED`.
- [ ] Raw extractor fields and signed media URLs are not leaked.

## Step 9 — Add isolated temporary-job storage

- [ ] Generate a cryptographically random job ID.
- [ ] Create one private directory per job under `TEMP_DIR`.
- [ ] Verify all resolved job paths remain inside that directory.
- [ ] Never use a client-controlled filename as a path.
- [ ] Register cleanup immediately after directory creation.
- [ ] Clean after success, error, timeout, client abort, and shutdown.
- [ ] Add startup cleanup for stale job directories.
- [ ] Prevent symlink/path traversal attacks.

Verification gate:

- [ ] Parallel jobs use different directories.
- [ ] Cleanup tests pass for every exit path.
- [ ] Attempts to escape the job directory fail.
- [ ] Stale directories older than the configured age are removed at startup.

## Step 10 — Implement format selection

- [ ] Define typed enums for mode and quality.
- [ ] Generate internal `yt-dlp` format selectors from those enums.
- [ ] Never accept raw format expressions from API clients.

Mode rules:

```text
video_audio + best
  -> best video + best audio; merge when separate

video_audio + fixed height
  -> requested/lower video + best compatible audio

video_only + best
  -> best video and explicitly no audio

video_only + fixed height
  -> requested/lower video and explicitly no audio

audio_only
  -> best original source audio; no forced conversion
```

- [ ] For fixed quality, select exact height when available.
- [ ] Otherwise select the closest lower height.
- [ ] Return `QUALITY_UNAVAILABLE` when no suitable lower stream exists.
- [ ] Never upscale.
- [ ] Preserve actual audio extension and MIME type.

Verification gate:

- [ ] Unit tests cover every mode/quality combination.
- [ ] Tests cover exact match, lower fallback, and unavailable quality.
- [ ] Video-only output contains no audio stream.
- [ ] Audio-only output contains no video stream.

## Step 11 — Enforce capacity, size, and time limits

- [ ] Add an in-memory semaphore with two concurrent slots.
- [ ] Hold the slot throughout inspection, download, processing, and streaming.
- [ ] Return `503 SERVICE_BUSY` with `Retry-After` when full.
- [ ] Enforce total job timeout.
- [ ] Track bytes written during download.
- [ ] Stop processing when output exceeds 1 GiB.
- [ ] Reject known over-limit media before download.
- [ ] Handle incorrect or missing remote size metadata.

Verification gate:

- [ ] Third simultaneous request is rejected while two jobs run.
- [ ] Over-limit fixtures are terminated and cleaned.
- [ ] Timed-out jobs release their concurrency slot.
- [ ] Failed jobs cannot leave orphan processes.

## Step 12 — Implement the download endpoint

- [ ] Validate request JSON.
- [ ] Inspect media before committing response headers.
- [ ] Create job directory and reserve capacity.
- [ ] Download selected stream or streams.
- [ ] Merge separate streams when required.
- [ ] Determine final MIME type and safe extension from actual output.
- [ ] Generate a sanitized attachment filename.
- [ ] Stream with backpressure.
- [ ] Set `Content-Length` when known.
- [ ] Detect client disconnect and abort work.
- [ ] Clean the job directory after stream completion or failure.

Request:

```json
{
  "url": "https://example.com/public-media",
  "mode": "video_audio",
  "quality": "best",
  "stripMetadata": false
}
```

Verification gate:

- [ ] Successful response downloads one playable attachment.
- [ ] Filename contains no control characters or unsafe path data.
- [ ] Truncated or failed generation never returns a fake successful JSON response.
- [ ] Client abort kills active work and removes temporary files.

## Step 13 — Implement optional metadata sanitization

- [ ] Inspect downloaded output with `ffprobe`.
- [ ] Choose sanitization behavior by actual container, not URL suffix.
- [ ] Write sanitized output to a separate file.
- [ ] Remove global/stream metadata, comments, chapters, and attached artwork where safe.
- [ ] Prefer codec stream copy.
- [ ] For images, normalize orientation into pixels before deleting orientation metadata.
- [ ] Validate the sanitized output using `ffprobe`.
- [ ] Confirm at least the expected audio/video streams remain.
- [ ] Delete the unsanitized intermediate before response streaming.
- [ ] Fail safely for unsupported containers.

Verification gate:

- [ ] `stripMetadata: false` bypasses sanitization.
- [ ] `stripMetadata: true` removes tested optional tags.
- [ ] Duration and expected streams remain valid.
- [ ] Corrupt sanitizer output is never returned.

## Step 14 — Normalize errors

- [ ] Define domain error classes/codes.
- [ ] Map validation, authentication, extraction, limits, capacity, processing, and unexpected failures.
- [ ] Include request ID in every JSON error.
- [ ] Use stable codes suitable for Android clients.
- [ ] Keep human-readable messages generic and safe.

Error shape:

```json
{
  "error": {
    "code": "MEDIA_UNAVAILABLE",
    "message": "The media is unavailable.",
    "requestId": "request-id"
  }
}
```

Verification gate:

- [ ] Every known failure maps to the status/code documented in `PLAN.md`.
- [ ] Unknown failures return `500 INTERNAL_ERROR`.
- [ ] No response exposes command lines, stack traces, local paths, or signed URLs.

## Step 15 — Add rate limiting

- [ ] Apply limits per API key and client IP.
- [ ] Trust proxy headers only from the configured reverse proxy.
- [ ] Return `429 RATE_LIMITED` with `Retry-After`.
- [ ] Keep concurrency limiting separate from request-rate limiting.
- [ ] Use in-memory state for one-instance MVP.
- [ ] Document Redis-backed/distributed limiting as a multi-instance requirement.

Verification gate:

- [ ] Burst requests reach the intended threshold.
- [ ] Spoofed forwarding headers do not bypass limits.
- [ ] Different keys receive independent quotas.

## Step 16 — Build the simple web interface

- [ ] Render a responsive page from the Hono application.
- [ ] Add URL input and inspect button.
- [ ] Show normalized title, duration, platform, thumbnail, and available choices.
- [ ] Add mode selector.
- [ ] Add quality selector.
- [ ] Disable quality when audio-only mode is selected.
- [ ] Add metadata-removal checkbox, off by default.
- [ ] Add download button and waiting/progress state.
- [ ] Display safe, actionable API errors.
- [ ] Ensure keyboard and screen-reader usability.
- [ ] Avoid third-party analytics and unnecessary remote assets.
- [ ] Never inject a privileged server API key into public JavaScript.

Verification gate:

- [ ] Desktop and phone layouts work.
- [ ] All three download modes work through the interface.
- [ ] Browser download uses the server-provided filename.
- [ ] Invalid input and backend failures are clearly shown.

## Step 17 — Add structured observability

- [ ] Emit JSON logs in production.
- [ ] Record request ID, safe key label, platform, mode, quality, sanitization flag, timings, output byte count, and result code.
- [ ] Do not log full URLs by default.
- [ ] Never log API keys, signed URLs, response bodies, or media contents.
- [ ] Add counters for active jobs, rejections, failures, bytes, and cleanup.
- [ ] Add graceful shutdown that stops new jobs and drains active jobs within a deadline.

Verification gate:

- [ ] Logs correlate one request across every stage.
- [ ] Secret-scanning tests find no leaked credentials or signed URLs.
- [ ] Shutdown cleans processes and temporary files.

## Step 18 — Add Docker packaging

- [ ] Create a multi-stage `Dockerfile` where useful.
- [ ] Install Bun, pinned `yt-dlp`, `ffmpeg`, and `ffprobe`.
- [ ] Run as a non-root user.
- [ ] Make only `/tmp/downloader` writable.
- [ ] Add `.dockerignore`.
- [ ] Add `compose.yaml` for local testing.
- [ ] Add container health check.
- [ ] Pin runtime/tool versions for reproducible builds.
- [ ] Configure CPU, memory, PID, and temporary-disk limits in deployment.

Verification gate:

```bash
docker compose build
docker compose up
```

- [ ] Container starts as non-root.
- [ ] `/health` and `/ready` pass.
- [ ] A fixture download works.
- [ ] Temporary files disappear after completion.

## Step 19 — Complete automated tests

- [ ] Unit-test schemas, URL security, format selectors, filename generation, authentication, errors, and path containment.
- [ ] Use stub executables for deterministic subprocess integration tests.
- [ ] Test success, unavailable media, timeout, corrupt output, excessive size, client abort, and process failure.
- [ ] Verify metadata-removal fixtures remain readable/playable.
- [ ] Verify cleanup for all exit paths.
- [ ] Add optional manual network smoke tests using small media owned by the project.
- [ ] Keep routine CI independent of changing third-party web pages.

Final verification gate:

```bash
bun run typecheck
bun test
docker compose build
```

All commands must pass before MVP completion.

## Step 20 — Prepare VPS deployment

- [ ] Provision a dedicated unprivileged service account or container runtime.
- [ ] Put Caddy, Nginx, or another reverse proxy in front of Bun.
- [ ] Enable HTTPS.
- [ ] Configure trusted proxy addresses.
- [ ] Set header, connection, and request timeouts.
- [ ] Set resource and temporary-disk quotas.
- [ ] Supply secrets through deployment configuration, not image layers.
- [ ] Rotate the development API key.
- [ ] Configure logs, metrics, alerting, restart policy, and backups of configuration only.
- [ ] Verify no downloaded media persists after requests.

Verification gate:

- [ ] Public traffic reaches only the TLS reverse proxy.
- [ ] Bun/container port is not publicly exposed.
- [ ] Invalid keys, request floods, large jobs, and disconnects behave safely.
- [ ] Restart cleanup removes abandoned job directories.

## Step 21 — Prepare Android API usage

- [ ] Publish a stable OpenAPI description for `/api/v1`.
- [ ] Generate or hand-build a typed Android API client from the stable schema.
- [ ] Stream responses directly to Android storage instead of loading files into memory.
- [ ] Surface stable backend error codes to the UI.
- [ ] Support cancellation and incomplete-download cleanup.
- [ ] Do not embed the server master API key in the APK.
- [ ] Before public launch, add user/device authentication and short-lived tokens.
- [ ] Add per-user quotas and abuse detection.
- [ ] Consider Play Integrity as an additional signal.

Verification gate:

- [ ] Android client handles large files without memory exhaustion.
- [ ] Cancelling a download stops backend processing.
- [ ] Extracting the APK does not reveal a privileged permanent secret.

## Step 22 — Public-release readiness

- [ ] Add Terms of Service.
- [ ] Add Privacy Policy.
- [ ] Add user confirmation that they own or have permission to download content.
- [ ] Add an abuse/takedown contact process.
- [ ] Review current terms for every supported platform.
- [ ] Review current Google Play intellectual-property and user-data policies.
- [ ] Avoid unsupported affiliation claims and platform branding.
- [ ] Obtain legal review appropriate to deployment regions.
- [ ] Decide whether the public product should limit platforms or capabilities.

Verification gate:

- [ ] Policy and legal review completed before public listing.
- [ ] Store listing accurately describes behavior and limitations.
- [ ] Support and takedown channels work.

## Runtime request workflow

Every download request follows this exact order:

1. Assign request ID.
2. Authenticate API key or user token.
3. Apply request-rate limit.
4. Parse and validate JSON.
5. Validate URL scheme, host, port, address, and redirect safety.
6. Reserve concurrency capacity.
7. Create isolated temporary job directory.
8. Inspect public media with `yt-dlp`.
9. Reject playlists, private media, unavailable media, and known limit violations.
10. Select mode and quality using internal rules.
11. Download selected stream or streams.
12. Enforce timeout and byte limits throughout.
13. Merge streams when required.
14. If requested, sanitize metadata into a new output file.
15. Validate final media with `ffprobe`.
16. Generate safe filename, MIME type, and response headers.
17. Stream file with backpressure.
18. Abort subprocess work if the client disconnects.
19. Delete all job files.
20. Release concurrency slot.
21. Emit sanitized completion metrics/logs.

Cleanup steps 19–21 run for both success and failure.

## Change workflow

For every implementation change:

1. Select the next unchecked step.
2. Read its requirements and verification gate.
3. Implement the smallest complete slice.
4. Add or update tests in the same change.
5. Run targeted tests.
6. Run type checking and the full test suite.
7. Verify Docker when dependencies or runtime behavior changed.
8. Update `README.md`, `PLAN.md`, and this workflow if behavior changed.
9. Mark a checkbox complete only after verification passes.
10. Record remaining limitations clearly.

## MVP completion checklist

- [ ] Steps 1–19 completed.
- [ ] All tests and type checks pass.
- [ ] Docker build and runtime verification pass.
- [ ] All supported modes and qualities work with controlled fixtures.
- [ ] Metadata sanitization returns valid media.
- [ ] Authentication, SSRF protection, limits, cleanup, and safe errors are verified.
- [ ] REST API and web interface use shared domain services.
- [ ] Documentation matches actual commands and behavior.

Steps 20–22 are required before VPS/public Android release, not before local MVP completion.
