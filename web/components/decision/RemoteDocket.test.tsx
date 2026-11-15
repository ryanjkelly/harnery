import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  usePathname: () => "/decisions",
  useSearchParams: () => new URLSearchParams(),
}));

import { RemoteDecisionDetail } from "@/app/decisions/[id]/remote-detail";
import type {
  RemoteDecisionRow,
  RemoteDocketSnapshot,
  RemoteSource,
} from "@/lib/remote-docket-reader";
import { RemoteApprovalsList, RemoteDecisionsSection } from "./RemoteDocket";

const NOW = "2026-11-14T12:00:00Z";
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");

const source = (over: Partial<RemoteSource> = {}): RemoteSource => ({
  ref: "laptop",
  label: "laptop",
  publishedAt: "2026-11-14T11:50:00Z",
  ageSecs: 600,
  stale: false,
  contact: "Wren",
  ...over,
});

const waitingRow = (over: Partial<RemoteSource> = {}): RemoteDecisionRow => ({
  decision: {
    decision_id: "pick-a-db-2026-11-14-aaaa",
    question: "Which database?",
    tier: 2,
    stakes: "high",
    status: "filed",
    waiting: true,
    filed_at: "2026-11-14T09:00:00Z",
    filed_by: "Wren",
    context: "Two options.",
    brief: "Option A is cheaper.",
    brief_truncated: true,
  },
  source: source(over),
});

function snap(over: Partial<RemoteDocketSnapshot> = {}): RemoteDocketSnapshot {
  return {
    presence: true,
    sharing: true,
    machines: [],
    waiting: [],
    recent: [],
    approvals: [],
    malformed: [],
    error: null,
    ...over,
  };
}

const render = (s: RemoteDocketSnapshot) =>
  text(renderToStaticMarkup(<RemoteDecisionsSection snap={s} binName="mybin" now={NOW} />));

describe("RemoteDecisionsSection", () => {
  test("labels each entry with its machine and links to the read-only view", () => {
    const row = waitingRow();
    const html = renderToStaticMarkup(
      <RemoteDecisionsSection
        snap={snap({
          machines: [{ ...source(), decisions: 1, approvals: 0, truncated: 0 }],
          waiting: [row],
        })}
        binName="mybin"
        now={NOW}
      />,
    );
    const out = text(html);
    expect(out).toContain("Other machines");
    expect(out).toContain("Waiting on a human there");
    expect(out).toContain("Which database?");
    expect(out).toContain("laptop");
    expect(out).toContain("open 3h");
    expect(html).toContain('href="/decisions/pick-a-db-2026-11-14-aaaa?from=laptop"');
    // Read-only: no review, claim, or resolve controls.
    expect(html).not.toMatch(/<button|<form/);
  });

  test("presence off explains why nothing can arrive", () => {
    expect(render(snap({ presence: false }))).toContain("Presence is off");
  });

  test("no remote refs, with and without local sharing", () => {
    expect(render(snap())).toContain("No other machine has shared its docket yet.");
    expect(render(snap({ sharing: false }))).toContain("decision.share is off");
  });

  test("stale, malformed and trimmed dockets each get a notice", () => {
    const out = render(
      snap({
        machines: [
          {
            ...source({ stale: true, publishedAt: "2026-11-14T06:00:00Z" }),
            decisions: 1,
            approvals: 0,
            truncated: 3,
          },
        ],
        waiting: [waitingRow({ stale: true, publishedAt: "2026-11-14T06:00:00Z" })],
        malformed: ["broken"],
      }),
    );
    expect(out).toContain("1 shared docket could not be read");
    expect(out).toContain("Skipped broken");
    expect(out).toContain("laptop (last published 6h ago)");
    expect(out).toContain("laptop · stale");
    expect(out).toContain("laptop left out 3 items");
  });

  test("a read error renders a notice instead of throwing", () => {
    expect(render(snap({ error: "git failed" }))).toContain(
      "Could not read other machines' dockets",
    );
  });
});

describe("RemoteApprovalsList", () => {
  test("shows the approval read-only with the configured bin name", () => {
    const out = text(
      renderToStaticMarkup(
        <RemoteApprovalsList
          rows={[
            {
              approval: {
                id: "apr-0123456789abcdef0123",
                run_id: "run-1",
                status: "pending",
                requested_at: "2026-11-14T11:00:00Z",
                addressed_to: "operator",
                phase: "act",
                action: "deploy",
              },
              source: source({ contact: null }),
            },
          ]}
          binName="mybin"
          now={NOW}
        />,
      ),
    );
    expect(out).toContain("Only laptop can approve or deny this.");
    expect(out).toContain("No agent is known on laptop; ask its owner directly.");
    expect(out).toContain("apr-0123456789abcdef0123");
  });
});

describe("RemoteDecisionDetail", () => {
  test("says only the filing machine can resolve it and how to reach the owner", () => {
    const html = renderToStaticMarkup(<RemoteDecisionDetail row={waitingRow()} binName="mybin" />);
    const out = text(html);
    expect(out).toContain("Shared from laptop. Only that machine can resolve it.");
    expect(out).toContain('mybin agents ping Wren "<message>"');
    expect(out).toContain("Option A is cheaper.");
    expect(out).toContain("Shortened in the shared copy.");
    // The nav bar has its own buttons; the page body must have none.
    expect(html.slice(html.indexOf("<main"))).not.toMatch(/<button|<form/);
  });
});
