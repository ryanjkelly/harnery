# Security Policy

## Supported versions

While Harnery is pre-1.0, only the latest minor version receives security updates. Once we hit 1.0, the most recent major + the immediately prior major will be supported.

## Reporting a vulnerability

Please **do not** open a public GitHub issue. Use GitHub's **private vulnerability reporting** (the "Report a vulnerability" button under the repo's **Security** tab), or email `ryan@harnery.com` if you'd rather. Include:

- A description of the vulnerability
- Steps to reproduce
- The affected version(s)
- Suggested fix (if known)

This is a solo, best-effort project: I'll acknowledge as soon as I reasonably can and prioritize confirmed vulnerabilities by severity. Coordinated disclosure preferred; credit will be given in the release notes.

## Scope

In scope:

- The published `harnery` npm package
- The `harn` CLI binary
- The web UI (`harn web up`) when bound to localhost
- Configuration file parsing (`.harnery/config.jsonc`)
- Coord-layer state files (under `.harnery/`: `active/`, `events.ndjson`, `councils/`, etc.)

Out of scope:

- Third-party tools Harnery shells out to (`restic`, `git`, `bun`, `node`, `playwright`, etc.): report to those projects directly
- Consumer CLIs that compose Harnery (report to their own maintainers)
- Vulnerabilities in projects that depend on Harnery (unless directly caused by Harnery's behavior)

## Defaults

The web UI binds to `127.0.0.1` only and runs without authentication. Exposing it to a network requires explicit `--bind` flag + gated-IP allowlist. Treat any production deployment as "intranet only"; there's no auth layer suitable for public exposure.
