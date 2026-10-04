# Contributing to Pith Desk

Pith Desk is an experimental desktop client built around the Pith Go SDK. Small, focused improvements are welcome. Keep agent behavior in Pith where possible; the desktop layer handles the interface, local persistence, and permissions.

## Scope

macOS is the first tested desktop target. Linux is a target with compilation checks and system WebView requirements; Windows is not supported. See the [README](README.md) for the current capabilities and limits. Discuss changes that introduce another runtime, large dependencies, or a new agent engine in an issue before implementing them.

## Development and checks

Follow the setup steps in the [README](README.md), then run:

```sh
npm run check
npm run build
```

Add or update focused tests for behavior changes. For interface, native dialog, or tool-approval changes, also follow the applicable [manual checks](docs/TESTING.md). Use a disposable workspace and separate application data directory; never commit credentials, private conversations, or local configuration.

## Issues and pull requests

For a bug, include the application commit or version, operating system, steps to reproduce, expected result, and a redacted error message. Do not include model keys, MCP tokens, conversation exports, or sensitive file contents.

Keep a pull request focused on one problem and explain the resulting behavior and validation. Preserve the existing tool approval and workspace path checks. Reuse SDK and native framework capabilities before adding another implementation.

Changes are distributed under the project's root [LICENSE](LICENSE). Submit only material you have the right to contribute, and preserve the license and attribution of any third-party code.

Report security issues using the repository's [security policy](SECURITY.md), rather than including sensitive details in a public issue.
