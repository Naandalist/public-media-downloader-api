import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const commandTimeoutMilliseconds = 2_000;

const tools = {
  ffmpeg: ["ffmpeg", "-version"],
  ffprobe: ["ffprobe", "-version"],
  ytDlp: ["yt-dlp", "--version"],
} as const;

export interface ReadinessResult {
  readonly checks: {
    readonly ffmpeg: boolean;
    readonly ffprobe: boolean;
    readonly tempDirectory: boolean;
    readonly ytDlp: boolean;
  };
  readonly status: "ready" | "not_ready";
}

export interface ReadinessChecker {
  check(): Promise<ReadinessResult>;
}

export interface StartupDependencyDiagnostic {
  readonly event: "startup_dependencies";
  readonly ffmpeg: "available" | "unavailable";
  readonly ffprobe: "available" | "unavailable";
  readonly status: ReadinessResult["status"];
  readonly tempDirectory: "available" | "unavailable";
  readonly ytDlp: "available" | "unavailable";
}

const availability = (available: boolean) => (available ? "available" : "unavailable");

export const createStartupDependencyDiagnostic = (
  result: ReadinessResult,
): StartupDependencyDiagnostic =>
  Object.freeze({
    event: "startup_dependencies",
    ffmpeg: availability(result.checks.ffmpeg),
    ffprobe: availability(result.checks.ffprobe),
    status: result.status,
    tempDirectory: availability(result.checks.tempDirectory),
    ytDlp: availability(result.checks.ytDlp),
  });

export type CommandChecker = (
  executable: string,
  arguments_: readonly string[],
) => Promise<boolean>;

export const checkCommand: CommandChecker = async (executable, arguments_) => {
  let process: ReturnType<typeof Bun.spawn>;

  try {
    process = Bun.spawn([executable, ...arguments_], {
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore",
    });
  } catch {
    return false;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(() => resolve("timeout"), commandTimeoutMilliseconds);
  });
  const result = await Promise.race([process.exited, timeoutResult]);

  if (timeout !== undefined) {
    clearTimeout(timeout);
  }

  if (result === "timeout") {
    process.kill();
    await process.exited.catch(() => undefined);
    return false;
  }

  return result === 0;
};

const checkTempDirectory = async (tempDirectory: string): Promise<boolean> => {
  let probeDirectory: string | undefined;

  try {
    await mkdir(tempDirectory, { recursive: true });
    probeDirectory = await mkdtemp(join(tempDirectory, ".ready-"));
    await writeFile(join(probeDirectory, "probe"), "ready", { flag: "wx" });
    await rm(probeDirectory, { force: true, recursive: true });
    return true;
  } catch {
    if (probeDirectory !== undefined) {
      await rm(probeDirectory, { force: true, recursive: true }).catch(() => undefined);
    }

    return false;
  }
};

export class SystemReadinessChecker implements ReadinessChecker {
  constructor(
    private readonly tempDirectory: string,
    private readonly commandChecker: CommandChecker = checkCommand,
  ) {}

  async check(): Promise<ReadinessResult> {
    const [tempDirectory, ffmpeg, ffprobe, ytDlp] = await Promise.all([
      checkTempDirectory(this.tempDirectory),
      this.commandChecker(tools.ffmpeg[0], tools.ffmpeg.slice(1)),
      this.commandChecker(tools.ffprobe[0], tools.ffprobe.slice(1)),
      this.commandChecker(tools.ytDlp[0], tools.ytDlp.slice(1)),
    ]);
    const ready = tempDirectory && ffmpeg && ffprobe && ytDlp;

    return {
      checks: {
        ffmpeg,
        ffprobe,
        tempDirectory,
        ytDlp,
      },
      status: ready ? "ready" : "not_ready",
    };
  }
}
