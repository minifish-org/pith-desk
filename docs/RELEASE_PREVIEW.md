New in rc.38:

- Reduce the extra space above the sidebar logo and app name with Pith UI 0.8.4.
- Restore the Linux desktop's standard titlebar and window controls. Mac keeps its integrated titlebar.

Apple Silicon: open the `darwin-arm64.tar.gz` and move **Pith Desk.app** to Applications. The Mac preview is ad-hoc signed and unnotarized; see [opening instructions](https://github.com/minifish-org/pith-desk/blob/main/docs/RELEASING.md#manual-installation).

Ubuntu x86-64: extract `linux-amd64.tar.gz` into its own user-writable directory and run `./pith-desk`. GTK 3 and WebKitGTK 4.1 are required. Linux releases older than rc.36 need one manual replacement with this archive to enable future in-app updates.
