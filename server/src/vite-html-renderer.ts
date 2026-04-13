import fs from "node:fs";
import path from "node:path";

type ViteWatcherEvent = "add" | "change" | "unlink";

export interface ViteWatcherHost {
  watcher?: {
    on?: (event: ViteWatcherEvent, listener: (file: string) => void) => unknown;
    off?: (event: ViteWatcherEvent, listener: (file: string) => void) => unknown;
  };
}

export interface CachedViteHtmlRenderer {
  render(_url: string): Promise<string>;
  dispose(): void;
}

const WATCHER_EVENTS: ViteWatcherEvent[] = ["add", "change", "unlink"];
const MAIN_ENTRY_TAG = '<script type="module" src="/src/main.tsx"></script>';
const VITE_CLIENT_TAG = '<script type="module" src="/@vite/client"></script>';

function injectViteClient(html: string): string {
  if (html.includes(VITE_CLIENT_TAG)) return html;
  if (html.includes(MAIN_ENTRY_TAG)) {
    return html.replace(MAIN_ENTRY_TAG, `${VITE_CLIENT_TAG}\n    ${MAIN_ENTRY_TAG}`);
  }
  return html.replace("</body>", `    ${VITE_CLIENT_TAG}\n  </body>`);
}

export function createCachedViteHtmlRenderer(opts: {
  vite: ViteWatcherHost;
  uiRoot: string;
  brandHtml?: (html: string) => string;
}): CachedViteHtmlRenderer {
  const uiRoot = path.resolve(opts.uiRoot);
  const templatePath = path.resolve(uiRoot, "index.html");
  const brandHtml = opts.brandHtml ?? ((html: string) => html);
  let cachedHtml: string | null = null;

  function loadHtml(): string {
    if (cachedHtml === null) {
      const rawTemplate = fs.readFileSync(templatePath, "utf-8");
      cachedHtml = brandHtml(injectViteClient(rawTemplate));
    }
    return cachedHtml;
  }

  function invalidate(): void {
    cachedHtml = null;
  }

  function onWatchEvent(filePath: string): void {
    const resolvedPath = path.resolve(filePath);
    if (resolvedPath === templatePath || resolvedPath.startsWith(`${uiRoot}${path.sep}`)) {
      invalidate();
    }
  }

  for (const eventName of WATCHER_EVENTS) {
    opts.vite.watcher?.on?.(eventName, onWatchEvent);
  }

  return {
    render(): Promise<string> {
      return Promise.resolve(loadHtml());
    },

    dispose(): void {
      for (const eventName of WATCHER_EVENTS) {
        opts.vite.watcher?.off?.(eventName, onWatchEvent);
      }
    },
  };
}
