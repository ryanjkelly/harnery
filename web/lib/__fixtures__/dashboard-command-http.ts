import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { dashboardActionResponse, readDashboardCommand } from "../dashboard-command-store";

const [root, boundary, port = "0"] = process.argv.slice(2);
if (!root || !boundary) throw new Error("HTTP fixture requires root and boundary");

const input = createInterface({ input: process.stdin });
let release!: () => void;
const barrier = new Promise<void>((resolve) => {
  release = resolve;
});
input.on("line", (line) => {
  if (line === "continue") release();
});

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(port),
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET") {
      const receipt = readDashboardCommand(
        root,
        decodeURIComponent(url.pathname.split("/").at(-1)!),
      );
      return receipt
        ? Response.json(receipt)
        : Response.json({ error: "command_not_found" }, { status: 404 });
    }
    const body = (await request.json()) as Record<string, string>;
    const response = await dashboardActionResponse(
      root,
      "ping",
      body,
      { instance_id: body.instance_id, message: body.message },
      async () => {
        const fd = openSync(join(root, "effects.jsonl"), "a");
        try {
          writeFileSync(
            fd,
            `${JSON.stringify({ command_id: body.command_id, pid: process.pid })}\n`,
          );
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        if (boundary === "effect") {
          process.stdout.write(`EFFECT ${body.command_id}\n`);
          await barrier;
        }
        return { ok: true, target_instance: body.instance_id, bytes: 4 };
      },
    );
    if (boundary === "receipt") {
      process.stdout.write(`RECEIPT ${body.command_id}\n`);
      await barrier;
    }
    return response;
  },
});
process.stdout.write(`LISTENING ${JSON.stringify({ port: server.port, pid: process.pid })}\n`);
