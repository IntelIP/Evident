import { resolve } from "node:path";

import {
  canonicalCandidatePath,
  pathState,
  sameFile,
} from "./output-safety.mjs";

export async function assertOutputDistinctFromInputs({
  output,
  inputs,
  message = "--out must not alias an input snapshot.",
}) {
  const outputPath = resolve(output);
  const inputPaths = inputs.map((input) => resolve(input));
  const [outputState, inputStates] = await Promise.all([
    pathState(outputPath),
    Promise.all(inputPaths.map(pathState)),
  ]);
  assertOutputIsNotSymbolicLink(outputState);
  assertNoDirectPathAlias(outputPath, inputPaths, message);
  assertNoExistingAlias(outputState, inputStates, message);
  await assertNoCandidateAlias(outputPath, outputState, inputStates, message);
}

function assertOutputIsNotSymbolicLink(outputState) {
  if (outputState?.symbolicLink) {
    throw new Error("--out must not be a symbolic link.");
  }
}

function assertNoDirectPathAlias(outputPath, inputPaths, message) {
  if (inputPaths.some((inputPath) => samePath(inputPath, outputPath))) {
    throw new Error(message);
  }
}

function assertNoExistingAlias(outputState, inputStates, message) {
  if (inputStates.some((inputState) => sameFile(outputState, inputState))) {
    throw new Error(message);
  }
}

async function assertNoCandidateAlias(
  outputPath,
  outputState,
  inputStates,
  message,
) {
  const outputCandidate = await canonicalCandidatePath(outputPath, outputState);
  if (inputStates.some((inputState) => sameCandidate(outputCandidate, inputState))) {
    throw new Error(message);
  }
}

function samePath(left, right) {
  return portablePathKey(left) === portablePathKey(right);
}

function sameCandidate(outputCandidate, inputState) {
  if (inputState?.resolvedPath === undefined) return false;
  return samePath(outputCandidate, inputState.resolvedPath);
}

function portablePathKey(path) {
  return path.normalize("NFC").toLowerCase();
}
