import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  if (process.env.FAKE_CODEX_SILENT === "1") return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { codexHome: "/tmp/codex" } })}\n`);
    return;
  }
  if (message.method !== "hooks/list") return;
  const cwd = message.params.cwds[0];
  const status = process.env.FAKE_CODEX_TRUST_STATUS ?? "trusted";
  process.stdout.write(
    `${JSON.stringify({
      id: message.id,
      result: {
        data: [
          {
            cwd,
            hooks: [
              {
                command: "bash harnery/bin/agent-hook session-start --adapter codex",
                enabled: process.env.FAKE_CODEX_DISABLED !== "1",
                trustStatus: status,
              },
            ],
            warnings: [],
            errors: [],
          },
        ],
      },
    })}\n`,
  );
});
