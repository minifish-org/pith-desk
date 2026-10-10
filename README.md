# Pith Desk

A local desktop workspace for getting things done with an AI agent. Pith Desk uses [Pith](https://github.com/minifish-org/pith) as a versioned Go library and [MyGo](https://github.com/egoist/mygo) for the native window. The interface is TypeScript. The product is a separate repository; agent behavior stays in the Pith SDK.

This preview supports text and image conversations, workspace folders, streamed answers, guarded tools, instructions/skills/prompt templates, conversation branches, manual compression, deferred MCP discovery, Code mode, OAuth, durable task journals and request cost estimates. DeepSeek Flash is the default model. See [SDK integration](docs/SDK_FEATURES.md) for the reused capabilities and their boundaries. Provider selection, model capabilities, thinking levels and native request adapters come from Pith’s SDK. API-key connections include DeepSeek, OpenAI, Anthropic, Google, Mistral and compatible providers in its catalog.

![Pith Desk on macOS showing a workspace conversation, a tool result, and a generated Markdown file](docs/images/pith-desk-macos.png)

*The macOS desktop in Light appearance, using a demonstration workspace and conversation.*

## Try it

Download the Apple Silicon (ARM64) preview from [Releases](https://github.com/minifish-org/pith-desk/releases). New Mac releases target M-series Macs only; packages use `macos-arm64` in their names. The earlier `v0.1.0-rc.1` universal preview remains available unchanged. The current preview is ad-hoc signed and **not notarized**; see the release notes for macOS opening instructions and tested platforms. Building from source remains an option for development.

The preview includes the Pith Desk icon in Finder and the Dock, with a matching
favicon for the browser preview.

On macOS, open the built **Pith Desk.app**. You do not need Go, Node.js or npm to run the packaged application.

1. Choose a workspace folder.
2. Open Settings, choose a provider and enter its API key, or use **Sign in with provider** when Pith offers OAuth. The default endpoint is filled in automatically; **Advanced connection settings** lets you override it. Use **Test connection** to check streaming and tool calling using that provider’s last selected model or Pith’s default, then Save settings. Testing sends one small model request, does not save the form, and never accesses workspace files or executes tools.
3. Choose a model and thinking effort beside the message box. Create a conversation and ask the agent to inspect or change files in that folder.
4. Review the tool name and arguments before approving a file change or command. You can change the permission mode beside the message box. Use Stop to cancel a running task.

For a safe first task, choose an empty test folder and ask: “Create a short welcome.md that explains what you can do in this workspace.”

The application saves settings and conversation data in your user configuration directory (`~/Library/Application Support/Pith Desk` on macOS). The key is stored in a private local file, not in the frontend, URLs or the repository. This version does not use macOS Keychain.

### Providers, models and thinking effort

**Settings** manages independent model connections. Choose a built-in provider and save its key or sign in through its SDK OAuth flow. **Add independent model connection** gives another endpoint its own name, protocol, models and credentials. Official OpenAI and several OpenAI-compatible endpoints can coexist. API base URL is prefilled and hidden under
**Advanced connection settings** for proxies and custom services. Saving another
provider’s connection does not change the active conversation model. Pith supplies the catalog, input
capabilities, context/output limits, and supported thinking levels. The model
list is the catalog bundled with the pinned Pith SDK, **not** a live list of
models authorized for your account. Updating the SDK updates this catalog.
The endpoint override must speak the selected model's native protocol.

The model button beside the composer opens a searchable
picker for configured providers. The thinking selector only shows levels that
Pith says the selected model supports, including `max` when available. Models
with no reasoning support hide that control. Changes apply to the next task;
stop all running tasks before changing the shared model or effort. The run details record
the provider and effort actually selected for that task.

Each provider retains its own endpoint, key and last selection. Switching
providers restores those settings. Changing an endpoint requires entering the
key again: a saved credential is never silently forwarded to a new address.
Custom connections have their own model IDs, capabilities, limits and optional
USD prices. Blank prices mean unknown; explicit zero prices mean free. A blank
key on a custom connection sends the SDK adapters a non-secret `unused` key,
which is suitable only for servers that ignore authentication.

Agent requests, connection probes and context summaries all use Pith's native
adapters. Desk does not implement separate OpenAI, Anthropic or Google clients.
OAuth availability comes from the selected SDK provider. The sign-in dialog
opens the provider page and forwards device codes or additional prompts; tokens
are saved by Pith and refreshed for subsequent requests. OAuth uses the official
provider endpoint, not a custom proxy. Cloud credential setups such as Bedrock,
Vertex and Azure are not configured by this UI.

### Appearance

Open **Settings → Appearance** to choose **Light**, **Dark**, or **Follow system**. Light uses a porcelain background with an indigo accent; Dark uses graphite with an ice-blue accent. Follow system is the default and responds to changes in your operating system's appearance while the app is open. Manual choices override the system until you select Follow system again.

Appearance changes apply immediately, including during an agent task, and are saved in the local settings file for the next launch. Native window controls follow the same preference. Model settings and conversation permissions are independent of appearance.

### Conversation permissions

Each new conversation starts with **Ask before changes**. Reads and searches can run without a prompt; file changes and commands need a decision.

File-change approvals show the workspace path and a colored diff for creates,
overwrites and multi-block edits. **Tool arguments** retains the complete
request. Large or non-text changes fall back to the arguments with an
explanation. If a previewed file changes while waiting, approving refreshes
the diff and requires another decision before execution or a lasting grant.

- **Allow workspace changes** lets file tools create and edit files inside the selected workspace without asking each time. Commands still need approval. A file-change approval card also offers **Always allow workspace changes** for that conversation.
- **Full access** also lets commands and enabled MCP tools run without individual approval. Choosing this mode requires explicit confirmation because commands and external tools can access data beyond the workspace. There is no operating-system sandbox.

The choice is saved for that conversation and survives restarting the app. It does not apply to other conversations. Change back to **Ask before changes** to require approval for future changes; revoking permission does not undo an action already executing.

### Continue a running task

While Pith is working, the send button becomes **Stop** when the composer is empty. Adding text or images switches it back to send; sending a message queues it for when the current task would otherwise finish. In **Pending messages**, edit or delete individual messages, or click **Steer** to turn one into an **Instruction** for the next turn boundary. Steering waits for the current model response and tool batch; it does not interrupt a running command. Editing preserves attached images. Messages already received by the agent cannot be edited or deleted. Stop cancels the task and clears its pending messages; they are not carried into a later task or another conversation.

Closing the desktop window or pressing `⌘Q` asks for confirmation when any workspace has an active task, including one waiting for approval. **Keep working** leaves those tasks running; it is the default when you press Return. **Stop tasks and quit** interrupts all tasks and exits the app. An idle app closes immediately. In this preview, Escape does not dismiss the confirmation; use **Keep working** or Return.

### Run status and recovery

Expand the status line above the composer to see the running model, Pith session token usage, estimated conversation context, context summary count, recorded tool failures and estimated cost. Expand **Request breakdown** within those statistics for each reported request, including retries and context summaries, with input/output/cache tokens, purpose, status, saved rates and price source. Model retries and context summarization have their own status. Conversation context excludes system instructions and tool schemas. Costs are USD estimates from the bundled Pith/Pi catalog or custom prices, not the provider bill. Requests with unknown usage or prices are excluded from totals. No external pricing or exchange-rate API is called. Earlier requests made before the ledger was added are not reconstructed.

Expand a **Command** tool entry to see its exact command text, initial working directory and output. Its header shows **Running**, **Completed** or **Failed**, and the details survive reopening the conversation. A numeric exit code appears only when supplied as structured tool-result metadata. The current pinned Pith SDK does not supply one; Pith Desk does not infer it from output or error messages.

The same status line shows the latest task's total elapsed time and average output tokens per second. Time includes tools, approval waits, retries and context summaries; speed uses that task's reported output tokens (including reasoning), excluding input, cache and earlier tasks. It is a task average, not instantaneous model decoding speed. Completed and stopped timing survives reopening. Old runs without timing show **Not recorded**; interrupted checkpoints show a lower-bound duration and no speed, excluding app downtime.

Failures show guidance for credentials, unknown models, incompatible endpoints, network interruptions, rate limits, summarization and local errors. **Review and continue** sends an explicit new instruction using the existing Pith transcript. It does not replay the original task or automatically restart actions after a crash. Review already completed or uncertain external actions first. After changing model settings, test the connection before continuing.

Run metadata is saved beside the sessions. After an interrupted shutdown, the conversation is marked for review when reopened. Settings and failure cards offer **Save diagnostics** through a native save dialog. The JSON contains version/platform information, counts, usage and failure category; it excludes prompts, transcript text, file contents, local paths, endpoint URLs, tool arguments and credentials.

### Conversations and files

The sidebar groups conversations under their workspace folders. Expand or collapse a folder, or use its new-conversation button to start a chat in that workspace. Search conversation titles across workspaces. Each conversation's `…` menu can rename, export or permanently delete that conversation without opening it first. Desktop exports open a native save dialog so you can choose the destination. Titles are recorded through Pith's session API; the desktop catalog indexes them.

Text drafts are saved automatically in the private application data profile,
separately for each conversation. Switching conversations or restarting the
app restores the text. A workspace with no conversation can retain its own
initial draft. Sending or queueing successfully clears only the submitted,
unchanged text; a rejected request keeps it. Drafts are not sent to the model
or added to the transcript until submitted. Removing a conversation or
workspace also removes its drafts. Text drafts have an 8 MiB limit; image
attachments retain their existing in-memory draft behavior.

The rc.11 preview supports **concurrent tasks in separate workspace folders**. Add folders, create conversations and switch views while other tasks continue in the background. The sidebar marks each running conversation and shows when it needs approval. Stop, pending input, permissions and run statistics belong to that conversation. A workspace can run one task at a time; nested or overlapping workspace folders share that restriction. An occupied workspace offers **Open running conversation**. Global model, credential and MCP connection changes require all tasks to stop. See [workspace concurrency](docs/WORKSPACE_CONCURRENCY.md) for the execution contract and validation. Earlier previews retain the application-wide single-task restriction.

The rc.12 preview replaces the sidebar's text badges with a small blue spinning ring and an amber approval icon. The ring has a fixed gap and indicates activity, without estimating progress. A completed task leaves a blue unread dot until its conversation is viewed. Completion in another conversation shows an in-app notice; when the desktop app is in the background, it sends a silent macOS notification instead. Both offer navigation to the completed conversation. System notifications require OS permission and remain subject to Focus and screen-sharing rules. These indicators and notifications are not included in rc.11.

The local source build retains notification targets across launches on macOS.
Clicking a valid older notification starts or activates the packaged app and
opens its workspace conversation. Targets expire after 90 days, a newer
completed run in the same conversation, or removal of the conversation/workspace;
at most 512 are retained. An unavailable target shows a short explanation. macOS
starts the normal application data profile; custom `--data-dir` profiles must be
reopened with the same argument before clicking. The OS does not replay launch
arguments. Linux and Windows notification backends support current-process
clicks only.

The native **File** menu provides **New Conversation** (`Cmd/Ctrl+N`),
**Choose Workspace…** (`Cmd/Ctrl+O`) and **Export Current Conversation…**
(`Cmd/Ctrl+Shift+E`). **Settings…** uses `Cmd/Ctrl+,`; macOS places it in the
application menu. The standard edit, view, window and quit controls remain.
Page actions wait for loading, requests and dialogs; export is disabled for the
current running or approval-pending conversation. Opening settings and choosing
another workspace remain available while tasks run. Configuration changes and
quit confirmation retain their existing rules.

**Delete conversation** permanently removes its local session history, image attachments and run receipt. **Remove workspace**, in the folder's `…` menu, unlinks the folder and deletes all its conversations and related application data. Both require confirmation. A running conversation cannot be deleted; a workspace with an active task or overlapping active folder cannot be removed. Unrelated idle conversations remain manageable while other tasks run. Workspace folders and their files—including files created by Pith and exported documents—are never deleted. There is no archive or restore feature. Removing a folder leaves no dangling conversations.

Deletion intent is saved before the catalog changes. If cleanup is interrupted, Pith Desk retries committed deletions on startup; uncommitted requests leave their conversation data intact. Cleanup errors are reported and never treated as a successful deletion.

Press `⌘N` to start a conversation in the current workspace.

After a reply stops streaming, **Copy response** copies its original text and Markdown.
Each fenced code block also has **Copy**, which copies only that block's literal
code, including its line breaks. This is available in Markdown file previews too.

Use **Cmd/Ctrl+F** to find text in the current conversation, including folded
tool results. **Enter** and **Shift+Enter** move between matches; **Esc** closes
search. Sidebar search continues to search conversation titles.
Switching conversations remembers each conversation's reading position and
expanded tool results for the current app session. New output follows the bottom
when you are already there; when reading earlier content, **Back to latest**
returns to the end.

After a task finishes, successful file writes and edits appear in the conversation's **Files** panel. The file button in the top-right title bar shows a count and is hidden when there are no files. Click it to open the file list; click it again, click outside, or press Escape to close. Switching conversations closes the panel. **Open** uses the default application; **Reveal** shows the file in Finder. **Copy file** places the file on the system clipboard so you can paste it into Finder; the original stays in place. Missing files, failed changes, and files outside the workspace are excluded. Files created by arbitrary shell commands are not automatically detected. Browser preview offers **Copy path**; native file actions require the desktop app.

**Preview** opens the file in a dialog within Desk: PNG, JPEG, GIF and WebP
images up to 50 MiB, rendered Markdown, and UTF-8 text. Long text previews show
the first 8 MiB in pages of up to 256 KiB. Large Markdown previews use paged source
text; smaller Markdown previews retain formatted rendering. HTML and SVG source
appear as text; scripts and external images do not run in the preview. Use **Open** to view an animation or other
file in its associated application. Preview reads the current recorded file
through the same workspace checks as the existing file actions.

Drop existing files from the selected workspace into the message area to insert editable, workspace-relative paths. Multiple files, spaces and Chinese names are supported. These are plain Markdown path references; dropping them does not import or read their contents. Images keep their existing attachment behavior. Browser preview can validate complete local file URIs; when the browser hides the path, type the relative path or use the desktop app.

On macOS, the Dock shows **!** for pending approval or the number of conversations with completed unread results across all workspaces. Approval takes priority over unread results. Ordinary running tasks do not add a Dock badge. Unread counts remain until the corresponding results are viewed, survive app restarts, and show **99+** above 99 conversations. With no approvals or unread results, the Dock badge stays empty. Other platforms retain the in-app task indicators.

### Workspace instructions, skills and prompt templates

Open **Workspace resources** to inspect the files discovered by Pith. Instructions
include AGENTS.md and CLAUDE.md along the ancestor path; project skills live in
`.pi/skills`, and prompt templates in `.pi/prompts`. View, create, edit or delete
project resources in the Markdown editor. Inherited instructions are read-only
here. Changes load on the next task. **Use** inserts `/skill:name` or `/name` into
the composer; Pith expands the resource and template arguments when submitted.

The application retains Pith's instruction and skill discovery. Skill references to the `read` tool are mapped in the desktop prompt to its guarded `read_file` tool. No separate skill engine or visual workflow builder is used.

### MCP connections

Open **Connections** to configure an HTTP endpoint or an installed local MCP server command. HTTP connections accept an optional bearer token; an empty token field preserves the saved token. Local commands accept an argument array and optional environment overrides as a JSON object of string values. Blank overrides preserve saved values; use the clear checkbox to remove them. Only saved variable names are displayed. Enable only the connections you want available, then connect explicitly or let the next task connect them. Connection status and tool counts appear in the dialog.

Pith provides the MCP transports, discovery, OAuth and calls. Desk saves connection settings, supplies sign-in UI and applies approvals. Enabled MCP tools are registered as deferred: the model starts with `tool_search`, and selected schemas become available on demand. Connecting still discovers the server catalog; deferred exposure saves model context rather than avoiding that initial catalog request. **Ask before changes** and **Allow workspace changes** both require approval for external MCP calls. **Full access** also authorizes tools from enabled connections. Connection changes and disconnects require all running tasks to finish or stop first.

Tokens and environment overrides are saved in the private local `mcp.json` file and their values are never returned in public configuration responses. This client does not install MCP servers or bundle their Node/Python runtimes. HTTP MCP connections can use the SDK OAuth flow instead of a bearer token, with optional client ID and scope. Sign in, then connect or reconnect to load tools. The temporary callback uses `127.0.0.1:54819`; the port must be available. External servers decide whether they support discovery and dynamic client registration. A connector marketplace is outside this version's scope.

### Code mode, history and recovery

**Code mode** is enabled alongside ordinary tools. The agent chooses whether to
compose several tool calls, filter results or return a smaller answer through
Pith's existing JavaScript/WASM runtime. Nested writes, commands and MCP calls
use the same workspace checks and approval rules as direct calls. Code mode
does not install Node.js and is not an OS sandbox for the tools it invokes.

Use the branch action below a saved assistant reply to continue from that point,
or **Conversation branches** in the conversation's sidebar menu to choose a
saved node. Pith preserves sibling branches in the same session; this does not
undo files, commands or remote effects. **Compact** calls Pith's summarizer,
keeps recent messages and preserves saved history. Short conversations may have
nothing to compress. Compression is a model request and appears in the cost ledger.

Every task is admitted to a Pith Durable JSONL journal before it runs, alongside
pending queued text/images. Restart shows an interrupted task for review; **Continue**
starts a new task over saved history and restores pending queue items. Unfinished
commands or remote effects are never automatically replayed. This is durable
admission, settlement and queue recovery around the coding-agent session, not an
exactly-once guarantee for each external effect or a resumable model stream.
Deleting a conversation also deletes its local cost ledger and durable journal.

## Images

Use **Attach images** in the composer, drag images onto it, or paste a screenshot.
Preview and remove attachments before sending. An image can be sent alone, with
text, or as a queued instruction or next task while the agent is working.
Click a draft attachment, a sent image, or an image in a file preview to enlarge
it. The viewer offers **Fit**, **Original size**, and zoom controls; **Esc** closes
the viewer and returns to the underlying conversation or file preview.

PNG, JPEG, GIF and WebP are accepted, with a **50 MiB total upload limit per
message** to bound local upload memory. Provider limits may be lower. Image
bytes are sent unchanged; this client does not resize or transcode uploads.
Model capability comes from the pinned Pith catalog. Text-only models reject
image inputs before starting a run; a compatible endpoint must actually support
the selected model's image input.

Accepted images are saved inside Pith's local session records, outside the
workspace, and sent to your configured model provider. Unsent image attachments
stay in memory and are cleared when you start or switch conversations; text
drafts are saved separately. History previews
are fetched from the authenticated local service; image bytes are not included
in every streaming state update. Guarded workspace image reading is also enabled
for image-capable models. Markdown exports mark image attachments but do not
embed their bytes.

Download the
[`v0.1.0-rc.15` Apple Silicon preview](https://github.com/minifish-org/pith-desk/releases/tag/v0.1.0-rc.15).


## Develop

Requirements: Go 1.27.1 or later, Node.js 22.12 or later, npm, and macOS 12 or later on Apple Silicon.

```sh
npm ci
npm --prefix frontend ci
npm run dev
```

`dev` starts Vite and the native desktop window with frontend hot reload, `GOWORK=off` and CGO disabled. CSS updates in place; TypeScript changes reload the interface. Restart the command after Go changes. The same development UI can be inspected in a browser:

```sh
npm run preview
```

Open the loopback URL printed by the process. Both development commands default to **Pith Desk Development** under the system application-data directory, separate from the installed app's **Pith Desk** data. They perform one initial frontend build for Go's embedded assets, then serve source changes through Vite behind the existing loopback authentication and navigation policy. Only one process may open a data directory at a time. To run development windows and browser preview together, choose separate directories, for example `npm run dev -- --data-dir /tmp/desk-native-dev` and `npm run preview -- --data-dir /tmp/desk-browser-dev`. Development refuses paths that overlap the default installed-app data directory, including symlink aliases. Use disposable workspaces too: their files are real even when application data is isolated.

For an embedded-UI browser check, run `GOWORK=off CGO_ENABLED=0 go run ./cmd/pith-desk --preview --data-dir /path/to/separate/test-data` after `npm run build:ui`. Packaged applications keep the embedded frontend and do not start Vite. The development runner chooses separate loopback ports and closes its frontend and Go process when stopped. Preview is local development, not a server deployment mode.

HTTP requests, queries, responses and streamed State types come from Go's
`internal/wire` registry and JSON tags. Run `npm run generate:contract` after a
schema change; `npm run check:contract` rejects stale generated TypeScript or
host route drift. `build:ui` and the CI check run this check automatically.
The frontend retains the authenticated loopback HTTP/WebSocket transport.
Opaque SDK JSON remains `unknown`; business validation stays in the service.

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

Both Pith and MyGo are pinned in `go.mod`; applications build without a sibling checkout or a local Go replacement. Release checks use `GOWORK=off` to verify the versioned dependency. See [SDK dependency validation](docs/SDK_FEATURES.md#versioned-sdk-dependency). Node/npm are development tools only. The Mac window uses the system WKWebView, which may have its own helper processes.

## Where to read the code

- `frontend/src/`: layout, settings, conversations, streamed state and approval controls.
- `internal/desk/`: the application service and its Pith SDK adapter, persisted settings/history and tool policy.
- `internal/host/`: embedded frontend, authenticated loopback API and streamed snapshots.
- `internal/wire/` and `cmd/contractgen/`: Go request/response schemas and generated TypeScript contracts.
- `cmd/pith-desk/`: the native window, folder picker, application lifetime and browser preview.
- `mygo.config.ts`: build and packaging settings.

The Go service owns each agent run. Closing a browser subscription does not end a run. **Stop** aborts it explicitly; application shutdown preserves an unfinished durable task for user-reviewed recovery. The frontend only renders snapshots and submits user actions.

See [testing and native smoke checks](docs/TESTING.md) for verification and a short manual checklist.

## Current boundaries

This is an experimental local desktop product. It has no computer-control tools, plugin marketplace, scheduled jobs, enterprise account system or automatic updates yet. Recovery requires user review and cannot roll back or deduplicate external effects.

Workspace checks are an application tool policy, **not an operating-system sandbox**. File tools reject paths outside the workspace. An approved command can access the computer with your account's permissions; examine it before allowing it. Model requests send the conversation and tool results to your configured provider. See [security and data handling](docs/SECURITY.md).

Pith Desk supports only macOS on Apple Silicon (ARM64). Intel Mac, Linux and Windows are outside the supported scope. Native application testing and release packages target Mac ARM64. CI also checks Linux compilation without testing its desktop runtime or publishing Linux packages. For end users, downloadable application packages are the intended delivery path; building from source is a development option. Preview downloads use manual replacement of the app bundle; no automatic updater is available. See [release packaging and signing](docs/RELEASING.md).

The interface draws on the workspace-and-conversation layout of DeepSeek Harness, but uses its own host and Pith SDK integration. It does not load Harness plugins or copy its application runtime.

## License

Pith Desk is licensed under the [GNU Affero General Public License v3](LICENSE), consistent with its Pith dependency. Dependency notices are in [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md). See [CONTRIBUTING.md](CONTRIBUTING.md) for development and contribution guidance, and [SECURITY.md](SECURITY.md) for private security reporting.
