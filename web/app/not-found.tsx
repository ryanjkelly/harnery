import { FileQuestion } from "lucide-react";
import Link from "next/link";
import { PageShell } from "@/components/layout/PageShell";

/**
 * Themed 404 — keeps the chrome so a dead link (an ended session whose
 * durable record is gone, a mistyped id) never strands the operator on the
 * default unstyled page with no way back.
 */
export default function NotFound() {
  return (
    <PageShell width="wide" className="flex flex-col items-center pt-24 text-center">
      <FileQuestion className="mb-4 size-10 text-muted-foreground/40" aria-hidden />
      <h1 className="mb-2 text-xl font-semibold tracking-tight">Not found</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Nothing lives at this address — the record may have ended, been archived, or the id may be
        mistyped. Head back to the{" "}
        <Link href="/" className="underline hover:text-foreground">
          dashboard
        </Link>{" "}
        or press <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-xs">⌘K</code> to
        search everything.
      </p>
    </PageShell>
  );
}
