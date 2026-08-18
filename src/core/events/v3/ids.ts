import { v7 as uuidv7 } from "uuid";

export function eventIdV3(): `evt_${string}` {
  return `evt_${uuidv7()}`;
}

export function generationIdV3(): `gen_${string}` {
  return `gen_${uuidv7()}`;
}

export function spanIdV3(): `span_${string}` {
  return `span_${uuidv7()}`;
}

export function delegationIdV3(): `del_${string}` {
  return `del_${uuidv7()}`;
}

export function attestationIdV3(): `att_${string}` {
  return `att_${uuidv7()}`;
}

export function clockIdV3(): `clk_${string}` {
  return `clk_${uuidv7()}`;
}

export function genesisIdV3(): `gex_${string}` {
  return `gex_${uuidv7()}`;
}

export function activationIdV3(): `act_${string}` {
  return `act_${uuidv7()}`;
}
