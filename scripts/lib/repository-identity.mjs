import { createHash } from "node:crypto";

import { parseGitHubRepositoryRemote } from "./github-repository.mjs";

export async function repositoryIdentity(store, explicitId = null) {
  if (explicitId) return explicitId;
  const remote = await store.gitConfig("remote.origin.url");
  return remote ? normalizeRepositoryRemote(remote) : localRepositoryId(store.repoPath);
}

function normalizeRepositoryRemote(remote) {
  const github = parseGitHubRepositoryRemote(remote);
  if (github) return github.identity;
  if (/^[A-Za-z]:[\\/]/.test(remote) || remote.startsWith("/") || remote.startsWith("\\\\")) {
    return hashedRemote(remote);
  }
  if (remote.includes("://")) {
    try {
      const parsed = new URL(remote);
      if (parsed.protocol === "file:") return hashedRemote(remote);
      return `${parsed.host}${parsed.pathname}`.replace(/^\/+/, "").replace(/\.git$/, "");
    } catch {
      return hashedRemote(remote);
    }
  }
  const scpLike = remote.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  return scpLike ? `${scpLike[1]}/${scpLike[2]}`.replace(/\.git$/, "") : hashedRemote(remote);
}

export function localRepositoryId(repoPath) {
  const normalizedPath = repoPath.replaceAll("\\", "/");
  const name = normalizedPath.split("/").filter(Boolean).at(-1);
  if (name && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) && ![".", ".."].includes(name)) {
    return `local/${name}`;
  }
  return `local/${createHash("sha256").update(normalizedPath).digest("hex").slice(0, 16)}`;
}

function hashedRemote(remote) {
  return `remote/${createHash("sha256").update(remote).digest("hex").slice(0, 16)}`;
}
