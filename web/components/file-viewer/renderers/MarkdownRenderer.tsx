"use client";

/**
 * Markdown renderer: react-markdown + remark-gfm + rehype-sanitize.
 * GFM tables/strikethrough/task-lists/autolinks; raw HTML is NOT enabled in v1
 * (no rehype-raw), so embedded `<script>`/`<img onerror>` in a .md file render
 * as inert text. Fenced code blocks highlight via Shiki (the `code` override →
 * ShikiBlock). Prose styling is hand-tuned with Tailwind (no @tailwindcss/typography
 * dep) to match the dark dashboard theme.
 */

import type { FileText } from "@/lib/file-viewer/types";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import ShikiBlock from "./ShikiBlock";

const PROSE = [
  "max-w-none px-5 py-4 text-[13px] leading-relaxed text-foreground/90",
  "[&_h1]:mt-0 [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:text-foreground",
  "[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-foreground [&_h2]:border-b [&_h2]:border-border/60 [&_h2]:pb-1",
  "[&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold",
  "[&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:font-semibold",
  "[&_p]:my-2.5",
  "[&_a]:text-sky-600 dark:[&_a]:text-sky-400 [&_a]:underline [&_a]:underline-offset-2",
  "[&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_blockquote]:italic",
  "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted/60 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[12px]",
  "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[12px]",
  "[&_th]:border [&_th]:border-border [&_th]:bg-muted/40 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left",
  "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:align-top",
  "[&_hr]:my-4 [&_hr]:border-border",
  "[&_img]:max-w-full [&_img]:rounded",
].join(" ");

export default function MarkdownRenderer({ file }: { file: FileText }) {
  return (
    <div className={`overflow-auto ${PROSE}`}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          // Pass-through <pre> so fenced code isn't double-wrapped; ShikiBlock
          // (from the `code` override) supplies its own container.
          pre: ({ children }) => <>{children}</>,
          code({ className, children, ...props }) {
            const match = /language-([\w-]+)/.exec(className ?? "");
            if (match) {
              return <ShikiBlock code={String(children).replace(/\n$/, "")} lang={match[1]!} />;
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {file.content}
      </Markdown>
    </div>
  );
}
