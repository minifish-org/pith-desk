# Releasing Pith Desk

End users download an application, not a source checkout. Mac packages target
Apple Silicon (ARM64) and contain the embedded UI, dependency notices and the
Pith library. Go, Node.js and npm are development requirements only.
Ubuntu x86-64 packages use the same backend, embedded UI and MyGo native shell,
with GTK 3 and WebKitGTK 4.1 supplied by the operating system.

## SDK dependency validation

Pith is pinned to a published revision in `go.mod`, including the SDK fixes used
by this preview. Run all checks with `GOWORK=off` to verify that versioned library
without an ignored local workspace override. The CI workflows set this explicitly.
See [the SDK dependency](SDK_FEATURES.md#versioned-sdk-dependency).

## Normal preview release

1. Validate the changed behavior locally. For UI changes, run the affected
   browser tests and inspect the affected native screens once. Reuse that
   evidence while the implementation is unchanged; do not also run the full
   Go/race/Linux suite locally just to repeat CI.
2. Commit only product code, necessary tests and release notes, then push to
   `main`. **Check** owns the complete regular tests and browser regressions.
   Go, dependency, build/release script or workflow changes also run race and
   Linux compile checks. UI-only changes skip those two unrelated checks.
   The comparison uses the last successful main Check, so an unvalidated Go
   change cannot be hidden by a later UI-only push. An unavailable or unrelated
   baseline runs the runtime checks conservatively.
3. After Check succeeds for that exact commit, push the version tag. **Desktop
   release** requires that successful result and builds/packages each platform once;
   it does not rerun the test suite. A tag without a successful Check fails
   before packaging or publication.
4. Download the platform archives, Debian package and their checksums once. Verify
   checksums, version, source commit, architecture/CGO, pinned SDK, signatures and contents; the
   provenance manifests are in the release job's `release-metadata` CI artifact.
   Confirm the update feed version. Keep screenshots and process records local.

Repeat downloaded-app cold launch and relevant native behavior only when host,
SDK, startup, native integration or packaging changes affect them, or when
explicitly requested. UI-only releases reuse their local native render check.
Verify the archive's Ed25519 signature again when packaging, updater or feed
publication changes; ordinary releases rely on the existing packager checks and
tests for that unchanged path. Manual installation and self-updates use the
same archive, so there is no second package to download or compare.

## Manual installation

Download `pith-desk-<release-version>-darwin-arm64.tar.gz`, double-click it in
Finder, and move **Pith Desk.app** to Applications. macOS Archive Utility handles
this format without additional software. Only Apple Silicon Macs are supported.
The preview is ad-hoc signed and unnotarized. If macOS blocks it and you trust
the source, follow [Apple's Open Anyway instructions](https://support.apple.com/en-us/102445)
in System Settings → Privacy & Security. Do not disable Gatekeeper globally.

## Ubuntu preview

The Linux release targets x86-64 (`amd64`) and is validated on Ubuntu 26.04 with
XFCE. MyGo generates both a Debian package and a portable archive. The `.deb`
declares GTK 3 and WebKitGTK 4.1 dependencies and registers **Pith Desk** in the
applications menu plus the `pith-desk` command:

```sh
sudo apt install ./<downloaded-file>.deb
pith-desk
```

Install a newer `.deb` the same way to upgrade. Use `sudo apt remove pith-desk`
to uninstall. The package version uses Debian's `~` prerelease separator.

For a portable installation, extract `pith-desk-<version>-linux-amd64.tar.gz`
into its own directory and run `./pith-desk`. If WebKitGTK is missing, install
`libwebkit2gtk-4.1-0` with apt. Keep the executable, release identity, icon and
dependency notices together. Replace the directory with a newer archive to
upgrade. Ubuntu packages use these manual upgrade paths; the Mac update feed
does not serve Linux packages. User settings and conversations are stored
outside either installation.

For an independent local package, run `RELEASE_TAG=v<version> npm run release:linux`.
The packager cross-compiles with `CGO_ENABLED=0` and `GOWORK=off`, verifies ELF
architecture and Go build metadata, and records checksums and source provenance.

## Optional local Mac package

For an independent local archive, after validating the affected change:

```sh
GOWORK=off npm run release:preview
```

The output is `build/releases/pith-desk-<release-version>-darwin-arm64.tar.gz`,
with a SHA-256 checksum, update manifest and provenance manifest recording
architecture, CGO and signing status. Packaging verifies the binary is ARM64 with `CGO_ENABLED=0` and checks
the ad-hoc signature. The preview is **not Developer ID signed or notarized**.
Do not advertise it as a Gatekeeper-approved distribution.

## Developer ID signing and notarization

You need an Apple Developer Program membership, a Developer ID Application
certificate with its private key, and credentials accepted by `notarytool`.
This is separate from storing a user's model API key; the app does not use
Keychain for its model or MCP credentials.

Store your notarization credentials in a local keychain profile using Apple's
`xcrun notarytool store-credentials` workflow. Do not put credentials in this
repository or in a terminal command saved in a public document. Then run:

```sh
PITH_DESK_SIGNING_IDENTITY='Developer ID Application: Your Name (TEAMID)' \
PITH_DESK_NOTARY_PROFILE=pith-desk-release npm run release:signed
```

For a non-default keychain, also set `PITH_DESK_NOTARY_KEYCHAIN` to its path.
The packager enables the hardened runtime, submits the app, requires Accepted
status, staples and validates the ticket, and runs Gatekeeper assessment before
making the final tar.gz. Its temporary notarization ZIP is not a release asset.
Failed signing/notarization never falls back to a preview.
The signed branch must be validated with real credentials before calling it a
verified release process; it cannot be tested on a host without a certificate.

## GitHub releases

The Desktop release workflow runs for pushed `v*` tags and reuses the successful
Check for the exact tagged source. Ubuntu packaging must finish before the Mac
job publishes the Mac archive, Linux archive, Debian package and their checksums
together. Build provenance and the Mac update manifest stay
in the job's `release-metadata` CI artifact; the update manifest is also
published to the existing update feed. Each release note contains only the
current changes and brief download/preview guidance; previous releases retain
their own history.
Without signing secrets it explicitly publishes a **prerelease preview**.

For a signed release configure these GitHub Actions secrets:

- `MAC_CERTIFICATE_P12`: base64-encoded exported certificate and private key.
- `MAC_CERTIFICATE_PASSWORD`: its export password.
- `MAC_SIGNING_IDENTITY`: full Developer ID Application identity.
- `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`: notarization credentials.

The CI job imports the certificate into a disposable keychain and deletes it at
the end. Partial secret configuration fails rather than silently producing an
unsigned package. Never put signing files or credentials into release assets.

Keep package.json and mygo.config.ts aligned when changing the numeric app
version. Packaging reads the complete version (including RC suffixes) from
RELEASE_TAG, or PITH_DESK_RELEASE_VERSION locally. It must match that numeric
version. The signed bundle carries pith-desk-release.json; the desktop uses
its identity for updater comparisons and diagnostics. Local builds without a
release tag receive a dev suffix. Follow the normal release flow above rather
than repeating the same checks locally, in Check and in Mac release. Changes to
the host, SDK, providers or runtime still require their affected native behavior
checks. Release packages target Apple Silicon Mac and Ubuntu x86-64. Linux
ARM64 remains compile-only; Intel Mac and Windows are outside the supported scope.

## Click to update

Settings → Updates and the macOS application menu's **Check for Updates…**
check the preview feed. **Update and restart** verifies and installs the signed
full app archive, saves text and image drafts, and restarts immediately. Running tasks in
any workspace, including pending approvals, require one confirmation. Cancel or
installation failure keeps the app running. New task admission is paused during
installation; existing tasks continue until shutdown. Data and workspace files
are outside the bundle. There are no unattended installs or scheduled restarts.

The updater reuses MyGo 0.3.6. It needs a writable app location; development and
browser previews do not install updates. Users of releases without the updater
must manually replace their app once. Native shutdown releases Desk's data lock
before starting the new process. Interrupted tasks require review after restart.

## Update signing and publication

`resources/update-public-key.txt` is public and embedded in the app. Set
`PITH_DESK_UPDATE_PRIVATE_KEY` in GitHub Actions secrets to the matching Ed25519
PKCS#8 PEM private key. Local packaging can read the same key from
`~/Library/Application Support/Pith Desk Release/updates/ed25519.key`. Keep a
private backup; do not commit the key or rotate it without a migration plan.
Missing or mismatched keys fail release packaging.

The key is independent of Apple Developer ID. Preview self-updates work with
ad-hoc signing. A signed release still completes Developer ID signing,
notarization and stapling before the updater archive is generated. The updater
signature is Ed25519 over SHA-256 of the final tar.gz, as MyGo expects. Manual
installation and self-updates use this same final archive and checksum.

CI uploads immutable assets to the version's GitHub Release, then updates
`preview/update-darwin-arm64.json` on the metadata-only `updates` branch. This
avoids GitHub's latest-release endpoint excluding prereleases. The feed points
to the immutable release archive. Publishing an older tag cannot move the feed
backward. The runtime never contains a GitHub token or private signing key.
The first feed appears with the first release of this implementation. The feed
currently follows this product's preview releases; a separate stable channel
can be added when stable distribution starts.

MyGo restores the old bundle if replacement fails, but does not roll back a new
version that fails to launch. Keep manual release downloads available.

The previously published `v0.1.0-rc.1` universal preview remains unchanged.
New Mac releases target Apple Silicon only.
