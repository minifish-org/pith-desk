Pith Desk is a lightweight local Mac client for the Pith agent SDK.

This preview adds the Pith Desk application icon for Finder and the Dock, plus
a matching browser favicon. It uses the same four-part mark as the interface.

This preview includes model connection checks, session token/context status,
failure guidance, explicit task continuation and metadata-only diagnostic
exports, alongside workspaces, file tools, skills, MCP and saved conversations.

Mac downloads are Apple Silicon only. The embedded Pith SDK preserves queued
inputs across retries and session rebuilds. Image selection, paste/drop,
previews, queued image inputs
and persistent image history are now included. PNG, JPEG, GIF and WebP uploads
must total 20 MiB or less per message; provider limits may be lower. Images
require an image-capable model and are sent to the configured provider.

Download the macOS ARM64 preview ZIP, extract it and move **Pith Desk.app**
to Applications. It supports Apple Silicon Macs (M series); Intel Mac is not
supported. You do not need Go, Node.js or npm to run it. Apple Silicon native
launch is tested. The earlier `v0.1.0-rc.1` universal release is unchanged.

**This is an ad-hoc signed, unnotarized experimental preview. macOS may block it.**
If you trust this source and intend to test it, follow [Apple's Open Anyway instructions](https://support.apple.com/en-us/102445)
in System Settings → Privacy & Security. Do not disable Gatekeeper
globally. A Developer ID signed/notarized release is still pending.

Choose a disposable workspace first, configure your provider in Settings, then
use Test connection before sending a task. Connection tests make a small paid
model request; they do not access files or execute tools. API keys remain in
private local files; this app does not store them in Keychain.

Commands and MCP tools run with their own permissions. There is no OS sandbox.
Review permissions before enabling Full access. Completed actions cannot be
undone by Stop, and task continuation reviews history rather than replaying the
original request. Runtime status and diagnostics are not provider billing data.

Check the accompanying SHA-256 checksum and signing-status manifest. Read the
README and security documentation for current boundaries. Report reproducible
issues with the app version and, if useful, the metadata-only diagnostic export.
