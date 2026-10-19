New in rc.34:

- Collapse conversation permissions to a shield icon in narrow input panels, keeping the attachment and model/thinking/send controls aligned. Wide panels retain the permission name.
- Distinguish Ask before changes, Allow workspace changes and Full access with question-mark, pencil and amber exclamation shields. Full menu labels, current-mode tooltips, keyboard navigation and full-access confirmation remain available.
- Upgrade to Pith UI 0.8.2.

Apple Silicon: open the `darwin-arm64.tar.gz` and move **Pith Desk.app** to Applications. The Mac preview is ad-hoc signed and unnotarized; see [opening instructions](https://github.com/minifish-org/pith-desk/blob/main/docs/RELEASING.md#manual-installation).

Ubuntu: GTK 3 and WebKitGTK 4.1 are required; the `.deb` declares these dependencies. Update Ubuntu installations with a newer package or archive. The in-app updater remains available for Mac releases.
