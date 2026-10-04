# Pith Desk

A local desktop workspace for getting things done with an AI agent. Pith Desk uses [Pith](https://github.com/minifish-org/pith) as a versioned Go library and [MyGo](https://github.com/egoist/mygo) for the native window. The interface is TypeScript. The product is a separate repository; it does not fork or modify the agent SDK.

This first version supports text and image conversations, workspace folders, streamed answers, file tools, conversation permissions, workspace instructions and skills, and optional MCP connections. DeepSeek Flash is the default model. An OpenAI-compatible Chat Completions endpoint with tool calling can also be configured, using a compatible model ID from Pith's catalog.

![Pith Desk on macOS showing a workspace conversation, a tool result, and a generated Markdown file](docs/images/pith-desk-macos.png)

*The macOS desktop in Light appearance, using a demonstration workspace and conversation.*

## Try it

Download the Apple Silicon (ARM64) preview from [Releases](https://github.com/minifish-org/pith-desk/releases). New Mac releases target M-series Macs only; packages use `macos-arm64` in their names. The earlier `v0.1.0-rc.1` universal preview remains available unchanged. The current preview is ad-hoc signed and **not notarized**; see the release notes for macOS opening instructions and tested platforms. Building from source remains an option for development.

The preview includes the Pith Desk icon in Finder and the Dock, with a matching
favicon for the browser preview.

On macOS, open the built **Pith Desk.app**. You do not need Go, Node.js or npm to run the packaged application.

1. Choose a workspace folder.
2. Open Settings and enter your model endpoint, model ID and API key. Use **Test connection** to check streaming and tool calling, then Save settings. Testing sends one small model request, does not save the form, and never accesses workspace files or executes tools.
3. Create a conversation and ask the agent to inspect or change files in that folder.
4. Review the tool name and arguments before approving a file change or command. You can change the permission mode beside the message box. Use Stop to cancel a running task.

For a safe first task, choose an empty test folder and ask: “Create a short welcome.md that explains what you can do in this workspace.”

The application saves settings and conversation data in your user configuration directory (`~/Library/Application Support/Pith Desk` on macOS). The key is stored in a private local file, not in the frontend, URLs or the repository. This version does not use macOS Keychain.

### Appearance

Open **Settings → Appearance** to choose **Light**, **Dark**, or **Follow system**. Light uses a porcelain background with an indigo accent; Dark uses graphite with an ice-blue accent. Follow system is the default and responds to changes in your operating system's appearance while the app is open. Manual choices override the system until you select Follow system again.

Appearance changes apply immediately, including during an agent task, and are saved in the local settings file for the next launch. Native window controls follow the same preference. Model settings and conversation permissions are independent of appearance.

### Conversation permissions

Each new conversation starts with **Ask before changes**. Reads and searches can run without a prompt; file changes and commands need a decision.

- **Allow workspace changes** lets file tools create and edit files inside the selected workspace without asking each time. Commands still need approval. A file-change approval card also offers **Always allow workspace changes** for that conversation.
- **Full access** also lets commands and enabled MCP tools run without individual approval. Choosing this mode requires explicit confirmation because commands and external tools can access data beyond the workspace. There is no operating-system sandbox.

The choice is saved for that conversation and survives restarting the app. It does not apply to other conversations. Change back to **Ask before changes** to require approval for future changes; revoking permission does not undo an action already executing.

### Continue a running task

While Pith is working, use **Add instruction** to steer it after the current assistant turn, or **Queue next task** to submit a follow-up when it would otherwise finish. These use Pith's existing steering and follow-up queues. The pending list shows messages waiting to be consumed. Stop cancels the task and clears its pending messages; they are not carried into a later task or another conversation.

### Run status and recovery

Expand the status line above the composer to see the running model, Pith session token usage, estimated conversation context, context summary count and recorded tool failures. Model retries and context summarization have their own status. Conversation context excludes system instructions and tool schemas; usage may omit provider requests without usage reports and summaries. Cost is explicitly not reported for compatible endpoints, rather than estimated from catalog prices. These numbers are not a provider bill.

Failures show guidance for credentials, unknown models, incompatible endpoints, network interruptions, rate limits, summarization and local errors. **Review and continue** sends an explicit new instruction using the existing Pith transcript. It does not replay the original task or automatically restart actions after a crash. Review already completed or uncertain external actions first. After changing model settings, test the connection before continuing.

Run metadata is saved beside the sessions. After an interrupted shutdown, the conversation is marked for review when reopened. Settings and failure cards offer **Save diagnostics** through a native save dialog. The JSON contains version/platform information, counts, usage and failure category; it excludes prompts, transcript text, file contents, local paths, endpoint URLs, tool arguments and credentials.

### Conversations and files

Search conversation titles in the sidebar. Use the conversation actions to rename, archive, restore, or export a conversation as Markdown. Desktop exports open a native save dialog so you can choose the destination. Archived conversations stay readable and can be restored before continuing. Titles are recorded through Pith's session API; the desktop catalog indexes them. Archiving preserves the session files.

After a task finishes, successful file writes and edits appear as generated-file cards. **Open** uses the default application; **Reveal** shows the file in your file manager. Missing files, failed changes, and files outside the workspace are excluded. Files created by arbitrary shell commands are not automatically detected. Browser preview shows paths but native file actions require the desktop app.

### Workspace instructions and skills

Open **Workspace resources** to see the instruction files and skills discovered by Pith. Instructions include AGENTS.md or CLAUDE.md files discovered along the workspace's ancestor path. Project skills live in `.pi/skills`. Open or reveal these Markdown files to edit them with your own tools; changes are loaded on the next task. If the workspace has no AGENTS.md, **Create instructions** adds a starter file without overwriting an existing one.

The application retains Pith's instruction and skill discovery. Skill references to the `read` tool are mapped in the desktop prompt to its guarded `read_file` tool. No separate skill engine or visual workflow builder is used.

### MCP connections

Open **Connections** to configure an HTTP endpoint or an installed local MCP server command. HTTP connections accept an optional bearer token; an empty token field preserves the saved token. Local commands accept an argument array and optional environment overrides as a JSON object of string values. Blank overrides preserve saved values; use the clear checkbox to remove them. Only saved variable names are displayed. Enable only the connections you want available, then connect explicitly or let the next task connect them. Connection status and tool counts appear in the dialog.

Pith provides the MCP transports, tool discovery, and calls. Desk saves connection settings, selects enabled tools, and applies approvals. **Ask before changes** and **Allow workspace changes** both require approval for external MCP calls. **Full access** also authorizes tools from enabled connections. Connection changes and disconnects require the current task to finish or stop first.

Tokens and environment overrides are saved in the private local `mcp.json` file and their values are never returned in public configuration responses. This client does not install MCP servers or bundle their Node/Python runtimes. OAuth login and a connector marketplace are outside this version's scope.

## Images

Use **Attach images** in the composer, drag images onto it, or paste a screenshot.
Preview and remove attachments before sending. An image can be sent alone, with
text, or as a queued instruction or next task while the agent is working.

PNG, JPEG, GIF and WebP are accepted, with a **20 MiB total upload limit per
message** to bound local upload memory. Provider limits may be lower. Image
bytes are sent unchanged; this client does not resize or transcode uploads.
Model capability comes from the pinned Pith catalog. Text-only models reject
image inputs before starting a run; a compatible endpoint must actually support
the selected model's image input.

Accepted images are saved inside Pith's local session records, outside the
workspace, and sent to your configured model provider. Unsaved drafts stay in
memory and are cleared when you start or switch conversations. History previews
are fetched from the authenticated local service; image bytes are not included
in every streaming state update. Guarded workspace image reading is also enabled
for image-capable models. Markdown exports mark image attachments but do not
embed their bytes.

Image support is included in the
[`v0.1.0-rc.5` Apple Silicon preview](https://github.com/minifish-org/pith-desk/releases/tag/v0.1.0-rc.5).


## Develop

Requirements: Go 1.27.1 or later, Node.js 22.12 or later, npm, and macOS 12 or later for the first desktop target.

```sh
npm ci
npm --prefix frontend ci
npm run dev
```

`dev` builds the frontend and starts the native desktop window with CGO disabled. The same UI can be inspected in a browser:

```sh
npm run preview
```

Open the loopback URL printed by the process. The browser preview uses the real local backend and the same local data. Its workspace picker accepts a path; the native application also has a folder dialog. Only one process may open a data directory at a time. Close the native application before previewing, or run `CGO_ENABLED=0 go run ./cmd/pith-desk --preview --data-dir /path/to/separate/test-data` after building the frontend. This is a local development preview, not a server deployment mode.

## Build a Mac application

```sh
npm run build
```

The local build creates an application bundle under `build/`. It uses ad-hoc signing and skips notarization and DMG generation. Developer ID signing and notarization are separate release steps for distributing outside this machine. `npm run build` uses the current host architecture; `npm run build:mac` and Mac release packaging target Apple Silicon (ARM64). Source builds on Intel Mac are outside the supported scope.

```sh
npm --prefix frontend run build
CGO_ENABLED=0 go test ./...
CGO_ENABLED=0 go vet ./...
```

Both Pith and MyGo are pinned in `go.mod`; the released application does not rely on a sibling checkout or a local Go `replace` directive. Node/npm are development tools only. The Mac window uses the system WKWebView, which may have its own helper processes.

## Where to read the code

- `frontend/src/`: layout, settings, conversations, streamed state and approval controls.
- `internal/desk/`: the application service and its Pith SDK adapter, persisted settings/history and tool policy.
- `internal/host/`: embedded frontend, authenticated loopback API and streamed snapshots.
- `cmd/pith-desk/`: the native window, folder picker, application lifetime and browser preview.
- `mygo.config.ts`: build and packaging settings.

The Go service owns each agent run. Closing a browser subscription does not end a run; Stop and application shutdown cancel it explicitly. The frontend only renders snapshots and submits user actions.

See [testing and native smoke checks](docs/TESTING.md) for verification and a short manual checklist.

## Current boundaries

This is an experimental local desktop product. It has no computer-control tools, plugin marketplace, scheduled jobs, enterprise account system or automatic updates yet. Durable is available in the pinned Pith library, but this UI currently uses its normal coding-agent sessions.

Workspace checks are an application tool policy, **not an operating-system sandbox**. File tools reject paths outside the workspace. An approved command can access the computer with your account's permissions; examine it before allowing it. Model requests send the conversation and tool results to your configured provider. See [security and data handling](docs/SECURITY.md).

Pith Desk targets macOS on Apple Silicon (ARM64) and Linux. Intel Mac and Windows are not supported. Native application testing and the current CI workflow cover Mac ARM64; Linux runtime testing and public release packages are still pending. For end users, downloadable application packages are the intended delivery path; building from source is a development option. Preview downloads use manual replacement of the app bundle; no automatic updater is available. See [release packaging and signing](docs/RELEASING.md).

CGO-disabled cross-builds have passed for Linux on amd64 and arm64. This establishes compilation only. Linux needs GTK3 and WebKitGTK at runtime; CGO-disabled builds do not remove these system WebView dependencies.

The interface draws on the workspace-and-conversation layout of DeepSeek Harness, but uses its own host and Pith SDK integration. It does not load Harness plugins or copy its application runtime.

## License

Pith Desk is licensed under the [GNU Affero General Public License v3](LICENSE), consistent with its Pith dependency. Dependency notices are in [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md). See [CONTRIBUTING.md](CONTRIBUTING.md) for development and contribution guidance, and [SECURITY.md](SECURITY.md) for private security reporting.
