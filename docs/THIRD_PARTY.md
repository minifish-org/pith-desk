# Third-party software

Pith Desk's own code is covered by the root [LICENSE](../LICENSE), GNU Affero General Public License version 3. Dependency licenses remain their own. The files in [`third_party/`](../third_party/) preserve the upstream texts; they are not replaced by this summary.

## Direct runtime dependencies

| Component | Pinned version | License and retained notice |
| --- | --- | --- |
| [Pith](https://github.com/minifish-org/pith) | `v0.0.0-20261004114236-0fbdc914b818` | AGPL v3: `PITH-LICENSE`, `PITH-NOTICE`. Pith is an independent Go migration of selected Pi components; their MIT notice is retained in `PI-LICENSE`. |
| [MyGo](https://github.com/egoist/mygo) | `v0.2.1` | MIT: `MYGO-LICENSE`. Native desktop window and system WebView integration. |
| [coder/websocket](https://github.com/coder/websocket) | `v1.8.15` | ISC: `WEBSOCKET-LICENSE`. |
| [gofrs/flock](https://github.com/gofrs/flock) | `v0.13.1` | BSD-3-Clause: `FLOCK-LICENSE`. |
| [Marked](https://github.com/markedjs/marked) | `16.4.2` | MIT, with upstream Markdown attribution: the complete `MARKED-LICENSE` file is retained. |
| [DOMPurify](https://github.com/cure53/DOMPurify) | `3.4.16` | Upstream declares `MPL-2.0 OR Apache-2.0`. This distribution uses the Apache-2.0 option and retains that upstream text in `DOMPURIFY-LICENSE`, together with the package's attribution below. |

DOMPurify 3.4.16: Copyright Cure53 and other contributors. The bundled upstream module identifies its license and links to its [versioned license file](https://github.com/cure53/DOMPurify/blob/3.4.16/LICENSE).

## Go dependencies used by the executable

The following additional modules are selected by the `CGO_ENABLED=0` executable dependency graph. Versions come from `go.mod` and `go.sum`; license and notice texts were read from those exact Go module versions.

| Component | Version | License and retained notice |
| --- | --- | --- |
| [AWS SDK for Go v2](https://github.com/aws/aws-sdk-go-v2) | Root `v1.47.1`; submodules listed below | Apache-2.0: `AWS-SDK-LICENSE`, `AWS-SDK-NOTICE`. The SDK submodules listed below contain the same license text. |
| [AWS Smithy Go](https://github.com/aws/smithy-go) | `v1.28.1` | Apache-2.0: `SMITHY-LICENSE`, `SMITHY-NOTICE`. |
| [Ebitengine purego](https://github.com/ebitengine/purego) | `v0.11.1` | Apache-2.0: `PUREGO-LICENSE`. Its Go-derived source retains Go copyright headers; `GO-LICENSE` is also included. |
| [goccy/go-yaml](https://github.com/goccy/go-yaml) | `v1.19.2` | MIT: `YAML-LICENSE`. |
| [sabhiram/go-gitignore](https://github.com/sabhiram/go-gitignore) | `v0.0.0-20210923224102-525f6e181f06` | MIT: `GITIGNORE-LICENSE`. |
| [wazero](https://github.com/tetratelabs/wazero) | `v1.9.0` | Apache-2.0: `WAZERO-LICENSE`, `WAZERO-NOTICE`. |
| [golang.org/x/sys](https://go.googlesource.com/sys) | `v0.47.0` | BSD-3-Clause: `SYS-LICENSE`. |
| [golang.org/x/text](https://go.googlesource.com/text) | `v0.39.0` | BSD-3-Clause: `TEXT-LICENSE`. |

AWS SDK submodules:

- `aws/protocol/eventstream v1.7.20`
- `config v1.33.6`
- `credentials v1.20.6`
- `feature/ec2/imds v1.20.1`
- `internal/configsources v1.5.4`
- `internal/endpoints/v2 v2.8.4`
- `internal/v4a v1.5.4`
- `service/bedrockruntime v1.63.1`
- `service/internal/accept-encoding v1.13.19`
- `service/internal/presigned-url v1.14.4`
- `service/signin v1.10.1`
- `service/sso v1.38.1`
- `service/ssooidc v1.43.1`
- `service/sts v1.51.1`

The Go toolchain and standard library are provided by the Go project under its BSD license, retained in `GO-LICENSE`.

## Development tools and system components

TypeScript, Vite, `mygo-cli 0.2.1`, and their development dependencies are used to build the application. Their exact versions and declared licenses are recorded in the two npm lockfiles. They are not installed on an end user's computer by Pith Desk. Type declarations, including `@types/trusted-types`, are erased from the frontend output.

The application uses macOS's system WKWebView; it does not bundle Node.js or an Electron browser. External MCP servers may need their own runtimes and retain their own licenses.

## Updating or distributing

Recheck the dependency graph and retained texts when updating Go or npm dependencies. To inspect the executable's Go modules without building a binary:

```sh
CGO_ENABLED=0 go list -deps -f '{{if and .Module (not .Module.Main)}}{{.Module.Path}} {{.Module.Version}}{{end}}' ./cmd/pith-desk | sort -u
```

Keep this document, the root LICENSE, and the `third_party/` notice files with downloadable packages. Identify the exact release commit and provide its corresponding source and build instructions alongside any binary. A local ad-hoc-signed test bundle is not a notarized release.
