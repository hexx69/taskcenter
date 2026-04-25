// Unified loading state for the whole app. Three variants:
//   "app"   — first paint, before session/board access resolves. Centered
//             logo with a subtle pulse + a thin indeterminate progress bar.
//             Don't show plain text — the user stares at this for whole seconds.
//   "page"  — inside the shell, when a route's primary query is loading.
//             Skeleton rows so the layout shape is hinted before data lands.
//   "panel" — small inline spinner for cards/lists/dialogs.
//
// All three use existing primitives — no new dep, no new asset.

import { Loader2 } from "lucide-react";

type Variant = "app" | "page" | "panel";

export function AppLoader({
  variant = "panel",
  label,
}: {
  variant?: Variant;
  label?: string;
}) {
  if (variant === "app") {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-background">
        <img
          src="/favicon.svg"
          alt="TaskCenter"
          className="h-14 w-14 animate-pulse opacity-80"
        />
        <div className="relative h-0.5 w-40 overflow-hidden rounded-full bg-border">
          <div className="absolute inset-y-0 left-0 w-1/3 animate-[appLoaderSlide_1.4s_ease-in-out_infinite] bg-foreground/70" />
        </div>
        {label ? (
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
            {label}
          </p>
        ) : null}
        <style>{`
          @keyframes appLoaderSlide {
            0% { transform: translateX(-110%); }
            50% { transform: translateX(140%); }
            100% { transform: translateX(340%); }
          }
        `}</style>
      </div>
    );
  }

  if (variant === "page") {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <p className="text-sm">{label ?? "Loading…"}</p>
      </div>
    );
  }

  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label ?? "Loading…"}
    </span>
  );
}
