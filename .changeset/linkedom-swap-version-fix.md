---
"harnery": patch
---

Make `harn read` work on Node and fix `harn --version`.

`harn read` previously crashed on a plain Node install: jsdom's dependency tree
(`html-encoding-sniffer`, `whatwg-url`) does a CommonJS `require()` of the
ESM-only `@exodus/bytes`, throwing `ERR_REQUIRE_ESM`. No version pin fixed it
(every `@exodus/bytes` release is ESM-only). jsdom is replaced with
[linkedom](https://github.com/WebReflection/linkedom), a lighter CJS-friendly
DOM that `@mozilla/readability` supports and that drops the broken chain
entirely. The `--url` option's relative-link resolution is preserved by
injecting a `<base>` tag (linkedom's `parseHTML` has no base-URL option). See
ADR 0002.

`harn --version` reported a hardcoded scaffold value (`0.1.0`) regardless of the
installed version; it now reads the real version from the package's
`package.json`, resolving correctly under both Bun (src) and Node (dist).
