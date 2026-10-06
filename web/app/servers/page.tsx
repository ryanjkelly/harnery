import { FormattedDateTime } from "@/components/FormattedDateTime";
import { NavBar } from "@/components/NavBar";
import { StopServerButton } from "@/components/StopServerButton";
import { coordRoot } from "@/lib/coord-reader";
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
    <div>
      <NavBar scannedDir={coordRoot()} />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <header className="mb-5">
          <h1 className="text-lg font-semibold">Servers</h1>
          <p className="text-sm text-muted-foreground">
            Every local server started in this project. Session servers stop on their own once the
            agent that started them is gone and nobody has used them for two hours. Services stop
            only when someone stops them.
          </p>
        </header>

        {error ? (
          <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
            Could not read the server registry: {error}
          </div>
        ) : (
          <div className="space-y-6">
            <ServerTable title="Session servers" views={sessions} now={now} session />
            <ServerTable title="Services" views={services} now={now} />
            <section>
              <h2 className="mb-2 text-sm font-semibold">Unregistered servers</h2>
              {report?.scan === "unsupported" ? (
                <p className="text-sm text-muted-foreground">Not checked on this platform.</p>
              ) : strays.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  None. Every server listening inside this project is registered.
                </p>
              ) : (
                <>
                  <p className="mb-2 text-sm text-muted-foreground">
                    These processes listen on a port from inside this project but never registered,
                    so nothing tracks or cleans them up.
                  </p>
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2">Process</th>
                          <th className="px-3 py-2">Ports</th>
                          <th className="px-3 py-2">Command</th>
                          <th className="px-3 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {strays.map((stray) => (
                          <tr key={stray.pid} className="border-t border-border align-top">
                            <td className="px-3 py-2 font-mono text-xs">{stray.pid}</td>
                            <td className="px-3 py-2 font-mono text-xs">
                              {stray.ports.join(", ")}
                            </td>
                            <td className="px-3 py-2 font-mono text-xs break-all">
                              {stray.command}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <StopServerButton pid={stray.pid} label={`process ${stray.pid}`} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>
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
      </main>
    </div>
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
    <section>
      <h2 className="mb-2 text-sm font-semibold">
        {title} <span className="font-normal text-muted-foreground">({views.length})</span>
      </h2>
      {views.length === 0 ? (
        <p className="text-sm text-muted-foreground">None running.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Server</th>
                <th className="px-3 py-2">Address</th>
                <th className="px-3 py-2">Started by</th>
                <th className="px-3 py-2">{session ? "Use" : "Running for"}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
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
                  <tr key={record.id} className="border-t border-border align-top">
                    <td className="px-3 py-2">
                      <div>{record.label}</div>
                      <div className="font-mono text-xs text-muted-foreground">{record.id}</div>
                    </td>
                    <td className="px-3 py-2 text-xs break-all">
                      {record.url ? (
                        <a className="underline" href={record.url} target="_blank" rel="noreferrer">
                          {record.url}
                        </a>
                      ) : record.port ? (
                        `port ${record.port}`
                      ) : (
                        ""
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">{owner}</td>
                    <td className="px-3 py-2 text-xs">
                      {view.state === "running" ? use : view.state}
                    </td>
                    <td className="px-3 py-2 text-right">
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
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
