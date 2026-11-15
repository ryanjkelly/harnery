/**
 * Which end-of-turn status style this machine prints (ADR 0259).
 *
 * `agents.statusStyle` is `"box"` (default) or `"plain"`. It may live in the
 * user file, the project file, or the machine-local
 * `.harnery/config.local.jsonc`, later layers winning, so one person's
 * computer can differ from the project. `HARNERY_STATUS_STYLE` overrides per
 * process. An unrecognized value falls back to `"box"`.
 */

export {
  parseStatusStyle,
  resolveStatusStyle,
  STATUS_STYLES,
  type StatusStyle,
} from "../config.ts";
