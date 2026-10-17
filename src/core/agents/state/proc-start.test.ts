import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPidToken,
  processStartToken,
  procfsStartToken,
  psStartToken,
  resetStartTokenCaches,
  signalIfSameGeneration,
  startTokenProbe,
  tokensAgree,
  verifyProcessGeneration,
} from "./proc-start.ts";

/** A pid nothing is using, so no token can be read for it. */
function deadPid(): number {
  for (let candidate = 30000; candidate < 40000; candidate++) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  throw new Error("no unused pid found");
}

const hasProcfs = procfsStartToken(process.pid) !== null;

function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    body();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetStartTokenCaches();
  }
}

afterEach(resetStartTokenCaches);

describe("processStartToken", () => {
  test("reads a stable token for a live process", () => {
    const first = processStartToken(process.pid);
    expect(first).toBeTruthy();
    // Start instants do not move. A token that drifts between reads would
    // invalidate every row it was ever compared against.
    expect(processStartToken(process.pid)).toBe(first as string);
  });

  test("tags the token by probe, so two platforms are never compared", () => {
    expect(processStartToken(process.pid)).toMatch(/^[lp]/);
  });

  test("declines to guess for a dead pid or a nonsense one", () => {
    expect(processStartToken(deadPid())).toBeNull();
    expect(processStartToken(0)).toBeNull();
    expect(processStartToken(-1)).toBeNull();
  });
});

describe("startTokenProbe", () => {
  test("is forced by the override, in either direction", () => {
    withEnv({ HARNERY_PID_PROBE: "ps" }, () => expect(startTokenProbe()).toBe("ps"));
    withEnv({ HARNERY_PID_PROBE: "procfs" }, () => expect(startTokenProbe()).toBe("procfs"));
  });

  test("otherwise follows what the machine actually has", () => {
    withEnv({ HARNERY_PID_PROBE: undefined }, () => {
      expect(startTokenProbe()).toBe(hasProcfs ? "procfs" : "ps");
    });
  });

  test("never falls back across probes, so one machine speaks one dialect", () => {
    // A procfs read that fails answers null rather than reaching for ps. Mixing
    // the two would compare an `l` token against a `p` token and call a live
    // process recycled.
    withEnv({ HARNERY_PID_PROBE: "procfs" }, () => {
      expect(processStartToken(deadPid())).toBeNull();
    });
  });
});

describe("psStartToken", () => {
  test("parses one line of ps output into a token", () => {
    const run = () => ({ status: 0, stdout: "Sat Jul 26  2:54:33 2026\n" });
    // Runs of whitespace collapse so a column-padded date and a plain one agree.
    expect(psStartToken(1, run)).toBe("pSat Jul 26 2:54:33 2026");
  });

  test("says nothing when ps fails, prints nothing, or is missing", () => {
    expect(psStartToken(1, () => ({ status: 1, stdout: "" }))).toBeNull();
    expect(psStartToken(1, () => ({ status: 0, stdout: "  \n" }))).toBeNull();
    expect(
      psStartToken(1, () => {
        throw new Error("ENOENT: ps");
      }),
    ).toBeNull();
  });

  test("reads a real process, so the branch runs on every platform with ps", () => {
    // The BSD path is the same code wherever ps exists. Exercising it only on
    // BSD hardware is how a branch rots between releases.
    const token = psStartToken(process.pid);
    expect(token).toMatch(/^p\S/);
    expect(psStartToken(process.pid)).toBe(token as string);
  });

  test("renders the same instant no matter the caller's timezone", () => {
    // `ps` formats lstart through TZ and LC_TIME, so an unpinned probe describes
    // one live process differently depending on who asked: a git hook runs under
    // LC_ALL=C, a login shell under the user's locale, and each then reads the
    // other's row as a recycled pid.
    //
    // The hostile environment has to be one a child really inherits. Assigning
    // `process.env.TZ` does not reach spawned children, so a test written that
    // way passes whether or not the pin exists; these are two subprocesses
    // reading one shared pid under environments they were actually launched
    // with.
    const script = join(tmpdir(), `harnery-tz-probe-${process.pid}.ts`);
    writeFileSync(
      script,
      `import { psStartToken } from ${JSON.stringify(join(import.meta.dir, "proc-start.ts"))};\n` +
        `process.stdout.write(String(psStartToken(Number(process.argv[2]))));\n`,
    );
    const readUnder = (tz: string) =>
      spawnSync(process.execPath, ["run", script, String(process.pid)], {
        encoding: "utf8",
        env: { ...process.env, TZ: tz },
      }).stdout.trim();
    try {
      const chicago = readUnder("America/Chicago");
      expect(chicago).toMatch(/^p\S/);
      expect(readUnder("Asia/Tokyo")).toBe(chicago);
    } finally {
      rmSync(script, { force: true });
    }
  });
});

describe("procfsStartToken", () => {
  test.skipIf(!hasProcfs)("scopes the tick count to the current boot", () => {
    // Ticks count from boot and repeat after one, while pid-map rows live in the
    // working tree and outlive reboots.
    expect(procfsStartToken(process.pid)).toMatch(/^l[0-9a-f]{8}\.\d+$/);
  });

  test.skipIf(!hasProcfs)("says nothing for a pid with no stat file", () => {
    expect(procfsStartToken(deadPid())).toBeNull();
  });
});

describe("tokensAgree", () => {
  test("accepts a token against itself and refuses a different instant", () => {
    expect(tokensAgree("labcd1234.5000", "labcd1234.5000")).toBe(true);
    expect(tokensAgree("labcd1234.5000", "labcd1234.5001")).toBe(false);
    expect(tokensAgree("pSat Jul 26 02:54:33 2026", "pSat Jul 26 02:54:33 2026")).toBe(true);
    expect(tokensAgree("pSat Jul 26 02:54:33 2026", "pSat Jul 26 02:54:34 2026")).toBe(false);
  });

  test("catches the same ticks under a different boot", () => {
    // The reboot collision the boot segment exists for: a stale row whose pid is
    // re-issued at the same moment of a later boot.
    expect(tokensAgree("labcd1234.5000", "ldeadbeef.5000")).toBe(false);
  });

  test("compares a pre-boot-id row on the part it recorded", () => {
    // Refusing these would call every row written before the upgrade a recycled
    // pid and prune a working machine's live rows on first run.
    expect(tokensAgree("l5000", "labcd1234.5000")).toBe(true);
    expect(tokensAgree("labcd1234.5000", "l5000")).toBe(true);
    expect(tokensAgree("l5001", "labcd1234.5000")).toBe(false);
  });

  test("never lets the two probes' dialects agree", () => {
    expect(tokensAgree("l5000", "pSat Jul 26 02:54:33 2026")).toBe(false);
    expect(tokensAgree("pSat Jul 26 02:54:33 2026", "l5000")).toBe(false);
  });
});

describe("checkPidToken", () => {
  test("matches the token it just read", () => {
    const token = processStartToken(process.pid) as string;
    expect(checkPidToken(process.pid, token)).toBe("match");
  });

  test("calls a re-issued pid a mismatch, not a live row", () => {
    // The distinction this whole module exists for: the pid is alive, and the
    // row is still wrong.
    expect(checkPidToken(process.pid, "l1")).toBe("mismatch");
  });

  test("says unverified rather than mismatch when either side is missing", () => {
    expect(checkPidToken(process.pid, undefined)).toBe("unverified");
    expect(checkPidToken(process.pid, "")).toBe("unverified");
    // Nothing to read for a dead pid, so the recorded token cannot be refuted.
    expect(checkPidToken(deadPid(), "l12345")).toBe("unverified");
  });

  test("works the same through the ps probe", () => {
    withEnv({ HARNERY_PID_PROBE: "ps" }, () => {
      const token = processStartToken(process.pid) as string;
      expect(token).toMatch(/^p/);
      expect(checkPidToken(process.pid, token)).toBe("match");
      expect(checkPidToken(process.pid, "pWed Jan  1 00:00:00 2020")).toBe("mismatch");
    });
  });
});

describe("verifyProcessGeneration", () => {
  test("requires an exact recorded and current token match", () => {
    expect(verifyProcessGeneration(123, "labcd1234.5000", () => "labcd1234.5000")).toBe("same");
    expect(verifyProcessGeneration(123, "labcd1234.5000", () => "labcd1234.5001")).toBe(
      "different",
    );
    expect(verifyProcessGeneration(123, "l5000", () => "labcd1234.5000")).toBe("unknown");
    expect(verifyProcessGeneration(123, "l5000", () => "l5000")).toBe("unknown");
    expect(verifyProcessGeneration(123, "labcd1234.5000", () => "l5000")).toBe("unknown");
  });

  test("reports unknown when either token is missing or the probe fails", () => {
    let probes = 0;
    const readToken = () => {
      probes++;
      return "current";
    };
    for (const recordedToken of [undefined, null, ""]) {
      expect(verifyProcessGeneration(123, recordedToken, readToken)).toBe("unknown");
    }
    expect(probes).toBe(0);
    expect(verifyProcessGeneration(123, "recorded", () => null)).toBe("unknown");
    expect(
      verifyProcessGeneration(123, "recorded", () => {
        throw new Error("probe unavailable");
      }),
    ).toBe("unknown");
  });

  test("rejects invalid process IDs before probing", () => {
    let probes = 0;
    for (const pid of [0, -123, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        verifyProcessGeneration(pid, "recorded", () => {
          probes++;
          return "recorded";
        }),
      ).toBe("unknown");
    }
    expect(probes).toBe(0);
  });

  test("keeps malformed and bootless generation evidence unknown", () => {
    for (const token of [123, {}, [], " "]) {
      expect(verifyProcessGeneration(123, token as never, () => "current")).toBe("unknown");
      expect(verifyProcessGeneration(123, "recorded", () => token as never)).toBe("unknown");
    }
    let signals = 0;
    for (const pid of [0, -123, 1.5, Number.NaN]) {
      expect(
        signalIfSameGeneration(pid, "recorded", "SIGTERM", {
          readToken: () => "recorded",
          kill: () => signals++,
        }),
      ).toEqual({ sent: false, verdict: "unknown" });
    }
    expect(
      signalIfSameGeneration(123, "l5000", "SIGTERM", {
        readToken: () => "l5000",
        kill: () => signals++,
      }),
    ).toEqual({ sent: false, verdict: "unknown" });
    expect(signals).toBe(0);
  });

  test("reads a real process token and declines a missing process", () => {
    expect(verifyProcessGeneration(process.pid, processStartToken(process.pid))).toBe("same");
    expect(verifyProcessGeneration(deadPid(), "recorded")).toBe("unknown");
  });
});

describe("signalIfSameGeneration", () => {
  test("reads the token immediately before signaling the same generation", () => {
    const events: string[] = [];
    const result = signalIfSameGeneration(123, "recorded", "SIGTERM", {
      readToken: (pid) => {
        events.push(`read:${pid}`);
        return "recorded";
      },
      kill: (pid, signal) => events.push(`kill:${pid}:${signal}`),
    });
    expect(result).toEqual({ sent: true, verdict: "same" });
    expect(events).toEqual(["read:123", "kill:123:SIGTERM"]);
  });

  test("does not trust an earlier successful generation check", () => {
    let current = "recorded";
    let signals = 0;
    const readToken = () => current;
    expect(verifyProcessGeneration(123, "recorded", readToken)).toBe("same");
    current = "replacement";
    expect(
      signalIfSameGeneration(123, "recorded", "SIGTERM", {
        readToken,
        kill: () => signals++,
      }),
    ).toEqual({ sent: false, verdict: "different" });
    expect(signals).toBe(0);
  });

  test("never signals a missing, unreadable, or different generation", () => {
    let signals = 0;
    const kill = () => signals++;
    expect(signalIfSameGeneration(123, undefined, "SIGTERM", { kill })).toEqual({
      sent: false,
      verdict: "unknown",
    });
    expect(
      signalIfSameGeneration(123, "recorded", "SIGTERM", { readToken: () => null, kill }),
    ).toEqual({
      sent: false,
      verdict: "unknown",
    });
    expect(
      signalIfSameGeneration(123, "recorded", "SIGTERM", {
        readToken: () => {
          throw new Error("probe failed");
        },
        kill,
      }),
    ).toEqual({ sent: false, verdict: "unknown" });
    expect(
      signalIfSameGeneration(123, "recorded", "SIGTERM", { readToken: () => "replacement", kill }),
    ).toEqual({ sent: false, verdict: "different" });
    expect(signals).toBe(0);
  });

  test("reports when a verified signal could not be sent", () => {
    expect(
      signalIfSameGeneration(123, "recorded", "SIGTERM", {
        readToken: () => "recorded",
        kill: () => {
          throw new Error("process exited");
        },
      }),
    ).toEqual({ sent: false, verdict: "same" });
  });
});
