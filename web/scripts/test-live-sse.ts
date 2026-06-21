#!/usr/bin/env bun
/**
 * Self-driving test for /api/live-events and /api/events-stream SSE freshness.
 *
 * Why this exists: the routes' failure mode (inotify drop on WSL2, dev-HMR
 * teardowns, proxy timeouts) is invisible without an end-to-end probe: the
 * server emits heartbeats happily while sending zero data events. This script
 * opens an EventSource against the live dev server, appends synthetic events
 * to the appropriate ndjson, and verifies they round-trip back over the wire
 * within an SLA. Lets me iterate on the route fix without asking the user to
 * reload tabs.
 *
 * Usage:
 *   bun harnery/web/scripts/test-live-sse.ts                # default 10s, 5 appends, --route live
 *   bun harnery/web/scripts/test-live-sse.ts --route events # probe /api/events-stream + .harnery/events.ndjson
 *   bun harnery/web/scripts/test-live-sse.ts --route both   # run both back-to-back, fail if either fails
 *   bun harnery/web/scripts/test-live-sse.ts --duration 60  # longer run
 *   bun harnery/web/scripts/test-live-sse.ts --appends 50
 *   bun harnery/web/scripts/test-live-sse.ts --stress       # 200 appends back-to-back
 *
 * Test modes (combine freely):
 *   --route <name>   live | events | both. Default live. `live` probes
 *                    /api/live-events ↔ .harnery/session-events.ndjson;
 *                    `events` probes /api/events-stream ↔ .harnery/events.ndjson;
 *                    `both` runs them sequentially and aggregates.
 *   --duration <s>   Total run time per route. Default 10.
 *   --appends <n>    How many synthetic events to inject. Default 5.
 *   --interval <ms>  Spacing between appends. Default 1000.
 *   --stress         Shorthand for --appends 200 --interval 50.
 *   --port <n>       Dev server port. Default $HARNERY_WEB_PORT or 9000.
 *   --no-append      Just listen, useful for verifying the safety-net poll
 *                    after killing the dev server's fs.watch.
 *
 * Exit codes:
 *   0  every appended event was received within p99 lag SLA
 *   1  any synthetic event timed out (>5s after append), likely a regression
 *   2  setup error (server unreachable, file not writable)
 */

import { appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { NO_DATA } from "../lib/format/no-data";

type Route = "live" | "events" | "both";

interface RouteSpec {
  name: "live" | "events";
  endpoint: string;
  file: string;
  // Renderer for the synthetic event payload. /live consumes
  // session-events.ndjson rows; /events consumes hook events.ndjson rows.
  // Shape mismatch silently drops rows from the rendered table, so each
  // route gets its own schema-correct probe.
  makeProbe: (cmdId: string, marker: string, i: number, n: number) => string;
}

const ROUTES: Record<"live" | "events", RouteSpec> = {
  live: {
    name: "live",
    endpoint: "/api/live-events",
    file: ".harnery/session-events.ndjson",
    makeProbe: (cmdId, marker, i, n) =>
      JSON.stringify({
        ts: new Date().toISOString(),
        type: "command_start",
        agent_name: "test-live-sse",
        cmd_id: cmdId,
        intent: `${marker} ${i + 1}/${n}`,
        cmd: `:probe ${i}`,
      }) + "\n",
  },
  events: {
    name: "events",
    endpoint: "/api/events-stream",
    file: ".harnery/events.ndjson",
    makeProbe: (cmdId, marker, i, n) =>
      JSON.stringify({
        event_id: cmdId,
        ts: new Date().toISOString(),
        event_type: "PROBE",
        instance_id: "test-live-sse",
        agent_name: "test-live-sse",
        // Stuff the marker into a payload field so the SSE consumer can
        // identify probes by substring even if the hook-event schema gains
        // new fields later.
        payload: { intent: `${marker} ${i + 1}/${n}` },
      }) + "\n",
  },
};

interface Args {
  route: Route;
  duration: number;
  appends: number;
  interval: number;
  port: number;
  noAppend: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    route: "live",
    duration: 10,
    appends: 5,
    interval: 1000,
    port: Number(process.env.HARNERY_WEB_PORT ?? 9000),
    noAppend: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--stress") {
      a.appends = 200;
      a.interval = 50;
      a.duration = Math.max(a.duration, 30);
    } else if (flag === "--no-append") {
      a.noAppend = true;
    } else if (flag === "--route") {
      const v = argv[++i];
      if (v !== "live" && v !== "events" && v !== "both") {
        console.error(`--route must be live | events | both, got ${v}`);
        process.exit(2);
      }
      a.route = v;
    } else if (flag === "--duration") {
      a.duration = Number(argv[++i]);
    } else if (flag === "--appends") {
      a.appends = Number(argv[++i]);
    } else if (flag === "--interval") {
      a.interval = Number(argv[++i]);
    } else if (flag === "--port") {
      a.port = Number(argv[++i]);
    } else if (flag === "--help" || flag === "-h") {
      console.log(
        "Usage: test-live-sse.ts [--route live|events|both] [--duration s] [--appends n] [--interval ms] [--stress] [--port n] [--no-append]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${flag}`);
      process.exit(2);
    }
  }
  return a;
}

const SLA_MS = 5000;
const PROBE_MARKER = "test-live-sse-probe";

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

async function probeRoute(spec: RouteSpec, args: Args): Promise<boolean> {
  const eventsFile = resolve(process.cwd(), spec.file);
  if (!existsSync(eventsFile)) {
    console.error(`✗ ${spec.file} not found at ${eventsFile}`);
    console.error("  Run this script from the the host project root.");
    return false;
  }

  console.log("");
  console.log(`━━━ route: ${spec.name} (${spec.endpoint}) ━━━━━━━━━━━━━━━━━`);
  const url = `http://127.0.0.1:${args.port}${spec.endpoint}?initial=1`;
  console.log(`[${ts()}] connecting ${url}`);
  console.log(
    `[${ts()}] plan: ${args.appends} appends @ ${args.interval}ms, total ${args.duration}s`,
  );

  // Track each synthetic event by its unique cmd_id so we can measure lag.
  const sent = new Map<string, number>(); // cmd_id → appendedAt(ms)
  const received = new Map<string, number>(); // cmd_id → receivedAt(ms)
  let snapshotEvents = 0;
  let liveEvents = 0;
  let heartbeats = 0;
  let staleSignals = 0;
  let errors = 0;
  let ready = false;

  // Use fetch + ReadableStream: Bun ships a usable global EventSource but
  // direct stream parsing is easier to instrument with high-resolution
  // timestamps and per-event-type counters.
  const ac = new AbortController();
  const fetchPromise = fetch(url, { signal: ac.signal })
    .then(async (resp) => {
      if (!resp.ok || !resp.body) {
        console.error(`✗ SSE handshake failed: ${resp.status} ${resp.statusText}`);
        process.exit(2);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let evType = "";
      let evData = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE framing: `event: <type>\n` then `data: <json>\n\n`
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line === "") {
            // dispatch
            if (evType && evData) handle(evType, evData);
            evType = "";
            evData = "";
            continue;
          }
          if (line.startsWith("event: ")) evType = line.slice(7);
          else if (line.startsWith("data: ")) evData += line.slice(6);
        }
      }
    })
    .catch((err) => {
      if (err.name !== "AbortError") {
        console.error(`✗ fetch error: ${err.message}`);
      }
    });

  function handle(type: string, dataStr: string): void {
    if (type === "ready") {
      ready = true;
      console.log(`[${ts()}] ✓ ready`);
      return;
    }
    if (type === "snapshot") {
      try {
        const data = JSON.parse(dataStr) as { events: unknown[] };
        snapshotEvents = data.events?.length ?? 0;
        console.log(`[${ts()}] ◇ snapshot (${snapshotEvents} events)`);
      } catch {
        /* ignore */
      }
      return;
    }
    if (type === "event") {
      liveEvents++;
      try {
        const ev = JSON.parse(dataStr) as {
          cmd_id?: string;
          intent?: string;
          event_id?: string;
          payload?: { intent?: string };
        };
        // Routes have different shapes, so try both. /live uses
        // {cmd_id, intent}; /events uses {event_id, payload.intent}.
        const probeId = ev?.cmd_id ?? ev?.event_id;
        const probeIntent = ev?.intent ?? ev?.payload?.intent;
        if (probeIntent?.includes(PROBE_MARKER) && probeId) {
          const sentAt = sent.get(probeId);
          if (sentAt !== undefined) {
            const lag = Date.now() - sentAt;
            received.set(probeId, Date.now());
            console.log(`[${ts()}] ← event ${probeId} (lag ${lag}ms)`);
          }
        }
      } catch {
        /* ignore */
      }
      return;
    }
    if (type === "heartbeat") {
      heartbeats++;
      return;
    }
    if (type === "stale") {
      staleSignals++;
      console.log(`[${ts()}] ⚠ server signalled stale (data=${dataStr})`);
      return;
    }
  }

  // Wait for `ready` before starting appends so we don't race against the
  // server pinning its offset = current EOF.
  const readyDeadline = Date.now() + 5000;
  while (!ready && Date.now() < readyDeadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!ready) {
    console.error("✗ never received `ready` event within 5s");
    ac.abort();
    process.exit(2);
  }

  if (!args.noAppend) {
    for (let i = 0; i < args.appends; i++) {
      const cmdId = `probe-${spec.name}-${Date.now()}-${i}`;
      const line = spec.makeProbe(cmdId, PROBE_MARKER, i, args.appends);
      sent.set(cmdId, Date.now());
      console.log(`[${ts()}] → append ${cmdId}`);
      await appendFile(eventsFile, line);
      if (i < args.appends - 1) {
        await new Promise((r) => setTimeout(r, args.interval));
      }
    }
  }

  // Wait the remaining duration, plus a 2s grace tail to catch any laggards.
  const endAt = Date.now() + args.duration * 1000;
  while (Date.now() < endAt) {
    if (sent.size > 0 && sent.size === received.size) {
      // all events accounted for; give a 250ms grace so any late heartbeat
      // can land in the counter
      await new Promise((r) => setTimeout(r, 250));
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 2000));
  ac.abort();
  await fetchPromise;

  // Report
  const lags: number[] = [];
  const missing: string[] = [];
  for (const [cmdId, sentAt] of sent) {
    const recvAt = received.get(cmdId);
    if (recvAt === undefined) missing.push(cmdId);
    else lags.push(recvAt - sentAt);
  }
  lags.sort((a, b) => a - b);
  const p50 = lags.length ? lags[Math.floor(lags.length * 0.5)] : null;
  const p99 = lags.length ? lags[Math.floor(lags.length * 0.99)] : null;
  const max = lags.length ? lags[lags.length - 1] : null;

  console.log("");
  console.log("─── results ─────────────────────────────────────");
  console.log(`appended:    ${sent.size}`);
  console.log(`received:    ${received.size}`);
  console.log(`missing:     ${missing.length}`);
  console.log(`lag p50:     ${p50 ?? NO_DATA}ms`);
  console.log(`lag p99:     ${p99 ?? NO_DATA}ms`);
  console.log(`lag max:     ${max ?? NO_DATA}ms`);
  console.log(`snapshot:    ${snapshotEvents}`);
  console.log(`live events: ${liveEvents}`);
  console.log(`heartbeats:  ${heartbeats}`);
  console.log(`stale sig:   ${staleSignals}`);
  console.log(`errors:      ${errors}`);

  if (missing.length > 0) {
    console.log(`✗ FAIL (${spec.name}): ${missing.length} probe(s) never arrived`);
    return false;
  }
  if (max !== null && max > SLA_MS) {
    console.log(
      `✗ FAIL (${spec.name}): max lag ${max}ms exceeds SLA ${SLA_MS}ms`,
    );
    return false;
  }
  console.log(`✓ PASS (${spec.name})`);
  return true;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const routes: RouteSpec[] =
    args.route === "both" ? [ROUTES.live, ROUTES.events] : [ROUTES[args.route]];
  let allPassed = true;
  for (const spec of routes) {
    const passed = await probeRoute(spec, args);
    if (!passed) allPassed = false;
  }
  process.exit(allPassed ? 0 : 1);
}

void main();
