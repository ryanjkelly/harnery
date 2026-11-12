/**
 * The current thread's id, for lease ownership. This module only reads
 * `threadId`: it starts, messages, or controls no thread, which lets read-only
 * graphs reach lease code without reaching thread control (the Codec
 * dependency boundary checks that this file imports nothing else).
 */
import { threadId } from "node:worker_threads";

export const currentThreadId: number = threadId;
