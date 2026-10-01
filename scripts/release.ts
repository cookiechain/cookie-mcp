/**
 * Release runner — automates README "Development › Release", end to end:
 *
 *   yarn release <X.Y.Z | patch | minor | major> [--dry-run] [--yes]
 *
 *   1. bump package.json, server.json (top-level + packages[0]) and src/version.ts
 *   2. CHANGELOG: `# Unreleased` → `# [X.Y.Z](…/releases/tag/vX.Y.Z)` + date, fresh `# Unreleased`
 *   3. gate: `mcp-publisher validate`, `yarn test`, strict smoke (EXPECTED_TOOLS + README in sync)
 *   4. build + tarball check (only dist/**, README.md, LICENSE, package.json; no absolute paths)
 *   5. commit `Release X.Y.Z` and tag `vX.Y.Z` locally — then STOP and print the push command.
 *      The script never pushes the protected branch; you push, then re-run the same command.
 *   6. GitHub release from the CHANGELOG section
 *   7. npm publish, then `npm view` + a pinned `npx -y cookie-mcp@X.Y.Z` boot from an empty dir
 *   8. MCP Registry publish, then confirm the registry serves the version
 *
 * Requires MCP_GITHUB_TOKEN: a classic GitHub PAT with `read:org` from an owner of the cookiechain
 * org. `mcp-publisher login github`'s device flow can't see an org that restricts OAuth apps, so it
 * only grants `io.github.<user>/*` and the publish 403s. Set it without leaving it in history:
 *   read -s MCP_GITHUB_TOKEN && export MCP_GITHUB_TOKEN
 *
 * Re-running with the same explicit version resumes: every step checks whether it already happened
 * (version already bumped, tag exists, origin has it, release exists, npm/registry have it) and
 * skips it. `--dry-run` runs the preflight, gate and tarball check on the current tree and changes
 * nothing. Nothing is published until you confirm (or pass `--yes`).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const PKG = "cookie-mcp";
const MCP_NAME = "io.github.cookiechain/cookie-mcp";
const REPO_URL = "https://github.com/cookiechain/cookie-mcp";
const REGISTRY = "https://registry.modelcontextprotocol.io/v0.1/servers";
const BRANCH = "main";
const RELEASE_FILES = ["package.json", "server.json", "CHANGELOG.md", "src/version.ts"];
const TARBALL_ALLOWED = [/^dist\//, /^README\.md$/, /^LICENSE$/, /^package\.json$/];

// Yarn 1 `run` injects its config as npm_config_* — notably registry=registry.yarnpkg.com, where the
// npm token is not valid (`npm whoami` fails) and `npm publish` would go. Let npm read ~/.npmrc.
if (process.env.npm_config_user_agent?.startsWith("yarn")) {
  for (const k of Object.keys(process.env)) if (/^npm_config_/i.test(k)) delete process.env[k];
}

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const assumeYes = argv.includes("--yes");
const target = argv.find((a) => !a.startsWith("--"));

// ── helpers ────────────────────────────────────────────────────────────────────────────────────

class ReleaseError extends Error {}
const fail = (msg: string): never => {
  throw new ReleaseError(msg);
};

const step = (title: string) => console.log(`\n▶ ${title}`);
const skip = (why: string) => console.log(`  ↷ skipped: ${why}`);
const ok = (msg: string) => console.log(`  ✓ ${msg}`);

/** Run a command with inherited stdio; throw on non-zero exit. */
function run(cmd: string, args: string[]) {
  console.log(`  $ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) fail(`\`${cmd} ${args.join(" ")}\` exited with ${r.status ?? r.signal}`);
}

/** Run a command and capture stdout; `null` on non-zero exit (for probes). */
function probe(cmd: string, args: string[]): string | null {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function capture(cmd: string, args: string[]): string {
  return probe(cmd, args) ?? fail(`\`${cmd} ${args.join(" ")}\` failed`);
}

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
function parseSemver(v: string): [number, number, number] {
  const m = SEMVER.exec(v) ?? fail(`not a plain X.Y.Z version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function cmpSemver(a: string, b: string): number {
  const [x, y] = [parseSemver(a), parseSemver(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
function bump(v: string, kind: string): string {
  const [maj, min, pat] = parseSemver(v);
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

async function confirm(question: string): Promise<void> {
  if (assumeYes) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`\n? ${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") fail("aborted — nothing past this point was done");
}

const npmHas = (v: string) => probe("npm", ["view", `${PKG}@${v}`, "version"]) === v;

async function registryHas(v: string): Promise<boolean> {
  const res = await fetch(`${REGISTRY}/${encodeURIComponent(MCP_NAME)}/versions/${v}`);
  if (res.status === 404) return false;
  if (!res.ok) fail(`MCP Registry lookup returned HTTP ${res.status}`);
  return true;
}

// ── CHANGELOG ──────────────────────────────────────────────────────────────────────────────────

const UNRELEASED = /^# \[?Unreleased\]?[ \t]*$/m;
const releasedHeading = (v: string) => `# [${v}](${REPO_URL}/releases/tag/v${v})`;

/** Body of the top-level `# …` section whose heading line starts with `headingStart`. */
function changelogSection(md: string, headingStart: string): string | null {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.startsWith(headingStart));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^# /.test(l));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

/** The release notes: the version's section without its `_Month D, YYYY_` date line. */
function releaseNotes(md: string, v: string): string {
  const body = changelogSection(md, releasedHeading(v)) ?? fail(`CHANGELOG has no ${v} section`);
  return body.replace(/^_[^_\n]+_\s*\n/, "").trim();
}

function today(): string {
  return new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

// ── steps ──────────────────────────────────────────────────────────────────────────────────────

function resolveVersion(): string {
  if (!target) fail("usage: yarn release <X.Y.Z | patch | minor | major> [--dry-run] [--yes]");
  const published = capture("npm", ["view", PKG, "version"]);
  if (["patch", "minor", "major"].includes(target!)) {
    const v = bump(published, target!);
    console.log(`  ${target} of npm latest ${published} → ${v}`);
    return v;
  }
  parseSemver(target!);
  if (cmpSemver(target!, published) <= 0 && !npmHas(target!)) {
    fail(`${target} is not above npm latest ${published}`);
  }
  return target!;
}

/** origin has the release commit on BRANCH and the tag. */
function originHasRelease(version: string): boolean {
  const remoteTag = probe("git", ["ls-remote", "--exit-code", "origin", `refs/tags/v${version}`]);
  return (
    !!remoteTag &&
    probe("git", ["merge-base", "--is-ancestor", `v${version}`, `origin/${BRANCH}`]) !== null
  );
}

function preflight(version: string) {
  step("Preflight");
  const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== BRANCH) fail(`on branch ${branch}; releases are cut from ${BRANCH}`);

  run("git", ["fetch", "--quiet", "origin", BRANCH]);
  if (probe("git", ["merge-base", "--is-ancestor", `origin/${BRANCH}`, "HEAD"]) === null) {
    fail(`HEAD is behind origin/${BRANCH} — pull first`);
  }
  // Ahead of origin by nothing, or (when resuming) by exactly this release's commit.
  const ahead = capture("git", ["rev-list", `origin/${BRANCH}..HEAD`])
    .split("\n")
    .filter(Boolean);
  const headSubject = capture("git", ["log", "-1", "--format=%s"]);
  if (ahead.length > 1 || (ahead.length === 1 && headSubject !== `Release ${version}`)) {
    fail(`HEAD has unpushed commits besides a "Release ${version}" commit — land them first`);
  }

  // NUL-separated `XY path` entries; not via capture(), whose trim() would eat the leading status space.
  const dirty = spawnSync("git", ["status", "--porcelain", "-z"], { encoding: "utf8" })
    .stdout.split("\0")
    .filter(Boolean)
    .map((l) => l.slice(3));
  const stray = dirty.filter((f) => !RELEASE_FILES.includes(f));
  if (stray.length) fail(`uncommitted changes outside the release files: ${stray.join(", ")}`);

  const pkg = readJson("package.json");
  if (pkg.mcpName !== MCP_NAME) fail(`package.json mcpName must stay ${MCP_NAME}`);

  const changelog = readFileSync("CHANGELOG.md", "utf8");
  if (!changelog.includes(releasedHeading(version))) {
    const heading = changelog.match(UNRELEASED)?.[0] ?? fail("CHANGELOG has no `# Unreleased`");
    if (!changelogSection(changelog, heading)) {
      fail("CHANGELOG `# Unreleased` section is empty — nothing to release");
    }
  }

  // Logins only matter for the publish half, so a dry run reports them instead of stopping.
  const needLogin = (msg: string) => (dryRun ? console.log(`  ⚠ ${msg}`) : fail(msg));
  if (probe("gh", ["auth", "status"]) === null)
    needLogin("gh is not logged in — run `gh auth login`");
  if (probe("mcp-publisher", ["--help"]) === null) {
    fail("mcp-publisher missing — `brew install mcp-publisher`");
  }
  if (!npmHas(version)) {
    const who = probe("npm", ["whoami"]);
    // npm reports an unauthenticated publish as E404, so catch a dead token up front.
    if (!who) needLogin("npm is not logged in (`npm whoami` failed) — run `npm login`");
    else ok(`npm user: ${who}`);
  }
  ok(`releasing ${PKG}@${version} from ${BRANCH}`);
}

function bumpVersion(version: string) {
  step(`Bump version to ${version}`);
  const pkg = readJson("package.json");
  const server = readJson("server.json");
  const versionTs = readFileSync("src/version.ts", "utf8");
  if (
    pkg.version === version &&
    server.version === version &&
    server.packages?.[0]?.version === version &&
    versionTs.includes(`"${version}"`)
  ) {
    return skip("already at this version");
  }
  if (dryRun) return skip("dry run");

  pkg.version = version;
  server.version = version;
  server.packages[0].version = version;
  writeJson("package.json", pkg);
  writeJson("server.json", server);
  const nextTs = versionTs.replace(/VERSION = "[^"]*"/, `VERSION = "${version}"`);
  if (nextTs === versionTs) fail('src/version.ts: could not find `VERSION = "…"`');
  writeFileSync("src/version.ts", nextTs);
  ok("package.json, server.json (×2), src/version.ts");
}

function updateChangelog(version: string) {
  step("CHANGELOG");
  const md = readFileSync("CHANGELOG.md", "utf8");
  if (md.includes(releasedHeading(version))) return skip(`already has the ${version} section`);
  if (dryRun) return skip("dry run");
  writeFileSync(
    "CHANGELOG.md",
    md.replace(UNRELEASED, `# Unreleased\n\n${releasedHeading(version)}\n\n_${today()}_`),
  );
  ok(`# Unreleased → ${releasedHeading(version)}, fresh # Unreleased above it`);
}

function gate() {
  step("Gate");
  run("mcp-publisher", ["validate"]);
  run("yarn", ["test"]);
  run("npx", ["tsx", "scripts/smoke.ts", "--strict"]);
}

function checkTarball(version: string) {
  step("Tarball");
  run("yarn", ["build"]);
  const packed = JSON.parse(capture("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]));
  const files: string[] = packed[0].files.map((f: { path: string }) => f.path);
  const stray = files.filter((f) => !TARBALL_ALLOWED.some((re) => re.test(f)));
  if (stray.length) fail(`tarball carries unexpected files: ${stray.join(", ")}`);
  if (!dryRun && packed[0].version !== version) {
    fail(`tarball is ${packed[0].version}, expected ${version}`);
  }
  const leaks = files.filter((f) => /\/(Users|home)\/[^/\s"'`]+\//.test(readFileSync(f, "utf8")));
  if (leaks.length) fail(`absolute home paths inside: ${leaks.join(", ")}`);
  ok(`${files.length} files, all under dist/ + README/LICENSE/package.json, no absolute paths`);
}

function commitAndTag(version: string) {
  step("Commit + tag (local)");
  const tag = `v${version}`;
  // Tagged and in HEAD's history: the release commit is done, even with commits stacked on top.
  const tagCommit = probe("git", ["rev-parse", `${tag}^{commit}`]);
  if (tagCommit && probe("git", ["merge-base", "--is-ancestor", tagCommit, "HEAD"]) !== null) {
    return skip(`${tag} (${tagCommit.slice(0, 7)}) is already in HEAD's history`);
  }
  if (capture("git", ["log", "-1", "--format=%s"]) === `Release ${version}`) {
    skip("HEAD is already the release commit");
  } else {
    run("git", ["add", ...RELEASE_FILES]);
    run("git", ["commit", "-m", `Release ${version}`]);
  }
  const tagged = probe("git", ["rev-parse", `${tag}^{commit}`]);
  if (tagged && tagged !== capture("git", ["rev-parse", "HEAD"])) {
    fail(`tag ${tag} already exists on another commit (${tagged.slice(0, 7)})`);
  }
  if (tagged) skip(`${tag} already points at HEAD`);
  else run("git", ["tag", tag]);
}

function githubRelease(version: string) {
  step("GitHub release");
  const tag = `v${version}`;
  if (probe("gh", ["release", "view", tag, "--json", "tagName"]) !== null) {
    return skip(`${tag} exists`);
  }
  const dir = mkdtempSync(join(tmpdir(), "cookie-mcp-release-"));
  const notes = join(dir, "notes.md");
  writeFileSync(notes, releaseNotes(readFileSync("CHANGELOG.md", "utf8"), version) + "\n");
  try {
    run("gh", [
      "release",
      "create",
      tag,
      "--title",
      version,
      "--notes-file",
      notes,
      "--verify-tag",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function npmPublish(version: string) {
  step("npm publish");
  if (npmHas(version)) skip(`${PKG}@${version} is already on npm`);
  else run("npm", ["publish"]);

  // npm says a fresh version "may take a few minutes to become available"; over a minute is normal.
  for (let i = 0; !npmHas(version); i++) {
    if (i >= 60) fail(`npm view ${PKG}@${version} still empty after 5 minutes`);
    if (i % 6 === 0) console.log("  … waiting for npm to serve the new version");
    await new Promise((r) => setTimeout(r, 5_000));
  }
  ok(`npm view ${PKG}@${version} → ${version}`);
  run("npx", ["tsx", "scripts/smoke.ts", "--pkg", `${PKG}@${version}`]);
}

async function registryPublish(version: string) {
  step("MCP Registry");
  if (await registryHas(version)) return skip(`${MCP_NAME}@${version} is already listed`);
  // Logs in with MCP_GITHUB_TOKEN (checked at startup) — the PAT, not a stale device-flow login.
  run("mcp-publisher", ["login", "github"]);
  const publish = spawnSync("mcp-publisher", ["publish"], { stdio: "inherit" });
  if (publish.status !== 0) {
    fail(
      "registry publish failed — a 403 for the org namespace means MCP_GITHUB_TOKEN is not a " +
        `classic PAT with \`read:org\` from an owner of the ${MCP_NAME.split("/")[0]} org`,
    );
  }
  if (!(await registryHas(version))) fail(`registry does not serve ${version} after publishing`);
  ok(`${MCP_NAME}@${version} is live on the MCP Registry`);
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.MCP_GITHUB_TOKEN) {
    fail(
      "MCP_GITHUB_TOKEN is not set — the MCP Registry publish needs a classic GitHub PAT with " +
        "`read:org`. Run `read -s MCP_GITHUB_TOKEN && export MCP_GITHUB_TOKEN`, then re-run",
    );
  }
  const version = resolveVersion();
  preflight(version);
  bumpVersion(version);
  updateChangelog(version);
  gate();
  checkTarball(version);

  if (dryRun) {
    console.log(`\n✅ dry run passed — \`yarn release ${version}\` would cut it`);
    return;
  }

  commitAndTag(version);

  if (!originHasRelease(version)) {
    console.log("\n  Release notes:\n");
    console.log(
      releaseNotes(readFileSync("CHANGELOG.md", "utf8"), version).replace(/^/gm, "    │ "),
    );
    console.log(
      `\n⏸  Committed and tagged locally. Review it, push it yourself, then re-run to publish:\n\n` +
        `    git push --atomic origin HEAD:refs/heads/${BRANCH} refs/tags/v${version}\n` +
        `    yarn release ${version}\n`,
    );
    return;
  }

  await confirm(
    `origin has v${version}. Create the GitHub release and publish to npm + MCP Registry?`,
  );
  githubRelease(version);
  await npmPublish(version);
  await registryPublish(version);

  console.log(`\n✅ ${PKG}@${version} released — npm, GitHub and the MCP Registry are in sync`);
}

main().catch((e) => {
  console.error(`\n❌ release: ${e instanceof Error ? e.message : e}`);
  if (!(e instanceof ReleaseError)) console.error(e);
  console.error("   Fix it and re-run the same command — finished steps are skipped.");
  process.exit(1);
});
