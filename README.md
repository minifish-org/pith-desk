# Pith Desk

A local desktop workspace for getting things done with an AI agent. Pith Desk uses [Pith](https://github.com/minifish-org/pith) as a versioned Go library and [MyGo](https://github.com/egoist/mygo) for the native window. The interface is TypeScript. The product is a separate repository; it does not fork or modify the agent SDK.

This first version supports text conversations, a workspace folder, streamed answers, file tools, explicit approval for changes and commands, and conversation history. DeepSeek Flash is the default model. An OpenAI-compatible Chat Completions endpoint with tool calling can also be configured, using a compatible model ID from Pith's catalog.

## Try it

On macOS, open the built **Pith Desk.app**. You do not need Go, Node.js or npm to run the packaged application.

1. Choose a workspace folder.
2. Open Settings and enter your model endpoint, model ID and API key.
3. Create a conversation and ask the agent to inspect or change files in that folder.
4. Review the tool name and arguments before approving a file change or command. Use Stop to cancel a running task.

For a safe first task, choose an empty test folder and ask: “Create a short welcome.md that explains what you can do in this workspace.”

The application saves settings and conversation data in your user configuration directory (`~/Library/Application Support/Pith Desk` on macOS). The key is stored in a private local file, not in the frontend, URLs or the repository. This version does not use macOS Keychain.

## Develop

Requirements: Go 1.27.1 or later, Node.js 22.6 or later, npm, and macOS 12 or later for the first desktop target.

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

The local build creates an application bundle under `build/`. It uses ad-hoc signing and skips notarization and DMG generation. Developer ID signing and notarization are separate release steps for distributing outside this machine. Use `npm run build -- -platform darwin/universal` for both Mac architectures.

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

## Current boundaries

This is an experimental local desktop product. It has no computer-control tools, image attachments, plugin marketplace, scheduled jobs, enterprise account system or automatic updates yet. Durable is available in the pinned Pith library, but this UI currently uses its normal coding-agent sessions.

Workspace checks are an application tool policy, **not an operating-system sandbox**. File tools reject paths outside the workspace. An approved command can access the computer with your account's permissions; examine it before allowing it. Model requests send the conversation and tool results to your configured provider. See [security and data handling](docs/SECURITY.md).

The interface draws on the workspace-and-conversation layout of DeepSeek Harness, but uses its own host and Pith SDK integration. It does not load Harness plugins or copy its application runtime.

## License

See [LICENSE](LICENSE). Dependency notices are in [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md).
