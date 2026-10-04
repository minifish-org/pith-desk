# Testing Pith Desk

## Automated checks

```sh
npm run build:ui
CGO_ENABLED=0 go test ./...
CGO_ENABLED=0 go vet ./...
CGO_ENABLED=1 go test -race ./internal/...
```

The race detector needs CGO in the development toolchain. Normal application
and release builds keep CGO disabled. No live model key is needed for these
tests: local provider and MCP fixtures exercise the actual pinned Pith APIs.

The tests cover queue consumption and cancellation, completion races, private
MCP settings and explicit process environments, MCP cancellation and reconnect,
canonical session titles, deletion/recovery, Markdown exports, resource discovery,
generated-file evidence, and authenticated native actions. Existing workspace
and permission tests remain part of the suite.

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
4. While a task is running, submit Add instruction and Queue next task. Check the
   pending list, consumption order, and that each message appears once. Stop a
   second task with pending messages; its queue must clear.
5. Approve a write or edit. After completion, Open and Reveal the generated file.
   Failed writes, missing files, and files outside the workspace must not appear.
6. Export Markdown. Save it through the native dialog, inspect its title/messages/
   tool results, and test Cancel. Cancel must not start a browser download.
7. Quit and reopen normally. Check saved titles, deletion results, permissions,
   connection configuration, and generated files. Connections are re-established
   explicitly or when the next task starts.

## Latest verification

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
