export { generateBash, generateBashDynamic } from "./bash.js";
export { generateFish, generateFishDynamic } from "./fish.js";
export {
  type Candidate,
  type CompletionProviderRunner,
  type CompletionResult,
  DIRECTIVE_PREFIX,
  Directive,
  encodeResult,
  resolveCompletions,
} from "./resolve.js";
export {
  type CommandSpec,
  type CompletionContextLookup,
  type OptionSpec,
  type PositionalSpec,
  walkProgram,
} from "./walk.js";
export { generateZsh, generateZshDynamic } from "./zsh.js";
