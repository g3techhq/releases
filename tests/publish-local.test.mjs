// Publishing from a workstation: the parts that touch neither the disk nor
// GitHub.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeSource, checkBridged, parseBridgeArgs } from "../scripts/bridge-local.mjs";
import {
  checkNewer,
  compareSemver,
  displayName,
  keyMatches,
  latestAssetUrl,
  parseArgs,
  planRelease,
  releaseCommands,
  releaseManifest,
} from "../scripts/publish-local.mjs";
import { generateKey, publicKeyText } from "../scripts/release-signing.mjs";

const SIGNATURE = "untrusted comment: signature\nRUQ...\ntrusted comment: t\nAAA=\n";
const BASE = "https://github.com/g3techhq/releases/releases/download/ad-sentinel-v1.2.0";

const args = (...extra) => [
  "--app",
  "ad-sentinel",
  "--version",
  "1.2.0",
  "--key",
  "/keys/ad-sentinel-updater.key",
  "--file",
  "android=dist/AdSentinel_1.2.0.apk",
  ...extra,
];

test("the command line reads repeated files, extras and flags", () => {
  const options = parseArgs(
    args(
      "--file=windows-x86_64-nsis=C:\\dist\\AdSentinel_1.2.0_x64-setup.zip",
      "--attach",
      "dist/AdSentinel_1.2.0_x64-setup.exe",
      "--notes",
      "@notes.md",
      "--source",
      "Gateway3B/ad-sentinel@0123abcd",
      "--prerelease",
      "--dry-run",
    ),
  );
  assert.equal(options.app, "ad-sentinel");
  assert.equal(options.key, "/keys/ad-sentinel-updater.key");
  assert.deepEqual(options.files, [
    { platform: "android", path: "dist/AdSentinel_1.2.0.apk" },
    { platform: "windows-x86_64-nsis", path: "C:\\dist\\AdSentinel_1.2.0_x64-setup.zip" },
  ]);
  assert.deepEqual(options.attach, ["dist/AdSentinel_1.2.0_x64-setup.exe"]);
  assert.equal(options.notes, "@notes.md");
  assert.equal(options.prerelease, true);
  assert.equal(options.dryRun, true);
  assert.equal(parseArgs(args()).dryRun, false);
});

test("the command line refuses what it does not know", () => {
  assert.throws(() => parseArgs(["--channel", "beta"]), /Unknown option --channel/);
  assert.throws(() => parseArgs(["ad-sentinel"]), /Unexpected argument/);
  assert.throws(() => parseArgs(["--app"]), /needs a value/);
  assert.throws(() => parseArgs(["--app", "--dry-run"]), /needs a value/);
  assert.throws(() => parseArgs(["--file", "dist/a.apk"]), /<platform>=<path>/);
  assert.throws(() => parseArgs(["--app", "a", "--app", "b"]), /twice/);
  assert.throws(() => parseArgs(["--dry-run=yes"]), /takes no value/);
});

test("a release is planned under its tag, with the download URLs latest.json names", () => {
  const plan = planRelease(
    parseArgs(args("--attach", "dist/Setup.exe", "--source", "Gateway3B/ad-sentinel@0123abcd")),
    "Faster startup.\n",
  );
  assert.equal(plan.tag, "ad-sentinel-v1.2.0");
  assert.equal(plan.title, "Ad Sentinel 1.2.0");
  assert.equal(plan.baseUrl, BASE);
  assert.equal(plan.manifestPath, "apps/ad-sentinel/latest.json");
  assert.equal(plan.commitMessage, "release(ad-sentinel): 1.2.0 on latest");
  assert.equal(plan.notes, "Faster startup.");
  assert.equal(plan.pageNotes, "Faster startup.\n\nBuilt from Gateway3B/ad-sentinel@0123abcd.");
  assert.deepEqual(
    plan.files.map(({ name }) => name),
    ["AdSentinel_1.2.0.apk"],
  );
  assert.deepEqual(
    plan.attach.map(({ name }) => name),
    ["Setup.exe"],
  );

  const manifest = releaseManifest(
    plan,
    { "AdSentinel_1.2.0.apk": SIGNATURE },
    "2026-11-11T12:00:00Z",
    { version: "1.1.0", platforms: { android: { url: "old", signature: SIGNATURE } } },
  );
  assert.deepEqual(manifest, {
    version: "1.2.0",
    notes: "Faster startup.",
    pub_date: "2026-11-11T12:00:00Z",
    platforms: { android: { url: `${BASE}/AdSentinel_1.2.0.apk`, signature: SIGNATURE } },
  });

  const bare = planRelease(parseArgs(args("--name", "AdSentinel")));
  assert.equal(bare.title, "AdSentinel 1.2.0");
  assert.equal(bare.pageNotes, "ad-sentinel 1.2.0");
  assert.equal(bare.notes, undefined);
});

test("a v before the version is dropped", () => {
  const options = parseArgs([
    "--app",
    "skicut",
    "--version",
    "v0.3.0",
    "--key",
    "k",
    "--file",
    "windows=a.zip",
  ]);
  assert.equal(planRelease(options).version, "0.3.0");
});

test("a plan the workflow would refuse is refused here", () => {
  const plan = (...extra) => planRelease(parseArgs(args(...extra)));
  assert.throws(() => planRelease(parseArgs(["--app", "x", "--version", "1.0.0"])), /--key/);
  assert.throws(() => planRelease(parseArgs(args().slice(0, 6))), /at least one --file/);
  assert.throws(
    () => planRelease({ ...parseArgs(args()), app: "Ad_Sentinel" }),
    /lowercase letters/,
  );
  assert.throws(() => planRelease({ ...parseArgs(args()), version: "1.2" }), /not semver/);
  assert.throws(() => plan("--file", "windows=dist/Ad Sentinel.zip"), /only letters/);
  assert.throws(() => plan("--attach", "dist/Setup (1).exe"), /only letters/);
  assert.throws(() => plan("--file", "android=other/AdSentinel_1.2.0.apk"), /listed twice/);
  assert.throws(() => plan("--file", "windows=other/AdSentinel_1.2.0.apk"), /given twice/);
  assert.throws(() => plan("--attach", "dist/a.apk.minisig"), /signatures are made here/);
  assert.throws(() => plan("--source", "main"), /--source/);
});

test("only a newer version replaces latest.json", () => {
  assert.doesNotThrow(() => checkNewer("1.2.0", undefined));
  assert.doesNotThrow(() => checkNewer("1.2.0", { version: "1.1.9" }));
  assert.throws(() => checkNewer("1.2.0", { version: "1.2.0" }), /not newer than 1\.2\.0/);
  assert.throws(() => checkNewer("1.2.0", { version: "1.10.0" }), /not newer/);
  assert.throws(() => checkNewer("1.2.0-beta.1", { version: "1.2.0" }), /not newer/);
  const ordered = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.10.0",
    "2.0.0",
  ];
  for (let index = 1; index < ordered.length; index += 1) {
    assert.equal(compareSemver(ordered[index - 1], ordered[index]), -1, ordered[index]);
    assert.equal(compareSemver(ordered[index], ordered[index - 1]), 1, ordered[index]);
  }
  assert.equal(compareSemver("1.0.0+build.1", "1.0.0"), 0);
});

test("the key is checked against the app's public key, in a .pub or a source file", () => {
  const key = generateKey();
  const pub = publicKeyText(key);
  assert.ok(keyMatches(key, pub));
  const source = `pub const UPDATER_PUBLIC_KEY: &str = "${pub.split("\n")[1]}";\n`;
  assert.ok(keyMatches(key, source));
  assert.ok(!keyMatches(generateKey(), pub));
});

test("the release is a draft until published, never marked latest", () => {
  const plan = planRelease(parseArgs(args("--prerelease")));
  const { create, publish } = releaseCommands(plan, "notes.md", ["a.apk", "a.apk.minisig"]);
  assert.deepEqual(create, [
    "release",
    "create",
    "ad-sentinel-v1.2.0",
    "--repo",
    "g3techhq/releases",
    "--target",
    "main",
    "--draft",
    "--latest=false",
    "--title",
    "Ad Sentinel 1.2.0",
    "--notes-file",
    "notes.md",
    "--prerelease",
    "a.apk",
    "a.apk.minisig",
  ]);
  assert.deepEqual(publish, [
    "release",
    "edit",
    "ad-sentinel-v1.2.0",
    "--repo",
    "g3techhq/releases",
    "--draft=false",
    "--latest=false",
  ]);
  assert.equal(displayName("greenside-partee"), "Greenside Partee");
});

test("--repo and --manifest asset publish into an app's own repository", () => {
  const plan = planRelease(
    parseArgs(
      args(
        "--repo",
        "Gateway3B/ad-sentinel",
        "--manifest",
        "asset",
        "--source",
        "Gateway3B/ad-sentinel@0123abcd",
      ),
    ),
  );
  assert.equal(plan.repo, "Gateway3B/ad-sentinel");
  assert.equal(plan.tag, "v1.2.0");
  assert.equal(plan.target, "0123abcd");
  assert.equal(plan.baseUrl, "https://github.com/Gateway3B/ad-sentinel/releases/download/v1.2.0");
  assert.equal(plan.manifestUrl, latestAssetUrl("Gateway3B/ad-sentinel"));
  assert.equal(
    latestAssetUrl("Gateway3B/ad-sentinel"),
    "https://github.com/Gateway3B/ad-sentinel/releases/latest/download/latest.json",
  );
  const manifest = releaseManifest(plan, { "AdSentinel_1.2.0.apk": SIGNATURE }, "t", undefined);
  assert.equal(
    manifest.platforms.android.url,
    "https://github.com/Gateway3B/ad-sentinel/releases/download/v1.2.0/AdSentinel_1.2.0.apk",
  );

  const { create, publish } = releaseCommands(plan, "notes.md", ["a.apk", "latest.json"]);
  assert.deepEqual(create.slice(0, 8), [
    "release",
    "create",
    "v1.2.0",
    "--repo",
    "Gateway3B/ad-sentinel",
    "--target",
    "0123abcd",
    "--draft",
  ]);
  assert.ok(!create.includes("--prerelease"));
  assert.deepEqual(publish, [
    "release",
    "edit",
    "v1.2.0",
    "--repo",
    "Gateway3B/ad-sentinel",
    "--draft=false",
    "--latest",
  ]);

  const tagged = planRelease(parseArgs(args("--manifest", "asset", "--tag", "release-1.2.0")));
  assert.equal(tagged.tag, "release-1.2.0");
  assert.equal(tagged.repo, "g3techhq/releases");
  assert.equal(tagged.target, "main");
  const commit = planRelease(parseArgs(args("--repo", "Gateway3B/ad-sentinel")));
  assert.equal(commit.tag, "ad-sentinel-v1.2.0");
  assert.equal(commit.manifest, "commit");
});

test("asset mode refuses a pre-release and a file named latest.json", () => {
  const plan = (...extra) => planRelease(parseArgs(args(...extra)));
  assert.throws(() => plan("--manifest", "asset", "--prerelease"), /--prerelease cannot/);
  assert.throws(() => plan("--manifest", "asset", "--attach", "dist/latest.json"), /made here/);
  assert.doesNotThrow(() => plan("--attach", "dist/latest.json"));
  assert.throws(() => plan("--manifest", "store"), /commit or asset/);
  assert.throws(() => plan("--repo", "releases"), /<owner>\/<name>/);
  assert.throws(() => plan("--tag", "v1.2.0 beta"), /--tag/);
});

test("a bridge copies another repository's release only when it is that repository's", () => {
  const options = parseBridgeArgs(["--app", "tawny", "--from", "Gateway3B/tawny"]);
  assert.equal(
    bridgeSource(options),
    "https://github.com/Gateway3B/tawny/releases/latest/download/latest.json",
  );
  assert.equal(
    bridgeSource({ ...options, tag: "v0.1.3" }),
    "https://github.com/Gateway3B/tawny/releases/download/v0.1.3/latest.json",
  );
  const url = "https://github.com/Gateway3B/tawny/releases/download/v0.1.3/Tawny_0.1.3.apk";
  const manifest = { version: "0.1.3", platforms: { android: { url, signature: SIGNATURE } } };
  assert.deepEqual(checkBridged(manifest, "Gateway3B/tawny"), [url]);
  assert.throws(() => checkBridged(manifest, "Gateway3B/other"), /not under/);
  assert.throws(
    () => checkBridged({ version: "0.1.3", platforms: { android: { url } } }, "Gateway3B/tawny"),
    /unsigned/,
  );
  assert.throws(() => checkBridged({ version: "x", platforms: {} }, "Gateway3B/tawny"), /version/);
  assert.throws(() => parseBridgeArgs(["--app", "tawny"]), /--from/);
  assert.throws(() => parseBridgeArgs(["--from", "a/b", "--app", "tawny", "--x"]), /Unknown/);
});
