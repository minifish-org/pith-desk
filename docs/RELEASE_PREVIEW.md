New in this preview:

- The original blue logo is 25% larger inside browser and application icons. Its colors and backing are preserved, and logos inside the Desk interface keep their existing size.
- Long streaming conversations reuse unchanged messages and interface state, with fewer redundant updates as transcripts grow.
- Workspace switches and delayed responses preserve the correct drafts, file results, tool tabs and model settings. Native Web previews retain their page state while hidden and close when their tab is removed.
- Task recovery avoids repeating an input that was already saved. Workspace path checks handle case-insensitive volumes, file search supports Unicode names, and nested code-mode file changes appear in recorded diffs.
- Conversation exports, diagnostics and resource edits preserve existing files when a save fails. Native menu, quit, file-drop, terminal and update flows have expanded regression coverage.
- Frontend components and actions are organized by responsibility, with unused components and retired transports removed. Existing settings, conversations, drafts, saved layouts and update feeds remain compatible.

Apple Silicon: open the `darwin-arm64.tar.gz` and move **Pith Desk.app** to Applications. The Mac preview is ad-hoc signed and unnotarized; see [opening instructions](https://github.com/minifish-org/pith-desk/blob/main/docs/RELEASING.md#manual-installation).

Ubuntu x86-64: extract `linux-amd64.tar.gz` into its own user-writable directory and run `./pith-desk`. GTK 3 and WebKitGTK 4.1 are required. Linux releases older than rc.36 need one manual replacement with this archive to enable future in-app updates.

Linux Server: choose `pith-desk-server-<version>-linux-amd64.tar.gz` or `linux-arm64.tar.gz`, verify its `.sha256`, extract it and run `./pith-desk-server`. See [Server installation and token login](https://github.com/minifish-org/pith-desk/blob/main/docs/RELEASING.md#linux-server-packages).
