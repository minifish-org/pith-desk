# Testing Pith Desk

The behavior baseline for shared recipes is Desk `3838b7f` and UI `0.6.3`.
Desk consumes the exact published npm package and has one application coordinator.
UI tests controls and region interaction; Desk tests business mapping, original
request targets, persistence and necessary integration. Shared interface details
are tested in Pith UI once.

## Current checks

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

`npm run check:ui-consumption` verifies the actual registry dependency/lock and
installed parts/recipes exports, unique native mount adapter, CSS/private-entry
boundaries and source aliases. It does not require local copies of recipes.
Types come from the installed package or are inferred from the coordinator.

## Required behavior

| Responsibility | Maintained checks |
|---|---|
| Snapshot/transport | real Go Host + SDK HTTP/WS ordering, two clients, reconnect and restart |
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
size permits them, and the native GTK button
targets and alignment. Repeat with `GDK_SCALE` / `GDK_DPI_SCALE` set to cover
different widget/text scaling. `PITH_DESK_NATIVE_INSPECT=1` keeps its isolated
verification window open after the assertions until it is closed manually.

These checks exercise native titlebar insets and existing controls, drafts, rejected sends, approval, file previews/downloads,
file-drop forwarding, update progress/failure and Dock unread state in native
WebViews, with temporary data and local providers. Browser validation alone
does not establish native behavior. These checks require an interactive desktop
session; they do not download or install a Desk release.

For user acceptance, copy the existing application configuration and sessions to
a private isolated data directory and start embedded browser preview:

```sh
GOWORK=off CGO_ENABLED=0 go run ./cmd/pith-desk --preview --data-dir /path/to/isolated/data
```

Keep the process running and open its printed loopback URL in a visible browser.
User workspaces contain real files even with isolated application data; use
read-only inspection of existing conversations and disposable workspaces for
mutating tests. Local preview and native build do not constitute a Desk release.
