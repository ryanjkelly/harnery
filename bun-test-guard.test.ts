process.stderr.write(
  [
    "\nUnscoped `bun test` is disabled in Harnery because it bypasses browser-suite isolation.",
    "Use `bun test <paths...>` for focused work or `bun run test` for the complete suite.\n",
  ].join("\n"),
);
process.exit(1);
