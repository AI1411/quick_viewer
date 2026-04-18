const selfWritePaths = new Map<string, number>();
const SUPPRESS_MS = 2000;

export function markSelfWrite(path: string) {
  selfWritePaths.set(path, Date.now());
}

export function isSelfWrite(path: string): boolean {
  const ts = selfWritePaths.get(path);
  if (ts == null) return false;
  if (Date.now() - ts < SUPPRESS_MS) return true;
  selfWritePaths.delete(path);
  return false;
}
