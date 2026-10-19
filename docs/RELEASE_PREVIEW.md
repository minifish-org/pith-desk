New in rc.35:

- Correct the bundled Pith UI dependency notice to match the pinned 0.8.2 package, and check this consistency in CI.
- Includes the compact permission controls introduced in rc.34: narrow input panels use distinct question-mark, pencil and amber exclamation shields, while wide panels retain permission names. Attachment and model/thinking/send controls stay aligned, with full menu labels, tooltips, keyboard navigation and full-access confirmation available.

Apple Silicon: open the `darwin-arm64.tar.gz` and move **Pith Desk.app** to Applications. The Mac preview is ad-hoc signed and unnotarized; see [opening instructions](https://github.com/minifish-org/pith-desk/blob/main/docs/RELEASING.md#manual-installation).

Ubuntu: GTK 3 and WebKitGTK 4.1 are required; the `.deb` declares these dependencies. Update Ubuntu installations with a newer package or archive. The in-app updater remains available for Mac releases.
