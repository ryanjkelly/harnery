import { expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { bindHeadingFragments } from "./heading-fragments";

function fixture(hash = "#setup") {
  const dom = parseHTML("<html><body></body></html>");
  const browser = Object.assign(new EventTarget(), {
    document: dom.document,
    location: new URL(`http://localhost/guide?view=markdown${hash}`),
    MouseEvent: class extends dom.window.Event {
      constructor(type: string, init: MouseEventInit) {
        super(type, init);
        Object.assign(this, { button: 0, ...init });
      }
    },
    HashChangeEvent: Event,
    history: {
      state: null,
      pushState(_state: unknown, _unused: string, url: string | URL) {
        browser.location = new URL(url, browser.location.href);
      },
      replaceState(_state: unknown, _unused: string, url: string | URL) {
        browser.location = new URL(url, browser.location.href);
      },
    },
  });
  Object.defineProperty(dom.document, "defaultView", { value: browser });
  browser.document.body.innerHTML =
    '<div id="outside"></div><article><h2 id="user-content-setup">Setup</h2><h3 id="user-content-setup-1">Setup</h3><h4 id="user-content-résumé--安装">Résumé</h4><a href="#setup">Setup</a><a href="#setup-1">Again</a><a href="other.md#setup">Other</a><a href="https://example.com/guide#setup">External</a></article>';
  const root = browser.document.querySelector("article")!;
  const calls: string[] = [];
  for (const heading of root.querySelectorAll("h2,h3,h4")) {
    (heading as HTMLElement).scrollIntoView = mock(() => calls.push(heading.id));
  }
  const unbind = bindHeadingFragments(root as unknown as HTMLElement);
  return { browser, root, calls, unbind };
}

test("incoming fragments, later hash changes and repeated clicks reach safe headings", () => {
  const { browser, root, calls, unbind } = fixture();
  expect(calls).toEqual(["user-content-setup"]);
  root
    .querySelector('a[href="#setup"]')!
    .dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(calls).toEqual(["user-content-setup", "user-content-setup"]);
  root
    .querySelector('a[href="#setup-1"]')!
    .dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(browser.location.hash).toBe("#setup-1");
  expect(calls.at(-1)).toBe("user-content-setup-1");
  browser.history.replaceState(null, "", "#r%C3%A9sum%C3%A9--%E5%AE%89%E8%A3%85");
  browser.dispatchEvent(new browser.HashChangeEvent("hashchange"));
  expect(calls.at(-1)).toBe("user-content-résumé--安装");
  const count = calls.length;
  unbind();
  browser.dispatchEvent(new browser.HashChangeEvent("hashchange"));
  expect(calls).toHaveLength(count);
});

test("malformed and unrelated fragments and modified links keep their normal behavior", () => {
  const { browser, root, calls } = fixture("#%E0%A4%A");
  expect(calls).toEqual([]);
  for (const selector of ['a[href="other.md#setup"]', 'a[href^="https:"]']) {
    const event = new browser.MouseEvent("click", { bubbles: true, cancelable: true });
    root.querySelector(selector)!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  const modified = new browser.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
  });
  root.querySelector("a")!.dispatchEvent(modified);
  expect(modified.defaultPrevented).toBe(false);
  browser.history.replaceState(null, "", "#outside");
  browser.dispatchEvent(new browser.HashChangeEvent("hashchange"));
  expect(calls).toEqual([]);
});
