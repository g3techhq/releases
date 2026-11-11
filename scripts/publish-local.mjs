// Publishes a release from a workstation: what publish.yml does in CI.
//
//   node scripts/publish-local.mjs --app <app> --version <x.y.z> --key <app>-updater.key \
//     --file <platform>=<path> [--file ...] [--attach <path> ...] [--notes <text or @file>] \
//     [--source <repo@sha>] [--public-key <file or text>] [--name <App name>] \
//     [--prerelease] [--dry-run]
//
// It signs each file with the app's key, creates the release `<app>-v<version>`
// of g3techhq/releases with `gh` (a draft, then published, never marked
// latest), uploads the files, their signatures and the `--attach` extras, and
// only then writes `apps/<app>/latest.json` and pushes it to main, so no app
// is sent to a file that is not there yet.
//
// Run it from a clean checkout of this repository on main. `--dry-run` signs
// into a temporary folder and prints what it would do, creating nothing.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest } from "./release-manifest.mjs";
import {
  parseSecret,
  prehash,
  publicKeyText,
  signatureText,
  verifySignatureText,
} from "./release-signing.mjs";

export const REPO = "g3techhq/releases";
export const CHANNEL = "latest";
export const USAGE =
  "Usage: node scripts/publish-local.mjs --app <app> --version <x.y.z> --key <path to <app>-updater.key> " +
  "--file <platform>=<path> [--file ...] [--attach <path> ...] [--notes <text or @file>] " +
  "[--source <repo@sha>] [--public-key <file|text>] [--name <App name>] [--prerelease] [--dry-run]";

const APP = /^[a-z0-9][a-z0-9-]*$/;
const SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const FILE_NAME = /^[A-Za-z0-9._-]+$/;
const SOURCE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?@[0-9a-f]{7,40}$/;

const VALUE_OPTIONS = new Set(["app", "version", "key", "notes", "source", "public-key", "name"]);
const LIST_OPTIONS = new Set(["file", "attach"]);
const FLAGS = new Set(["prerelease", "dry-run", "help"]);

/** The command line as options. Throws on anything it does not know. */
export function parseArgs(argv) {
  const options = { files: [], attach: [], prerelease: false, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument ${argument}`);
    let name = argument.slice(2);
    let value;
    const equals = name.indexOf("=");
    if (equals >= 0) {
      value = name.slice(equals + 1);
      name = name.slice(0, equals);
    }
    if (FLAGS.has(name)) {
      if (value !== undefined) throw new Error(`--${name} takes no value`);
      if (name === "dry-run") options.dryRun = true;
      else options[name] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name) && !LIST_OPTIONS.has(name)) {
      throw new Error(`Unknown option --${name}`);
    }
    if (value === undefined) {
      value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
      index += 1;
    }
    if (name === "file") {
      const split = value.indexOf("=");
      if (split < 1 || split === value.length - 1) {
        throw new Error(`--file expects <platform>=<path>, got ${value}`);
      }
      options.files.push({ platform: value.slice(0, split), path: value.slice(split + 1) });
    } else if (name === "attach") {
      options.attach.push(value);
    } else {
      if (options[name] !== undefined) throw new Error(`--${name} is given twice`);
      options[name] = value;
    }
  }
  return options;
}

/** A semantic version's parts, or undefined. */
export function parseSemver(version) {
  const match = SEMVER.exec(version);
  if (!match) return undefined;
  return {
    numbers: match.slice(1, 4).map(Number),
    pre: match[4] ? match[4].split(".") : [],
  };
}

/** Semver precedence: negative, zero or positive, as a comparator. */
export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left) throw new Error(`${a} is not a semantic version`);
  if (!right) throw new Error(`${b} is not a semantic version`);
  for (let index = 0; index < 3; index += 1) {
    const difference = left.numbers[index] - right.numbers[index];
    if (difference !== 0) return Math.sign(difference);
  }
  // A pre-release sorts before its release.
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumber = /^\d+$/.test(x);
    const yNumber = /^\d+$/.test(y);
    if (xNumber && yNumber) {
      const difference = Number(x) - Number(y);
      if (difference !== 0) return Math.sign(difference);
    } else if (xNumber !== yNumber) {
      return xNumber ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** "ad-sentinel" as "Ad Sentinel", for the release title. */
export function displayName(app) {
  return app
    .split("-")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

export const releaseTag = (app, version) => `${app}-v${version}`;

/** Where GitHub serves a release's assets, which latest.json points at. */
export const downloadBase = (app, version, repo = REPO) =>
  `https://github.com/${repo}/releases/download/${releaseTag(app, version)}`;

/** Whether a public key file (or a source file holding one) names this key's public key. */
export function keyMatches(key, publicKeySource) {
  const line = publicKeyText(key).split("\n")[1];
  return publicKeySource.includes(line);
}

/**
 * Checks the options and works out the release, without touching the disk
 * or the network. `notesText` is --notes after reading an @file.
 */
export function planRelease(options, notesText) {
  for (const required of ["app", "version", "key"]) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  if (!APP.test(options.app)) {
    throw new Error(`--app must be lowercase letters, digits and hyphens: ${options.app}`);
  }
  const version = options.version.replace(/^v/, "");
  if (!parseSemver(version)) throw new Error(`--version is not semver: ${options.version}`);
  if (options.files.length === 0) throw new Error("Pass at least one --file <platform>=<path>");
  if (options.source !== undefined && !SOURCE.test(options.source)) {
    throw new Error(`--source expects <repo>@<commit sha>, got ${options.source}`);
  }
  const names = new Set();
  const asset = (path) => {
    const name = basename(path);
    if (!FILE_NAME.test(name)) {
      throw new Error(`${name}: use only letters, digits, dots, hyphens and underscores`);
    }
    if (name.endsWith(".minisig")) throw new Error(`${name}: signatures are made here`);
    if (names.has(name)) throw new Error(`${name} is given twice`);
    names.add(name);
    return name;
  };
  const platforms = new Set();
  const files = options.files.map(({ platform, path }) => {
    if (platforms.has(platform)) throw new Error(`${platform} is listed twice`);
    platforms.add(platform);
    return { platform, path, name: asset(path) };
  });
  const attach = options.attach.map((path) => ({ path, name: asset(path) }));
  const app = options.app;
  const tag = releaseTag(app, version);
  const notes = notesText?.trim() || undefined;
  const pageNotes = [
    notes ?? `${app} ${version}`,
    options.source && `Built from ${options.source}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    app,
    version,
    tag,
    title: `${options.name ?? displayName(app)} ${version}`,
    baseUrl: downloadBase(app, version),
    manifestPath: `apps/${app}/${CHANNEL}.json`,
    commitMessage: `release(${app}): ${version} on ${CHANNEL}`,
    files,
    attach,
    notes,
    pageNotes,
    prerelease: options.prerelease,
  };
}

/** Refuses a version that is not newer than the one apps already have. */
export function checkNewer(version, current) {
  if (current && compareSemver(version, current.version) <= 0) {
    throw new Error(`${version} is not newer than ${current.version}, the current ${CHANNEL}.json`);
  }
}

/** latest.json for the release, from the files' signatures. */
export function releaseManifest(plan, signatures, pubDate, existing) {
  return buildManifest({
    version: plan.version,
    notes: plan.notes,
    pubDate,
    baseUrl: plan.baseUrl,
    downloads: plan.files.map(({ platform, name }) => ({
      platform,
      fileName: name,
      signature: signatures[name],
    })),
    existing,
  });
}

/** The `gh` arguments that create the draft and then publish it. */
export function releaseCommands(plan, notesFile, uploads) {
  const create = ["release", "create", plan.tag, "--repo", REPO, "--target", "main", "--draft"];
  create.push("--latest=false", "--title", plan.title, "--notes-file", notesFile);
  if (plan.prerelease) create.push("--prerelease");
  create.push(...uploads);
  const publish = ["release", "edit", plan.tag, "--repo", REPO, "--draft=false", "--latest=false"];
  return { create, publish };
}

function run(command, args, { cwd, allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result;
}

const NOT_FOUND = /not found|HTTP 404/i;

/** Whether a tag or a release (drafts included) already has this name. */
function tagTaken(tag) {
  const ref = run("gh", ["api", `repos/${REPO}/git/ref/tags/${tag}`], { allowFailure: true });
  if (ref.status === 0) return `the tag ${tag} exists`;
  if (!NOT_FOUND.test(ref.stderr))
    throw new Error(`Could not check the tag ${tag}: ${ref.stderr.trim()}`);
  const release = run("gh", ["release", "view", tag, "--repo", REPO, "--json", "isDraft"], {
    allowFailure: true,
  });
  if (release.status === 0) return `a release ${tag} exists (perhaps a draft)`;
  if (!NOT_FOUND.test(release.stderr)) {
    throw new Error(`Could not check the release ${tag}: ${release.stderr.trim()}`);
  }
  return undefined;
}

function prepareCheckout(root, dryRun) {
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root }).stdout.trim();
  const dirty = run("git", ["status", "--porcelain"], { cwd: root }).stdout.trim();
  const problems = [];
  if (branch !== "main") problems.push(`the checkout is on ${branch}, not main`);
  if (dirty) problems.push(`the checkout has changes:\n${dirty}`);
  if (problems.length > 0) {
    if (!dryRun) throw new Error(`${root}: ${problems.join("; ")}`);
    for (const problem of problems) console.warn(`warning: ${problem} (a real run refuses)`);
  }
  run("git", ["fetch", "--quiet", "origin", "main"], { cwd: root });
  if (!dryRun) run("git", ["pull", "--rebase", "--quiet", "origin", "main"], { cwd: root });
}

function currentRelease(root, manifestPath) {
  const shown = run("git", ["show", `origin/main:${manifestPath}`], {
    cwd: root,
    allowFailure: true,
  });
  return shown.status === 0 ? JSON.parse(shown.stdout) : undefined;
}

function pushManifest(root, plan) {
  run("git", ["add", plan.manifestPath], { cwd: root });
  run("git", ["commit", "--quiet", "-m", plan.commitMessage, "--", plan.manifestPath], {
    cwd: root,
  });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    // Apps publish into one branch, so another may have pushed meanwhile.
    const pulled = run("git", ["pull", "--rebase", "--quiet", "origin", "main"], {
      cwd: root,
      allowFailure: true,
    });
    if (pulled.status === 0) {
      const pushed = run("git", ["push", "--quiet", "origin", "HEAD:main"], {
        cwd: root,
        allowFailure: true,
      });
      if (pushed.status === 0) return;
    }
    if (attempt < 5) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 5000);
  }
  throw new Error(
    `Committed ${plan.manifestPath} but could not push it after five attempts; push it by hand`,
  );
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const notesText = options.notes?.startsWith("@")
    ? readFileSync(options.notes.slice(1), "utf8")
    : options.notes;
  const plan = planRelease(options, notesText);
  for (const { path } of [...plan.files, ...plan.attach]) {
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`No file ${path}`);
  }
  const key = parseSecret(readFileSync(options.key, "utf8"));
  if (options["public-key"] !== undefined) {
    const given = options["public-key"];
    const source = existsSync(given) ? readFileSync(given, "utf8") : given;
    // An app refuses every file signed by another key.
    if (!keyMatches(key, source)) throw new Error(`${options.key} does not belong to --public-key`);
  }

  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  prepareCheckout(root, options.dryRun);
  const current = currentRelease(root, plan.manifestPath);
  checkNewer(plan.version, current);
  const taken = tagTaken(plan.tag);
  if (taken) throw new Error(`Refusing to publish: ${taken} on ${REPO}`);

  const work = mkdtempSync(join(tmpdir(), "g3-publish-"));
  try {
    const signatures = {};
    const uploads = [];
    for (const file of plan.files) {
      const digest = await prehash(file.path);
      const text = signatureText(key, digest, file.name);
      if (!verifySignatureText(publicKeyText(key), digest, text)) {
        throw new Error(`The signature of ${file.name} does not verify`);
      }
      const signaturePath = join(work, `${file.name}.minisig`);
      writeFileSync(signaturePath, text);
      signatures[file.name] = text;
      uploads.push(file.path, signaturePath);
      console.log(`Signed ${file.path}`);
    }
    uploads.push(...plan.attach.map(({ path }) => path));
    const notesFile = join(work, "notes.md");
    writeFileSync(notesFile, `${plan.pageNotes}\n`);
    const pubDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const manifest = releaseManifest(plan, signatures, pubDate, current);
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const { create, publish } = releaseCommands(plan, notesFile, uploads);

    if (options.dryRun) {
      console.log(`\nDry run: nothing was created. A real run would:`);
      console.log(`  gh ${create.join(" ")}`);
      console.log(`  gh ${publish.join(" ")}`);
      console.log(`  write ${plan.manifestPath}:\n${manifestText}`);
      console.log(`  git commit -m "${plan.commitMessage}" and push to origin main`);
      return;
    }

    run("gh", create);
    try {
      run("gh", publish);
      const view = run("gh", ["release", "view", plan.tag, "--repo", REPO, "--json", "assets"]);
      const uploaded = new Set(JSON.parse(view.stdout).assets.map(({ name }) => name));
      const missing = uploads.map((path) => basename(path)).filter((name) => !uploaded.has(name));
      if (missing.length > 0) throw new Error(`The release is missing ${missing.join(", ")}`);
    } catch (error) {
      throw new Error(
        `${error.message}\nThe release ${plan.tag} was created but ${plan.manifestPath} was not ` +
          `written. Fix it on GitHub, or remove it: gh release delete ${plan.tag} --repo ${REPO} --cleanup-tag`,
      );
    }
    console.log(`Published https://github.com/${REPO}/releases/tag/${plan.tag}`);

    mkdirSync(dirname(join(root, plan.manifestPath)), { recursive: true });
    writeFileSync(join(root, plan.manifestPath), manifestText);
    pushManifest(root, plan);
    console.log(`Pushed ${plan.manifestPath}: ${Object.keys(manifest.platforms).join(", ")}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    if (process.argv.length <= 2) console.error(USAGE);
    process.exit(1);
  });
}
