import {
  closeSync,
  existsSync,
  fdatasyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export interface RotatingTextSinkOptions {
  path: string;
  max_bytes: number;
  backups?: number;
  durable?: boolean;
}

export class RotatingTextSink {
  readonly #options: Required<RotatingTextSinkOptions>;
  #closed = false;

  constructor(options: RotatingTextSinkOptions) {
    if (!Number.isSafeInteger(options.max_bytes) || options.max_bytes <= 0)
      throw new Error("invalid text log size limit");
    this.#options = {
      ...options,
      backups: options.backups ?? 3,
      durable: options.durable ?? false,
    };
  }

  append(text: string): void {
    if (this.#closed) throw new Error("text sink is closed");
    const bytes = Buffer.from(text, "utf8");
    mkdirSync(dirname(this.#options.path), { recursive: true, mode: 0o700 });
    const current = existsSync(this.#options.path) ? statSync(this.#options.path).size : 0;
    if (current > 0 && current + bytes.byteLength > this.#options.max_bytes) this.#rotate();
    const fd = openSync(this.#options.path, "a", 0o600);
    try {
      writeSync(fd, bytes);
      if (this.#options.durable) fdatasyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  flush(): void {}
  close(): void {
    this.#closed = true;
  }

  #rotate(): void {
    for (let index = this.#options.backups; index >= 1; index -= 1) {
      const from = index === 1 ? this.#options.path : `${this.#options.path}.${index - 1}`;
      const to = `${this.#options.path}.${index}`;
      if (existsSync(from)) renameSync(from, to);
    }
  }
}
