#!/usr/bin/env node
// pnpm blocks install (lifecycle) scripts for any dependency not listed
// under `allowBuilds` in pnpm-workspace.yaml — that's what stops a
// compromised package from running arbitrary code on `pnpm install`.
// Each addition to that list is therefore a deliberate grant of script
// execution and deserves a human look, not a silent merge. This check
// fails the PR whenever allowBuilds gains new entries, so a reviewer has
// to consciously re-run/approve rather than rubber-stamp a lockfile bump.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FAIL_ON_CHANGE = process.env.FAIL_ON_ALLOWBUILDS_CHANGE !== "false";
const BASE_REF = process.env.BASE_REF || "origin/main";

function parseAllowBuilds(text) {
  const start = text.indexOf("allowBuilds:");
  if (start === -1) return new Set();
  const rest = text.slice(start + "allowBuilds:".length);
  const names = new Set();
  const re = /^\s+'?([^:'\s]+)'?:\s*(true|false)\s*$/gm;
  let m;
  while ((m = re.exec(rest))) {
    // Stop once indentation returns to a new top-level key.
    if (!/^\s/.test(rest[m.index])) break;
    if (m[2] === "true") names.add(m[1]);
  }
  return names;
}

function getBaseWorkspaceFile() {
  try {
    return execSync(`git show ${BASE_REF}:pnpm-workspace.yaml`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function main() {
  const headText = readFileSync("pnpm-workspace.yaml", "utf8");
  const baseText = getBaseWorkspaceFile();

  const headAllowed = parseAllowBuilds(headText);
  const baseAllowed = baseText ? parseAllowBuilds(baseText) : new Set();

  const added = [...headAllowed].filter((name) => !baseAllowed.has(name));

  if (added.length === 0) {
    console.log("No new allowBuilds entries — nothing to review.");
    return;
  }

  console.log("New package(s) granted permission to run install scripts:\n");
  for (const name of added) {
    console.log(`::warning file=pnpm-workspace.yaml::${name} was added to allowBuilds — verify why it needs to run install scripts before merging.`);
  }

  if (FAIL_ON_CHANGE) {
    console.log(
      "\nFailing the check so this gets an explicit human review " +
        "(set FAIL_ON_ALLOWBUILDS_CHANGE=false to warn without blocking)."
    );
    process.exit(1);
  }
}

main();
