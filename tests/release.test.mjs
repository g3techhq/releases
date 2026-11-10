// The release scripts: keys and signatures in minisign's format, and the
// release files the app updater reads.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildManifest } from "../scripts/release-manifest.mjs";
import {
  generateKey,
  parseSecret,
  prehash,
  publicKeyText,
  secretText,
  signFile,
  verifySignatureText,
} from "../scripts/release-signing.mjs";

const SIGNATURE = "untrusted comment: signature\nRUQ...\ntrusted comment: t\nAAA=\n";
const BASE = "https://github.com/g3techhq/releases/releases/download/tawny-v0.2.0";

test("a signed file verifies, and a changed one does not", async () => {
  const folder = mkdtempSync(join(tmpdir(), "g3-release-"));
  try {
    const key = generateKey();
    const path = join(folder, "Tawny.apk");
    writeFileSync(path, "release bytes");
    const signature = await signFile(key, path);
    assert.match(signature, /^untrusted comment: /);
    assert.match(signature, /\ntrusted comment: timestamp:\d+\tfile:Tawny\.apk\thashed\n/);
    assert.ok(verifySignatureText(publicKeyText(key), await prehash(path), signature));
    writeFileSync(path, "release bytez");
    assert.ok(!verifySignatureText(publicKeyText(key), await prehash(path), signature));
    // Someone else's key never verifies it.
    writeFileSync(path, "release bytes");
    assert.ok(!verifySignatureText(publicKeyText(generateKey()), await prehash(path), signature));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("the public key is minisign's format and the secret round-trips", () => {
  const key = generateKey();
  const text = publicKeyText(key);
  const [comment, line] = text.trim().split("\n");
  const id = Buffer.from(key.keyId).reverse().toString("hex").toUpperCase();
  assert.equal(comment, `untrusted comment: minisign public key ${id}`);
  const bytes = Buffer.from(line, "base64");
  assert.equal(bytes.subarray(0, 2).toString(), "Ed");
  assert.equal(bytes.length, 42);
  const back = parseSecret(secretText(key));
  assert.deepEqual(Buffer.from(back.seed), key.seed);
  assert.equal(publicKeyText(back), text);
  // A key made under Tawny's old prefix still reads.
  const legacy = secretText(key).replace("g3-updater-key:v1:", "tawny-updater-key:v1:");
  assert.equal(publicKeyText(parseSecret(legacy)), text);
  assert.throws(() => parseSecret("RWQ..."), /not a key/);
});

test("downloads are listed under the release's URL, store pages as they are", () => {
  const manifest = buildManifest({
    version: "0.2.0",
    notes: "Faster startup.",
    pubDate: "2026-11-10T12:00:00Z",
    baseUrl: `${BASE}/`,
    downloads: [
      { platform: "android", fileName: "Tawny_0.2.0.apk", signature: SIGNATURE },
      { platform: "windows-x86_64-nsis", fileName: "Tawny_0.2.0_x64-setup.zip", signature: SIGNATURE },
    ],
    stores: [{ platform: "ios-store", url: "https://testflight.apple.com/join/abc" }],
  });
  assert.deepEqual(manifest, {
    version: "0.2.0",
    notes: "Faster startup.",
    pub_date: "2026-11-10T12:00:00Z",
    platforms: {
      android: { url: `${BASE}/Tawny_0.2.0.apk`, signature: SIGNATURE },
      "windows-x86_64-nsis": { url: `${BASE}/Tawny_0.2.0_x64-setup.zip`, signature: SIGNATURE },
      "ios-store": { url: "https://testflight.apple.com/join/abc" },
    },
  });
});

test("merging keeps the same version's other entries and drops an older version's", () => {
  const first = buildManifest({
    version: "0.2.0",
    notes: "Notes",
    pubDate: "a",
    stores: [{ platform: "ios-store", url: "https://apps.apple.com/app/id1" }],
  });
  const both = buildManifest({
    version: "0.2.0",
    pubDate: "b",
    stores: [{ platform: "android-store", url: "https://play.google.com/store/apps/details?id=x" }],
    existing: first,
  });
  assert.deepEqual(Object.keys(both.platforms), ["ios-store", "android-store"]);
  assert.equal(both.notes, "Notes");
  const next = buildManifest({
    version: "0.3.0",
    pubDate: "c",
    stores: [{ platform: "android-store", url: "market://details?id=x" }],
    existing: both,
  });
  assert.deepEqual(Object.keys(next.platforms), ["android-store"]);
});

test("entries the updater would refuse are refused here first", () => {
  const base = { version: "0.2.0", pubDate: "x", baseUrl: BASE };
  assert.throws(() => buildManifest(base), /at least one/);
  assert.throws(
    () => buildManifest({ ...base, version: "next", stores: [{ platform: "ios-store", url: "https://apps.apple.com/" }] }),
    /semantic/,
  );
  const unsigned = [{ platform: "android", fileName: "a.apk", signature: "" }];
  assert.throws(() => buildManifest({ ...base, downloads: unsigned }), /no minisign/);
  const unknown = [{ platform: "windows-arm64", fileName: "a.zip", signature: SIGNATURE }];
  assert.throws(() => buildManifest({ ...base, downloads: unknown }), /not a platform/);
  const storeAsDownload = [{ platform: "android", url: "https://play.google.com/x" }];
  assert.throws(() => buildManifest({ ...base, stores: storeAsDownload }), /not a store entry/);
  const notAStore = [{ platform: "android-store", url: "https://example.com/Tawny.apk" }];
  assert.throws(() => buildManifest({ ...base, stores: notAStore }), /not a store link/);
  const spaced = [{ platform: "android", fileName: "Tawny 0.2.0.apk", signature: SIGNATURE }];
  assert.throws(() => buildManifest({ ...base, downloads: spaced }), /only letters/);
  const plainHttp = [{ platform: "android", fileName: "a.apk", signature: SIGNATURE }];
  assert.throws(
    () => buildManifest({ ...base, baseUrl: "http://x.test", downloads: plainHttp }),
    /HTTPS/,
  );
});
