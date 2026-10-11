# Releasing Pith Desk

End users download an application, not a source checkout. Mac packages target
Apple Silicon (ARM64) and contain the embedded UI, dependency notices and the
Pith library. Go, Node.js and npm are development requirements only.

## SDK dependency validation

Pith is pinned to a published revision in `go.mod`, including the SDK fixes used
by this preview. Run all checks with `GOWORK=off` to verify that versioned library
without an ignored local workspace override. The CI workflows set this explicitly.
See [the SDK dependency](SDK_FEATURES.md#versioned-sdk-dependency).

## Local preview

After installing development dependencies:

```sh
GOWORK=off npm run check
GOWORK=off npm run release:preview
```

The output is `build/releases/pith-desk-<release-version>-macos-arm64-preview.zip`,
with a SHA-256 checksum, a signed updater tar.gz and update manifest, and a provenance manifest recording architecture, CGO and signing
status. Packaging verifies the binary is ARM64 with `CGO_ENABLED=0` and checks
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
making the final ZIP. Failed signing/notarization never falls back to a preview.
The signed branch must be validated with real credentials before calling it a
verified release process; it cannot be tested on a host without a certificate.

## GitHub releases

The Mac release workflow runs for pushed `v*` tags, tests the exact tagged source,
builds an ARM64 application and publishes the ZIP, checksum and manifest.
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
release tag receive a dev suffix. Before tagging, run automated checks and the native
checks affected by the change. Reuse completed checks for unchanged code instead
of repeating the full native checklist for a UI-only release. Changes to the
host, SDK, providers or runtime require the applicable cold-launch, Settings
connection, task execution, Stop, restart and save-dialog checks. Verify the
downloaded archive's checksum, source revision, SDK dependency and signature;
repeat its native launch when host or packaging changes affect startup. Only
Apple Silicon Mac is supported; Intel Mac, Linux and Windows are outside the
supported scope.

## Click to update

Settings → Updates and the macOS application menu's **Check for Updates…**
check the preview feed. **Update and restart** verifies and installs the signed
full app archive, saves text drafts, and restarts immediately. Running tasks in
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
signature is Ed25519 over SHA-256 of the final tar.gz, as MyGo expects. The manual
ZIP, updater archive, checksum and provenance all describe the same final app.

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
New releases target Apple Silicon only.
