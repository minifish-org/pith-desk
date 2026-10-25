New in this preview:

- Paste a screenshot straight into the composer with Cmd+V (Ctrl+V): PNG, JPEG, GIF and WebP images attach exactly like the picker and drag paths, while pasted text is untouched.
- Sidebars and dialogs follow the harness palette in both appearances: one cool-grey surface for the navigation and tool rails in light mode, one dark grey in dark mode, and dialogs sit on the raised surface.
- Rail chrome is quieter: the sidebar footer and tool header dividers are gone, and the rail edge itself is the only separator. A closed rail shows no line, strip or resize cursor, and only its toolbar toggle opens it again.
- On Server, the sidebar shows a labelled **Log out** row instead of a bare icon.
- Dialog footers now reach the dialog edge, so the takeover and settings dialogs no longer end on a stray strip.

Apple Silicon: open the `darwin-arm64.tar.gz` and move **Pith Desk.app** to Applications. The Mac preview is ad-hoc signed and unnotarized; see [opening instructions](https://github.com/minifish-org/pith-desk/blob/main/docs/RELEASING.md#manual-installation).

Ubuntu x86-64: extract `linux-amd64.tar.gz` into its own user-writable directory and run `./pith-desk`. GTK 3 and WebKitGTK 4.1 are required. Linux releases older than rc.36 need one manual replacement with this archive to enable future in-app updates.

Linux Server: choose `pith-desk-server-<version>-linux-amd64.tar.gz` or `linux-arm64.tar.gz`, verify its `.sha256`, extract it and run `./pith-desk-server`. See [Server installation and token login](https://github.com/minifish-org/pith-desk/blob/main/docs/RELEASING.md#linux-server-packages).
