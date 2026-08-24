import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CodecRosterExpressions } from "./CodecRosterExpressions";

const expressions = ["neutral", "focused", "dormant"];

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
});
