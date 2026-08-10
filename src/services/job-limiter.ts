import { ApplicationError } from "../domain/errors";

const defaultRetryAfterSeconds = 30;

const assertPositiveInteger = (name: string, value: number) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
};

const outputLimitError = () =>
  new ApplicationError("LIMIT_EXCEEDED", 413, "The media exceeds the maximum output size.");

const timeoutError = () =>
  new ApplicationError("DOWNLOAD_FAILED", 502, "The media job exceeded its allowed time.");

export class OutputByteLimiter {
  private observedBytes = 0;

  constructor(
    readonly maximumBytes: number,
    private readonly abort: (reason: ApplicationError) => void,
  ) {
    assertPositiveInteger("maximumBytes", maximumBytes);
  }

  get bytesWritten(): number {
    return this.observedBytes;
  }

  assertKnownSize(bytes: number | null | undefined): void {
    if (bytes === null || bytes === undefined) {
      return;
    }

    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new TypeError("Known output size must be a non-negative safe integer");
    }

    if (bytes > this.maximumBytes) {
      this.fail();
    }
  }

  recordBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new TypeError("Written byte count must be a non-negative safe integer");
    }

    if (bytes > this.maximumBytes - this.observedBytes) {
      this.observedBytes = this.maximumBytes + 1;
      this.fail();
    }

    this.observedBytes += bytes;
  }

  observeBytesWritten(totalBytes: number): void {
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
      throw new TypeError("Observed byte count must be a non-negative safe integer");
    }

    this.observedBytes = Math.max(this.observedBytes, totalBytes);

    if (this.observedBytes > this.maximumBytes) {
      this.fail();
    }
  }

  createTransformStream(): TransformStream<Uint8Array, Uint8Array> {
    return new TransformStream({
      transform: (chunk, controller) => {
        this.recordBytes(chunk.byteLength);
        controller.enqueue(chunk);
      },
    });
  }

  private fail(): never {
    const error = outputLimitError();
    this.abort(error);
    throw error;
  }
}

export interface JobContext {
  readonly output: OutputByteLimiter;
  readonly signal: AbortSignal;
}

export interface JobLease {
  readonly context: JobContext;
  readonly timedOut: boolean;
  release(): void;
}

interface ActiveLease {
  readonly abort: () => void;
  readonly completed: Promise<void>;
}

export class JobLimiter {
  private readonly activeLeases = new Set<ActiveLease>();
  private acceptingJobs = true;

  constructor(
    readonly maximumConcurrentJobs: number,
    readonly timeoutMilliseconds: number,
    readonly maximumOutputBytes: number,
    readonly retryAfterSeconds = defaultRetryAfterSeconds,
  ) {
    assertPositiveInteger("maximumConcurrentJobs", maximumConcurrentJobs);
    assertPositiveInteger("timeoutMilliseconds", timeoutMilliseconds);
    assertPositiveInteger("maximumOutputBytes", maximumOutputBytes);
    assertPositiveInteger("retryAfterSeconds", retryAfterSeconds);
  }

  get activeJobs(): number {
    return this.activeLeases.size;
  }

  acquire(requestSignal?: AbortSignal): JobLease {
    if (!this.acceptingJobs || this.activeJobs >= this.maximumConcurrentJobs) {
      throw new ApplicationError("SERVICE_BUSY", 503, "The media service is busy.", {
        retryAfterSeconds: this.retryAfterSeconds,
      });
    }

    const controller = new AbortController();
    let timedOut = false;
    let released = false;
    let complete: () => void = () => undefined;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const handleRequestAbort = () => controller.abort(requestSignal?.reason);
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError());
    }, this.timeoutMilliseconds);
    const activeLease: ActiveLease = {
      abort: () => controller.abort(),
      completed,
    };
    const output = new OutputByteLimiter(this.maximumOutputBytes, (reason) =>
      controller.abort(reason),
    );

    requestSignal?.addEventListener("abort", handleRequestAbort, { once: true });
    if (requestSignal?.aborted === true) {
      handleRequestAbort();
    }

    this.activeLeases.add(activeLease);

    return {
      context: Object.freeze({ output, signal: controller.signal }),
      get timedOut() {
        return timedOut;
      },
      release: () => {
        if (released) {
          return;
        }

        released = true;
        clearTimeout(timeout);
        requestSignal?.removeEventListener("abort", handleRequestAbort);
        this.activeLeases.delete(activeLease);
        complete();
      },
    };
  }

  async run<T>(
    operation: (context: JobContext) => Promise<T>,
    requestSignal?: AbortSignal,
  ): Promise<T> {
    const lease = this.acquire(requestSignal);

    try {
      const result = await operation(lease.context);

      if (lease.timedOut) {
        throw timeoutError();
      }

      return result;
    } catch (error) {
      if (lease.timedOut) {
        throw timeoutError();
      }

      throw error;
    } finally {
      lease.release();
    }
  }

  async shutdown(): Promise<void> {
    this.acceptingJobs = false;
    const activeLeases = [...this.activeLeases];

    for (const lease of activeLeases) {
      lease.abort();
    }

    await Promise.all(activeLeases.map((lease) => lease.completed));
  }
}
