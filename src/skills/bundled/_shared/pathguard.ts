/**
 * Shared path-containment guard for bundled skill scripts.
 *
 * Every file-touching skill resolves the requested path and then checks it
 * stays inside an allowed root. A naive `target.startsWith(root)` also
 * accepts sibling directories that merely share a name prefix: with the
 * workspace `/home/u/ws`, the path `/home/u/ws-evil/secret.txt` starts
 * with `/home/u/ws` and escapes. Compare path segments instead.
 */

import * as path from 'path';

/**
 * True when `target` is `root` itself or lives inside it, comparing whole
 * path segments so a sibling like `/home/u/ws-evil` is rejected for a root
 * of `/home/u/ws`. Both inputs are normalized first; neither needs to
 * exist on disk (use realpath beforehand to guard symlinks).
 */
export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * Convenience for skills that allow several roots: true when `target` is
 * inside ANY of them.
 */
export function isWithinAny(target: string, roots: Iterable<string>): boolean {
  for (const root of roots) {
    if (isWithin(root, target)) return true;
  }
  return false;
}
