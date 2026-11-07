import { FormattedDateTime } from "@/components/FormattedDateTime";
import { EmptyState } from "@/components/layout/EmptyState";
import { Notice } from "@/components/layout/Notice";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { Section } from "@/components/layout/Section";
import { StopServerButton } from "@/components/StopServerButton";
import { Table, TableHead, Td, Th, Tr } from "@/components/ui/table";
import { readServersReport, type ServerView, type UnregisteredListener } from "@/lib/servers";

export const dynamic = "force-dynamic";

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

const OWNER_STATE: Record<ServerView["owner_state"], string> = {
  live: "active",
  abandoned: "not seen for a day",
  ended: "ended",
  unknown: "state unknown",
  none: "",
};

export default async function ServersPage() {
  const { report, error } = await readServersReport();
  const now = Date.now();
  const services = report?.servers.filter((s) => s.record.kind === "service") ?? [];
  const sessions = report?.servers.filter((s) => s.record.kind === "session") ?? [];
  const strays = groupByPid(report?.unregistered ?? []);

  return (
    <PageShell width="wide">
      <PageHeader
        title="Servers"
        description="Every local server started in this project. Session servers stop on their own once the agent that started them is gone and nobody has used them for two hours. Services stop only when someone stops them."
      />

      {error ? (
        <Notice tone="danger" title="Could not read the server registry">
          {error}
        </Notice>
      ) : (
        <div className="space-y-6">
          <ServerTable title="Session servers" views={sessions} now={now} session />
          <ServerTable title="Services" views={services} now={now} />
          <Section title="Unregistered servers" className="mb-0">
            {report?.scan === "unsupported" ? (
              <EmptyState>Not checked on this platform.</EmptyState>
            ) : strays.length === 0 ? (
              <EmptyState>
                None. Every server listening inside this project is registered.
              </EmptyState>
            ) : (
              <>
                <p className="mb-2 text-sm text-muted-foreground">
                  These processes listen on a port from inside this project but never registered, so
                  nothing tracks or cleans them up.
                </p>
                <Table>
                  <TableHead>
                    <tr>
                      <Th>Process</Th>
                      <Th>Ports</Th>
                      <Th>Command</Th>
                      <Th />
                    </tr>
                  </TableHead>
                  <tbody>
                    {strays.map((stray) => (
                      <Tr key={stray.pid}>
                        <Td mono>{stray.pid}</Td>
                        <Td mono>{stray.ports.join(", ")}</Td>
                        <Td mono className="break-all">
                          {stray.command}
                        </Td>
                        <Td className="text-right">
                          <StopServerButton pid={stray.pid} label={`process ${stray.pid}`} />
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </>
            )}
          </Section>
          {report?.pruned.length ? (
            <p className="text-xs text-muted-foreground">
              Removed records of servers that had exited: {report.pruned.join(", ")}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            as of <FormattedDateTime iso={new Date(now).toISOString()} kind="timestamp" />
          </p>
        </div>
      )}
    </PageShell>
  );
}

function groupByPid(items: UnregisteredListener[]) {
  const byPid = new Map<number, { pid: number; ports: number[]; command: string }>();
  for (const item of items) {
    const entry = byPid.get(item.pid) ?? { pid: item.pid, ports: [], command: item.command };
    entry.ports.push(item.port);
    byPid.set(item.pid, entry);
  }
  return [...byPid.values()];
}

function ServerTable({
  title,
  views,
  now,
  session,
}: {
  title: string;
  views: ServerView[];
  now: number;
  session?: boolean;
}) {
  return (
    <Section title={title} count={views.length} className="mb-0">
      {views.length === 0 ? (
        <EmptyState>None running.</EmptyState>
      ) : (
        <Table>
          <TableHead>
            <tr>
              <Th>Server</Th>
              <Th>Address</Th>
              <Th>Started by</Th>
              <Th>{session ? "Use" : "Running for"}</Th>
              <Th />
            </tr>
          </TableHead>
          <tbody>
            {views.map((view) => {
              const { record } = view;
              const started = Date.parse(record.started_at);
              const owner = record.owner
                ? `${record.owner.name ?? record.owner.instance_id.slice(0, 8)}${
                    view.owner_state !== "live" ? ` (${OWNER_STATE[view.owner_state]})` : ""
                  }`
                : "no agent";
              const use = !session
                ? Number.isFinite(started)
                  ? duration(now - started)
                  : "unknown"
                : view.connections
                  ? `in use (${view.connections} connection${view.connections === 1 ? "" : "s"})`
                  : `idle ${duration(view.idle_ms)}`;
              return (
                <Tr key={record.id}>
                  <Td>
                    <div>{record.label}</div>
                    <div className="font-mono text-xs text-muted-foreground">{record.id}</div>
                  </Td>
                  <Td className="text-xs break-all">
                    {record.url ? (
                      <a className="underline" href={record.url} target="_blank" rel="noreferrer">
                        {record.url}
                      </a>
                    ) : record.port ? (
                      `port ${record.port}`
                    ) : (
                      ""
                    )}
                  </Td>
                  <Td className="text-xs">{owner}</Td>
                  <Td className="text-xs">{view.state === "running" ? use : view.state}</Td>
                  <Td className="text-right">
                    {view.state === "running" ? (
                      <StopServerButton
                        id={record.id}
                        label={record.label}
                        confirmMessage={
                          session
                            ? undefined
                            : `Stop ${record.label}? A service is not restarted automatically${record.type === "tunnel" ? ", and a restarted tunnel gets a new public URL" : ""}.`
                        }
                      />
                    ) : null}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Section>
  );
}
