import { type Extractor, type FieldSpec, parseExtractor, parseFieldSpec } from "./fields.ts";

/**
 * Site presets for `browse --collect <preset>`.
 *
 * A preset is data, not code: an item selector, an optional key extractor, a
 * map of field extractors in the `--collect-field` grammar, an optional
 * "show more" selector for `--collect-expand`, and text patterns that mean the
 * site has stopped serving the feed. Adding a site is one entry here.
 *
 * `tested: false` marks presets written from each site's public markup but not
 * exercised against the live site. Feed markup changes often; override any
 * part with `--collect-item`, `--collect-key` and `--collect-field`.
 */
export interface CollectPreset {
  description: string;
  /** True when the preset has been exercised against the live site. */
  tested: boolean;
  /** CSS selector matching one feed item. */
  item: string;
  /** Extractor for the dedupe key; falls back to the permalink heuristic, then a text hash. */
  key?: string;
  /** Regex (source) a link must match for the permalink heuristic. */
  keyPattern?: string;
  /** Field name (suffix [] for arrays) to extractor. */
  fields: Record<string, string>;
  /** Selector for "show more" style buttons inside an item. */
  expand?: string;
  /** Regexes (source, case-insensitive) that mean a login wall or rate limit. */
  blockedText?: string[];
}

export const COLLECT_PRESETS: Record<string, CollectPreset> = {
  generic: {
    description:
      "Any feed of <article> or role=article items; key is the first permalink-like link.",
    tested: true,
    item: 'article, [role="article"]',
    fields: { text: "", time: "time@datetime" },
  },
  x: {
    description: "X (Twitter) timelines, searches, profiles and threads.",
    tested: true,
    item: 'article[data-testid="tweet"]',
    key: "a:has(> time)@href",
    fields: {
      url: "a:has(> time)@href",
      time: "time@datetime",
      author: '[data-testid="User-Name"]',
      text: '[data-testid="tweetText"]',
      "media[]": '[data-testid="tweetPhoto"] img@src',
    },
    expand: 'button[data-testid="tweet-text-show-more-link"]',
    blockedText: ["Something went wrong\\. Try reloading", "Rate limit exceeded"],
  },
  threads: {
    description: "Threads (threads.net / threads.com) feeds and profiles.",
    tested: false,
    item: 'div[data-pressable-container="true"]',
    keyPattern: "/post/[^/?#]+",
    fields: {
      url: 'a[href*="/post/"]@href',
      time: "time@datetime",
      author: 'a[href^="/@"]',
      text: "",
      "media[]": "img[src]@src",
    },
  },
  bluesky: {
    description: "Bluesky (bsky.app) feeds, searches and profiles.",
    tested: false,
    item: '[data-testid^="feedItem-by-"]',
    key: 'a[href*="/post/"]@href',
    fields: {
      url: 'a[href*="/post/"]@href',
      author: 'a[href^="/profile/"]',
      text: '[data-testid="postText"]',
      "media[]": 'img[src*="/img/feed"]@src',
    },
  },
  reddit: {
    description: "Reddit (new shreddit UI) subreddit, search and home feeds.",
    tested: false,
    item: "shreddit-post",
    key: "@permalink",
    fields: {
      url: "@permalink",
      title: "@post-title",
      author: "@author",
      time: "@created-timestamp",
      score: "@score",
      comments: "@comment-count",
      text: '[slot="text-body"]',
    },
  },
  linkedin: {
    description: "LinkedIn home and search feeds (signed in).",
    tested: false,
    item: "div.feed-shared-update-v2",
    key: "@data-urn",
    fields: {
      author: ".update-components-actor__title",
      time: ".update-components-actor__sub-description",
      text: ".update-components-text",
    },
    expand: "button.feed-shared-inline-show-more-text__see-more-less-toggle",
  },
  instagram: {
    description: "Instagram home feed posts.",
    tested: false,
    item: "article",
    keyPattern: "/(p|reel)/[^/?#]+",
    fields: {
      url: 'a[href*="/p/"]@href',
      time: "time@datetime",
      author: 'header a[href^="/"]',
      text: "h1",
      "media[]": "img[src]@src",
    },
  },
  tiktok: {
    description: "TikTok web For You, search and profile grids.",
    tested: false,
    item: '[data-e2e="recommend-list-item-container"], [data-e2e="search_top-item"], [data-e2e="user-post-item"]',
    key: 'a[href*="/video/"]@href',
    fields: {
      url: 'a[href*="/video/"]@href',
      author: '[data-e2e="video-author-uniqueid"]',
      text: '[data-e2e="video-desc"]',
    },
  },
  mastodon: {
    description: "Mastodon web UI timelines and profiles (any instance).",
    tested: false,
    item: "article",
    key: "a.status__relative-time@href",
    fields: {
      url: "a.status__relative-time@href",
      time: "time@datetime",
      author: ".display-name__account",
      text: ".status__content",
      "media[]": ".media-gallery img@src",
    },
    expand: "button.status__content__spoiler-link",
  },
  "youtube-comments": {
    description: "YouTube watch-page comment threads (scroll past the video first).",
    tested: false,
    item: "ytd-comment-thread-renderer",
    key: '#published-time-text a, .published-time-text a, a[href*="lc="]@href',
    fields: {
      url: 'a[href*="lc="]@href',
      author: "#author-text",
      time: '#published-time-text, .published-time-text, a[href*="lc="]',
      text: "#content-text",
      likes: "#vote-count-middle",
    },
    expand: "tp-yt-paper-button#more, #more.ytd-expander",
  },
};

/** What the page driver needs: every string parsed and validated. */
export interface ResolvedCollectSpec {
  preset: string;
  item: string;
  key: Extractor | null;
  keyPattern: string | null;
  fields: FieldSpec[];
  expand: string | null;
  blockedText: string[];
}

export interface CollectSpecOverrides {
  item?: string;
  key?: string;
  keyPattern?: string;
  fields?: string[];
  /** A selector, or true to use the preset's selector. */
  expand?: string | boolean;
}

export function presetNames(): string[] {
  return Object.keys(COLLECT_PRESETS);
}

export function resolveCollectSpec(
  presetName: string,
  overrides: CollectSpecOverrides = {},
): ResolvedCollectSpec {
  const preset = COLLECT_PRESETS[presetName];
  if (!preset) {
    throw new Error(
      `Unknown collect preset "${presetName}". Available: ${presetNames().join(", ")}.`,
    );
  }
  const fields = new Map<string, FieldSpec>();
  for (const [name, spec] of Object.entries(preset.fields)) {
    const field = parseFieldSpec(`${name}=${spec}`);
    fields.set(field.name, field);
  }
  for (const raw of overrides.fields ?? []) {
    const field = parseFieldSpec(raw);
    fields.set(field.name, field);
  }
  const keySpec = overrides.key ?? preset.key;
  const keyPattern = overrides.keyPattern ?? preset.keyPattern ?? null;
  if (keyPattern !== null) {
    try {
      new RegExp(keyPattern);
    } catch (err) {
      throw new Error(
        `Key pattern "${keyPattern}" is not a valid regex: ${(err as Error).message}`,
      );
    }
  }
  let expand: string | null = null;
  if (typeof overrides.expand === "string" && overrides.expand.trim()) {
    expand = overrides.expand.trim();
  } else if (overrides.expand) {
    if (!preset.expand) {
      throw new Error(
        `Preset "${presetName}" has no expand selector; pass one: --collect-expand '<selector>'.`,
      );
    }
    expand = preset.expand;
  }
  const item = overrides.item?.trim() || preset.item;
  return {
    preset: presetName,
    item,
    key: keySpec === undefined ? null : parseExtractor(keySpec),
    keyPattern,
    fields: [...fields.values()],
    expand,
    blockedText: preset.blockedText ?? [],
  };
}
