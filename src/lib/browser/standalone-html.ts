// Self-contained HTML snapshots for `harn browse` trio mode.
//
// `page.content()` serializes the DOM but not the resources it points at, and
// framework pages reference those with root-absolute paths (`/_next/static/…`).
// Written to a file and reopened from anywhere else — the files origin, another
// host, `file://` — every one of those paths resolves against the wrong root and
// 404s, so the snapshot renders as unstyled black-on-white text with broken
// images. That is what an operator sees when they preview an artifact's `.html`.
//
// This rewrite makes the saved document stand on its own:
//   - stylesheets are fetched and inlined as <style>
//   - fonts, images, and icons are inlined as data: URIs under a byte budget
//   - anything left over (too large, cross-origin, unreachable) is rewritten to
//     an absolute URL on the captured origin rather than left root-relative
//   - <script> and preload/prefetch hints are dropped: none of them can work in
//     a snapshot, and a dead script tag only invites a hydration attempt
//
// The live page is untouched — everything happens on a clone of the document.

/** Byte budget for one inlined sub-resource. Larger ones stay as absolute URLs. */
export const DEFAULT_MAX_RESOURCE_BYTES = 512 * 1024;

/** Byte budget for all inlined sub-resources in one snapshot. */
export const DEFAULT_MAX_TOTAL_RESOURCE_BYTES = 8 * 1024 * 1024;

export interface StandaloneHtmlRequest {
  maxResourceBytes: number;
  maxTotalResourceBytes: number;
}

export interface StandaloneHtmlResult {
  html: string;
  /** Source URL the snapshot was taken from. */
  source: string;
  /** Stylesheets inlined as <style>. */
  stylesheetsInlined: number;
  /** Stylesheets left as absolute <link> (unreachable or cross-origin). */
  stylesheetsLinked: number;
  /** Sub-resources (fonts, images, icons) inlined as data: URIs. */
  resourcesInlined: number;
  /** Sub-resources left as absolute URLs (over budget or unreachable). */
  resourcesLinked: number;
  /** Bytes of sub-resource payload inlined. */
  inlinedBytes: number;
}

export function buildStandaloneHtmlScript(): (
  args: StandaloneHtmlRequest,
) => Promise<StandaloneHtmlResult> {
  return async ({ maxResourceBytes, maxTotalResourceBytes }) => {
    const SKIP = /^(?:data:|blob:|javascript:|mailto:|tel:|sms:|about:|#)/i;
    const base = document.baseURI;

    let inlinedBytes = 0;
    let resourcesInlined = 0;
    let resourcesLinked = 0;
    let stylesheetsInlined = 0;
    let stylesheetsLinked = 0;

    const absolute = (url: string, from: string): string | null => {
      try {
        return new URL(url, from).href;
      } catch {
        return null;
      }
    };

    const dataUriCache = new Map<string, string | null>();

    /** Fetch a resource as a data: URI, or null when it is unreachable or over budget. */
    const toDataUri = async (url: string): Promise<string | null> => {
      const cached = dataUriCache.get(url);
      if (cached !== undefined) return cached;
      let result: string | null = null;
      try {
        const res = await fetch(url, { credentials: "include" });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          const fits =
            buf.byteLength <= maxResourceBytes &&
            inlinedBytes + buf.byteLength <= maxTotalResourceBytes;
          if (fits) {
            const bytes = new Uint8Array(buf);
            let binary = "";
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
              binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
            }
            const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim();
            result = `data:${type || "application/octet-stream"};base64,${btoa(binary)}`;
            inlinedBytes += buf.byteLength;
          }
        }
      } catch {
        result = null;
      }
      dataUriCache.set(url, result);
      return result;
    };

    /** Resolve one reference: data: URI when it fits, absolute URL otherwise. */
    const resolveRef = async (
      raw: string,
      from: string,
      inline: boolean,
    ): Promise<string | null> => {
      const trimmed = raw.trim();
      if (!trimmed || SKIP.test(trimmed)) return null;
      const url = absolute(trimmed, from);
      if (!url) return null;
      if (!inline) return url;
      const dataUri = await toDataUri(url);
      if (dataUri) {
        resourcesInlined += 1;
        return dataUri;
      }
      resourcesLinked += 1;
      return url;
    };

    /** Rewrite url() and @import references inside a stylesheet against its own URL. */
    const rewriteCss = async (css: string, from: string): Promise<string> => {
      const urlRef = /url\(\s*(['"]?)([^'")]*)\1\s*\)/g;
      const importRef = /@import\s+(['"])([^'"]+)\1/g;

      const replacements = new Map<string, string>();
      const collect = async (pattern: RegExp, inline: boolean) => {
        pattern.lastIndex = 0;
        const seen: string[] = [];
        for (let m = pattern.exec(css); m; m = pattern.exec(css)) {
          const raw = m[2];
          if (raw !== undefined && !replacements.has(raw)) seen.push(raw);
        }
        for (const raw of seen) {
          const resolved = await resolveRef(raw, from, inline);
          if (resolved) replacements.set(raw, resolved);
        }
      };
      await collect(urlRef, true);
      await collect(importRef, false);

      return css
        .replace(urlRef, (full, _q, raw: string) => {
          const next = replacements.get(raw);
          return next ? `url("${next}")` : full;
        })
        .replace(importRef, (full, _q, raw: string) => {
          const next = replacements.get(raw);
          return next ? `@import "${next}"` : full;
        });
    };

    const doc = document.cloneNode(true) as Document;

    // Nothing executable survives a snapshot; leaving these in only produces
    // console noise and a doomed hydration pass on reopen.
    for (const node of Array.from(doc.querySelectorAll("script, base"))) node.remove();
    const deadHints = 'link[rel~="preload"],link[rel~="modulepreload"],link[rel~="prefetch"]';
    for (const node of Array.from(doc.querySelectorAll(deadHints))) node.remove();

    // Stylesheets: fetch → inline. Falls back to the CSSOM (which covers rules a
    // same-origin sheet already parsed) and finally to an absolute <link>.
    for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"]'))) {
      const href = link.getAttribute("href");
      const url = href ? absolute(href, base) : null;
      if (!url) {
        link.remove();
        continue;
      }
      let css: string | null = null;
      try {
        const res = await fetch(url, { credentials: "include" });
        if (res.ok) css = await res.text();
      } catch {
        css = null;
      }
      if (css === null) {
        for (const sheet of Array.from(document.styleSheets)) {
          if (sheet.href !== url) continue;
          try {
            css = Array.from(sheet.cssRules)
              .map((rule) => rule.cssText)
              .join("\n");
          } catch {
            css = null;
          }
          break;
        }
      }
      if (css === null) {
        link.setAttribute("href", url);
        stylesheetsLinked += 1;
        continue;
      }
      const style = doc.createElement("style");
      style.setAttribute("data-harnery-inlined-from", url);
      const media = link.getAttribute("media");
      if (media) style.setAttribute("media", media);
      style.textContent = await rewriteCss(css, url);
      link.replaceWith(style);
      stylesheetsInlined += 1;
    }

    // Inline <style> blocks carry their own relative refs (framework @font-face
    // rules in particular), so they need the same treatment.
    for (const style of Array.from(doc.querySelectorAll("style"))) {
      if (style.hasAttribute("data-harnery-inlined-from")) continue;
      const css = style.textContent;
      if (css) style.textContent = await rewriteCss(css, base);
    }

    // Stylesheets adopted via CSSOM never appear in the DOM and would be lost.
    const adopted = (document as Document & { adoptedStyleSheets?: CSSStyleSheet[] })
      .adoptedStyleSheets;
    if (adopted?.length) {
      const parts: string[] = [];
      for (const sheet of adopted) {
        try {
          parts.push(
            Array.from(sheet.cssRules)
              .map((rule) => rule.cssText)
              .join("\n"),
          );
        } catch {
          // Constructed sheet with unreadable rules; nothing to recover.
        }
      }
      if (parts.length) {
        const style = doc.createElement("style");
        style.setAttribute("data-harnery-adopted", "");
        style.textContent = await rewriteCss(parts.join("\n"), base);
        doc.head?.appendChild(style);
      }
    }

    // Element references. Media and icons are worth inlining; navigation targets
    // only need to stop pointing at the wrong root.
    const inlineAttrs: Array<[string, string]> = [
      ["img", "src"],
      ["source", "src"],
      ["video", "src"],
      ["video", "poster"],
      ["audio", "src"],
      ["track", "src"],
      ["input", "src"],
      ["object", "data"],
      ['link[rel~="icon"]', "href"],
      ['link[rel~="apple-touch-icon"]', "href"],
      ["image", "href"],
      ["use", "href"],
    ];
    const absoluteAttrs: Array<[string, string]> = [
      ["a", "href"],
      ["area", "href"],
      ["form", "action"],
      ["iframe", "src"],
      ["embed", "src"],
      ["link", "href"],
    ];

    const applyAttrs = async (specs: Array<[string, string]>, inline: boolean) => {
      for (const [selector, attr] of specs) {
        for (const el of Array.from(doc.querySelectorAll(selector))) {
          const raw = el.getAttribute(attr);
          if (!raw) continue;
          const next = await resolveRef(raw, base, inline);
          if (next) el.setAttribute(attr, next);
        }
      }
    };
    await applyAttrs(inlineAttrs, true);
    await applyAttrs(absoluteAttrs, false);

    // srcset is a comma-separated list of `url descriptor` pairs.
    for (const el of Array.from(doc.querySelectorAll("img[srcset], source[srcset]"))) {
      const raw = el.getAttribute("srcset");
      if (!raw) continue;
      const rewritten: string[] = [];
      for (const candidate of raw.split(",")) {
        const parts = candidate.trim().split(/\s+/);
        const url = parts.shift();
        if (!url) continue;
        const next = (await resolveRef(url, base, true)) ?? url;
        rewritten.push([next, ...parts].join(" "));
      }
      if (rewritten.length) el.setAttribute("srcset", rewritten.join(", "));
    }

    // Inline style attributes can carry background-image url().
    for (const el of Array.from(doc.querySelectorAll("[style]"))) {
      const raw = el.getAttribute("style");
      if (!raw?.includes("url(")) continue;
      el.setAttribute("style", await rewriteCss(raw, base));
    }

    const provenance = doc.createElement("meta");
    provenance.setAttribute("name", "harnery:snapshot-source");
    provenance.setAttribute("content", location.href);
    doc.head?.prepend(provenance);

    const doctype = document.doctype ? `<!DOCTYPE ${document.doctype.name}>` : "<!DOCTYPE html>";
    return {
      html: `${doctype}\n${doc.documentElement.outerHTML}\n`,
      source: location.href,
      stylesheetsInlined,
      stylesheetsLinked,
      resourcesInlined,
      resourcesLinked,
      inlinedBytes,
    };
  };
}
