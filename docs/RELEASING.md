# Releasing Pith Desk

End users download an application, not a source checkout. Mac packages target
Apple Silicon (ARM64) and contain the embedded UI, dependency notices and the
Pith library. Go, Node.js and npm are development requirements only.

## Local preview

After installing development dependencies:

```sh
npm run check
npm run release:preview
```

The output is `build/releases/pith-desk-0.1.0-macos-arm64-preview.zip`,
with a SHA-256 checksum and a manifest recording architecture, CGO and signing
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

Keep package.json, mygo.config.ts and the backend Version constant aligned when
changing the app version. Test native cold launch, Settings connection tests,
normal task execution, Stop, restart, and both save-dialog cancellation paths
before tagging. Intel Mac is outside the supported scope. Run Linux runtime checks on actual hosts;
cross-compilation alone is not runtime verification.

Automatic updates are intentionally absent. Users can quit the app and replace
the old bundle; their settings and sessions are stored outside it. Back up that
data before upgrading if it matters to you.

The previously published `v0.1.0-rc.1` universal preview remains unchanged.
New releases target Apple Silicon only.
