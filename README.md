# releases

Release files and update checks for the g3 apps. Installed apps check here
for a newer version, using g3-native-plugins' `updater`:

- **Apps distributed directly** (a sideloaded APK, a Windows installer, an ad
  hoc iOS build) download the new build from this repository's releases,
  check it against their app's signing key, and install it.
- **Apps distributed through a store** (Google Play, the App Store,
  TestFlight, the Microsoft Store) learn a new version is out and open the
  store, which installs it.

**The g3 store apps do not use this for their store builds.** Their store
updates come from g3-brand's catalog, which adds what a store app needs
beyond a link: optional prompts with snooze, required updates, and policy per
platform and channel. Use `store.json` only for an app without g3-brand, or
a store build of an app that otherwise publishes here. Today this repository
serves Tawny (Android APK, Windows) and Snow Cut (Windows).

The app's source can live anywhere, private repositories included: only the
release files are published here.

## What is here

```
apps/<app>/latest.json   What directly distributed builds check
apps/<app>/store.json    What store builds check
scripts/                 Signing files, and writing the two files above
.github/workflows/
  publish.yml            Called by an app's release workflow: signs, publishes, updates latest.json
  announce.yml           Run by hand when a store has a version live: updates store.json
```

Installers are attached to the releases tagged `<app>-v<version>`. The app
reads its file from:

```
https://raw.githubusercontent.com/g3techhq/releases/main/apps/<app>/latest.json
https://raw.githubusercontent.com/g3techhq/releases/main/apps/<app>/store.json
```

Both are the Tauri updater's format: a `version`, and a `platforms` table of
`url` (and, for a download, `signature`) per platform. GitHub caches raw
files for up to five minutes, so a release reaches apps within that.

Store builds read their own file because each store goes live on its own
schedule. A sideloaded release must not tell a Play user about a version
Play does not have yet.

## Adding an app

1. **A signing key**, once per app, outside any repository:

   ```bash
   node scripts/release-signing.mjs keygen ~/.g3-release <app>
   ```

   `<app>-updater.pub` goes in the app's source (it is public).
   `<app>-updater.key` goes in the app repository's `UPDATER_KEY` secret,
   plus an offline backup: an app only ever trusts the key it was built
   with, so a lost key strands every install.

2. **The app** enables g3-native-plugins' `updater` and configures it with
   that public key, its version and its file here:

   ```rust
   UpdaterConfig::new(UPDATER_PUBLIC_KEY, env!("CARGO_PKG_VERSION"))
       .endpoint("https://raw.githubusercontent.com/g3techhq/releases/main/apps/<app>/latest.json")
   ```

   A store build points at `store.json` instead. On Android, a sideloaded
   build also enables `updater-install` (which lets it install APKs); a Play
   build must not, since Play restricts that permission.

3. **A token that can publish here**, in the app repository's
   `RELEASES_TOKEN` secret: a fine-grained personal access token with
   *Contents: read and write* on `g3techhq/releases` only.

4. **The app's release workflow** builds its files, uploads them as
   artifacts, and calls `publish.yml`:

   ```yaml
   publish:
     needs: [android, windows]
     uses: g3techhq/releases/.github/workflows/publish.yml@main
     with:
       app: <app>
       version: ${{ needs.prepare.outputs.version }}
       artifacts: release-*
       files: |
         android=App_1.2.0.apk
         windows-x86_64-nsis=App_1.2.0_x64-setup.zip
       attach: App_1.2.0_x64-setup.exe   # on the release page only, for a first install
       key_file: src/updater.rs           # checked against UPDATER_KEY
     secrets:
       updater_key: ${{ secrets.UPDATER_KEY }}
       releases_token: ${{ secrets.RELEASES_TOKEN }}
   ```

   `publish.yml` signs each file, publishes the release, and only then
   writes `latest.json`, so no app is sent to a file that is not there yet.
   File names may use letters, digits, `.`, `_` and `-`: GitHub renames
   anything else on upload, which would break its URL.

Tawny (`Gateway3B/tawny`, `.github/workflows/release.yml`) is a complete
example.

## Announcing a store release

Once a store has the version live, run **Announce a store release** from the
Actions tab:

| Input | Example |
| --- | --- |
| app | `tawny` |
| version | `1.2.0` |
| stores | `android-store=https://play.google.com/store/apps/details?id=net.example ios-store=https://apps.apple.com/app/id123` |

It merges into `store.json`: announcing iOS a day after Android keeps the
Android entry for the same version. An app's release workflow can also pass
`stores:` to `publish.yml` to list a store page alongside its downloads.

## Platform names

A build looks itself up as `{target}-{arch}-{installer}`, then
`{target}-{installer}`, then `{target}-{arch}`, then `{target}`, and a store
entry (`{target}-store`) last:

| | Values |
| --- | --- |
| target | `android`, `ios`, `windows`, `darwin`, `linux` |
| arch | `aarch64`, `x86_64`, `armv7`, `i686` |
| installer | `apk`, `ipa`, `nsis`, `msi`, `app`, `appimage`, `deb`, `store` |

`android` is enough for a universal APK. `windows-x86_64-nsis` for dx's
NSIS update archive.

## Development

```bash
node --test tests/release.test.mjs
```

The scripts are Node ES modules on the standard library only. Keys and
signatures are minisign's format, so `minisign -V -P <key> -m <file>` checks
a release file by hand.
