import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export async function writeOutputPair(outputs) {
  const entries = outputs.map(({ path, content }) => ({
    target: resolve(path),
    content,
    staged: null,
    backup: null,
    published: false,
  }));
  await assertRegularTargets(entries);
  try {
    for (const entry of entries) await stageEntry(entry);
    for (const entry of entries) await publishEntry(entry);
  } catch (error) {
    await Promise.allSettled(entries.map(rollbackEntry));
    throw error;
  }
  await Promise.all(entries.map(removeBackup));
}

async function assertRegularTargets(entries) {
  const metadata = await Promise.all(entries.map((entry) => optionalLstat(entry.target)));
  if (metadata.some((item) => item !== null && !item.isFile())) {
    throw new Error("Analytics outputs must be regular files.");
  }
}

async function stageEntry(entry) {
  await mkdir(dirname(entry.target), { recursive: true });
  entry.staged = siblingPath(entry.target, "stage");
  await writeFile(entry.staged, entry.content, { flag: "wx" });
}

async function publishEntry(entry) {
  if (await optionalLstat(entry.target)) {
    entry.backup = siblingPath(entry.target, "backup");
    await rename(entry.target, entry.backup);
  }
  await rename(entry.staged, entry.target);
  entry.staged = null;
  entry.published = true;
}

async function rollbackEntry(entry) {
  if (entry.published) await rm(entry.target, { force: true });
  if (entry.backup) await rename(entry.backup, entry.target);
  if (entry.staged) await rm(entry.staged, { force: true });
}

async function removeBackup(entry) {
  if (entry.backup) await rm(entry.backup, { force: true });
}

function siblingPath(target, kind) {
  return join(dirname(target), `.${basename(target)}.tabellio-${kind}-${randomUUID()}`);
}

async function optionalLstat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
