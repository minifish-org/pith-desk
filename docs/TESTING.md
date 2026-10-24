# Testing Pith Desk

The Web UI is source-controlled in this repository. Browser specs cover product
behavior and interaction; Go tests cover business mapping, original request
targets, persistence and native integration. The checked-in shadcn components
are part of the product and follow the same acceptance as application code.

## Current checks

For ordinary UI edits, start with `npm run check:ui`: generated contract and
frontend types, without a bundle or Go test run. Use `npm run dev` or
`npm run dev:server` for live frontend preview through the authenticated Host.

Run the relevant browser spec, for example
`npm run test:ui -- frontend/e2e/ui-consistency.spec.ts`. The full product
sequence remains:

```sh
npm ci
npm --prefix frontend ci
npm run check
npx playwright install chromium webkit
npm run test:ui
GOWORK=off CGO_ENABLED=1 go test -race -p 1 ./internal/...
```

`npm run check` builds the frontend once, checks generated transport contracts
and TypeScript types, runs ordinary frontend/tool tests, Go tests and vet. Browser
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

Frontend types, generated contracts and the behavior suites are the UI
boundaries. Native ingress is validated in `native-protocol.ts` and forwarded
as data.

For workspace tool ownership and runtime-ledger changes, run:

```sh
npm run test:ui -- frontend/e2e/workspace-tools.spec.ts frontend/e2e/runtime-summary.spec.ts
```

These scenarios include delayed terminal closes across tab creation and workspace
switches, a single close request from the tab control, and cost reads that refresh
with their conversation/revision, retire late responses and retry after failure.

For the resource, model-settings, Web lifetime and task-recovery regressions:

```sh
npm run test:ui -- frontend/e2e/settings.spec.ts frontend/e2e/ui-consistency.spec.ts frontend/e2e/web-preview-lifecycle.spec.ts frontend/e2e/web-preview.spec.ts
GOWORK=off CGO_ENABLED=0 go test ./internal/desk ./internal/workspacefs ./internal/appdata -run 'TestWorkspaceCase|TestWithinChecksCase|TestContinueRestoresOnlyUnrecorded|TestFindFilesMatchesUnicode|TestCodemodeFileChanges' -count=1
```

These cover failed resource reads and retry without replacement writes, refreshed
model choices, retired provider-key results, workspace/drawer Web retention and
closing during native page creation, workspace removal and delayed native placement.
Go fixtures cover actual directory identity,
admitted text/images before and after transcript persistence, Unicode file search,
and approved nested file changes with diff, restart and branch projection.

For shared drawer, workspace draft and provider-editor ownership:

```sh
npm run test:ui -- frontend/e2e/sidebar-controls.spec.ts frontend/e2e/draft-scope.spec.ts frontend/e2e/settings.spec.ts
GOWORK=off CGO_ENABLED=0 go test ./internal/desk -run 'TestCompactionUsesSavedCredential|TestNativeProvidersUsedForAgentProbeAndCompaction|TestManualCompactionKeepsHistoryAndMetersSummary' -count=1
```

These cover 800px drawers and terminal/dialog focus, initial workspace drafts
after deleting the active conversation in both modes, and retired provider-edit
results. Compaction checks exercise the same summary stream used by real tasks,
including saved credentials, provider protocols, history and metered usage.

For resource creation, file-drop routing, Files expansion and late artifact reads:

```sh
npm run test:ui -- frontend/e2e/regressions.spec.ts frontend/e2e/edited-files.spec.ts frontend/e2e/server-remote.spec.ts frontend/e2e/workspace-tools.spec.ts
GOWORK=off CGO_ENABLED=0 go test ./internal/desk -run 'TestResourceCreation|TestMCP|TestDeferredMCP|TestWorkspaceMCPAbort' -count=1
GOWORK=off CGO_ENABLED=0 go test ./cmd/contractgen -count=1
GOWORK=off CGO_ENABLED=0 go test ./internal/host -run TestTypedMutationsReadAndRejectMalformedBodies -count=1
```

Resource write failures run in a separate test process with disposable files and
a temporary file-size limit. The checks retain existing files, remove incomplete
new resources and permit a retry. Browser cases cover textarea and frame drops,
folding a directory during a read, and responses from retired conversation reads.
Contract generation checks route coverage and query types with resolved import
aliases. The Host regression sends malformed bodies through every nonempty POST
contract in Desktop and Server, checking both rejection and actual body reads so
missing decoding or an early request-type mismatch cannot masquerade as success.
The stdio MCP regression executes a real task and checks that its child exits
after task completion, retaining environment isolation and error redaction.

## Required behavior

| Responsibility | Maintained checks |
|---|---|
| Snapshot/transport | real Go Server + SDK HTTP/WS ordering, exclusive page takeover, reconnect and restart |
| Writes | original operation object, permission gate, failed refresh never replays a committed write |
| Composer/queue | sending, stopping, editing, queue delivery, stale draft reads and native reference routing |
| Task recovery | selected workspace availability, approval, recovery and completion/read state |
| Configuration/resources | original workspace/provider/MCP targets, failed writes keep drafts, async reads retire on close |
| Application lifetime | shared dialog replacement, callback reentry, session switching, root teardown and native menus |
| Files | authenticated paths, preview/read limits, clipboard/export/download, recorded generated files, the conversation edited-files summary and its recorded diff preview |
| Workspace browser | lazy directories and view restoration, saved-layout compatibility, private/symlink boundaries, lease revocation, late workspace/preview responses, reference insertion and draft/image preservation |
| Sidebars | rail-owned expanded controls/topbar openers, independent drag/keyboard widths, viewport limits and persisted restore across refresh/restart, live PTY columns and pending input, phone overlay exclusion, scrim/close/Escape and focus restoration, native titlebar insets |
| Workspace tool tabs | initially empty, create/select/close, three direct empty-state entries, single-row tabs and reachable controls, independent file expansion/reading positions, workspace layout/selection restore, drafts and narrow overlays |
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
GOWORK=off CGO_ENABLED=0 PITH_DESK_NATIVE_SMOKE=1 go test ./cmd/pith-desk -run 'Native' -v -count=1
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
file-drop forwarding, terminal tabs and reconnect, the native Web preview view,
update progress/failure and Dock unread state in native WebViews, with temporary
data and local providers. All macOS application windows use the production
window options and matching Host titlebar state, with saved window geometry
disabled. To retain screenshots for visual review, set
`PITH_DESK_NATIVE_SCREENSHOTS=/absolute/path/outside/the/repository` on the test
command. Browser validation alone
does not establish native behavior. These checks require an interactive desktop
session; they do not download or install a Desk release.

The installed-menu check triggers actual menu callbacks and verifies the page,
exported file and WebView zoom. The quit check closes a disposable child app:
a pending or failed draft save must keep its window open, and successful retry
must reach storage before the window closes. Text export failure checks use
the installed Host callbacks and an isolated file-size limit to preserve the
existing destination, then verify cancellation and retry.

Include `WorkspaceBrowserNative` in the native test filter to verify the lazy
workspace list, existing preview and native Open/Reveal/Copy file/save callbacks,
draft insertion, independent panels and narrow focus restoration. The check
shows its disposable window before measuring layout and waits for breakpoint
updates before operating the phone-style controls.

For native acceptance against a live source frontend, keep `npm run dev:server`
running with disposable data, then pass the printed **Development frontend**
origin and the frontend source root to native acceptance:

```sh
GOWORK=off CGO_ENABLED=0 PITH_DESK_NATIVE_SMOKE=1 go test ./cmd/pith-desk \
  -run 'Native' -v -count=1 \
  -args -native-ui-url http://127.0.0.1:PORT -native-ui-root /absolute/path/to/pith-desk/frontend
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
cookies; refresh/expiry/logout; immediate WebSocket revocation; mutation deduplication
and downloads; and actual SDK task completion without a connected page. The
Server entry regression accepts top-level GET document navigation to `/` after
an identity proxy redirect while retaining cross-site rejection for APIs,
login writes, assets, fetches, foreign Origins and the Desktop entry.
The real-host browser fixture runs Server with the Vite development frontend.
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
`frontend/e2e/web-preview-lifecycle.spec.ts` covers native page retention across
workspace switches and narrow drawers, pending navigation after the view unmounts,
explicit closure racing page creation, removed workspaces and ordered native
visibility requests. Its native transport is mocked;
the opt-in native test below verifies the actual page and retained JavaScript state.
Workspace-tools tests retain saved layouts and independent preview tabs without saving
addresses or grants.

`frontend/e2e/web-preview.spec.ts` runs both Desktop and Server transports in
Chromium/WebKit against a real temporary Vite project: nested paths/root assets,
interactive content, direct Desktop HMR and Server HMR through Go's WebSocket
proxy, separate origins, blocked Desk API access, independent Server grants surviving tool close and Desk refresh, lease
takeover, direct domain/public/private IP pages without Desk credentials,
top-level X-Frame-Options pages and opening without an opener. Address submission uses Return. The opt-in
`TestWebPreviewNativeIsolationAndSocket` covers the actual macOS WKWebView.
It verifies a distinct native child page, retained hide/show and workspace/drawer
switches, modal yielding and explicit destruction with no iframe. A bound native probe verifies localhost
project pages cannot call Go even in development builds. Its project binds only to IPv6 while the UI receives a localhost URL; the Vite
browser scenario uses Vite's default bind settings to retain that real-world gap.
Include `WebPreviewNative` in the native test filter; remote wildcard DNS/TLS and
physical mobile browsers need deployment-specific acceptance.

Start `npm run dev:server -- --preview-listen 127.0.0.1:0` and use its printed
frontend origin for `hostFrontend` in a temporary local Playwright config. The
same `-native-ui-url` / `-native-ui-root` flags select it for native tests. Keep
temporary configuration, binaries and disposable workspaces outside commits.
Run `npm run check:ui` for contract/types, frontend units, the full Go race
suite/vet and affected browser/native suites.

## Terminal acceptance

Start with `go test ./internal/terminal ./internal/host -run 'TestTerminal|TestRealShell|TestCloseCleans|TestBoundedByte'`
and `npm run test:unit`.
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
These are test-only options; default suites use the embedded frontend build.
Do not change installed dependencies, lockfiles or production resolution to
simulate a release.
