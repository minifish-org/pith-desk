New in rc.36:

- Enable Linux portable in-app updates: Check for updates, download the signed portable archive, install it and restart. Drafts, settings and conversations are retained, with confirmation when tasks are running.
- Publish only the Linux portable archive and its checksum. Debian packages are no longer included; Mac packaging and updates are unchanged.

Apple Silicon: open the `darwin-arm64.tar.gz` and move **Pith Desk.app** to Applications. The Mac preview is ad-hoc signed and unnotarized; see [opening instructions](https://github.com/minifish-org/pith-desk/blob/main/docs/RELEASING.md#manual-installation).

Ubuntu x86-64: extract `linux-amd64.tar.gz` into its own user-writable directory and run `./pith-desk`. GTK 3 and WebKitGTK 4.1 are required. Existing Linux releases need one manual replacement with this archive to enable future in-app updates.
