import {
  lstat,
  realpath,
  stat,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export async function pathState(path) {
  try {
    const [entry, resolvedPath, metadata] = await Promise.all([
      lstat(path),
      realpath(path),
      stat(path),
    ]);
    return {
      symbolicLink: entry.isSymbolicLink(),
      resolvedPath,
      device: metadata.dev,
      inode: metadata.ino,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function canonicalCandidatePath(path, state) {
  if (state !== null) return state.resolvedPath;
  const suffix = [];
  let candidate = path;
  let resolvedPath = await optionalRealpath(candidate);
  while (resolvedPath === null) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("Output has no resolvable parent.");
    suffix.unshift(basename(candidate));
    candidate = parent;
    resolvedPath = await optionalRealpath(candidate);
  }
  return resolve(resolvedPath, ...suffix);
}

export function sameFile(left, right) {
  if (left === null || right === null) return false;
  return left.resolvedPath === right.resolvedPath
    || (left.device === right.device && left.inode === right.inode);
}

async function optionalRealpath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
