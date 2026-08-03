---
"harnery": minor
---

Add `browse --check-critique`: a vision-model page critic with tiling.

Heuristic checks only catch what we can enumerate. The reason a human still eyeballs a page is the long tail — the thing that looks off without tripping a named rule. `--check-critique` hands the rendered page to a vision model and asks for that judgement, structured.

Two design choices keep it useful and portable:

- **Tiling.** A tall page screenshotted whole and downscaled to a model's input budget loses the detail the critique depends on. The page is cut into overlapping vertical bands (`--check-critique-band` / `--check-critique-overlap`), or one tile per element when a selector is given (`--check-critique <selector>`), each captured at full resolution and judged on its own. Findings carry their tile and document scroll offset for locality, and `--check-critique-max-tiles` bounds cost.
- **Injection.** harnery ships no model client and no API key. The host wires a `critiqueProvider` into `HarneryProgramContext` (the same pattern as `extraHeaders`); given one tile plus the rubric it returns that tile's findings. Without a provider the check reports `skipped`, never a false pass, so the portable tiling/prompt/orchestration stays here and the model call stays in the host.

Findings land under `critique` in the JSON envelope; `--check-critique-fail` exits 2 on any high-severity finding. A provider throw becomes a high-severity error finding for that tile rather than aborting the run. `--check-critique-rubric` overrides the default rubric.

New exports: `bandRects`, `normalizeFindings`, `runCritique`, `DEFAULT_CRITIQUE_RUBRIC`, and the `CritiqueTile` / `CritiqueFinding` / `CritiqueResult` / `CritiqueProvider` types, plus `Browser.pageMetrics()`, `Browser.screenshotClipBase64()`, and `Browser.elementTiles()`.
