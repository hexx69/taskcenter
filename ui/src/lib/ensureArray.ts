// Defensive: API responses sometimes arrive in envelope shapes
// (`{issues:[...]}`) instead of bare arrays. Pages that iterate the value
// (`[...x]`, `.filter`, `.map`) crash when the shape regresses, and the
// `?? []` destructure default doesn't help because the value is a non-array
// object — only `undefined` triggers the default.
//
// Wrap every list-query read in `ensureArray(query.data)` and the page stops
// being one bad envelope away from a white screen. The fix-it-once-then-forget
// pattern, applied at the seam where the data enters React state.

export function ensureArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    // Common single-key envelope shapes returned by the worker (e.g.
    // `{issues:[...]}`, `{users:[...]}`). Pick the first array property
    // we find rather than guessing the key per call site.
    for (const key of Object.keys(value)) {
      const v = (value as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}
