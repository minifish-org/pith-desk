# Security and data handling

Pith Desk runs under your own operating-system account. It is intended for one local user, not remote hosting.

## Local interface

The host listens only on a randomly selected IPv4 loopback port. Every API request requires a fresh process-local bearer token. HTTP requests use the Authorization header; the live state WebSocket carries the token in a request subprotocol, which the server does not echo. The trusted index page bootstraps that token; it is never placed in a URL or browser storage. Host and Origin checks reject cross-site requests and DNS-rebound hostnames. There is no CORS access for foreign pages. The built UI has a Content Security Policy and never serves workspace files as web content.

These controls address access from other websites. They do not protect against malicious processes already running as your user, browser extensions with access to the preview, or a compromised operating system. Only trusted application assets belong in the native window.

## Model credentials and data

Settings and session files are stored locally. API credentials are kept in a private local settings file; this release does not use Keychain. Public state contains only a `hasApiKey` flag. Credentials are not returned to the frontend or included in command-tool environments. MCP bearer tokens and explicit environment overrides are stored separately in private `mcp.json`; public configuration exposes only whether a token is present and the saved environment key names. Avoid selecting the application data directory as a workspace.

Conversation content and tool results are sent to the endpoint you configure. Reading a workspace file can therefore disclose its contents to that model provider. Use a test folder first and select workspaces deliberately.

Pith can automatically load regular AGENTS.md and CLAUDE.md instructions inherited from the workspace's ancestor directories. Instruction symlinks must resolve inside the selected workspace. Project `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, skills, and prompts must also stay inside the workspace, including when a resource directory is a symlink. Unsafe resources stop a task before its model request. These checks exclude private application storage; they do not replace an operating-system sandbox.

## Tool approvals

File operations are checked against the selected canonical workspace path, including symlink resolution. New conversations use **Ask before changes**: changes and commands require a user decision before execution, while reads and searches do not. A denied tool call can be reported to the agent; cancellation wakes pending approval waits.

Permission choices are stored per conversation. **Allow workspace changes** automatically permits `write_file` and `edit_file` after their workspace path checks; it does not authorize commands or external MCP calls. **Full access** additionally permits `run_command` and tools from enabled MCP connections without asking. The interface requires explicit confirmation before enabling Full access and explains its host-account and external-tool access. Neither mode bypasses the file-tool path checks. Changing a mode can resolve a matching pending approval; returning to Ask before changes applies to future calls, not actions already executing. Restarting the application retains the selected mode, and new conversations still start with Ask before changes.

**Command approval grants the command normal host-account access.** It is not confined by the file-tool path checks. The command environment is restricted to essentials and does not inherit the model key, but the command can still read your user's files, invoke other programs or access the network. Stopping a task cannot undo a file change or an external command effect that already happened.

This is application-level gating. It is not a filesystem sandbox, enterprise authorization gateway, network isolation system or a guarantee against all filesystem races. Those mechanisms require separate designs if the product's threat model expands.

## External tools and native file actions

MCP servers are external programs or services selected by the user. They have their own access and may read or change data beyond a workspace. The workspace file policy does not confine them. Local servers receive essential process variables and the overrides explicitly configured for that server, not the application's full ambient environment. Only registered tools from enabled connections are exposed, and external calls use a separate approval path. Configuration changes cannot replace tools during a running task. Connections are closed on application shutdown.

Generated-file Open and Reveal actions accept only successful recorded write/edit results that still resolve to regular files inside the workspace. Resource actions accept only instruction and skill files discovered by Pith, including inherited instruction files. Both paths exclude private application storage; arbitrary model-generated links do not gain native file access. Opening a file invokes its system-associated application and does not serve it as web content.

Markdown exports use a native save dialog in the desktop app, or an authenticated download in browser preview. They may include local file contents and tool results, so keep them with the same care as the original conversation. Archiving changes the desktop catalog only and does not delete a transcript.
