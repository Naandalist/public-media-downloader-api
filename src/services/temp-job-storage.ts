import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const jobDirectoryPattern = /^job-[a-f0-9]{32}$/;
const maximumCreateAttempts = 4;
const isAborted = (signal: AbortSignal | undefined) => signal?.aborted === true;

const isContainedPath = (parent: string, candidate: string) => {
  const relativePath = relative(parent, candidate);

  return (
    relativePath !== "" &&
    !relativePath.startsWith(`..${sep}`) &&
    relativePath !== ".." &&
    !isAbsolute(relativePath)
  );
};

export class TempJobStorageError extends Error {
  override readonly name = "TempJobStorageError";
}

export class TempJob {
  private cleanupPromise: Promise<void> | null = null;

  constructor(
    readonly id: string,
    readonly directory: string,
    private readonly release: (job: TempJob) => Promise<void>,
  ) {}

  async resolveFile(fileName: string): Promise<string> {
    if (this.cleanupPromise !== null) {
      throw new TempJobStorageError("Temporary job is no longer active.");
    }

    if (
      fileName.length === 0 ||
      fileName === "." ||
      fileName === ".." ||
      basename(fileName) !== fileName
    ) {
      throw new TempJobStorageError("Temporary file name must be a plain server-generated name.");
    }

    const candidate = resolve(this.directory, fileName);

    if (!isContainedPath(this.directory, candidate)) {
      throw new TempJobStorageError("Temporary file path escaped its job directory.");
    }

    const resolvedParent = await realpath(this.directory);

    if (resolvedParent !== this.directory) {
      throw new TempJobStorageError("Temporary job directory is not trusted.");
    }

    try {
      const candidateStatus = await lstat(candidate);

      if (candidateStatus.isSymbolicLink()) {
        throw new TempJobStorageError("Symbolic links are not allowed in temporary jobs.");
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }

    return candidate;
  }

  async cleanup(): Promise<void> {
    if (this.cleanupPromise === null) {
      this.cleanupPromise = this.release(this);
    }

    await this.cleanupPromise;
  }
}

export class TempJobStorage {
  private readonly activeJobs = new Set<TempJob>();
  private acceptingJobs = true;
  private rootDirectory: string | null = null;

  constructor(
    private readonly configuredRootDirectory: string,
    private readonly staleAfterMilliseconds: number,
  ) {
    if (!isAbsolute(configuredRootDirectory)) {
      throw new TempJobStorageError("Temporary storage root must be absolute.");
    }

    if (!Number.isSafeInteger(staleAfterMilliseconds) || staleAfterMilliseconds < 1) {
      throw new TempJobStorageError("Temporary file maximum age must be a positive integer.");
    }
  }

  async initialize(now = Date.now()): Promise<number> {
    await mkdir(this.configuredRootDirectory, { mode: 0o700, recursive: true });
    await chmod(this.configuredRootDirectory, 0o700);
    this.rootDirectory = await realpath(this.configuredRootDirectory);

    return this.cleanupStaleJobs(now);
  }

  async createJob(signal?: AbortSignal): Promise<TempJob> {
    if (!this.acceptingJobs || isAborted(signal)) {
      throw new TempJobStorageError("Temporary storage is shutting down.");
    }

    const rootDirectory = await this.getRootDirectory();

    for (let attempt = 0; attempt < maximumCreateAttempts; attempt += 1) {
      const id = `job-${randomBytes(16).toString("hex")}`;
      const directory = join(rootDirectory, id);

      try {
        await mkdir(directory, { mode: 0o700 });
        const resolvedDirectory = await realpath(directory);

        if (!isContainedPath(rootDirectory, resolvedDirectory)) {
          await rm(directory, { force: true, recursive: true });
          throw new TempJobStorageError("Temporary job directory escaped its storage root.");
        }

        const job = new TempJob(id, resolvedDirectory, async (releasedJob) => {
          signal?.removeEventListener("abort", abortHandler);

          this.activeJobs.delete(releasedJob);
          await rm(releasedJob.directory, { force: true, recursive: true });
        });

        this.activeJobs.add(job);
        const abortHandler = () => void job.cleanup().catch(() => undefined);
        signal?.addEventListener("abort", abortHandler, { once: true });

        if (isAborted(signal)) {
          await job.cleanup();
          throw new TempJobStorageError("Temporary job was cancelled.");
        }

        return job;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          continue;
        }

        throw error;
      }
    }

    throw new TempJobStorageError("Could not allocate a unique temporary job directory.");
  }

  async withJob<T>(operation: (job: TempJob) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const job = await this.createJob(signal);

    try {
      return await operation(job);
    } finally {
      await job.cleanup();
    }
  }

  async shutdown(): Promise<void> {
    this.acceptingJobs = false;
    await Promise.all([...this.activeJobs].map((job) => job.cleanup()));
  }

  private async cleanupStaleJobs(now: number): Promise<number> {
    const rootDirectory = await this.getRootDirectory();
    const entries = await readdir(rootDirectory, { withFileTypes: true });
    let removed = 0;

    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory() || !jobDirectoryPattern.test(entry.name)) {
          return;
        }

        const directory = join(rootDirectory, entry.name);
        const status = await lstat(directory);

        if (status.isSymbolicLink() || now - status.mtimeMs <= this.staleAfterMilliseconds) {
          return;
        }

        await rm(directory, { force: true, recursive: true });
        removed += 1;
      }),
    );

    return removed;
  }

  private async getRootDirectory(): Promise<string> {
    if (this.rootDirectory === null) {
      await this.initialize();
    }

    if (this.rootDirectory === null) {
      throw new TempJobStorageError("Temporary storage could not be initialized.");
    }

    return this.rootDirectory;
  }
}
