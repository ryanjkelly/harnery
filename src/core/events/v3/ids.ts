import {
  activationIdV2,
  attestationIdV2,
  clockIdV2,
  delegationIdV2,
  eventIdV2,
  generationIdV2,
  genesisIdV2,
  spanIdV2,
} from "../v2/ids.ts";

/** V3 preserves V2's sortable UUIDv7 identity formats across the cutover. */
export const eventIdV3 = eventIdV2;
export const generationIdV3 = generationIdV2;
export const spanIdV3 = spanIdV2;
export const delegationIdV3 = delegationIdV2;
export const attestationIdV3 = attestationIdV2;
export const clockIdV3 = clockIdV2;
export const genesisIdV3 = genesisIdV2;
export const activationIdV3 = activationIdV2;
