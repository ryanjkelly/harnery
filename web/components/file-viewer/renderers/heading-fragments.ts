/** Resolve readable incoming fragments without exposing unprefixed document IDs. */
export function bindHeadingFragments(root: HTMLElement): () => void {
  const browser = root.ownerDocument.defaultView;
  if (!browser) return () => {};
  const targetFor = (hash: string): HTMLElement | null => {
    let fragment: string;
    try {
      fragment = decodeURIComponent(hash.slice(1));
    } catch {
      return null;
    }
    if (!fragment) return null;
    const exact = root.ownerDocument.getElementById(fragment);
    if (exact && root.contains(exact) && /^H[1-6]$/.test(exact.tagName)) return exact;
    for (const heading of root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")) {
      if (heading.dataset.headingSlug === fragment) return heading;
    }
    const target = root.ownerDocument.getElementById(`user-content-${fragment}`);
    return target && root.contains(target) && /^H[1-6]$/.test(target.tagName) ? target : null;
  };
  const scroll = () => targetFor(browser.location.hash)?.scrollIntoView();
  const click = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const anchor = (event.target as Element | null)?.closest("a[href]");
    if (
      !anchor ||
      anchor.hasAttribute("download") ||
      (anchor.getAttribute("target") && anchor.getAttribute("target") !== "_self")
    )
      return;
    const url = new URL(anchor.getAttribute("href") ?? "", browser.location.href);
    if (
      url.origin !== browser.location.origin ||
      url.pathname !== browser.location.pathname ||
      url.search !== browser.location.search
    )
      return;
    const target = targetFor(url.hash);
    if (!target) return;
    event.preventDefault();
    if (url.hash !== browser.location.hash)
      browser.history.pushState(browser.history.state, "", url);
    target.scrollIntoView();
  };
  scroll();
  browser.addEventListener("hashchange", scroll);
  root.addEventListener("click", click, true);
  return () => {
    browser.removeEventListener("hashchange", scroll);
    root.removeEventListener("click", click, true);
  };
}
