import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  usePathname: () => "/devtools",
  useSearchParams: () => new URLSearchParams(),
}));

import { helperLimitReportFixture } from "@/lib/helper-limit-fixture";
import { HelperAgentsBlock } from "./HelperAgentsBlock";

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");

describe("HelperAgentsBlock", () => {
  test("shows the limit, its source, active state, coverage and the last day", () => {
    const out = text(
      renderToStaticMarkup(<HelperAgentsBlock report={helperLimitReportFixture()} />),
    );
    expect(out).toContain("Helper agents (subagents)");
    expect(out).toContain(
      "Now: Helpers run on Opus at Medium effort or cheaper. From: your choice for all projects.",
    );
    expect(out).toContain("Active in Claude Code.");
    expect(out).toContain("Project defaultNone. Set in .harnery/config.jsonc.");
    expect(out).toContain("Covered: helpers, harn run workers. Not covered: forks, teammates.");
    expect(out).toContain(
      "Last 24 hours, all projects: 14 helpers, 9 lowered. Ran on Opus 11, Haiku 3.",
    );
  });

  test("an inactive limit says why; no limit says nothing about active", () => {
    const inactive = text(
      renderToStaticMarkup(
        <HelperAgentsBlock
          report={helperLimitReportFixture({
            active: false,
            inactive_reason: "Claude Code 2.1.300 is older than 2.1.309",
            source: "project",
            user: null,
            project_default: { max_model: "sonnet" },
            limit: { max_model: "sonnet" },
            warnings: ["Workers with a full-access floor of opus will run sandboxed."],
            last_24h: { since: "x", helpers: 0, lowered: 0, by_model: {} },
          })}
        />,
      ),
    );
    expect(inactive).toContain("Not active: Claude Code 2.1.300 is older than 2.1.309");
    expect(inactive).toContain("From: this project's default.");
    expect(inactive).toContain("Project defaultSonnet. Set in .harnery/config.jsonc.");
    expect(inactive).toContain("Workers with a full-access floor of opus will run sandboxed.");
    expect(inactive).toContain("No helpers in the last 24 hours.");

    const none = text(
      renderToStaticMarkup(
        <HelperAgentsBlock
          report={helperLimitReportFixture({
            limit: null,
            source: "none",
            user: null,
            summary: "Helpers run on any model and effort.",
            active: false,
            inactive_reason: "no limit is set",
          })}
        />,
      ),
    );
    expect(none).not.toContain("Active in");
    expect(none).not.toContain("Not active");
    expect(none).not.toContain("From:");
  });

  test("an unreadable report renders one quiet line", () => {
    const out = text(renderToStaticMarkup(<HelperAgentsBlock report={null} />));
    expect(out).toBe("The helper agent limit could not be read.");
  });
});
