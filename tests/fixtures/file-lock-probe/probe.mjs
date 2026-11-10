// Race probe: several processes take and release one exclusive lock path in a
// tight loop and record every create outcome (success or error code).
//
// Usage: bun file-lock-probe.mjs [--workers 6] [--attempts 200000] [--min-acquire 1500] [--modes a,b] [--dir <tmp>]
// Each worker runs until it has made its share of attempts AND completed --min-acquire
// take/release cycles, so every mode sees many release-versus-create races.
// Modes mirror the real lock sites:
//   mkdir    mkdirSync(lock)              / rmdirSync(lock)            (control: folder locks)
//   openwx   openSync(lock,"wx")+write    / unlinkSync(lock)           (cookie store lock)
//   writewx  writeFileSync(lock,t,{wx})   / readFileSync+unlinkSync    (identity assume lock)
//   link     linkSync(owner,current)      / unlinkSync(current)+unlinkSync(owner) (run lease)
import { spawn } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ALL_MODES = ["mkdir", "openwx", "writewx", "link"];
const KNOWN = ["EEXIST", "EPERM", "EACCES", "EBUSY", "ENOENT"];

function busy(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) {}
}

function bump(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

function codeOf(error) {
  return error?.code ?? `noncode:${String(error?.message ?? error).slice(0, 60)}`;
}

function worker(mode, dir, attempts, id, minAcquire) {
  const create = {};
  const release = {};
  const ownerCreate = {};
  const lock = join(dir, "lock");
  let owner;
  let seq = 0;
  let acquired = 0;
  const token = `${process.pid}:${id}`;
  const newOwner = () => {
    const path = join(dir, `owner-${id}-${seq++}`);
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, token, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      return path;
    } catch (error) {
      bump(ownerCreate, codeOf(error));
      return undefined;
    }
  };
  for (let i = 0; i < attempts || acquired < minAcquire; i++) {
    let ok = false;
    try {
      if (mode === "mkdir") mkdirSync(lock);
      else if (mode === "openwx") {
        const fd = openSync(lock, "wx", 0o600);
        try {
          writeFileSync(fd, token);
        } finally {
          closeSync(fd);
        }
      } else if (mode === "writewx") writeFileSync(lock, token, { encoding: "utf8", flag: "wx" });
      else if (mode === "link") {
        owner ??= newOwner();
        if (!owner) continue;
        linkSync(owner, lock);
      }
      ok = true;
    } catch (error) {
      bump(create, codeOf(error));
    }
    if (!ok) continue;
    bump(create, "success");
    acquired++;
    busy(Math.random() * 2);
    try {
      if (mode === "mkdir") rmdirSync(lock);
      else if (mode === "openwx") unlinkSync(lock);
      else if (mode === "writewx") {
        if (readFileSync(lock, "utf8") === token) unlinkSync(lock);
        else bump(release, "token-mismatch");
      } else if (mode === "link") {
        unlinkSync(lock);
        unlinkSync(owner);
        owner = undefined;
      }
      bump(release, "ok");
    } catch (error) {
      bump(release, codeOf(error));
    }
  }
  if (owner) {
    try {
      unlinkSync(owner);
    } catch {}
  }
  process.stdout.write(`${JSON.stringify({ create, release, ownerCreate, acquired })}\n`);
}

function argValue(name, fallback) {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
}

function runWorker(mode, dir, attempts, id, minAcquire) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [process.argv[1], "__worker", mode, dir, String(attempts), String(id), String(minAcquire)],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`worker ${id} exited ${code}`));
      resolve(JSON.parse(out.trim()));
    });
  });
}

function merge(target, source) {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
}

async function main() {
  const workers = Number(argValue("--workers", "6"));
  const attempts = Number(argValue("--attempts", "200000"));
  const modes = argValue("--modes", ALL_MODES.join(",")).split(",");
  const base = argValue("--dir", tmpdir());
  const perWorker = Math.ceil(attempts / workers);
  const minAcquire = Number(argValue("--min-acquire", "1500"));
  console.log(
    `PROBE platform=${process.platform} arch=${process.arch} bun=${process.versions.bun ?? "none"} node=${process.versions.node} workers=${workers} minAcquirePerWorker=${minAcquire} attemptsPerMode>=${perWorker * workers} base=${base}`,
  );
  const results = {};
  for (const mode of modes) {
    const dir = mkdtempSync(join(base, `flprobe-${mode}-`));
    const started = Date.now();
    const parts = await Promise.all(
      Array.from({ length: workers }, (_, id) => runWorker(mode, dir, perWorker, id, minAcquire)),
    );
    const create = {};
    const release = {};
    const ownerCreate = {};
    for (const part of parts) {
      merge(create, part.create);
      merge(release, part.release);
      merge(ownerCreate, part.ownerCreate);
    }
    const histogram = { success: create.success ?? 0 };
    for (const code of KNOWN) histogram[code] = create[code] ?? 0;
    const other = {};
    for (const [key, value] of Object.entries(create)) {
      if (key !== "success" && !KNOWN.includes(key)) other[key] = value;
    }
    histogram.other = other;
    histogram.total = Object.values(create).reduce((sum, value) => sum + value, 0);
    results[mode] = { create: histogram, release, ownerCreate, ms: Date.now() - started };
    console.log(`PROBE_RESULT ${mode} ${JSON.stringify(results[mode])}`);
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`PROBE_ALL ${JSON.stringify(results)}`);
}

if (process.argv[2] === "__worker") {
  worker(
    process.argv[3],
    process.argv[4],
    Number(process.argv[5]),
    Number(process.argv[6]),
    Number(process.argv[7]),
  );
} else {
  await main();
}
