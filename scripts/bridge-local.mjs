// Points an app's apps/<app>/latest.json here at a release in another
// repository, for an app that moved its releases out of g3techhq/releases.
//
//   node scripts/bridge-local.mjs --app <app> --from <owner/name> [--tag <tag>] [--dry-run]
//
// It reads the latest.json asset of that repository's release (the latest
// one, or `--tag`), which publish-local.mjs `--manifest asset` uploaded, and
// writes it here unchanged: the same version, notes, URLs and signatures. So
// installs still checking this repository find the release and download it
// from its new home, and once updated check there themselves.
//
// It refuses a file whose URLs are not that repository's release downloads,
// a version not newer than the current latest.json here, and any URL that
// does not download. Then it commits `release(<app>): <version> on latest
// from <repo>` and pushes to main. Run it from a clean checkout on main.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHANNEL,
  checkNewer,
  currentRelease,
  fetchRelease,
  latestAssetUrl,
  MANIFEST_ASSET,
  parseSemver,
  prepareCheckout,
  pushManifest,
} from "./publish-local.mjs";

export const USAGE =
  "Usage: node scripts/bridge-local.mjs --app <app> --from <owner/name> [--tag <tag>] [--dry-run]";

const APP = /^[a-z0-9][a-z0-9-]*$/;
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The command line as options. Throws on anything it does not know. */
export function parseBridgeArgs(argv) {
  const options = { dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--help") options.help = true;
    else if (["--app", "--from", "--tag"].includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`${argument} needs a value`);
      options[argument.slice(2)] = value;
      index += 1;
    } else throw new Error(`Unknown argument ${argument}`);
  }
  if (options.help) return options;
  if (!options.app || !APP.test(options.app)) throw new Error("--app <app> is required");
  if (!options.from || !REPO_NAME.test(options.from)) {
    throw new Error("--from <owner/name> is required");
  }
  if (options.tag !== undefined && !TAG.test(options.tag))
    throw new Error(`Bad --tag ${options.tag}`);
  return options;
}

/** Where the other repository serves its latest.json. */
export const bridgeSource = ({ from, tag }) =>
  tag
    ? `https://github.com/${from}/releases/download/${tag}/${MANIFEST_ASSET}`
    : latestAssetUrl(from);

/** Refuses a manifest that is not a signed release of that repository. */
export function checkBridged(manifest, from) {
  if (!manifest?.version || !parseSemver(manifest.version)) {
    throw new Error("The release file has no semantic version");
  }
  const entries = Object.entries(manifest.platforms ?? {});
  if (entries.length === 0) throw new Error("The release file lists no platforms");
  const prefix = `https://github.com/${from}/releases/download/`;
  for (const [platform, { url, signature }] of entries) {
    if (!url?.startsWith(prefix)) throw new Error(`${platform}: ${url} is not under ${prefix}`);
    if (!signature?.startsWith("untrusted comment:")) throw new Error(`${platform} is unsigned`);
  }
  return entries.map(([, { url }]) => url);
}

async function main(argv) {
  const options = parseBridgeArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const source = bridgeSource(options);
  const manifest = await fetchRelease(source);
  if (!manifest) throw new Error(`${source} is not there`);
  const urls = checkBridged(manifest, options.from);
  for (const url of urls) {
    const response = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (!response.ok) throw new Error(`${url} does not download: HTTP ${response.status}`);
  }

  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const plan = {
    manifestPath: `apps/${options.app}/${CHANNEL}.json`,
    commitMessage: `release(${options.app}): ${manifest.version} on ${CHANNEL} from ${options.from}`,
  };
  prepareCheckout(root, options.dryRun);
  checkNewer(manifest.version, currentRelease(root, plan.manifestPath));
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (options.dryRun) {
    console.log(`Dry run: a real run would write ${plan.manifestPath}:\n${text}`);
    console.log(`  git commit -m "${plan.commitMessage}" and push to origin main`);
    return;
  }
  mkdirSync(dirname(join(root, plan.manifestPath)), { recursive: true });
  writeFileSync(join(root, plan.manifestPath), text);
  pushManifest(root, plan);
  console.log(`Pushed ${plan.manifestPath}: ${manifest.version} from ${source}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    if (process.argv.length <= 2) console.error(USAGE);
    process.exit(1);
  });
}
