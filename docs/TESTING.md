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
canonical session titles, archive/restore, Markdown exports, resource discovery,
generated-file evidence, and authenticated native actions. Existing workspace
and permission tests remain part of the suite.

## Native smoke test

Build with `npm run build`. Close other instances using the same data directory.
For testing, launch the bundle with a separate `--data-dir` and choose a disposable
workspace. Keep its model and connection settings separate from everyday data.

1. Open Workspace resources. Check AGENTS.md and a skill in
   `.pi/skills/<name>/SKILL.md`. Inspect the instruction preview and Reveal a file.
   Create instructions in an empty workspace; an existing AGENTS.md must survive.
2. Rename a conversation, search its title, archive it, and restore it. Archived
   conversations remain readable but cannot accept a new task until restored.
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
7. Quit and reopen normally. Check saved titles, archive state, permissions,
   connection configuration, and generated files. Connections are re-established
   explicitly or when the next task starts.

## Latest verification

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
