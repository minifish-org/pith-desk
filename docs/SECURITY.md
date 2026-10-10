# Security and data handling

Pith Desk runs under your own operating-system account. It is intended for one local user, not remote hosting.

## Local interface

The host listens only on a randomly selected IPv4 loopback port. Every API request requires a fresh process-local bearer token. HTTP requests use the Authorization header; the live state WebSocket carries the token in a request subprotocol, which the server does not echo. The trusted index page bootstraps that token; it is never placed in a URL or browser storage. Host and Origin checks reject cross-site requests and DNS-rebound hostnames. There is no CORS access for foreign pages. The built UI has a Content Security Policy and never serves workspace files as web content.

Generated Go/TypeScript contracts describe this same authenticated transport.
Native menu state is submitted through its authenticated endpoint; task state
and conversation identity are checked against the service. Menu activation
forwards only fixed action names to existing page handlers, which recheck their
current loading, request and dialog state.

Completion notification targets are stored in private `notifications.json`
beside application data. The OS receives an ID, title and workspace/conversation
label; no token, credential or filesystem path is included in the target ID.
Targets are bounded to 512 and 90 days. Clicks validate the retained session,
workspace and completed run under the service lock before navigating. A missing,
expired, deleted or superseded target does not create a conversation or select a
different target. Delivered valid notifications survive process exit; no
background process is kept for them.

These controls address access from other websites. They do not protect against malicious processes already running as your user, browser extensions with access to the preview, or a compromised operating system. Only trusted application assets belong in the native window.

Frontend hot reload is explicitly enabled only with a loopback `--dev-url`. The Desk host injects its own credential into Vite's HTML, forwards a limited set of frontend/HMR routes, and retains its Host, Origin, cross-site, API authentication and navigation checks. Normal builds serve embedded assets. Development defaults to a separate application-data directory and rejects overlap with the default installed-app directory, including symlinked ancestors and macOS case aliases. Existing directory ancestry is checked by filesystem identity; macOS also reserves planned case variants of the default application-data name. Development workspaces still contain real files; use disposable folders for acceptance checks.

## Model credentials and data

Settings and session files are stored locally. API credentials are kept in a private local settings file; this release does not use Keychain. Public state exposes only readiness/sign-in flags for credentials, never the saved keys or OAuth tokens. Each provider retains a separate saved connection; its key is reused only for the same provider and endpoint. Changing the endpoint clears the active key unless a new key is entered explicitly. Credentials are not returned to the frontend or included in command-tool environments. MCP bearer tokens and explicit environment overrides are stored separately in private `mcp.json`; public configuration exposes only whether a token is present and the saved environment key names. Avoid selecting the application data directory as a workspace.

Model OAuth credentials are stored through Pith in private `auth.json`; MCP OAuth state is scoped to the connection name and URL under `mcp-auth/`. The temporary MCP callback listens on loopback port 54819 during sign-in and checks the SDK-generated state before exchanging a code. It closes on completion or cancellation. OAuth model requests use the official provider endpoint, and refresh uses the SDK.

Conversation content and tool results are sent to the endpoint you configure. Reading a workspace file can therefore disclose its contents to that model provider. Use a test folder first and select workspaces deliberately.

Pith can automatically load regular AGENTS.md and CLAUDE.md instructions inherited from the workspace's ancestor directories. Instruction symlinks must resolve inside the selected workspace. Project `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, skills, and prompts must also stay inside the workspace, including when a resource directory is a symlink. Unsafe resources stop a task before its model request. These checks exclude private application storage; they do not replace an operating-system sandbox.

## Tool approvals

File operations are checked against the selected canonical workspace path, including symlink resolution. New conversations use **Ask before changes**: changes and commands require a user decision before execution, while reads and searches do not. A denied tool call can be reported to the agent; cancellation wakes pending approval waits.

Permission choices are stored per conversation. **Allow workspace changes** automatically permits `write_file` and `edit_file` after their workspace path checks; it does not authorize commands or external MCP calls. **Full access** additionally permits `run_command` and tools from enabled MCP connections without asking. The interface requires explicit confirmation before enabling Full access and explains its host-account and external-tool access. Neither mode bypasses the file-tool path checks. Changing a mode can resolve a matching pending approval; returning to Ask before changes applies to future calls, not actions already executing. Restarting the application retains the selected mode, and new conversations still start with Ask before changes.

**Command approval grants the command normal host-account access.** It is not confined by the file-tool path checks. The command environment is restricted to essentials and does not inherit the model key, but the command can still read your user's files, invoke other programs or access the network. Stopping a task cannot undo a file change or an external command effect that already happened.

This is application-level gating. It is not a filesystem sandbox, enterprise authorization gateway, network isolation system or a guarantee against all filesystem races. Those mechanisms require separate designs if the product's threat model expands.

Code mode runs in the SDK's existing JavaScript/WASM runtime. Every nested tool call passes through the same hooks as a direct call. It does not grant raw file access, bypass approvals, or sandbox the commands and MCP servers called through it. Tool search exposes deferred MCP schemas on demand; searching is not permission to execute an external call.

## External tools and native file actions

MCP servers are external programs or services selected by the user. They have their own access and may read or change data beyond a workspace. The workspace file policy does not confine them. Local servers receive essential process variables and the overrides explicitly configured for that server, not the application's full ambient environment. Only registered tools from enabled connections are exposed through deferred discovery, and external calls use a separate approval path. Configuration changes cannot replace tools during a running task. Connections are closed on application shutdown.

Generated-file Open, Reveal and Copy file actions accept only successful recorded write/edit results that still resolve to regular files inside the workspace. Resource actions accept only instruction, skill and prompt files discovered by Pith, including inherited instruction files. The built-in editor may only mutate project resources inside the selected workspace; inherited instructions remain read-only. Both paths exclude private application storage; arbitrary model-generated links do not gain native file access. Opening a file invokes its system-associated application and does not serve it as web content.

Generated-file Preview has the same authenticated, recorded-artifact and
workspace boundaries. Reads use the workspace root at access time and reject
non-regular files. Image previews allow PNG/JPEG/GIF/WebP and at most 50 MiB;
text previews are limited to 8 MiB and displayed in pages of up to 256 KiB.
Small Markdown previews use the same sanitizer as replies, with scripts,
embedded content and remote images removed. Large Markdown previews, HTML and
SVG remain inert source text.

Text drafts live in mode-0600 files under the selected data profile's `drafts/`
directory. They are fetched on demand rather than included in streamed State,
and do not enter provider requests before submission. Save revisions prevent
an older delayed request from restoring cleared text. Draft scope identifiers
must refer to an existing conversation or workspace; their data is removed
with that conversation or workspace.

Copy controls write to the clipboard only when clicked by the user. Desktop **Copy response** writes the reply's original text and Markdown through the authenticated native clipboard action. **Copy file** writes a native file reference after the generated-file checks above; it leaves the source file in place. Browser preview uses the browser clipboard for response text and **Copy path**, rather than copying a native file reference.

Dropped workspace files become plain, editable relative-path text. The authenticated reference endpoint uses the existing canonical workspace/private-data policy and rooted file checks, rejects directories, missing files and paths outside the selected workspace, and validates the whole batch before returning references. It does not copy or read file contents. The native window forwards only the file-drop event; it does not expose MyGo bound methods or trust browser file basenames. Later agent file tools reapply the workspace policy.

Markdown exports use a native save dialog in the desktop app, or an authenticated download in browser preview. They may include local file contents and tool results, so keep them with the same care as the original conversation. Deleting a conversation does not remove previously exported documents.

## Connection checks and diagnostics

Test connection sends a small tool-calling probe through Pith's selected
provider adapter. It uses the form values and, when blank, the existing saved
key for the same provider and endpoint. Testing a changed endpoint requires an explicit key;
the hidden saved key is not forwarded to a new address. It does not save settings, load instructions or execute tools. Tests can
be cancelled; closing the application cancels an outstanding probe. Provider
response bodies are not included in the result; failures use fixed guidance.

Diagnostics use an explicit metadata allowlist rather than transcript redaction.
No conversation text, titles, file contents, paths, endpoint URLs, raw errors,
tool arguments or keys are exported. Session token totals and aggregate counts
are included. Native saves require a destination chosen by the user.

Task admission, settlement and pending queued text/images are stored with Pith Durable. Shutdown preserves unfinished tasks for reviewed continuation. Task continuation is a user-initiated new prompt over persisted history; it does not promise exactly-once execution, roll back changes, resume an interrupted model stream or automatically replay external effects. Branch changes also do not undo effects. Review uncertain operations before continuing. Request cost JSONL files contain usage and rate snapshots, not conversation text.

## Deleting local application data

Conversation deletion removes only its session transcript (including inline images), run receipt, request cost ledger and durable journal. Workspace removal also removes its catalog association and all
its conversations. Neither operation deletes workspace files or exported documents.
The API requires the same loopback host, origin and bearer-token checks as other
mutations, and rejects changes while a task is running or a connection probe is
active. Workspace removal checks the conversation count shown in the confirmation.

Filesystem cleanup uses Go's `os.Root` to stay inside the private application data
directory and recursively removes only the expected per-conversation durable directory; unexpected directories at transcript, receipt or cost-file paths are rejected. A persisted
delete-intent journal allows startup to finish committed cleanup after an
interruption. The catalog decides whether a deletion committed; referenced
conversations are preserved. Disk errors are surfaced and the journal is retained
until cleanup completes. User copies, exports and backups are outside this scope;
this is logical file deletion, not secure erasure of storage media.
