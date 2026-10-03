# Third-party software

The repository's own code is covered by its root LICENSE. Dependency licenses remain their own.

- **Pith** — `github.com/minifish-org/pith`, pinned to `v0.0.0-20261003091049-9ef56f7b1a53`. Go agent SDK with an AGPL-3.0 license, derived from Pi. Preserve Pith's upstream Pi notices as well. Source: https://github.com/minifish-org/pith.
- **MyGo** — `github.com/egoist/mygo` and `mygo-cli`, pinned to `v0.2.1` / `0.2.1`, MIT. Native desktop framework and development packager. Source: https://github.com/egoist/mygo.
- **coder/websocket** — `github.com/coder/websocket`, ISC. Pure Go live state transport. Source: https://github.com/coder/websocket.
- **gofrs/flock** — `github.com/gofrs/flock`, BSD-3-Clause. Pure Go process lock for the local data directory. Source: https://github.com/gofrs/flock.
- Frontend build and rendering dependencies are pinned in `frontend/package-lock.json`. MyGo CLI dependencies are pinned in the root `package-lock.json`. Complete Go dependencies are recorded in `go.mod` and `go.sum`.

The application uses macOS's system WKWebView; it does not bundle Node.js or an Electron browser. Optional future connectors may have their own external runtime requirements.

Direct runtime dependency notices, including Pith, Pi and MyGo, are retained in `third_party/`. Review the full transitive dependency notice set before a public binary release. A local test bundle is not a notarized release.
