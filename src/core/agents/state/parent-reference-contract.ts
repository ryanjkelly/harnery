export type AgentParentReference =
  | {
      state: "verified";
      relationship: "delegated-child" | "native-child";
      parent_instance_id: string;
      parent_v3_instance_id: string;
      parent_generation_id: string | null;
      parent_session_id: string | null;
      parent_name: string | null;
      source: "v3-session-link" | "native-session-metadata";
      source_witness?: string;
      addressable: boolean;
    }
  | { state: "none" | "unknown" | "conflict"; reason: string };
