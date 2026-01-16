export type IsoDateTimeString = string;

export type HealthResponse = {
  ok: boolean;
};

export type AgentRevisionCreateRequest = {
  name: string;
  author: string | null;
  spec_json: Record<string, unknown>;
};

export type AgentRevisionResponse = {
  id: string;
  name: string;
  created_at: IsoDateTimeString;
  author: string | null;
  content_hash: string;
  spec_json: Record<string, unknown>;
};

export type RunCreateRequest = {
  agent_revision_id: string;
  inputs_json: Record<string, unknown>;
  tags_json: Record<string, unknown>;
  group_id: string | null;
};

export type RunResponse = {
  id: string;
  agent_revision_id: string;
  started_at: IsoDateTimeString;
  ended_at: IsoDateTimeString | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | (string & {});
  inputs_json: Record<string, unknown>;
  final_output: string | null;
  tags_json: Record<string, unknown>;
  trace_id: string | null;
  group_id: string | null;
  error: string | null;
  cancel_requested: boolean;
};

export type RunEventResponse = {
  id: string;
  run_id: string;
  created_at: IsoDateTimeString;
  seq: number;
  type: string;
  payload_json: Record<string, unknown>;
};

