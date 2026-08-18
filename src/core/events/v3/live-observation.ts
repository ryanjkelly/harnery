/**
 * Privacy-bounded coordination observations accepted by live V3 emitters.
 *
 * This is a dependency-free shared contract so downstream mirrors can type
 * their emit surfaces without importing the authority implementation.
 */
export type LiveCoordinationObservationV3 =
  | {
      event_type: "coord.status_observed";
      status: string;
      subject?: string;
    }
  | {
      event_type: "coord.presence_changed";
      prior_state?: string;
      new_state: string;
      reason: string;
    }
  | {
      event_type: "coord.message_observed";
      message_id?: string;
      direction: "sent" | "received";
      body: string;
      subject?: string;
    }
  | {
      event_type: "council.state_changed";
      council_id: string;
      prior_state?: string;
      new_state: string;
      record: unknown;
    }
  | {
      event_type: "decision.state_changed";
      decision_id: string;
      prior_state?: string;
      new_state: string;
      record: unknown;
    };

