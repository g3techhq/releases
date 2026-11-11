// Writes an app's release file (`apps/<app>/latest.json` or `store.json`) in
// the Tauri updater's format, which g3-native-plugins' `updater` reads.
//
//   node scripts/release-manifest.mjs --version 0.2.0 --out apps/tawny/latest.json \
//     --base-url https://github.com/g3techhq/releases/releases/download/tawny-v0.2.0 \
//     [--notes-file notes.md] [--merge] \
//     android=dist/Tawny_0.2.0.apk windows-x86_64-nsis=dist/Tawny_0.2.0_x64-setup.zip \
//     --store android-store=https://play.google.com/store/apps/details?id=net.example
//
// Each `platform=file` names a file already signed by release-signing.mjs:
// its `.minisig` becomes the entry's signature, and its URL is the file name
// under --base-url, where the publish workflow uploads it. Each
// `--store platform=url` names a store page: opened, not downloaded, so it
// carries no signature. With --merge, entries of an existing file for the
// same version are kept unless named again, so the stores of one version
// can be announced as each goes live.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const TARGET = "(android|ios|windows|darwin|linux)";
const ARCH = "(aarch64|x86_64|armv7|i686)";
const DOWNLOAD = new RegExp(`^${TARGET}(-${ARCH})?(-(apk|ipa|nsis|msi|app|appimage|deb))?$`);
const STORE = new RegExp(`^${TARGET}(-${ARCH})?-store$`);
// What the updater opens rather than downloads (release.rs, is_store_link).
const STORE_LINK =
  /^(https:\/\/(apps\.apple\.com|testflight\.apple\.com|play\.google\.com|apps\.microsoft\.com|flathub\.org|snapcraft\.io)\/|(itms-apps|itms-beta|macappstore|market|ms-windows-store|appstream|snap):\/\/)/i;

/**
 * The release JSON. `downloads` are signed files under `baseUrl`; `stores`
 * are store pages. `existing` is a file being merged into.
 */
export function buildManifest({
  version,
  notes,
  pubDate,
  baseUrl,
  downloads = [],
  stores = [],
  existing,
}) {
  if (!SEMVER.test(version)) throw new Error(`${version} is not a semantic version`);
  if (downloads.length + stores.length === 0) {
    throw new Error("A release needs at least one platform");
  }
  const platforms =
    existing && existing.version === version ? { ...(existing.platforms ?? {}) } : {};
  const named = new Set();
  const claim = (platform) => {
    if (named.has(platform)) throw new Error(`${platform} is listed twice`);
    named.add(platform);
  };
  for (const { platform, fileName, signature } of downloads) {
    if (!DOWNLOAD.test(platform))
      throw new Error(`${platform} is not a platform the updater downloads for`);
    if (!baseUrl?.startsWith("https://")) throw new Error("--base-url must be HTTPS");
    // GitHub renames an uploaded asset with other characters (a space becomes
    // a dot), and the URL here would then name a file that is not there.
    if (!/^[A-Za-z0-9._-]+$/.test(fileName)) {
      throw new Error(`${fileName}: use only letters, digits, dots, hyphens and underscores`);
    }
    if (!signature.startsWith("untrusted comment:")) {
      throw new Error(`${fileName} has no minisign signature`);
    }
    claim(platform);
    platforms[platform] = {
      url: `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(fileName)}`,
      signature,
    };
  }
  for (const { platform, url } of stores) {
    if (!STORE.test(platform)) throw new Error(`${platform} is not a store entry (<target>-store)`);
    if (!STORE_LINK.test(url)) throw new Error(`${url} is not a store link the updater opens`);
    claim(platform);
    platforms[platform] = { url };
  }
  return {
    version,
    ...(notes
      ? { notes }
      : existing?.version === version && existing.notes
        ? { notes: existing.notes }
        : {}),
    pub_date: pubDate,
    platforms,
  };
}

function pair(argument) {
  const split = argument.indexOf("=");
  if (split < 1) throw new Error(`Expected platform=value, got ${argument}`);
  return [argument.slice(0, split), argument.slice(split + 1)];
}

function parse(argv) {
  const options = { downloads: [], stores: [], merge: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--merge") {
      options.merge = true;
    } else if (argument === "--store") {
      const [platform, url] = pair(argv[index + 1] ?? "");
      options.stores.push({ platform, url });
      index += 1;
    } else if (argument.startsWith("--")) {
      options[argument.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      const [platform, path] = pair(argument);
      options.downloads.push({ platform, path });
    }
  }
  return options;
}

function main(argv) {
  const options = parse(argv);
  for (const required of ["version", "out"]) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  const existing =
    options.merge && existsSync(options.out)
      ? JSON.parse(readFileSync(options.out, "utf8"))
      : undefined;
  const manifest = buildManifest({
    version: options.version.replace(/^v/, ""),
    notes: options["notes-file"] ? readFileSync(options["notes-file"], "utf8").trim() : undefined,
    pubDate: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    baseUrl: options["base-url"],
    downloads: options.downloads.map(({ platform, path }) => ({
      platform,
      fileName: basename(path),
      signature: readFileSync(`${path}.minisig`, "utf8"),
    })),
    stores: options.stores,
    existing,
  });
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${options.out}: ${Object.keys(manifest.platforms).join(", ")}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
