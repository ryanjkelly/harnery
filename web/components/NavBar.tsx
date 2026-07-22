"use client";

import Link from "next/link";
import { useState } from "react";

import { AttentionReplayBell } from "./AttentionReplayBell";
import { LiveRefresher } from "./LiveRefresher";
import { SettingsDialog } from "./SettingsDialog";
import { Tooltip } from "./ui/tooltip";

export function NavBar({ scannedDir }: { scannedDir: string }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <header className="border-b border-border mb-8">
      <div className="max-w-screen-2xl mx-auto px-6 py-4 flex items-baseline justify-between gap-6 flex-wrap">
        <div className="flex items-baseline flex-wrap gap-x-4 gap-y-1 sm:gap-6">
          <Link
            href="/"
            className="flex items-center gap-2 font-semibold text-base hover:text-foreground"
          >
            {/* Brand emblem (provisional). Served from web/public/; swap when final. */}
            <img src="/harnery-emblem.svg" alt="" width={22} height={22} className="shrink-0" />
            Harnery
          </Link>
          <nav className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <Link href="/" className="hover:text-foreground">
              Dashboard
            </Link>
            <Link href="/councils" className="hover:text-foreground">
              Councils
            </Link>
            <Link href="/decisions" className="hover:text-foreground">
              Decisions
            </Link>
            <Link href="/live" className="hover:text-foreground">
              Live
            </Link>
            <Link href="/events" className="hover:text-foreground">
              Events
            </Link>
            <Link href="/work" className="hover:text-foreground">
              Work
            </Link>
            <Link href="/supervisors" className="hover:text-foreground">
              Goals
            </Link>
            <Link href="/workflows" className="hover:text-foreground">
              Workflows
            </Link>
            <Link href="/images" className="hover:text-foreground">
              Images
            </Link>
            <Link href="/files" className="hover:text-foreground">
              Files
            </Link>
            <Link href="/browse" className="hover:text-foreground">
              Browse
            </Link>
            <Link href="/devtools" className="hover:text-foreground">
              Tools
            </Link>
          </nav>
        </div>
        {/* items-center (not baseline): the icon buttons have no text baseline,
            so a baseline row drops them to their bottom edge. The cluster still
            baseline-ties to the left nav via its first item (LIVE). */}
        <div className="flex items-center gap-4">
          <LiveRefresher />
          {/* min-w-0 + a viewport-relative cap so the (long, unbreakable) scan
              path truncates on narrow screens instead of forcing horizontal
              page overflow. Desktop keeps the original ~420px cap. */}
          <span className="text-xs font-mono text-muted-foreground truncate min-w-0 max-w-[45vw] sm:max-w-105">
            {scannedDir}
          </span>
          <AttentionReplayBell />
          <Tooltip content="Display settings: datetime format + timezone">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="text-muted-foreground hover:text-foreground rounded p-1 -mr-1 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              aria-label="Display settings"
            >
              {/* Gear icon (Heroicons-style, inline so we don't add a deps) */}
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                className="size-5"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 0 1 1.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.894.149c-.424.07-.764.383-.929.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 0 1-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.398.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 0 1-.12-1.45l.527-.737c.25-.35.272-.806.108-1.204-.166-.397-.506-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.764-.383.93-.78.165-.398.143-.854-.108-1.204l-.526-.738a1.125 1.125 0 0 1 .12-1.45l.773-.773a1.125 1.125 0 0 1 1.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894Z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
                />
              </svg>
            </button>
          </Tooltip>
        </div>
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </header>
  );
}
