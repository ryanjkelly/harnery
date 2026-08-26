# Default Codec roster

Harnery's tracked default character roster lives in `default-packs/`. Each
character directory follows the same `pack.json` contract accepted for host
packs under `.harnery/codec/packs/`.

The loader combines both sources. A complete host pack overrides the bundled
pack with the same id. A broken host override leaves the bundled character
available, and host-only ids extend the roster. The machine-local
`.harnery/codec/registry.json` is never shipped or copied.

The release invariant is 52 character packs with all 21 roster expressions.
`web/lib/codec/packs.test.ts` enforces that count and validates every manifest.

