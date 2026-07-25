import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export async function assertOutputBoundary({
  outputs,
  protectedInputs = [],
  protectedRoots = [],
  duplicatePathMessage,
  symbolicLinkMessage,
  outputAliasMessage,
  inputAliasMessage,
  protectedRootMessage,
}) {
  const targets = outputs.map((target) => resolve(target));
  const inputTargets = protectedInputs.map((target) => resolve(target));
  const rootTargets = protectedRoots.map((target) => resolve(target));
  assertUniqueOutputPaths(targets, duplicatePathMessage);
  assertNoProtectedPathMatches(targets, inputTargets, inputAliasMessage);
  const outputIdentities = await Promise.all(targets.map(outputIdentity));
  assertNoSymbolicLinks(outputIdentities, symbolicLinkMessage);
  assertNoIdentityCollision(outputIdentities, outputAliasMessage);
  const rootIdentities = await Promise.all(rootTargets.map(canonicalFuturePath));
  assertNoProtectedRootContains(outputIdentities, rootIdentities, protectedRootMessage);
  const inputIdentities = await Promise.all(
    inputTargets.map((target) => optionalExistingIdentity(target)),
  );
  assertNoInputIdentityCollision(outputIdentities, inputIdentities, inputAliasMessage);
}

export async function outputPathWithinRoot(target, root) {
  const [targetPath, rootPath] = await Promise.all([
    canonicalFuturePath(resolve(target)),
    canonicalFuturePath(resolve(root)),
  ]);
  return pathIsWithin(targetPath, rootPath);
}

function assertUniqueOutputPaths(targets, message) {
  if (new Set(targets).size !== targets.length) throw new Error(message);
}

function assertNoProtectedPathMatches(outputs, inputs, message) {
  if (outputs.some((target) => inputs.includes(target))) throw new Error(message);
}

function assertNoSymbolicLinks(identities, message) {
  if (identities.some((identity) => identity.symbolicLink)) throw new Error(message);
}

function assertNoIdentityCollision(identities, message) {
  if (hasIdentityCollision(identities)) throw new Error(message);
}

function assertNoInputIdentityCollision(outputs, inputs, message) {
  const aliasesInput = outputs.some((output) =>
    inputs.some((input) => input !== null && sameIdentity(output, input))
  );
  if (aliasesInput) throw new Error(message);
}

function assertNoProtectedRootContains(outputs, roots, message) {
  const insideRoot = outputs.some((output) =>
    roots.some((root) => root !== null && pathIsWithin(output.canonicalPath, root))
  );
  if (insideRoot) throw new Error(message);
}

function pathIsWithin(target, root) {
  if (target === null) return false;
  const path = relative(root, target);
  return !pathEscapesRoot(path);
}

function pathEscapesRoot(path) {
  return [path === "..", path.startsWith(`..${sep}`), isAbsolute(path)].some(Boolean);
}

async function outputIdentity(target) {
  const entry = await optionalFilesystemEntry(() => lstat(target));
  if (entry?.isSymbolicLink()) {
    return { canonicalPath: null, inode: null, symbolicLink: true };
  }
  if (!entry) {
    return {
      canonicalPath: await canonicalFuturePath(target),
      inode: null,
      symbolicLink: false,
    };
  }
  return existingIdentity(target);
}

async function canonicalFuturePath(target) {
  try {
    return await realpath(target);
  } catch (error) {
    return canonicalMissingPath(target, error);
  }
}

async function canonicalMissingPath(target, error) {
  if (error?.code !== "ENOENT") throw error;
  const parent = dirname(target);
  if (parent === target) throw error;
  return join(await canonicalFuturePath(parent), basename(target));
}

async function existingIdentity(target) {
  const metadata = await stat(target);
  return {
    canonicalPath: await realpath(target),
    inode: `${metadata.dev}:${metadata.ino}`,
    symbolicLink: false,
  };
}

async function optionalExistingIdentity(target) {
  try {
    return await existingIdentity(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function hasIdentityCollision(identities) {
  return identities.some((identity, index) =>
    identities.slice(index + 1).some((candidate) => sameIdentity(identity, candidate))
  );
}

function sameIdentity(left, right) {
  if (portablePathKey(left.canonicalPath) === portablePathKey(right.canonicalPath)) return true;
  return left.inode !== null && left.inode === right.inode;
}

function portablePathKey(path) {
  return path?.normalize("NFC").toLowerCase() ?? null;
}

async function optionalFilesystemEntry(read) {
  try {
    return await read();
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
