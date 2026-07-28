import {
  lstat,
  readlink,
  realpath,
  stat,
} from "node:fs/promises";
import { basename, dirname, parse, relative, resolve, sep } from "node:path";

export async function pathState(path) {
  const entry = await optionalEntry(path);
  if (entry === null) return null;
  return resolvedState(path, entry);
}

export async function assertNoSymlinkPath(path, label = "Output") {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  const segments = relative(root, absolute).split(sep).filter(Boolean);
  let candidate = root;
  for (const segment of segments) {
    candidate = resolve(candidate, segment);
    const entry = await optionalEntry(candidate);
    if (entry === null) return;
    if (entry.isSymbolicLink()) {
      throw new Error(`${label} must not use a symbolic-link path.`);
    }
  }
}

async function optionalEntry(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function resolvedState(path, entry) {
  try {
    const [resolvedPath, metadata] = await Promise.all([
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
    return resolvedStateFailure(path, entry, error);
  }
}

async function resolvedStateFailure(path, entry, error) {
  if (error?.code !== "ENOENT") throw error;
  if (!entry.isSymbolicLink()) throw error;
  return danglingSymlinkState(path);
}

async function danglingSymlinkState(path) {
  const target = await readlink(path);
  return {
    symbolicLink: true,
    resolvedPath: null,
    linkTargetPath: resolve(dirname(path), target),
    device: null,
    inode: null,
  };
}

export async function canonicalCandidatePath(path, state) {
  if (state !== null) return canonicalStatePath(state);
  return canonicalMissingPath(path);
}

async function canonicalStatePath(state) {
  if (state.resolvedPath !== null) return state.resolvedPath;
  return canonicalMissingPath(state.linkTargetPath);
}

async function canonicalMissingPath(path) {
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
  if (left === null) return false;
  if (right === null) return false;
  return [
    left.resolvedPath === right.resolvedPath,
    sameInode(left, right),
  ].some(Boolean);
}

function sameInode(left, right) {
  return left.device === right.device && left.inode === right.inode;
}

async function optionalRealpath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
