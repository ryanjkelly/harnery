import { existsSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { resolveCoordRoot } from "../core/agents/coord-client.ts";
import { resolveBinName, serverGcConfig } from "../core/config.ts";
import {
  adoptServer,
  allocateServerPort,
  isValidServerId,
  listServers,
  planServerGc,
  readServer,
  registerServer,
  SERVER_DEFAULT_IDLE_HOURS,
  SERVER_DEFAULT_OWNER_STALE_HOURS,
  type ServerKind,
  type ServersReport,
  type ServerView,
  type StopResult,
  stopServer,
  touchServer,
  unregisterServer,
} from "../core/servers/index.ts";

export function registerServersCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  const root = (): string => {
    const resolved = context?.resolveCoordRoot?.() ?? context?.repoRoot ?? resolveCoordRoot();
    if (!resolved) throw new Error("not inside a Harnery project");
    return resolved;
  };
  const fail = (error: unknown, code = "servers_error"): void => {
    emit.error({ code, message: error instanceof Error ? error.message : String(error) });
    emit.setExitCode(1);
  };

  const cmd = program
    .command("servers")
    .description(
      "Every local server started in this project: list, stop, clean up idle session servers, read logs",
    );

  cmd
    .command("list", { isDefault: true })
    .alias("status")
    .description("List registered servers and any unregistered listener running inside the project")
    .option("--no-scan", "Skip the scan for unregistered listeners")
    .option("--json", "Emit the versioned report")
    .action((options: { scan?: boolean; json?: boolean }) => {
      try {
        const report = listServers({ coordRoot: root(), scan: options.scan !== false });
        if (options.json) {
          emit.config({ format: "json" });
          emit.data(report);
        } else emit.text(renderReport(report, resolveBinName(report.coord_root)));
      } catch (error) {
        fail(error);
      }
    });

  cmd
    .command("stop [ids...]")
    .description("Stop named servers now; --type selects several and previews unless --yes")
    .option("--type <type>", "Select every running server of this type")
    .option(
      "--pid <pid>",
      "Stop an unregistered listener found by the list scan (repeatable)",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("--kind <kind>", "With --type, limit to session or service")
    .option("--yes", "Apply a --type selection")
    .option("--json", "Emit JSON")
    .action(
      async (
        ids: string[],
        options: { type?: string; kind?: string; pid?: string[]; yes?: boolean; json?: boolean },
      ) => {
        try {
          const coordRoot = root();
          const pids = (options.pid ?? []).map((value) => integer(value, "--pid"));
          if (!ids.length && !options.type && !pids.length)
            throw new Error("name server ids, or pass --type or --pid");
          const report = listServers({ coordRoot, scan: pids.length > 0 });
          const strays = pids.map((pid) => {
            const found = report.unregistered.find((item) => item.pid === pid);
            if (!found)
              throw new Error(
                `pid ${pid} is not an unregistered listener inside this project; only pids shown by "servers list" can be stopped this way`,
              );
            return found;
          });
          const byId = new Map(report.servers.map((view) => [view.record.id, view]));
          const missing = ids.filter((id) => !byId.has(id));
          if (missing.length) throw new Error(`no running server named: ${missing.join(", ")}`);
          const selected = [
            ...ids.map((id) => byId.get(id)!),
            ...(options.type
              ? report.servers.filter(
                  (view) =>
                    view.record.type === options.type &&
                    view.state === "running" &&
                    (!options.kind || view.record.kind === options.kind) &&
                    !ids.includes(view.record.id),
                )
              : []),
          ];
          const preview = Boolean(options.type) && !options.yes;
          const results: Array<StopResult | { id: string; would_stop: true }> = [];
          for (const stray of strays) {
            results.push(
              await stopServer(
                {
                  schema_version: 1,
                  id: `pid-${stray.pid}`,
                  kind: "session",
                  type: "unregistered",
                  label: stray.command,
                  pid: stray.pid,
                  host: hostname(),
                  started_at: new Date().toISOString(),
                  registered_at: new Date().toISOString(),
                },
                { coordRoot },
              ),
            );
          }
          for (const view of selected) {
            if (preview && !ids.includes(view.record.id))
              results.push({ id: view.record.id, would_stop: true });
            else results.push(await stopServer(view.record, { coordRoot }));
          }
          if (options.json) {
            emit.config({ format: "json" });
            emit.data({ applied: !preview, results });
          } else {
            emit.text(
              results.length
                ? results
                    .map((r) =>
                      "would_stop" in r
                        ? `would stop ${r.id}`
                        : `${r.stopped ? "stopped" : r.method === "not-running" ? "already stopped" : "could not stop"} ${r.id}${r.detail ? ` (${r.detail})` : ""}`,
                    )
                    .join("\n") +
                    (preview ? `\nPreview only. Re-run with --yes to stop these.` : "")
                : "No matching running servers.",
            );
          }
          if (results.some((r) => "stopped" in r && !r.stopped && r.method === "refused"))
            emit.setExitCode(1);
        } catch (error) {
          fail(error);
        }
      },
    );

  cmd
    .command("gc")
    .description(
      `Stop idle session servers whose starting agent ended (preview unless --yes); services are never touched`,
    )
    .option(
      "--idle-hours <hours>",
      `Idle window before a server may stop (default ${SERVER_DEFAULT_IDLE_HOURS})`,
    )
    .option(
      "--owner-stale-hours <hours>",
      `Treat a starting agent unobserved this long as gone (default ${SERVER_DEFAULT_OWNER_STALE_HOURS})`,
    )
    .option("--yes", "Stop the selected servers")
    .option("--json", "Emit JSON")
    .action(
      async (options: {
        idleHours?: string;
        ownerStaleHours?: string;
        yes?: boolean;
        json?: boolean;
      }) => {
        try {
          const coordRoot = root();
          const configured = serverGcConfig(coordRoot);
          const idleHours = positive(
            options.idleHours,
            configured.idle_hours ?? SERVER_DEFAULT_IDLE_HOURS,
            "--idle-hours",
          );
          const ownerStaleHours = positive(
            options.ownerStaleHours,
            configured.owner_stale_hours ?? SERVER_DEFAULT_OWNER_STALE_HOURS,
            "--owner-stale-hours",
          );
          const report = listServers({ coordRoot, scan: false, ownerStaleHours });
          const decisions = planServerGc(report.servers, { idleHours, ownerStaleHours });
          const stops = decisions.filter((d) => d.action === "stop");
          const results: StopResult[] = [];
          if (options.yes) {
            for (const decision of stops) {
              const view = report.servers.find((v) => v.record.id === decision.id)!;
              results.push(await stopServer(view.record, { coordRoot }));
            }
          }
          if (options.json) {
            emit.config({ format: "json" });
            emit.data({ applied: Boolean(options.yes), pruned: report.pruned, decisions, results });
          } else {
            const lines = decisions.map(
              (d) =>
                `${d.action === "stop" ? (options.yes ? "stopped" : "would stop") : "keep"}  ${d.id}  ${d.reason}`,
            );
            if (report.pruned.length)
              lines.push(`Removed records of exited servers: ${report.pruned.join(", ")}`);
            if (!decisions.length) lines.push("No registered servers.");
            if (stops.length && !options.yes)
              lines.push("Preview only. Re-run with --yes to stop.");
            emit.text(lines.join("\n"));
          }
        } catch (error) {
          fail(error);
        }
      },
    );

  cmd
    .command("adopt")
    .description(
      "Register running servers that never registered (only pids the list reports as unregistered)",
    )
    .option(
      "--pid <pid>",
      "Adopt this unregistered listener (repeatable)",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("--all", "Adopt every unregistered listener the scan reports")
    .option("--type <type>", "Server family to record", "adopted")
    .option("--kind <kind>", "session (cleaned up when idle) or service", "session")
    .option("--label <label>", "Human-readable name (single --pid only)")
    .option("--scope <path>", "What the server serves (default: its working directory)")
    .option("--no-owner", "Record no owner, so gc never stops it")
    .option("--json", "Emit JSON")
    .action(
      (options: {
        pid?: string[];
        all?: boolean;
        type: string;
        kind: string;
        label?: string;
        scope?: string;
        owner?: boolean;
        json?: boolean;
      }) => {
        try {
          const coordRoot = root();
          if (options.kind !== "session" && options.kind !== "service")
            throw new Error("--kind must be session or service");
          const pids = options.all
            ? [...new Set(listServers({ coordRoot, sample: false }).unregistered.map((u) => u.pid))]
            : (options.pid ?? []).map((value) => integer(value, "--pid"));
          if (!pids.length)
            throw new Error(options.all ? "no unregistered listeners" : "pass --pid or --all");
          if (options.label && pids.length > 1) throw new Error("--label needs a single --pid");
          const records = pids.map((pid) =>
            adoptServer(pid, {
              coordRoot,
              type: options.type,
              kind: options.kind as ServerKind,
              ...(options.label ? { label: options.label } : {}),
              ...(options.scope ? { scope: options.scope } : {}),
              owner: options.owner === false ? "none" : "self",
            }),
          );
          if (options.json) {
            emit.config({ format: "json" });
            emit.data({ adopted: records });
          } else emit.text(records.map((r) => `adopted ${r.id}  ${r.url ?? ""}`).join("\n"));
        } catch (error) {
          fail(error);
        }
      },
    );

  cmd
    .command("port <type>")
    .description(
      "Print a free port from the type's configured range (.harnery/config.jsonc servers.port_ranges)",
    )
    .action((type: string) => {
      try {
        const port = allocateServerPort(type, { coordRoot: root() });
        if (port === null) throw new Error(`no port range configured for ${type}`);
        emit.text(String(port));
      } catch (error) {
        fail(error);
      }
    });

  cmd
    .command("logs <id>")
    .description("Print the end of a server's log file")
    .option("-n, --lines <n>", "Lines to print", "60")
    .action((id: string, options: { lines: string }) => {
      try {
        const record = readServer(id, { coordRoot: root() });
        if (!record) throw new Error(`no server named ${id}`);
        if (!record.log || !existsSync(record.log))
          throw new Error(`${id} did not record a log file`);
        const lines = positive(options.lines, 60, "--lines");
        const size = statSync(record.log).size;
        const content = readFileSync(record.log, "utf8").slice(Math.max(0, size - 512 * 1024));
        emit.text(
          content
            .split("\n")
            .slice(-Math.floor(lines) - 1)
            .join("\n"),
        );
      } catch (error) {
        fail(error);
      }
    });

  cmd
    .command("open <id>")
    .description("Print a server's URL")
    .action((id: string) => {
      try {
        const record = readServer(id, { coordRoot: root() });
        if (!record) throw new Error(`no server named ${id}`);
        if (!record.url) throw new Error(`${id} did not record a URL`);
        emit.text(record.url);
      } catch (error) {
        fail(error);
      }
    });

  cmd
    .command("register")
    .description(
      "Record a server started by a script or another language (prints the record; the calling agent is recorded as owner)",
    )
    .requiredOption("--type <type>", "Server family, for example preview or review")
    .option("--kind <kind>", "session (per piece of work) or service (long-running)", "session")
    .option(
      "--pid <pid>",
      "Process that owns the server's lifetime (default: this command's parent)",
    )
    .option("--port <port>", "Listening port")
    .option("--id <id>", "Stable id (default derived from type and scope)")
    .option("--url <url>", "Local URL")
    .option("--scope <path>", "What the server serves, usually a directory")
    .option("--label <label>", "Human-readable name")
    .option("--log <path>", "Log file")
    .option("--cwd <path>", "Working directory")
    .action(
      (options: {
        type: string;
        kind: string;
        pid?: string;
        port?: string;
        id?: string;
        url?: string;
        scope?: string;
        label?: string;
        log?: string;
        cwd?: string;
      }) => {
        try {
          if (options.kind !== "session" && options.kind !== "service")
            throw new Error("--kind must be session or service");
          if (options.id && !isValidServerId(options.id))
            throw new Error(`invalid id: ${options.id}`);
          const record = registerServer(
            {
              kind: options.kind as ServerKind,
              type: options.type,
              pid: options.pid ? integer(options.pid, "--pid") : process.ppid,
              ...(options.port ? { port: integer(options.port, "--port") } : {}),
              ...(options.id ? { id: options.id } : {}),
              ...(options.url ? { url: options.url } : {}),
              ...(options.scope ? { scope: options.scope } : {}),
              ...(options.label ? { label: options.label } : {}),
              ...(options.log ? { log: options.log } : {}),
              ...(options.cwd ? { cwd: options.cwd } : {}),
            },
            { coordRoot: root() },
          );
          emit.config({ format: "json" });
          emit.data(record);
        } catch (error) {
          fail(error);
        }
      },
    );

  cmd
    .command("unregister <id>")
    .description("Remove a server's record (with --pid, only if the record still names that pid)")
    .option("--pid <pid>", "Only remove when the record names this pid")
    .action((id: string, options: { pid?: string }) => {
      try {
        const removed = unregisterServer(id, {
          coordRoot: root(),
          ...(options.pid ? { pid: integer(options.pid, "--pid") } : {}),
        });
        emit.config({ format: "json" });
        emit.data({ id, removed });
      } catch (error) {
        fail(error);
      }
    });

  cmd
    .command("touch <id>")
    .description("Mark a server as used now, postponing idle cleanup")
    .action((id: string) => {
      try {
        touchServer(id, { coordRoot: root() });
      } catch (error) {
        fail(error);
      }
    });
}

function integer(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function positive(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive number`);
  return parsed;
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d`;
}

function ownerText(view: ServerView): string {
  if (!view.record.owner) return "no agent";
  const name = view.record.owner.name ?? view.record.owner.instance_id.slice(0, 8);
  return view.owner_state === "live" ? name : `${name} (${view.owner_state})`;
}

/** Plain-text table grouped by kind; exported for tests. */
export function renderReport(report: ServersReport, bin: string): string {
  const lines: string[] = [];
  for (const kind of ["service", "session"] as const) {
    const views = report.servers.filter((view) => view.record.kind === kind);
    lines.push(
      kind === "service"
        ? "Services (stopped only by hand)"
        : "Session servers (cleaned up when idle and their agent is gone)",
    );
    if (!views.length) {
      lines.push("  none");
      continue;
    }
    for (const view of views) {
      const { record } = view;
      const state = view.state === "running" ? "" : ` [${view.state}]`;
      const started = Date.parse(record.started_at);
      const use =
        kind === "service"
          ? `up ${Number.isFinite(started) ? duration(Date.now() - started) : "?"}`
          : view.connections === null
            ? `idle ${duration(view.idle_ms)}`
            : view.connections > 0
              ? `${view.connections} open connection(s)`
              : `idle ${duration(view.idle_ms)}`;
      lines.push(
        `  ${record.id}${state}  ${record.url ?? (record.port ? `port ${record.port}` : "")}`,
        `      ${record.label} · ${ownerText(view)} · ${use}`,
      );
    }
  }
  if (report.scan === "unsupported") {
    lines.push("Unregistered listeners: not checked on this platform");
  } else if (report.unregistered.length) {
    const byPid = new Map<number, { ports: number[]; command: string }>();
    for (const item of report.unregistered) {
      const entry = byPid.get(item.pid) ?? { ports: [], command: item.command };
      entry.ports.push(item.port);
      byPid.set(item.pid, entry);
    }
    lines.push(`Unregistered servers inside this project (${byPid.size} processes):`);
    for (const [pid, entry] of byPid)
      lines.push(`  pid ${pid}  port ${entry.ports.join(", ")}  ${entry.command.slice(0, 100)}`);
    lines.push(
      `  These started without registering. Stop one with: ${bin} servers stop --pid <pid>`,
    );
  }
  if (report.pruned.length)
    lines.push(`Removed records of exited servers: ${report.pruned.join(", ")}`);
  lines.push(`Control: ${bin} servers stop <id> · ${bin} servers gc · ${bin} servers logs <id>`);
  return lines.join("\n");
}
