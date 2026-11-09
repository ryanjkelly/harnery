import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { listListeningPorts, parseNetstatListening } from "./net.ts";

describe("parseNetstatListening", () => {
  test("reads listening ports by their unconnected remote address, in any language", () => {
    const output = [
      "",
      "Active Connections",
      "",
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1204",
      "  TCP    127.0.0.1:4392         0.0.0.0:0              ABHÖREN         8812",
      "  TCP    127.0.0.1:4392         127.0.0.1:51234        ESTABLISHED     8812",
      "  TCP    [::]:445               [::]:0                 LISTENING       4",
      "  TCP    [::1]:9229             [::1]:50000            ESTABLISHED     77",
      "  UDP    0.0.0.0:5353           *:*                                    2200",
    ].join("\r\n");
    expect(parseNetstatListening(output)).toEqual([135, 4392, 445]);
  });
});

// Windows used to report no listening ports at all, so allocation could hand
// out a port already in use.
test.skipIf(process.platform !== "win32")(
  "listListeningPorts sees a port opened by this process on Windows",
  async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      expect(listListeningPorts().has(port)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
