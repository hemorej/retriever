#!/usr/bin/env node
// Warns (and by default fails CI) when a dependency version introduced by
// this PR's pnpm-lock.yaml was published to npm by an account that hasn't
// published any of that package's recent prior versions. That pattern is
// the signature of a hijacked publisher account / supply-chain compromise
// (see the fake typescript@7.0.2 release that prompted this check — real
// TypeScript releases stop at 6.0.3, but 7.0.2 was published to npm under
// a brand-new releaser name).
//
// This is a heuristic, not proof: legitimate maintainer handoffs happen
// too. Treat a flag as "stop and verify against the project's official
// releases/changelog", not as certain compromise.
//
// Versions published via npm's OIDC-based Trusted Publishing show up as
// publisher "GitHub Actions" with a `trustedPublisher` field on the npm
// user, even though a human maintainer triggered the release from their
// own repo. That's a stronger authenticity signal than a personal token
// (no long-lived credential to steal, tied to the repo via OIDC), so
// those are exempted rather than flagged.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FAIL_ON_WARNING = process.env.FAIL_ON_NEW_PUBLISHER !== "false";
const BASE_REF = process.env.BASE_REF || "origin/main";
const LOOKBACK = 5;

function extractPackagesSection(lockText) {
  const start = lockText.indexOf("\npackages:\n");
  if (start === -1) return "";
  const end = lockText.indexOf("\nsnapshots:\n", start);
  return lockText.slice(start, end === -1 ? undefined : end);
}

function parseLockVersions(lockText) {
  const section = extractPackagesSection(lockText);
  const versions = new Map();
  const re = /^ {2}'?(@[a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w.-]*|[a-zA-Z0-9][\w.-]*)@([\w.+-]+)'?:/gm;
  let m;
  while ((m = re.exec(section))) {
    const [, name, version] = m;
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(version);
  }
  return versions;
}

function getBaseLockfile() {
  try {
    return execSync(`git show ${BASE_REF}:pnpm-lock.yaml`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

async function getPublisherInfo(name, version) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name).replace("%40", "@").replace("%2F", "/")}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const packument = await res.json();
  const versionMeta = packument.versions?.[version];
  const publisher = versionMeta?._npmUser?.name;
  const trustedPublisher = versionMeta?._npmUser?.trustedPublisher;
  const time = packument.time || {};
  const targetTime = time[version] ? new Date(time[version]) : null;
  if (!publisher || !targetTime) return null;

  const priorVersions = Object.keys(time)
    .filter((v) => v !== "created" && v !== "modified" && v !== version)
    .filter((v) => new Date(time[v]) < targetTime)
    .sort((a, b) => new Date(time[b]) - new Date(time[a]))
    .slice(0, LOOKBACK);

  const priorPublishers = new Set(
    priorVersions.map((v) => packument.versions?.[v]?._npmUser?.name).filter(Boolean)
  );

  return { publisher, priorPublishers, trustedPublisher };
}

async function main() {
  const headText = readFileSync("pnpm-lock.yaml", "utf8");
  const baseText = getBaseLockfile();
  const headVersions = parseLockVersions(headText);
  const baseVersions = baseText ? parseLockVersions(baseText) : new Map();

  const changed = [];
  for (const [name, versions] of headVersions) {
    const baseSet = baseVersions.get(name) || new Set();
    for (const version of versions) {
      if (!baseSet.has(version)) changed.push({ name, version });
    }
  }

  if (changed.length === 0) {
    console.log("No new package versions introduced — nothing to check.");
    return;
  }

  console.log(`Checking npm publisher history for ${changed.length} new package version(s)...`);
  const warnings = [];

  for (const { name, version } of changed) {
    let info;
    try {
      info = await getPublisherInfo(name, version);
    } catch (err) {
      console.log(`  skip ${name}@${version}: ${err.message}`);
      continue;
    }
    if (!info || info.priorPublishers.size === 0) continue; // nothing to compare against
    if (info.trustedPublisher) continue; // published via npm OIDC trusted publishing, not a personal token
    if (!info.priorPublishers.has(info.publisher)) {
      warnings.push(
        `${name}@${version} was published by npm user "${info.publisher}", who is not among the ` +
          `last ${LOOKBACK} publisher(s) of this package (previous: ${[...info.priorPublishers].join(", ")}).`
      );
    }
  }

  if (warnings.length > 0) {
    console.log("\nPossible new/unfamiliar package publisher(s) detected:\n");
    for (const w of warnings) {
      console.log(`::warning file=pnpm-lock.yaml::${w}`);
    }
    console.log(
      "\nThis can be a legitimate maintainer transfer, but it's also the exact pattern behind " +
        "hijacked-account supply-chain attacks. Verify the release against the project's official " +
        "GitHub releases/changelog before merging."
    );
    if (FAIL_ON_WARNING) {
      console.log("\nFailing the check (set FAIL_ON_NEW_PUBLISHER=false to warn without blocking).");
      process.exit(1);
    }
  } else {
    console.log("No unfamiliar publishers detected.");
  }
}

main();
