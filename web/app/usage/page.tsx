import { FormattedDateTime } from "@/components/FormattedDateTime";
import { Notice } from "@/components/layout/Notice";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { UsageBoard } from "@/components/UsageBoard";
import { readDevtoolsReport } from "@/lib/devtools-reader";

export const dynamic = "force-dynamic";

export default async function UsagePage() {
  const report = await readDevtoolsReport();
  const now = Date.now();
  return (
    <PageShell>
      <PageHeader
        title="Usage"
        description="How much each Claude Code, Codex, and Cursor account on this machine has left, its pace, and its resets. Plan and sign-in details are on the Tools page."
      />
      {report.error ? (
        <Notice tone="danger" title="Could not read agent usage">
          {report.error}
        </Notice>
      ) : (
        <UsageBoard tools={report.tools} now={now} />
      )}
      {report.generatedAt && !report.error ? (
        <p className="mt-5 text-xs text-muted-foreground">
          as of <FormattedDateTime iso={report.generatedAt} kind="timestamp" />
        </p>
      ) : null}
    </PageShell>
  );
}
