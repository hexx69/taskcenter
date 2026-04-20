import { definePlugin, runWorker, type PluginMemoryProvider } from "@paperclipai/plugin-sdk";
import { QMD_PLUGIN_DATA_DIR_ENV, QMD_MEMORY_PROVIDER_KEY } from "./constants.js";
import { checkQmdMemoryHealth, createQmdMemoryProvider, resolveQmdMemoryDataDir } from "./lib/provider.js";

export function createQmdMemoryPlugin(opts?: {
  createProvider?: () => PluginMemoryProvider;
}) {
  return definePlugin({
    async setup(ctx) {
      ctx.memoryProviders.register(
        QMD_MEMORY_PROVIDER_KEY,
        opts?.createProvider?.() ?? createQmdMemoryProvider(),
      );
      ctx.logger.info("Registered QMD memory provider", {
        providerKey: QMD_MEMORY_PROVIDER_KEY,
        dataDir: resolveQmdMemoryDataDir(),
      });
    },

    async onHealth() {
      const configuredDataDir = process.env[QMD_PLUGIN_DATA_DIR_ENV] ?? null;
      const health = await checkQmdMemoryHealth();
      const hasError = health.checks.some((check) => check.status === "error");
      const hasWarning = health.checks.some((check) => check.status === "warning");
      return {
        status: hasError ? "error" : hasWarning ? "degraded" : "ok",
        message: hasError
          ? "QMD memory provider has health check failures"
          : configuredDataDir
            ? "QMD memory provider is ready"
            : "QMD memory provider is ready with fallback local data dir",
        details: {
          dataDir: health.dataDir,
          usingFallbackDataDir: configuredDataDir === null,
          checks: health.checks,
        },
      };
    },
  });
}

const plugin = createQmdMemoryPlugin();

export default plugin;
runWorker(plugin, import.meta.url);
