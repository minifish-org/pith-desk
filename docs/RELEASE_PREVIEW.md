New in rc.37:

- Keep narrow-window input controls aligned: the permission selector collapses to its mode-specific icon based on the available space, including Linux display scaling.
- Make Linux minimize, maximize and close buttons readable and easier to click across display and page zoom levels. The integrated Mac titlebar is unchanged.

Apple Silicon: open the `darwin-arm64.tar.gz` and move **Pith Desk.app** to Applications. The Mac preview is ad-hoc signed and unnotarized; see [opening instructions](https://github.com/minifish-org/pith-desk/blob/main/docs/RELEASING.md#manual-installation).

Ubuntu x86-64: extract `linux-amd64.tar.gz` into its own user-writable directory and run `./pith-desk`. GTK 3 and WebKitGTK 4.1 are required. Linux releases older than rc.36 need one manual replacement with this archive to enable future in-app updates.
