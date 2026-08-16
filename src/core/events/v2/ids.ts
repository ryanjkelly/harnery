import { v7 as uuidv7 } from "uuid";

export function eventIdV2(): `evt_${string}` {
  return `evt_${uuidv7()}`;
}

export function generationIdV2(): `gen_${string}` {
  return `gen_${uuidv7()}`;
}

export function spanIdV2(): `span_${string}` {
  return `span_${uuidv7()}`;
}

export function delegationIdV2(): `del_${string}` {
  return `del_${uuidv7()}`;
}

export function attestationIdV2(): `att_${string}` {
  return `att_${uuidv7()}`;
}

export function clockIdV2(): `clk_${string}` {
  return `clk_${uuidv7()}`;
}
