import { describe, expect, test } from "bun:test";
import { REDACTED_MARKER as M, redactSecretArgv, redactSecretText } from "./redact-secrets.ts";

const r = (text: string) => redactSecretText(text).text;

describe("redactSecretText: masks", () => {
  test.each([
    ["deploy --password hunter2x", `deploy --password ${M}`],
    ["deploy --token=abc123def", `deploy --token=${M}`],
    ["x --api-key 'q w e'", `x --api-key '${M}'`],
    ["x --client_secret s3cr3t", `x --client_secret ${M}`],
    ["x --key abcdef", `x --key ${M}`],
    ["API_TOKEN=abc123 run.sh", `API_TOKEN=${M} run.sh`],
    ['export DB_PASSWORD="p a s s"', `export DB_PASSWORD="${M}"`],
    ["SESSION_COOKIE=xyz ./go", `SESSION_COOKIE=${M} ./go`],
    ["GOOGLE_CREDENTIALS=blob", `GOOGLE_CREDENTIALS=${M}`],
    ["OPENAI_KEY: abcdef", `OPENAI_KEY: ${M}`],
    ["psql postgres://admin:pw123@db.example/x", `psql postgres://${M}@db.example/x`],
    [
      "fetch https://h.example/p?access_token=abc&page=2&sig=zz",
      `fetch https://h.example/p?access_token=${M}&page=2&sig=${M}`,
    ],
    ["curl -H 'Authorization: Bearer abc.def.ghi'", `curl -H 'Authorization: Bearer ${M}'`],
    ["use Bearer abcdefghijk now", `use Bearer ${M} now`],
    ['{"api_key": "abc", "name": "n"}', `{"api_key": "${M}", "name": "n"}`],
    [`k sk-ant-api03-${"a1".repeat(12)}`, `k ${M}`],
    [`k sk-proj-${"Ab3".repeat(8)}`, `k ${M}`],
    [`k ghp_${"A1".repeat(18)}`, `k ${M}`],
    [`k github_pat_${"A1".repeat(12)}`, `k ${M}`],
    ["k xoxb-1234567890-abcdefghij", `k ${M}`],
    ["k AKIAABCDEFGHIJKLMNOP", `k ${M}`],
    [`k AIza${"B".repeat(35)}`, `k ${M}`],
    [`k ya29.${"a1".repeat(12)}`, `k ${M}`],
    ["t eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q", `t ${M}`],
    [`long ${"aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI"} end`, `long ${M} end`],
    [`hex ${"0123456789abcdef".repeat(2)}`, `hex ${M}`],
    [`b64 ${"QWxhZGRpbjpvcGVuIHNlc2FtZQ12".repeat(2)}==`, `b64 ${M}`],
  ])("%s", (input, expected) => {
    expect(r(input)).toBe(expected);
    expect(redactSecretText(input).redacted).toBe(true);
  });

  test("PEM private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\nxyz\n-----END RSA PRIVATE KEY-----";
    expect(r(`before\n${pem}\nafter`)).toBe(`before\n${M}\nafter`);
  });

  test("a secret segment inside a path is masked, the rest kept", () => {
    expect(r(`/srv/hooks/${"aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI"}/run`)).toBe(`/srv/hooks/${M}/run`);
  });
});

describe("redactSecretText: keeps", () => {
  test.each([
    "/home/someone/projects/a-very-long-project-name/scripts/dev/local-dev-heal.sh",
    "/usr/lib/node_modules/some-package-name/dist/index-with-a-long-name.js",
    "open thread 3f2b8c1e-9d4a-4b6f-8e2a-1c7d9e0f3a5b now",
    "checkout 9fceb02d0ae598e95dc970b74767f19372d61af8",
    "digest sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "run my-very-long-backup-script-name-for-the-nightly-job.sh",
    "ThisIsAVeryLongIdentifierNameWithoutAnyDigitsAtAll",
    "--key-file /etc/ssl/private/server.pem",
    "TOKEN=$API_TOKEN ./run.sh",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal shell variable reference
    "PASSWORD=${DB_PASS} ./run.sh",
    "GIT_AUTHOR_NAME=someone git commit",
    "Key: the backups run nightly.",
    "--token --verbose",
    "https://example.com/path?page=2&sort=name",
    "plain prompt text: summarise yesterday's failed checks and open an issue",
  ])("%s", (input) => {
    expect(r(input)).toBe(input);
    expect(redactSecretText(input).redacted).toBe(false);
  });
});

describe("redactSecretArgv", () => {
  test("masks the argument after a secret flag", () => {
    expect(redactSecretArgv(["tool", "--password", "hunter2", "--user", "me"])).toEqual({
      argv: ["tool", "--password", M, "--user", "me"],
      redacted: true,
    });
  });

  test("keeps a following flag or a variable reference", () => {
    expect(redactSecretArgv(["tool", "--token", "--dry-run"]).argv).toEqual([
      "tool",
      "--token",
      "--dry-run",
    ]);
    expect(redactSecretArgv(["tool", "--token", "$TOKEN"]).redacted).toBe(false);
  });

  test("applies text rules to each argument", () => {
    expect(redactSecretArgv(["sh", "-c", "API_KEY=abc ./x"])).toEqual({
      argv: ["sh", "-c", `API_KEY=${M} ./x`],
      redacted: true,
    });
  });

  test("leaves an ordinary argv alone", () => {
    expect(redactSecretArgv(["bun", "scripts/check.ts", "--json"])).toEqual({
      argv: ["bun", "scripts/check.ts", "--json"],
      redacted: false,
    });
  });
});
