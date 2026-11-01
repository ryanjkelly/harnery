import { gzipSync } from "node:zlib";

/** Minimal ustar `.tar.gz` builder for computer-driver archive fixtures. */
export interface TarSpec {
  name: string;
  body?: string;
  type?: "0" | "5" | "2";
  mode?: number;
}

export function buildTarGz(specs: TarSpec[]): Uint8Array<ArrayBuffer> {
  const blocks: Buffer[] = [];
  for (const spec of specs) {
    const body = Buffer.from(spec.body ?? "");
    const header = Buffer.alloc(512);
    header.write(spec.name, 0, 100, "utf8");
    header.write(`${(spec.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write(spec.type ?? "0", 156);
    if (spec.type === "2") header.write("../escape", 157);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(blocks)));
}
