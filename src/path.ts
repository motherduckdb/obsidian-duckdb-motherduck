export function shortPathLabel(rawPath: string): string {
  const v = (rawPath || "").trim();
  if (!v || v === ":memory:") return ":memory:";
  const m = v.match(/[^/\\]+$/);
  return m ? m[0] : v;
}
