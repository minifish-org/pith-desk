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
the lock or the installed package. Normal builds and automated product suites
use the pinned package; local source changes must be published and pinned before
formal delivery.

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
The mode-specific file checks verify Reveal in Desktop and its absence from
Server resources, generated files and preview, while file downloads still work.

```sh
npx playwright test frontend/e2e/server.spec.ts frontend/e2e/transport.spec.mjs frontend/e2e/message-edit-host.spec.ts
GOWORK=off CGO_ENABLED=0 go build -o build/pith-desk-server ./cmd/pith-desk-server
GOWORK=off CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o build/pith-desk-server-linux-amd64 ./cmd/pith-desk-server
```

Native smoke checks continue to launch Desktop and retain its local bearer-token
transport. A successful Server check alone does not establish native behavior.
