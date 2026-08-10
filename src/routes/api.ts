import { Hono } from "hono";
import { z } from "zod";

import { ApplicationError } from "../domain/errors";
import {
  DOWNLOAD_MODES,
  MEDIA_QUALITIES,
  type MediaDownloader,
  type MediaInfoInspector,
} from "../domain/media";
import { createApiKeyMiddleware } from "../middleware/api-key";
import { createMediaReadinessMiddleware } from "../middleware/media-readiness";
import type { ApiKeyAuthenticator } from "../services/api-key-authenticator";
import type { JobLimiter } from "../services/job-limiter";
import { attachmentContentDisposition, sanitizeAttachmentName } from "../services/media-download";
import type { ReadinessChecker } from "../services/readiness";
import type { AppEnvironment } from "../types/http";

export const createApiRoutes = (
  apiKeyAuthenticator: ApiKeyAuthenticator,
  readiness: ReadinessChecker,
  mediaInfo: MediaInfoInspector,
  mediaDownloader: MediaDownloader,
  jobLimiter: JobLimiter,
) => {
  const api = new Hono<AppEnvironment>();

  api.use("*", createApiKeyMiddleware(apiKeyAuthenticator));
  api.use("/info", createMediaReadinessMiddleware(readiness));
  api.use("/download", createMediaReadinessMiddleware(readiness));

  api.post("/info", async (context) => {
    let body: unknown;

    try {
      body = await context.req.json();
    } catch {
      throw new ApplicationError("INVALID_REQUEST");
    }

    const parsed = z
      .object({
        url: z.string().trim().min(1).max(2_048),
      })
      .strict()
      .safeParse(body);

    if (!parsed.success) {
      throw new ApplicationError("INVALID_REQUEST");
    }

    return context.json(
      await jobLimiter.run(
        ({ signal }) => mediaInfo.inspect(parsed.data.url, signal),
        context.req.raw.signal,
      ),
    );
  });

  api.post("/download", async (context) => {
    let body: unknown;

    try {
      body = await context.req.json();
    } catch {
      throw new ApplicationError("INVALID_REQUEST");
    }

    const parsed = z
      .object({
        mode: z.enum(DOWNLOAD_MODES).default("video_audio"),
        quality: z.enum(MEDIA_QUALITIES).default("best"),
        stripMetadata: z.boolean().default(false),
        url: z.string().trim().min(1).max(2_048),
      })
      .strict()
      .safeParse(body);

    if (!parsed.success) {
      throw new ApplicationError("INVALID_REQUEST");
    }

    const lease = jobLimiter.acquire(context.req.raw.signal);
    let prepared: Awaited<ReturnType<MediaDownloader["prepare"]>>;

    try {
      prepared = await mediaDownloader.prepare(parsed.data, lease.context);
    } catch (error) {
      lease.release();
      throw error;
    }

    const fileName = sanitizeAttachmentName(prepared.title, prepared.extension);
    const reader = Bun.file(prepared.filePath).stream().getReader();
    let finalized = false;
    const finalize = async () => {
      if (finalized) {
        return;
      }

      finalized = true;
      lease.context.signal.removeEventListener("abort", handleAbort);
      await prepared.cleanup().finally(() => lease.release());
    };
    const handleAbort = () => {
      void reader.cancel(lease.context.signal.reason).finally(finalize);
    };
    lease.context.signal.addEventListener("abort", handleAbort, { once: true });

    if (lease.context.signal.aborted) {
      handleAbort();
    }

    const stream = new ReadableStream<Uint8Array>({
      cancel: async (reason) => {
        await reader.cancel(reason).finally(finalize);
      },
      pull: async (controller) => {
        try {
          const chunk = await reader.read();

          if (chunk.done) {
            controller.close();
            await finalize();
            return;
          }

          controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error);
          await finalize();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Disposition": attachmentContentDisposition(fileName),
        "Content-Length": String(prepared.sizeBytes),
        "Content-Type": prepared.mimeType,
      },
    });
  });

  api.get("/", (context) =>
    context.json({
      name: "media-downloader",
      version: "v1",
    }),
  );

  return api;
};
