# Testing Pith Desk

## Automated checks

```sh
GOWORK=off npm run build:ui
GOWORK=off CGO_ENABLED=0 go test ./...
GOWORK=off CGO_ENABLED=0 go vet ./...
GOWORK=off CGO_ENABLED=1 go test -race ./internal/...
```

The race detector needs CGO in the development toolchain. Normal application
and release builds keep CGO disabled. No live model key is needed for these
tests: local provider and MCP fixtures exercise the Pith APIs. Tests use the
published Pith revision pinned in `go.mod`, without a sibling checkout; see
[SDK dependency validation](SDK_FEATURES.md#versioned-sdk-dependency).

The tests cover queue consumption and cancellation, completion races, private
MCP settings and explicit process environments, MCP cancellation and reconnect,
canonical session titles, deletion/recovery, Markdown exports, resource discovery,
generated-file evidence, and authenticated native actions. Existing workspace
and permission tests remain part of the suite.

## SDK integration regression tests

`internal/desk/sdk_features_test.go` uses temporary data/workspace directories
and local SSE/MCP fixtures. It checks independent compatible providers, credential
scoping and restart, empty-key local endpoints, immutable cost snapshots,
unknown-price handling, manual compression with metered summaries, Code mode
nested approvals and path boundaries, deferred MCP schemas, resource editing,
branch switching, mocked SDK OAuth credential persistence, endpoint-scoped MCP
tokens, a complete local SDK MCP OAuth discovery/PKCE/callback/exchange flow with invalid-state rejection and cancellation, durable queue/image recovery beyond one pagination page, and actual shutdown/restart with reviewed queue continuation.

The pinned Pith revision includes regression tests for retaining composed model
metadata and refreshing deferred tool schemas in the next session turn. No live
model or identity-provider credentials are used. Live vendor OAuth and actual
MCP authorization-server compatibility still need account-backed smoke tests;
the mocked flow verifies host integration, not vendor availability.

## Native smoke test

Build with `npm run build`. Close other instances using the same data directory.
For testing, launch the bundle with a separate `--data-dir` and choose a disposable
workspace. Keep its model and connection settings separate from everyday data.

1. Open Workspace resources. Check AGENTS.md and a skill in
   `.pi/skills/<name>/SKILL.md`. Inspect the instruction preview and Reveal a file.
   Create instructions in an empty workspace; an existing AGENTS.md must survive.
2. Create two workspaces with multiple conversations. Check the folder tree,
   collapse/expand, search and each folder's new-conversation button. Use an
   inactive chat's `…` menu to rename, export and delete it without switching
   the active chat. Cancel deletion first and verify data stays intact; then
   confirm and inspect that its session and run files are gone. Delete an active
   chat and check messages, attachments, usage and queued drafts clear.
   Use a folder's `…` menu to remove the workspace. Verify the confirmation names
   the folder and conversation count, and removal leaves no chats for that
   workspace. All original workspace files must remain unchanged. Re-add the
   folder: old conversations must not return. Restart and repeat the checks.
   Check menu keyboard access and Escape/outside-click dismissal. Running tasks
   must block deletion, workspace removal and switching conversations.
3. Configure an HTTP or installed stdio MCP server. Connect and inspect the tool
   count. Check that saved tokens/environment values are not filled back into the
   form. In Ask before changes, an MCP call must require its own approval.
4. While a task is running, send several messages (including duplicate text and
   image attachments). All must enter the ordinary queue. Edit one, delete one,
   and click Steer on another. Only the steered entry becomes an Instruction;
   it must precede ordinary pending input at the next turn boundary. Edits must
   retain attachments and consumed messages must appear only once. Quit and
   restart with pending mutations, check their recovery, and edit/delete before
   reviewed continuation. Stop a second task; its pending queue must clear.
5. Approve a write or edit. After completion, Open and Reveal the generated file.
   Failed writes, missing files, and files outside the workspace must not appear.
6. Export Markdown. Save it through the native dialog, inspect its title/messages/
   tool results, and test Cancel. Cancel must not start a browser download.
7. Quit and reopen normally. Check saved titles, deletion results, permissions,
   connection configuration, and generated files. Connections are re-established
   explicitly or when the next task starts.

## Latest verification

The rc.8 candidate pins published Pith revision `92adcb39fd33`. With `GOWORK=off`,
the complete frontend/Go tests, vet and internal race checks passed. The ARM64
app embeds the versioned SDK with CGO disabled, and its ad-hoc signature
verified.

The 2026-10-07 follow-up verified pending-message edit/delete/Steer with native
SDK IDs, preserved images, durable mutation recovery and rejection after
delivery. SDK regression tests cover promotion between the final queue polls,
so steering the last pending message cannot lose it or reorder ordinary input.
Full Pith tests and vet, plus agent/coding-agent race checks, passed.

Isolated native fixtures verified ordinary queueing, edit/delete/Steer delivery
order without duplicates, and preservation of the composer draft. Timing tests
cover a live clock without stream events, per-task output independent of price,
reset for the next task, Stop (including immediate Stop), reopening and crash
checkpoints without downtime. A native timing fixture checked both collapsed
and expanded statistics, reset, Stop and an unchanged duration after reopening.
All fixture credentials and workspaces were local; no user conversation or
live model provider was used.

Pith shares an in-memory QuickJS compilation cache instead of recompiling the
same immutable module for every sandbox. Codemode and coding-agent race tests
passed; an added regression verifies independent host bindings, VM state and
runtime lifetimes.

CI runs race-instrumented packages sequentially, preserving concurrent execution
within each package. State synchronization permits 30 seconds for cold startup;
the deliberately padded 3 MiB image completion wait permits 90 seconds. CPU
profiling confirmed race instrumentation dominates this test's JSON processing.
These are bounded synchronization waits rather than latency contracts. All
state assertions, upload limits, authenticated history and exact-byte checks
remain in place.

An isolated native test bundle with a distinct bundle identifier and disposable
data verified cold launch, provider OAuth controls, a local compatible endpoint's
streaming/tool probe, a real guarded README read through Pith, Stop, and restored
history/status/cost totals after restart. Markdown export and diagnostics native
save dialogs both returned normally on Cancel. No live model provider or identity
provider was contacted. Gitleaks found no secrets in the intended source tree;
both npm dependency audits reported zero vulnerabilities.

On 2026-10-05, the delete/remove implementation passed the CGO-disabled project
tests and vet checks, plus race checks. An isolated browser preview verified
cancel/confirm on inactive and active conversations, draft/image clearing,
workspace cascade removal (including an empty folder), and removal of the final
workspace. A second client added a chat while confirmation was open: removal
was rejected until its updated count was reviewed. On-disk checks confirmed
transcripts were gone and both workspace folders/files remained intact. A
backend restart and re-adding the same folder did not resurrect old chats.
The intentionally rejected stale request returned HTTP 400; no JavaScript
errors were observed. No live model calls or production data were used.

Deletion tests cover transcripts with image attachments, run receipts, active/inactive
state, workspace cascade removal, stale confirmation counts, failed catalog writes,
interrupted cleanup recovery and filesystem containment. Historical checks below
include the previous archive UI; archive/restore has since been removed.

On 2026-10-05, an isolated browser preview of the ARM64 bundle verified the
workspace tree with two temporary folders and multiple chats: creating a chat
in a different workspace, collapsing/expanding folders, title search, and
rename/archive/restore/export of an inactive conversation without switching the
active chat. Menu keyboard navigation, Escape and outside-click dismissal
passed. A backend process restart preserved titles, archive state and the active
workspace. Light/dark layouts were inspected; no live model calls were made.

On 2026-10-04, the automated checks and Mac ARM64 packaging passed. An isolated
native app used a local streaming provider and HTTP MCP fixture to verify title
search/rename, archive/restore, instruction/skill discovery, MCP connection and
approval, steering/follow-up consumption, Stop clearing the queue, a successful
write/file card, Finder Reveal, native Markdown save/cancel, and restored history.
The saved export contained the title, queued messages, and MCP result. These
checks validate integration behavior; they do not measure a live model's quality.

Desktop export uses MyGo's save dialog rather than the WebView download path.
Native policies are registered before navigation, and the window is shown when
MyGo reports it is ready. Linux runtime testing remains pending.

## Open-source review

The 2026-10-04 review covered the complete Git history and the intended source
tree with Gitleaks 8.30.1; neither scan found a secret. Both npm lockfiles passed
`npm audit`, including development dependencies. The source and documentation
were checked for private machine paths, committed local data, and Chinese text.

A CGO-disabled source and call-reachability scan using govulncheck v1.8.0, built
with Go 1.27.1, initially found a reachable Unicode normalization issue:
[GO-2026-5970](https://pkg.go.dev/vuln/GO-2026-5970). Updating the indirect
`golang.org/x/text` dependency to v0.39.0 resolved the finding; the subsequent
scan reported no vulnerabilities. These are dated database checks, not a
guarantee that future vulnerabilities will not be discovered.

The review also added regressions for instruction/system-prompt symlink escapes
and canonical workspace selection, and checked asynchronous form saves and
export availability. The AGPL license and exact-version third-party license
texts are retained with the source. Public binary distribution remains a
separate step requiring the accompanying notices and corresponding source.

After the fixes, the full Go tests, vet, internal race tests, TypeScript/frontend
build, Mac ARM64 application packaging, and ad-hoc signature verification
passed. CGO-disabled builds also passed for Intel Mac and Linux amd64/arm64.
These cross-builds establish compilation only; they do not add native runtime
coverage for those targets.

## Release and run-status checks

- Test unsaved model settings: success must confirm streaming and a tool call,
  while the existing settings and conversation remain unchanged. Try an invalid
  key, an unavailable model, an endpoint without tools and Cancel test.
- Expand run status; verify provider token usage, retry/compaction transitions
  and restored totals after restarting. Cost must not appear as a guessed bill.
- Verify the latest-task clock advances while a model request waits without new
  stream events. Finish or Stop and reopen: duration must freeze and persist.
  The next task resets timing and output; speed uses reported output only, even
  for unpriced endpoints. Interrupted checkpoints exclude downtime and show no
  speed; old receipts without timing remain unrecorded.
- Stop a task and use Review and continue. Check history is available and the
  old user request is not appended again. No task resumes without a user action.
- Save diagnostics and inspect its JSON. Confirm it contains no prompts, file
  data, endpoint URL, local paths, API/MCP keys or raw provider error bodies.
  Cancel must not trigger a WebView download.
- Run `npm run release:preview`; verify the ARM64 architecture and CGO-disabled
  metadata, archive extraction and dependency notices. Actual Developer ID
  signing/notarization requires credentials and a separate native acceptance.

The 2026-10-04 release follow-up passed an isolated Mac ARM64 native launch
using the universal preview bundle: restored interruption notice, explicit
continuation, cumulative usage, successful tool-call connection probe, rejected
key guidance, native diagnostic save, JSON inspection and Save cancellation.
No production configuration or live model credentials were used. Intel Mac
runtime and real Developer ID notarization remain unverified.

## Image input verification

The image follow-up on 2026-10-04 used only offline provider fixtures and
isolated application data. Full Go tests, vet, race checks and an ARM64
CGO-disabled app build cover the actual pinned SDK image options. Integration
tests verify unchanged image bytes in Chat Completions requests, image-only
messages, steering/follow-up ordering, detached snapshots, persistent history
after restart, and image markers in Markdown exports. A larger-than-2-MiB
upload exercises the expanded image request transport. Invalid MIME/base64,
SVG, excess upload size, unknown image references, unauthenticated and foreign
origin reads are rejected. Workspace image reads retain the existing file guard.

The browser check covered choosing/removing a PNG, image-only sending, and
loaded history after refresh. File-drop and a synthetic PNG clipboard event
added loaded previews; switching the fixture to a text-only model disabled
sending and kept both drafts. The native WKWebView check covered restoring
that session, choosing a PNG with the macOS file picker, previewing it, sending
it and completing the response. Fixture logs confirmed the selected bytes
reached the offline provider. These checks do not certify a live model's visual
understanding or an endpoint's support for every catalog capability.

For manual acceptance, also paste a screenshot or drag multiple supported
images onto the composer, check removal and mixed text/image input, and test
a text-only model. A rejected upload must keep the draft and leave the
existing history unchanged. Diagnostics must not include image bytes.

## Provider and model selection

Offline fixtures exercise the native OpenAI Responses, Anthropic Messages, and
Google Generative AI routes for an agent task, a tool-call connection probe, and
context summarization. DeepSeek fixtures inspect outgoing requests for `low`,
`high`, `max`, and `off`; this verifies that the selected effort reaches Pith's
adapter rather than merely changing the UI. The full catalog and credentials
are not copied into streaming frontend snapshots.

Tests also cover authenticated catalog/selection routes, detached capability
arrays, legacy settings loading, per-provider selection and key restoration,
endpoint key isolation, invalid thinking levels, failed saves and restart.
These are protocol fixtures, not live provider-account acceptance tests.

Manual UI checks:

1. Load legacy DeepSeek settings. Confirm the saved key is still configured and
   the old `high` default remains selected.
2. Open the model picker, search a model ID, change models and select effort.
   Confirm unsupported effort values disappear and image guidance follows the
   selected model. Reload: the selection should remain.
3. In Settings, change providers. Confirm the endpoint updates inside the
   collapsed Advanced connection settings and another provider’s key is never
   filled into the password field. Settings must have no model/effort controls
   and the top bar must have no duplicate model picker. Saving an inactive
   provider must leave the current model and effort unchanged.
4. Save two provider connections and switch between them with the composer
   picker. Confirm each saved selection/key is restored without re-entering it.
5. Expand Advanced connection settings and change the endpoint. Confirm the key becomes required again. Cancel and
   reopen Settings: saved configuration must be unchanged.
6. During a task, model/effort selection must be disabled. A direct mutation
   must also be rejected by the service, including during a connection probe.

The development browser check uses its own data directory and fixture keys;
no live provider request or user settings are needed.

## SDK batch verification (2026-10-06)

The local Pith override passed the full coding-agent package suite. Desk passed
CGO-disabled package tests and vet, TypeScript checking, the production UI build,
and targeted race checks for custom connections, Code mode, deferred MCP,
OAuth, durable recovery and manual compression. The ARM64 application bundle
was rebuilt locally with CGO disabled.

An isolated Playwright browser preview and local SSE provider exercised adding
an empty-key custom connection with rates, selecting its model, streaming a
reply, viewing the request ledger, continuing from a history node, and creating
and using SDK resources. Screenshots are development evidence under ignored
`output/playwright/`, not captures of real user conversations. The browser check
found an HTML pattern issue in the resource editor; the corrected editor saved
a hyphenated skill name without browser errors. Light and Dark layouts were
inspected, and incomplete custom price input was rejected rather than silently
treating missing categories as free.

Live vendor OAuth, a real external MCP OAuth server, and Linux desktop runtime
compatibility are not established by these fixtures. Release checks must be
repeated with the published SDK dependency and `GOWORK=off`.

## Inline branching and message layout (2026-10-06)

Saved user messages and settled replies expose their Pith history node IDs to
the inline branch action. A regression rejects branch targets inside unfinished
tool exchanges. Existing sibling-branch and restart tests still pass, as do the
CGO-disabled full suite, vet, frontend build and ARM64 app packaging.

An isolated browser fixture verified inline branching, preservation of an
unsent draft, composer focus, and restoring the later messages through the
history browser. Light, Dark and 560-pixel layouts were inspected. Image history
loaded after restart, remained aligned to the right, and kept its branch action
below the image without horizontal overflow. Screenshots are retained under
ignored `output/playwright/message-*.png`. No live model request was needed.

## Grouped tool activity (2026-10-06)

Consecutive tool calls now share a collapsed summary with call, running and
failure counts. Expanding it reveals the original per-call results. Stable SDK
tool-call IDs keep individual expansion state when transient messages become
saved transcript entries; group state also survives streaming refreshes.

The browser fixture grouped 11 consecutive calls separately from a later
single call. WebSocket fixture updates verified expansion preservation across
live/saved ID changes and that a manually closed group stays closed. Keyboard
toggling, visible failure counts, escaped tool output and a 560-pixel layout
passed without browser errors. Screenshots are under ignored
`output/playwright/tool-groups-*.png`. This fixture did not run commands or
contact a model provider. Full CGO-disabled tests, vet, the frontend build,
ARM64 app packaging and ad-hoc signature verification passed afterward.

## Inline request costs (2026-10-06)

Costs now share the original run statistics instead of a separate button and
modal. Regression tests verify the snapshot matches immutable ledger totals,
latest-task totals reset, restart and conversation switching rebuild from the
ledger, and corrupt cost data does not prevent opening conversation history.

An isolated browser fixture checked the summary amount, inline totals and
request breakdown, no cost button or open dialog, lazy ledger loading and
preserved rate disclosure during streamed updates. Unknown, unrecorded, partial,
free and unavailable states were checked separately. At 560 pixels, the details
scroll within the statistics and the composer stays visible without document
overflow. There were no browser console errors. Screenshots are under ignored
`output/playwright/inline-costs-*.png`; no live provider or user data was used.
CGO-disabled full Go tests, vet, the frontend build, ARM64 packaging and ad-hoc
signature verification passed before release.

The header follow-up leaves one labelled Compact button with an inward-arrow
icon; the active conversation's menu holds the history browser. A browser
fixture verified the single header action, the relocated history browser and
the compact request payload (intercepted without contacting a model provider),
with no console errors. TypeScript/UI checks and ARM64 app packaging passed.

Message labels and avatars were removed after left/right alignment made them
redundant. Browser fixtures verified commentary/tool/result order, a tool-first
reply, branch actions, the plain working indicator and screen-reader message
names. Reply text and tools share the same left edge on wide and 560-pixel
layouts, without document overflow or console errors. Light/Dark screenshots
are retained under ignored `output/playwright/messages-*.png`. The frontend and
ARM64 app were rebuilt; no provider call or user conversation was used.

Inline branch actions are now limited to saved assistant replies. A browser
fixture with two user messages and two settled replies verified zero user-row
branch buttons and two reply-row buttons, with no console errors. TypeScript/UI
checks and ARM64 app packaging passed. The SDK history browser still exposes
saved nodes; the underlying branch semantics are unchanged.

The dark message-bubble follow-up uses a brighter neutral fill without a visible
outline. Browser checks confirmed explicit Light/Dark preferences win over the
opposite OS preference, System follows both OS palettes, and narrow layouts have
no document overflow. No console errors were observed. TypeScript/UI checks and
ARM64 app packaging passed; the fixture screenshot is retained under ignored
`output/playwright/bubble-contrast-dark.png`.

Attachment messages now place the image gallery above a content-sized text
bubble, with both aligned right. An isolated browser fixture checked short and
long text, image-only messages, mixed portrait/landscape images and 560-pixel
layouts. Previews preserve their individual aspect ratios and do not stretch to
the tallest image in a row. No document overflow or browser console errors were
observed. TypeScript/UI checks and ARM64 app packaging passed. Screenshots are
retained under ignored `output/playwright/attachment-layout-*.png`; no live
provider or user conversation was used. This was verified locally before release.
