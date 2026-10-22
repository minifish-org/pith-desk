# Testing Pith Desk

The behavior baseline for shared recipes is Desk `3838b7f` and UI `0.6.3`.
Desk consumes the exact published npm package and has one application coordinator.
UI tests controls and region interaction; Desk tests business mapping, original
request targets, persistence and necessary integration. Shared interface details
are tested in Pith UI once.

## Current checks

For ordinary UI edits, start with `npm run check:ui`: generated contract,
production consumption boundary and frontend types, without a bundle or Go
test run. `npm run check:ui -- --ui-source ../pith-ui` uses the explicitly selected
checkout for types while still checking the registry install and public imports.
Use `npm run dev:server -- --ui-source ../pith-ui` for live source preview; omit
the flag after stopping it to restore npm resolution. Neither command changes
the lock or the installed package. New shared interfaces can be implemented,
debugged and accepted locally before publication. Complete the affected local
source checks, including browser and native integration, against that explicit
checkout. Normal builds and automated product suites use the pinned package;
publish and pin the validated library when preparing formal consumer builds,
CI or a product release. Publication is not a prerequisite for local source
development or its acceptance.

Run the relevant browser spec, for example
`npm run test:ui -- frontend/e2e/server.spec.ts`. In Pith UI, run the affected
part/recipe checks. The full product sequence remains:

```sh
npm ci
npm --prefix frontend ci
npm run check
npx playwright install chromium webkit
npm run test:ui
GOWORK=off CGO_ENABLED=1 go test -race -p 1 ./internal/...
```

`npm run check` builds the frontend once, checks generated transport contracts
and UI consumption, runs ordinary frontend/tool tests, Go tests and vet. Browser
checks reuse that output. Individual frontend and tool tests can run after the
build with:

```sh
node --experimental-strip-types --test frontend/tests/*.test.mjs frontend/tests/*.test.ts
node --experimental-strip-types --test scripts/*.test.mjs scripts/*.test.ts
```

`npm run check:frontend` runs only the shared frontend build and frontend/tool
tests. Full CI uses it with `go vet ./...` and a single
`CGO_ENABLED=1 go test -count=1 -race -p 1 ./...`, including command packages,
instead of repeating internal tests in ordinary and race modes. Main/manual
runs also retain both browsers and all four Linux Desktop/Server target builds.
PR scope and cache commands are documented in the README. Scope regression
tests cover dependency/public-contract expansion and missing-history fallback;
the `mac` job itself is never conditionally removed.

`scripts/package-server-release.test.ts` builds disposable Go fixtures for both
Linux architectures, extracts the archives and checks executable permissions,
ELF/CGO metadata, release identity, license notices and SHA-256 files. It also
executes the actual tag-publication shell with a recording `gh` fixture to
verify all four Desktop/Server packages and checksums in both release branches.
The full Check replaces the two plain Server cross-builds with the real Server
packager after the shared frontend build, retaining both architecture checks.
For focused packaging checks, run:

```sh
node --experimental-strip-types --test scripts/package-server-release.test.ts scripts/release-linux.test.mjs scripts/update-release.test.mjs scripts/publish-update.test.mjs
```

The tag workflow extracts and verifies both Server archives and runs the
packaged amd64 executable's `--help` on Ubuntu. ARM64 is built, packaged and
inspected; this workflow does not establish ARM64 runtime acceptance.

`npm run check:ui-consumption` verifies the actual registry dependency/lock and
installed parts/recipes exports, unique native mount adapter, CSS/private-entry
boundaries and source aliases. It does not require local copies of recipes.
Types come from the installed package or are inferred from the coordinator.

The checker permits safe declaration grouping, aliases and intermediate data
values. It still rejects DOM creation, internal selectors, styles, private UI
imports, raw native event forwarding and mount leakage. Native event validation
lives in `native-protocol.ts` with behavior tests; the consumption checker
restricts ingress to those readers instead of matching their source layout.
Mounting, bootstrap metadata and the ownership tree remain bounded.

## Required behavior

| Responsibility | Maintained checks |
|---|---|
| Snapshot/transport | real Go Server + SDK HTTP/WS ordering, exclusive page takeover, reconnect and restart |
| Writes | original operation object, permission gate, failed refresh never replays a committed write |
| Composer/queue | sending, stopping, editing, queue delivery, stale draft reads and native reference routing |
| Task recovery | selected workspace availability, approval, recovery and completion/read state |
| Configuration/resources | original workspace/provider/MCP targets, failed writes keep drafts, async reads retire on close |
| Application lifetime | shared dialog replacement, callback reentry, session switching, root teardown and native menus |
| Files | authenticated paths, preview/read limits, clipboard/export/download and recorded generated files |
| Workspace browser | lazy directories and view restoration, retired legacy filters, private/symlink boundaries, lease revocation, late workspace/preview responses, reference insertion and draft/image preservation |
| Sidebars | rail-owned expanded controls/topbar openers, independent drag/keyboard widths, viewport limits and persisted restore across refresh/restart, live PTY columns and pending input, phone overlay exclusion, scrim/close/Escape and focus restoration, native titlebar insets |
| Workspace tool tabs | create/select/close, independent file expansion/reading positions, workspace layout/selection restore, drafts and narrow overlays |
| Manual terminal | independent tab processes/PTY interaction/interrupt/resize/UTF-8, bounded history/parse acknowledgements, page-independent lifetime, reconnect/takeover/late controls, scoped close/workspace cleanup |
| Persistence | literal compatibility fixtures, real creation, restart recovery and failure handling |

Browser scenarios use Chromium and WebKit. Isolated local providers and MCP
fixtures exercise the pinned published Pith SDK without a live account. UI owns
IME, selection, scrolling, rendering, pagination and region disposal regressions;
Desk retains only the corresponding business integration assertions.

Notification ledger capacity/supersession/age tests use minimal valid catalog
rows and real ledger writes. Separate tests retain real SDK conversation creation,
restart restoration and failure handling. Go production code and product
architecture are unchanged by this simplification.

## Native desktop acceptance

After `npm run build:ui`, run the opt-in actual WebView scenarios:

```sh
GOWORK=off CGO_ENABLED=0 PITH_DESK_NATIVE_SMOKE=1 go test ./cmd/pith-desk -run '^Test(TitlebarNative|UsabilityNative|WorkspaceFileDropNativeBridge|ConversationFileLinkNative|UpdatesNative|TaskDockNative)' -v -count=1
```

The Linux `TestTitlebarNativeLinuxAndNarrowComposer` check runs with the same
`PITH_DESK_NATIVE_SMOKE=1` switch in an interactive XFCE session. It checks real
WebKitGTK composer widths from 390 to 640 CSS pixels where the window's minimum
size permits them, without an in-content titlebar. The Linux
`TestTitlebarNativeLinuxUsesSystemDecorations` check verifies that GTK leaves
window decorations to the desktop. Repeat with `GDK_SCALE` / `GDK_DPI_SCALE` set to cover
different widget/text scaling. `PITH_DESK_NATIVE_INSPECT=1` keeps its isolated
verification window open after the assertions until it is closed manually.

These checks exercise native titlebar insets and existing controls, drafts, rejected sends, approval, file previews/downloads,
file-drop forwarding, update progress/failure and Dock unread state in native
WebViews, with temporary data and local providers. Browser validation alone
does not establish native behavior. These checks require an interactive desktop
session; they do not download or install a Desk release.

Include `WorkspaceBrowserNative` in the native test filter to verify the lazy
workspace list, existing preview and native Open/Reveal/Copy file/save callbacks,
draft insertion, independent panels and narrow focus restoration. The check
shows its disposable window before measuring layout and waits for breakpoint
updates before operating the phone-style controls.

For explicit source integration, keep `npm run dev:server -- --ui-source ../pith-ui`
running with disposable data, then pass the printed **Development frontend**
origin and the same source checkout to native acceptance:

```sh
GOWORK=off CGO_ENABLED=0 PITH_DESK_NATIVE_SMOKE=1 go test ./cmd/pith-desk \
  -run '^Test(TitlebarNative|UsabilityNative|WorkspaceFileDropNativeBridge|ConversationFileLinkNative|WorkspaceBrowserNative)' -v -count=1 \
  -args -native-ui-url http://127.0.0.1:PORT -native-ui-root /absolute/path/to/pith-ui
```

These test-only flags select the same authenticated development Host and public
source entries as the runner. Omit both flags for formal embedded-package native
acceptance; no environment variable changes production source resolution.

The macOS foreground/unread check also requires an unlocked screen. A locked
screen keeps WebKit's document hidden even after showing/focusing the window;
passing other native checks does not establish foreground acknowledgement.
Unlock the desktop and rerun that check. Failure diagnostics retain document
focus/visibility and frame/visual-viewport height to distinguish this condition
from layout or acknowledgement failures.

For user acceptance, copy the existing application configuration and sessions to
a private isolated data directory and start Server with the embedded frontend:

```sh
GOWORK=off CGO_ENABLED=0 go run ./cmd/pith-desk-server --data-dir /path/to/isolated/data
```

Keep the process running, open its printed loopback URL in a visible browser and sign in using its private server-token file.
User workspaces contain real files even with isolated application data; use
read-only inspection of existing conversations and disposable workspaces for
mutating tests. Local Server checks and native builds do not constitute a Desk release.

## Server acceptance

`internal/host/server_mode_test.go` checks every registered business endpoint
without login, without a lease and after takeover; Host/Origin/CSRF and HTTPS
cookies; refresh/expiry/logout; immediate WS/SSE revocation; mutation deduplication
and downloads; and actual SDK task completion without a connected page. The
real-host browser fixture now runs Server with Vite, not Preview.
`frontend/e2e/server.spec.ts` covers Token login, refresh, two-tab takeover,
sign-out, authenticated Vite HMR, server workspace paths, background task completion
and pending file approval across takeover.
Other Host integration scenarios retain ordering, failed-refresh, history,
drafts, restart, export and Stop behavior in both Chromium and WebKit.
`frontend/e2e/workspace-browser.spec.ts` uses both actual Desktop and Server
transports with temporary workspaces. It verifies lazy directory requests,
bounded name lookup, refresh after file changes, current preview/download,
relative references without submission, image/text draft restoration, retired
directory/preview responses and phone keyboard geometry/scrolling/dismissal.
`internal/host/workspace_browser_test.go` covers current and revoked Server
leases plus the existing Desktop shell/save callbacks. The endpoint manifest
also keeps every new route in the all-routes authentication/lease regression.
The mode-specific file checks verify Reveal in Desktop and its absence from
Server resources, generated files and preview, while file downloads still work.

`frontend/e2e/server-remote.spec.ts` covers revoked autosave/recovery, server
configuration and diagnostics, browser-local path rejection, image draft restore,
queued work/unread completion across refresh and page close, and a phone viewport
with simulated keyboard resize, approval scrolling, sidebar and download.
`oauth_server_test.go` checks the SDK headless method selection, manual prompt
forwarding, catalog audit and private persistent ChatGPT device binding. OAuth
account eligibility and real provider authorization require an external account;
automated tests do not sign in to live accounts. Directory access, mutation
handoff and waiting draft writes have Go regressions, including race coverage.
Mobile emulation does not establish real OS keyboard or download-sheet behavior.

```sh
npx playwright test frontend/e2e/server.spec.ts frontend/e2e/transport.spec.mjs frontend/e2e/message-edit-host.spec.ts
GOWORK=off CGO_ENABLED=0 go build -o build/pith-desk-server ./cmd/pith-desk-server
GOWORK=off CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o build/pith-desk-server-linux-amd64 ./cmd/pith-desk-server
```

Native smoke checks continue to launch Desktop and retain its local bearer-token
transport. A successful Server check alone does not establish native behavior.

## Web preview acceptance

`internal/host/web_preview_test.go` covers Desktop bearer admission and Server
leases, Desk-port rejection, direct Desktop/domain/public/private IP URLs without server fetch,
credential stripping, redirect confinement, preserved embedding headers, scoped
close, per-preview cookies across loopback ports, workspace removal, logout,
expiry, and HTTP/WebSocket/stream cancellation on takeover. The tests also exercise
HTTP and WebSocket against IPv4-only and IPv6-only localhost projects, without
changing their bind settings, default HTTP/HTTPS ports, project paths matching
the bootstrap path and normal HTTPS certificate validation. The registered routes
also participate in the all-endpoint anonymous/missing/revoked-lease regression.
`frontend/tests/web-preview.test.ts` covers original workspace targets, late
responses, independent new-tab completion after teardown, suspension, native
viewport placement, explicit close and no automatic write replay.
Workspace-tools tests retain old layouts and retain independent preview tabs without saving
addresses or grants.

`frontend/e2e/web-preview.spec.ts` runs both Desktop and Server transports in
Chromium/WebKit against a real temporary Vite project: nested paths/root assets,
interactive content, direct Desktop HMR and Server HMR through Go's WebSocket
proxy, separate origins, blocked Desk API access, independent Server grants surviving tool close and Desk refresh, lease
takeover, direct domain/public/private IP pages without Desk credentials,
top-level X-Frame-Options pages and opening without an opener. Address submission uses Return. The opt-in
`TestWebPreviewNativeIsolationAndSocket` covers the actual macOS WKWebView.
It verifies a distinct native child page, retained hide/show, modal yielding and
explicit destruction with no iframe. A bound native probe verifies localhost
project pages cannot call Go even in development builds. Its project binds only to IPv6 while the UI receives a localhost URL; the Vite
browser scenario uses Vite's default bind settings to retain that real-world gap.
Include `WebPreviewNative` in the native test filter; remote wildcard DNS/TLS and
physical mobile browsers need deployment-specific acceptance.

The preview controls normally use the pinned registry package. To validate
companion Pith UI source changes before publication, start
`npm run dev:server -- --ui-source ../pith-ui --preview-listen 127.0.0.1:0` and use
its printed frontend origin for `hostFrontend` plus the absolute checkout for
`hostUISource` in a temporary local Playwright config. The same existing native
`-native-ui-url` / `-native-ui-root` flags select it for native tests. Keep
temporary configuration, binaries and disposable workspaces outside commits.
Run `npm run check:ui -- --ui-source ../pith-ui` for contract/boundary/types,
frontend units, the full Go race suite/vet and affected browser/native suites.
Library acceptance also includes its full validation and packed consumer checks.
After publishing and pinning the library, repeat formal consumer builds without
source resolution; no npm version or lockfile is changed for local acceptance.

## Terminal acceptance

Start with `go test ./internal/terminal ./internal/host -run 'TestTerminal|TestRealShell|TestCloseCleans|TestBoundedByte'`
and `node --experimental-strip-types --test frontend/tests/terminal.test.ts frontend/tests/workspace-tools.test.ts`.
`frontend/e2e/terminal.spec.ts` covers Desktop/Server real shells, Agent command
approval and cwd/environment independence, retained drafts/files, page close,
network reconnect, parse-bounded output, truncation, workspace command lines,
lease takeover, vim/top and phone keyboard geometry. Tests use disposable host
profiles, workspaces and deterministic provider requests.
`frontend/e2e/workspace-tools.spec.ts` verifies independent processes and file
views, per-workspace selection, refresh without process creation, scoped process
cleanup, retained drafts and empty layouts. The business controller's unit
tests also cover late creation responses, hidden/revoked controls and bounded
layout restoration. Native
`TestTerminalNative` exercises the same public UI in a real macOS WKWebView;
include it in the opt-in native filter above. Physical phone acceptance is
separate from browser visual-viewport simulation.
Its visual checks require an unlocked desktop: the test waits for a visible
document and actual rendering frames before checking cell geometry, inherited
theme and taking a screenshot. A locked screen's frozen snapshot does not prove
the current terminal display.

For explicit local source browser acceptance, the shared host fixture accepts
`hostFrontend` and `hostUISource` test options; select the development runner's
printed frontend origin and absolute UI checkout in a local Playwright config.
These are test-only options; default formal suites still use the locked registry
package and ordinary frontend origin. Do not change installed dependencies,
lockfiles or production resolution to simulate a package release.
