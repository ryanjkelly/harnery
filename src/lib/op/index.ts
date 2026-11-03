/** 1Password CLI toolkit for embedding hosts. See ./types.ts for the host contract. */

export * from "./client.ts";
export * from "./command.ts";
export {
  detectOp,
  isWindowsOp,
  isWslKernel,
  isWslRuntime,
  locateWindowsOpFromWsl,
  type OpDetectionRuntime,
  opEnvironment,
  windowsLocalAppData,
  windowsPathToWsl,
  wslPathToWindows,
} from "./detect.ts";
export * from "./local-credentials.ts";
export type * from "./types.ts";
