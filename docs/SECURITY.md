# Security and data handling

Pith Desk runs under your own operating-system account. It is intended for one local user, not remote hosting.

## Local interface

The host listens only on a randomly selected IPv4 loopback port. Every API request requires a fresh process-local bearer token. HTTP requests use the Authorization header; the live state WebSocket carries the token in a request subprotocol, which the server does not echo. The trusted index page bootstraps that token; it is never placed in a URL or browser storage. Host and Origin checks reject cross-site requests and DNS-rebound hostnames. There is no CORS access for foreign pages. The built UI has a Content Security Policy and never serves workspace files as web content.

These controls address access from other websites. They do not protect against malicious processes already running as your user, browser extensions with access to the preview, or a compromised operating system. Only trusted application assets belong in the native window.

## Model credentials and data

Settings and session files are stored locally. API credentials are kept in a private local settings file; this release does not use Keychain. Public state contains only a `hasApiKey` flag. Credentials are not passed to the frontend or included in tool environments. Avoid selecting the application data directory as a workspace.

Conversation content and tool results are sent to the endpoint you configure. Reading a workspace file can therefore disclose its contents to that model provider. Use a test folder first and select workspaces deliberately.

## Tool approvals

File operations are checked against the selected canonical workspace path, including symlink resolution. Changes and commands require a user decision before execution. A denied tool call can be reported to the agent; cancellation wakes pending approval waits.

**Command approval grants the command normal host-account access.** It is not confined by the file-tool path checks. The command environment is restricted to essentials and does not inherit the model key, but the command can still read your user's files, invoke other programs or access the network. Stopping a task cannot undo a file change or an external command effect that already happened.

This is application-level gating. It is not a filesystem sandbox, enterprise authorization gateway, network isolation system or a guarantee against all filesystem races. Those mechanisms require separate designs if the product's threat model expands.
