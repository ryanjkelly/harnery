import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CodecRosterExpressions } from "./CodecRosterExpressions";

const expressions = [
  { label: "neutral", source: "neutral" },
  { label: "focused", source: "focused" },
  { label: "dormant", source: "waiting" },
];

test("only the initially visible pack emits image requests during server rendering", () => {
  const deferred = renderToStaticMarkup(
    <CodecRosterExpressions packId="aurora" packVersion="2" expressions={expressions} />,
  );
  const visible = renderToStaticMarkup(
    <CodecRosterExpressions
      packId="aurora"
      packVersion="2"
      expressions={expressions}
      initiallyLoad
    />,
  );

  expect(deferred).not.toContain("/api/codec-pack/");
  expect(deferred).toContain('data-codec-images="deferred"');
  expect(deferred).toContain("dormant");
  expect(visible.match(/src="\/api\/codec-pack\//g)).toHaveLength(expressions.length);
  expect(visible).toContain('data-codec-images="loaded"');
  expect(visible).toContain("waiting?v=2&amp;variant=roster-v1");
  expect(visible).toContain('width="256"');
  expect(visible).toContain('height="384"');
});

test("complete-render mode emits every image without making every request high priority", () => {
  const complete = renderToStaticMarkup(
    <CodecRosterExpressions packId="aurora" packVersion="2" expressions={expressions} persistent />,
  );

  expect(complete.match(/src="\/api\/codec-pack\//g)).toHaveLength(expressions.length);
  expect(complete).toContain('data-codec-images="persistent"');
  expect(complete).toContain('fetchPriority="low"');
  expect(complete).not.toContain('fetchPriority="high"');
});
