import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;

export type QmdSearchMode = "query" | "search" | "vsearch";

export interface QmdMemoryConfig {
  searchMode: QmdSearchMode;
  topK: number;
  autoIndexOnWrite: boolean;
  qmdBinaryPath: string | null;
}

export interface QmdQueryHit {
  path?: string;
  file?: string;
  filePath?: string;
  recordId?: string;
  id?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface QmdClient {
  checkHealth?(input: {
    binaryPath?: string | null;
  }): Promise<{
    available: boolean;
    binaryPath: string;
    message: string;
  }>;
  refreshIndex(input: {
    bindingDir: string;
    binaryPath?: string | null;
  }): Promise<void>;
  query(input: {
    bindingDir: string;
    binaryPath?: string | null;
    query: string;
    topK: number;
    mode: QmdSearchMode;
  }): Promise<QmdQueryHit[]>;
}

export type QmdExecutor = (
  binary: string,
  args: string[],
  opts: {
    cwd: string;
    timeoutMs?: number;
  },
) => Promise<{ stdout: string; stderr: string }>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeHits(value: unknown): QmdQueryHit[] {
  if (Array.isArray(value)) {
    return value.filter(isPlainRecord) as QmdQueryHit[];
  }
  if (!isPlainRecord(value)) return [];

  for (const key of ["hits", "results", "items"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate.filter(isPlainRecord) as QmdQueryHit[];
    }
  }

  return [];
}

export async function defaultQmdExecutor(
  binary: string,
  args: string[],
  opts: {
    cwd: string;
    timeoutMs?: number;
  },
) {
  try {
    const result = await execFileAsync(binary, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    const stderr = typeof err.stderr === "string" && err.stderr.trim().length > 0
      ? err.stderr.trim()
      : null;
    if (err.code === "ENOENT") {
      throw new Error(`qmd binary not found: ${binary}`);
    }
    throw new Error(stderr ? `qmd command failed: ${stderr}` : `qmd command failed: ${err.message}`);
  }
}

export function createQmdClient(executor: QmdExecutor = defaultQmdExecutor): QmdClient {
  return {
    async checkHealth(input) {
      const binaryPath = input.binaryPath ?? "qmd";
      try {
        await executor(binaryPath, ["--version"], { cwd: process.cwd(), timeoutMs: 5_000 });
        return {
          available: true,
          binaryPath,
          message: "qmd binary is available",
        };
      } catch (error) {
        return {
          available: false,
          binaryPath,
          message: error instanceof Error ? error.message : "qmd binary check failed",
        };
      }
    },

    async refreshIndex(input) {
      await executor(
        input.binaryPath ?? "qmd",
        ["index", input.bindingDir],
        { cwd: input.bindingDir },
      );
    },

    async query(input) {
      const { stdout } = await executor(
        input.binaryPath ?? "qmd",
        [
          input.mode,
          input.query,
          "--root",
          input.bindingDir,
          "--limit",
          String(input.topK),
          "--json",
        ],
        { cwd: input.bindingDir },
      );
      const trimmed = stdout.trim();
      if (!trimmed) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new Error("qmd query returned invalid JSON");
      }
      return normalizeHits(parsed);
    },
  };
}
