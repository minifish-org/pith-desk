New in rc.32:

- Add an Ubuntu x86-64 desktop preview, retaining the same MyGo shell, embedded UI and Pith backend. Install the `.deb` with `sudo apt install ./pith-desk_0.1.0~rc.32_amd64.deb`, or extract the Linux archive and run `./pith-desk`.
- Support native windows down to 480 × 600. Show the current conversation in the header and keep the input controls compact.
- Show concise token counts and cost estimates while keeping output tokens/s directly visible. Expand the runtime row for model and usage details.
- Remove persistent composer explanations and the Thinking label prefix. Keep skill names readable by hiding list descriptions and moving actions below names in narrow windows.
- Upgrade to Pith UI 0.8.1.

Apple Silicon: open the `darwin-arm64.tar.gz` and move **Pith Desk.app** to Applications. The Mac preview is ad-hoc signed and unnotarized; see [opening instructions](https://github.com/minifish-org/pith-desk/blob/main/docs/RELEASING.md#manual-installation).

Ubuntu: GTK 3 and WebKitGTK 4.1 are required; the `.deb` declares these dependencies. Update Ubuntu installations with a newer package or archive. The in-app updater remains available for Mac releases.
