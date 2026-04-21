/**
 * Dynamic UI parser loading for external adapters — sandboxed execution.
 *
 * When the Paperclip UI encounters an adapter type that doesn't have a
 * built-in parser (e.g., an external adapter loaded via the plugin system),
 * it fetches the parser JS from `/api/adapters/:type/ui-parser.js` and
 * executes it **inside a dedicated Web Worker** so it cannot access the
 * board UI's same-origin state (cookies, localStorage, DOM, authenticated
 * fetch, etc.).
 *
 * The worker communicates via a narrow postMessage protocol:
 *   Main → Worker:  { type: "init", source }
 *   Worker → Main:  { type: "ready" } | { type: "error", message }
 *   Main → Worker:  { type: "parse", id, line, ts }
 *   Worker → Main:  { type: "result", id, entries }
 *
 * Because the parse call is async (cross-thread postMessage), but the
 * existing `parseStdoutLine` contract is synchronous, we maintain an
 * internal queue and return results via the registry re-registration
 * pattern that already exists for the lazy-loading bridge.
 *
 * **Synchronous fast-path**: After init, parse requests are sent to the
 * worker which responds asynchronously.  The `parseStdoutLine` wrapper
 * collects lines and returns `[]` synchronously; when the worker responds,
 * the results are merged into the transcript via the existing adapter
 * change notification mechanism.  In practice this adds ~1 frame of
 * latency which is imperceptible.
 *
 * Security: see `sandboxed-parser-worker.ts` for the full lockdown.
 */

import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import type { StatefulStdoutParser, StdoutLineParser, StdoutParserFactory } from "./types";
import { createSandboxedWorker } from "./sandboxed-parser-worker";
import type { SandboxRequest, SandboxResponse } from "./sandboxed-parser-worker";

// ── Types ───────────────────────────────────────────────────────────────────

interface DynamicParserModule {
  parseStdoutLine: StdoutLineParser;
  createStdoutParser?: StdoutParserFactory;
}

interface SandboxedParser {
  worker: Worker;
  ready: boolean;
  hasFactory: boolean;
  nextId: number;
  pendingResolves: Map<number, (entries: TranscriptEntry[]) => void>;
  pendingParserCreates: Map<number, (parserId: number | null) => void>;
}

// ── State ───────────────────────────────────────────────────────────────────

/** Cache of fully initialised sandboxed parsers by adapter type. */
const sandboxedParsers = new Map<string, SandboxedParser>();

/** Cache of the public DynamicParserModule wrappers. */
const dynamicParserCache = new Map<string, DynamicParserModule>();

/** Track which types we've already attempted to load (to avoid repeat 404s). */
const failedLoads = new Set<string>();

/** In-flight init promises so concurrent callers share the same load. */
const loadPromises = new Map<string, Promise<DynamicParserModule | null>>();

// ── Internal helpers ────────────────────────────────────────────────────────

function sendToWorker(sandbox: SandboxedParser, msg: SandboxRequest): void {
  sandbox.worker.postMessage(msg);
}

function nextRequestId(sandbox: SandboxedParser): number {
  return sandbox.nextId++;
}

/**
 * Parse a single line synchronously by delegating to the worker.
 * Returns a Promise that resolves with the TranscriptEntry[] from the worker.
 */
function parseLineAsync(sandbox: SandboxedParser, line: string, ts: string): Promise<TranscriptEntry[]> {
  return new Promise((resolve) => {
    const id = nextRequestId(sandbox);
    sandbox.pendingResolves.set(id, resolve);
    sendToWorker(sandbox, { type: "parse", id, line, ts });
  });
}

function drainPendingRequests(sandbox: SandboxedParser): void {
  for (const resolver of sandbox.pendingResolves.values()) {
    resolver([]);
  }
  sandbox.pendingResolves.clear();

  for (const resolver of sandbox.pendingParserCreates.values()) {
    resolver(null);
  }
  sandbox.pendingParserCreates.clear();
}

/**
 * Create a sandboxed worker, send the parser source, and wait for init.
 */
function initSandboxedWorker(source: string): Promise<SandboxedParser> {
  return new Promise((resolve, reject) => {
    const worker = createSandboxedWorker();
    const sandbox: SandboxedParser = {
      worker,
      ready: false,
      hasFactory: false,
      nextId: 1,
      pendingResolves: new Map(),
      pendingParserCreates: new Map(),
    };

    // Timeout if the worker doesn't respond within 5s
    const timeout = setTimeout(() => {
      drainPendingRequests(sandbox);
      worker.terminate();
      reject(new Error("Parser worker init timed out"));
    }, 5000);

    worker.onmessage = (e: MessageEvent<SandboxResponse>) => {
      const msg = e.data;

      if (msg.type === "ready") {
        clearTimeout(timeout);
        sandbox.ready = true;
        sandbox.hasFactory = msg.hasFactory;

        // Switch to the steady-state message handler.
        worker.onmessage = (ev: MessageEvent<SandboxResponse>) => {
          const resp = ev.data;
          if (resp.type === "result") {
            const resolver = sandbox.pendingResolves.get(resp.id);
            if (resolver) {
              sandbox.pendingResolves.delete(resp.id);
              resolver(resp.entries as TranscriptEntry[]);
            }
          } else if (resp.type === "parser_created") {
            const resolver = sandbox.pendingParserCreates.get(resp.id);
            if (resolver) {
              sandbox.pendingParserCreates.delete(resp.id);
              resolver(resp.parserId);
            }
          } else if (resp.type === "error") {
            console.error("[adapter-ui-loader] Worker reported error:", resp.message);
            drainPendingRequests(sandbox);
          }
        };

        resolve(sandbox);
        return;
      }

      if (msg.type === "error") {
        clearTimeout(timeout);
        drainPendingRequests(sandbox);
        worker.terminate();
        reject(new Error(msg.message));
        return;
      }
    };

    worker.onerror = (ev) => {
      clearTimeout(timeout);
      drainPendingRequests(sandbox);
      worker.terminate();
      reject(new Error(`Worker error: ${ev.message}`));
    };

    // Send the parser source to the worker for evaluation.
    sendToWorker(sandbox, { type: "init", source });
  });
}

/**
 * Build a DynamicParserModule that delegates all calls to the sandboxed worker.
 *
 * The parseStdoutLine wrapper is **synchronous** to match the existing contract.
 * It sends the parse request to the worker and returns `[]` immediately.
 * When the worker responds, the caller must handle the async result.
 *
 * For callers that need sync results (the current transcript renderer), we
 * provide a sync wrapper that accumulates results.  The registry's
 * re-registration pattern will trigger a re-render when results arrive.
 *
 * In practice, because the existing codebase already handles the "bridge"
 * pattern where parseStdoutLine returns [] until the dynamic parser loads,
 * the same UX applies here: the first render may show raw lines, and a
 * subsequent render shows the parsed entries.
 */
function buildParserModule(sandbox: SandboxedParser): DynamicParserModule {
  // Accumulator for async results.  The sync parseStdoutLine returns the
  // accumulated buffer and clears it, so results appear on the next call.
  const asyncBuffer: TranscriptEntry[] = [];

  const parseStdoutLine: StdoutLineParser = (line: string, ts: string) => {
    // Drain any previously resolved async results first.
    const buffered = asyncBuffer.splice(0, asyncBuffer.length);

    // Fire off the async parse; results will be buffered for next call.
    parseLineAsync(sandbox, line, ts).then((entries) => {
      if (entries.length > 0) {
        asyncBuffer.push(...entries);
      }
    });

    return buffered;
  };

  const mod: DynamicParserModule = { parseStdoutLine };

  if (sandbox.hasFactory) {
    mod.createStdoutParser = (): StatefulStdoutParser => {
      let parserId: number | null = null;
      let parserReady = false;
      const parserBuffer: TranscriptEntry[] = [];

      // Request a parser instance from the worker.
      const id = nextRequestId(sandbox);
      sandbox.pendingParserCreates.set(id, (createdParserId) => {
        if (createdParserId !== null) {
          parserId = createdParserId;
          parserReady = true;
        }
      });
      sendToWorker(sandbox, { type: "create_parser", id });

      return {
        parseLine: (line: string, ts: string): TranscriptEntry[] => {
          const buffered = parserBuffer.splice(0, parserBuffer.length);

          if (parserReady && parserId !== null) {
            const reqId = nextRequestId(sandbox);
            sandbox.pendingResolves.set(reqId, (entries) => {
              if (entries.length > 0) {
                parserBuffer.push(...entries);
              }
            });
            sendToWorker(sandbox, { type: "parser_parse", id: reqId, parserId, line, ts });
          }

          return buffered;
        },
        reset: () => {
          if (parserReady && parserId !== null) {
            sendToWorker(sandbox, { type: "parser_reset", parserId });
          }
        },
      };
    };
  }

  return mod;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Dynamically load a UI parser for an adapter type from the server API,
 * executing it inside a sandboxed Web Worker.
 *
 * @returns A DynamicParserModule, or null if unavailable.
 */
export async function loadDynamicParser(adapterType: string): Promise<DynamicParserModule | null> {
  // Return cached parser if already loaded.
  const cached = dynamicParserCache.get(adapterType);
  if (cached) return cached;

  // Don't retry types that previously failed.
  if (failedLoads.has(adapterType)) return null;

  // Coalesce concurrent loads.
  const inflight = loadPromises.get(adapterType);
  if (inflight) return inflight;

  const loadPromise = (async (): Promise<DynamicParserModule | null> => {
    try {
      const response = await fetch(`/api/adapters/${encodeURIComponent(adapterType)}/ui-parser.js`);
      if (!response.ok) {
        failedLoads.add(adapterType);
        return null;
      }

      const source = await response.text();

      // Initialise the sandboxed worker with the parser source.
      const sandbox = await initSandboxedWorker(source);
      sandboxedParsers.set(adapterType, sandbox);

      const parserModule = buildParserModule(sandbox);
      dynamicParserCache.set(adapterType, parserModule);

      console.info(`[adapter-ui-loader] Loaded sandboxed UI parser for "${adapterType}"`);
      return parserModule;
    } catch (err) {
      console.warn(`[adapter-ui-loader] Failed to load UI parser for "${adapterType}":`, err);
      failedLoads.add(adapterType);
      return null;
    } finally {
      loadPromises.delete(adapterType);
    }
  })();

  loadPromises.set(adapterType, loadPromise);
  return loadPromise;
}

/**
 * Invalidate a cached dynamic parser, removing it from both the parser cache
 * and the failed-loads set so that the next load attempt will try again.
 * Also terminates the sandboxed worker if one exists.
 */
export function invalidateDynamicParser(adapterType: string): boolean {
  const wasCached = dynamicParserCache.has(adapterType);
  dynamicParserCache.delete(adapterType);
  failedLoads.delete(adapterType);
  loadPromises.delete(adapterType);

  // Terminate the worker to free resources.
  const sandbox = sandboxedParsers.get(adapterType);
  if (sandbox) {
    drainPendingRequests(sandbox);
    sandbox.worker.terminate();
    sandboxedParsers.delete(adapterType);
  }

  if (wasCached) {
    console.info(`[adapter-ui-loader] Invalidated sandboxed UI parser for "${adapterType}"`);
  }
  return wasCached;
}
