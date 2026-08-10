import process from "node:process";

const defaultTimeoutMilliseconds = 30_000;
const defaultMaxStdoutBytes = 1_048_576;
const defaultMaxStderrBytes = 262_144;
const terminationGraceMilliseconds = 200;

export type ProcessErrorCode =
  "ABORTED" | "EXIT_NON_ZERO" | "OUTPUT_LIMIT_EXCEEDED" | "SPAWN_FAILED" | "TIMED_OUT";

const errorMessages: Readonly<Record<ProcessErrorCode, string>> = {
  ABORTED: "The operation was cancelled.",
  EXIT_NON_ZERO: "The external process failed.",
  OUTPUT_LIMIT_EXCEEDED: "The external process exceeded its output limit.",
  SPAWN_FAILED: "The external process could not be started.",
  TIMED_OUT: "The external process timed out.",
};

export class ProcessRunnerError extends Error {
  override readonly name = "ProcessRunnerError";

  constructor(
    readonly code: ProcessErrorCode,
    readonly exitCode: number | null = null,
  ) {
    super(errorMessages[code]);
  }
}

export interface ProcessRunOptions {
  readonly arguments?: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly executable: string;
  readonly maxStderrBytes?: number;
  readonly maxStdoutBytes?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMilliseconds?: number;
}

export interface ProcessRunResult {
  readonly durationMilliseconds: number;
  readonly exitCode: 0;
  readonly stderr: string;
  readonly stdout: string;
}

interface CapturedOutput {
  readonly exceeded: boolean;
  readonly text: string;
}

type SpawnedProcess = ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;

const validateLimit = (name: string, value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
};

const isSignalAborted = (signal: AbortSignal | undefined) => signal?.aborted === true;

const captureOutput = async (
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  onLimitExceeded: () => void,
): Promise<CapturedOutput> => {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let capturedBytes = 0;
  let exceeded = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      const remainingBytes = maximumBytes - capturedBytes;

      if (remainingBytes > 0) {
        const capturedChunk =
          value.byteLength <= remainingBytes ? value : value.subarray(0, remainingBytes);
        chunks.push(capturedChunk);
        capturedBytes += capturedChunk.byteLength;
      }

      if (!exceeded && value.byteLength > remainingBytes) {
        exceeded = true;
        onLimitExceeded();
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    exceeded,
    text: Buffer.concat(chunks, capturedBytes).toString("utf8"),
  };
};

const sendSignalToProcessTree = (subprocess: SpawnedProcess, signal: NodeJS.Signals) => {
  if (process.platform !== "win32") {
    try {
      process.kill(-subprocess.pid, signal);
      return;
    } catch {
      // The process group may already have exited. Fall through to the direct child.
    }
  }

  try {
    subprocess.kill(signal);
  } catch {
    // The child already exited.
  }
};

const terminateProcessTree = async (subprocess: SpawnedProcess) => {
  sendSignalToProcessTree(subprocess, "SIGTERM");
  await Bun.sleep(terminationGraceMilliseconds);
  sendSignalToProcessTree(subprocess, "SIGKILL");
};

export class ProcessRunner {
  private readonly activeExecutions = new Map<() => void, Promise<void>>();
  private acceptingExecutions = true;

  async shutdown(): Promise<void> {
    this.acceptingExecutions = false;
    const activeExecutions = [...this.activeExecutions.entries()];

    for (const [abort] of activeExecutions) {
      abort();
    }

    await Promise.all(activeExecutions.map(([, completed]) => completed));
  }

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const timeoutMilliseconds = options.timeoutMilliseconds ?? defaultTimeoutMilliseconds;
    const maxStdoutBytes = options.maxStdoutBytes ?? defaultMaxStdoutBytes;
    const maxStderrBytes = options.maxStderrBytes ?? defaultMaxStderrBytes;

    validateLimit("timeoutMilliseconds", timeoutMilliseconds);
    validateLimit("maxStdoutBytes", maxStdoutBytes);
    validateLimit("maxStderrBytes", maxStderrBytes);

    if (!this.acceptingExecutions || isSignalAborted(options.signal)) {
      throw new ProcessRunnerError("ABORTED");
    }

    const startedAt = performance.now();
    let subprocess: SpawnedProcess;

    try {
      subprocess = Bun.spawn([options.executable, ...(options.arguments ?? [])], {
        detached: true,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.environment === undefined ? {} : { env: { ...options.environment } }),
      });
    } catch {
      throw new ProcessRunnerError("SPAWN_FAILED");
    }

    let terminationCode: Extract<
      ProcessErrorCode,
      "ABORTED" | "OUTPUT_LIMIT_EXCEEDED" | "TIMED_OUT"
    > | null = null;
    let terminationPromise: Promise<void> | null = null;

    const terminate = (code: NonNullable<typeof terminationCode>) => {
      if (terminationCode !== null) {
        return;
      }

      terminationCode = code;
      terminationPromise = terminateProcessTree(subprocess);
    };

    let completeExecution: () => void = () => undefined;
    const executionCompleted = new Promise<void>((resolve) => {
      completeExecution = resolve;
    });
    const abortForShutdown = () => terminate("ABORTED");
    this.activeExecutions.set(abortForShutdown, executionCompleted);

    const handleAbort = () => terminate("ABORTED");
    options.signal?.addEventListener("abort", handleAbort, { once: true });

    if (isSignalAborted(options.signal)) {
      handleAbort();
    }

    const timeout = setTimeout(() => terminate("TIMED_OUT"), timeoutMilliseconds);
    const stdoutPromise = captureOutput(subprocess.stdout, maxStdoutBytes, () =>
      terminate("OUTPUT_LIMIT_EXCEEDED"),
    );
    const stderrPromise = captureOutput(subprocess.stderr, maxStderrBytes, () =>
      terminate("OUTPUT_LIMIT_EXCEEDED"),
    );

    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        subprocess.exited,
        stdoutPromise,
        stderrPromise,
      ]);

      if (terminationPromise !== null) {
        await terminationPromise;
      }

      if (terminationCode !== null) {
        throw new ProcessRunnerError(terminationCode);
      }

      if (stdout.exceeded || stderr.exceeded) {
        throw new ProcessRunnerError("OUTPUT_LIMIT_EXCEEDED");
      }

      if (exitCode !== 0) {
        throw new ProcessRunnerError("EXIT_NON_ZERO", exitCode);
      }

      return Object.freeze({
        durationMilliseconds: performance.now() - startedAt,
        exitCode: 0 as const,
        stderr: stderr.text,
        stdout: stdout.text,
      });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", handleAbort);
      this.activeExecutions.delete(abortForShutdown);
      completeExecution();
    }
  }
}
