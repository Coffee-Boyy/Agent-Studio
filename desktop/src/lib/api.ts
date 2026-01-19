import type {
  AgentRevisionCreateRequest,
  AgentRevisionResponse,
  HealthResponse,
  RunCreateRequest,
  RunEventResponse,
  RunResponse,
  SpecCompileResponse,
  SpecValidateRequest,
  SpecValidateResponse,
  WorkflowCreateRequest,
  WorkflowRevisionCreateRequest,
  WorkflowRevisionResponse,
  WorkflowUpdateRequest,
  WorkflowWithLatestRevisionResponse,
} from "./types";

export type BackendConfig = { baseUrl: string };

export class ApiError extends Error {
  status: number;
  bodyText: string;
  constructor(message: string, status: number, bodyText: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

function joinUrl(baseUrl: string, path: string): string {
  const b = baseUrl.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(`HTTP ${res.status} from ${url}`, res.status, text);
  }
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

export function api(cfg: BackendConfig) {
  return {
    async health(): Promise<HealthResponse> {
      return fetchJson(joinUrl(cfg.baseUrl, "/v1/health"));
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Workflow endpoints
    // ─────────────────────────────────────────────────────────────────────────

    async createWorkflow(req: WorkflowCreateRequest): Promise<WorkflowWithLatestRevisionResponse> {
      return fetchJson(joinUrl(cfg.baseUrl, "/v1/workflows"), { method: "POST", body: JSON.stringify(req) });
    },

    async listWorkflows(limit = 100, offset = 0): Promise<WorkflowWithLatestRevisionResponse[]> {
      const url = joinUrl(cfg.baseUrl, `/v1/workflows?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`);
      return fetchJson(url);
    },

    async getWorkflow(workflowId: string): Promise<WorkflowWithLatestRevisionResponse> {
      return fetchJson(joinUrl(cfg.baseUrl, `/v1/workflows/${encodeURIComponent(workflowId)}`));
    },

    async updateWorkflow(workflowId: string, req: WorkflowUpdateRequest): Promise<WorkflowWithLatestRevisionResponse> {
      return fetchJson(joinUrl(cfg.baseUrl, `/v1/workflows/${encodeURIComponent(workflowId)}`), {
        method: "PUT",
        body: JSON.stringify(req),
      });
    },

    async deleteWorkflow(workflowId: string): Promise<{ deleted: boolean }> {
      return fetchJson(joinUrl(cfg.baseUrl, `/v1/workflows/${encodeURIComponent(workflowId)}`), { method: "DELETE" });
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Workflow revision endpoints
    // ─────────────────────────────────────────────────────────────────────────

    async createWorkflowRevision(workflowId: string, req: WorkflowRevisionCreateRequest): Promise<WorkflowRevisionResponse> {
      return fetchJson(joinUrl(cfg.baseUrl, `/v1/workflows/${encodeURIComponent(workflowId)}/revisions`), {
        method: "POST",
        body: JSON.stringify(req),
      });
    },

    async listWorkflowRevisions(workflowId: string, limit = 100, offset = 0): Promise<WorkflowRevisionResponse[]> {
      const url = joinUrl(
        cfg.baseUrl,
        `/v1/workflows/${encodeURIComponent(workflowId)}/revisions?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`,
      );
      return fetchJson(url);
    },

    async getWorkflowRevision(revisionId: string): Promise<WorkflowRevisionResponse> {
      return fetchJson(joinUrl(cfg.baseUrl, `/v1/workflow-revisions/${encodeURIComponent(revisionId)}`));
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Legacy agent revision endpoints (kept for backward compatibility)
    // ─────────────────────────────────────────────────────────────────────────

    async createAgentRevision(req: AgentRevisionCreateRequest): Promise<AgentRevisionResponse> {
      return fetchJson(joinUrl(cfg.baseUrl, "/v1/agent-revisions"), { method: "POST", body: JSON.stringify(req) });
    },

    async listAgentRevisions(limit = 100, offset = 0): Promise<AgentRevisionResponse[]> {
      const url = joinUrl(cfg.baseUrl, `/v1/agent-revisions?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`);
      return fetchJson(url);
    },

    async getAgentRevision(revisionId: string): Promise<AgentRevisionResponse> {
      return fetchJson(joinUrl(cfg.baseUrl, `/v1/agent-revisions/${encodeURIComponent(revisionId)}`));
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Run endpoints
    // ─────────────────────────────────────────────────────────────────────────

    async createRun(req: RunCreateRequest): Promise<RunResponse> {
      return fetchJson(joinUrl(cfg.baseUrl, "/v1/runs"), { method: "POST", body: JSON.stringify(req) });
    },

    async getRun(runId: string): Promise<RunResponse> {
      return fetchJson(joinUrl(cfg.baseUrl, `/v1/runs/${encodeURIComponent(runId)}`));
    },

    async listRuns(limit = 100, offset = 0, opts?: { revisionId?: string; workflowId?: string }): Promise<RunResponse[]> {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      params.set("offset", String(offset));
      if (opts?.revisionId) {
        params.set("revision_id", opts.revisionId);
      }
      if (opts?.workflowId) {
        params.set("workflow_id", opts.workflowId);
      }
      return fetchJson(joinUrl(cfg.baseUrl, `/v1/runs?${params.toString()}`));
    },

    async cancelRun(runId: string): Promise<{ ok: boolean }> {
      return fetchJson(joinUrl(cfg.baseUrl, `/v1/runs/${encodeURIComponent(runId)}/cancel`), { method: "POST", body: "{}" });
    },

    async listRunEvents(runId: string, limit = 500, offset = 0): Promise<RunEventResponse[]> {
      const url = joinUrl(
        cfg.baseUrl,
        `/v1/runs/${encodeURIComponent(runId)}/events?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`,
      );
      return fetchJson(url);
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Spec endpoints
    // ─────────────────────────────────────────────────────────────────────────

    async validateSpec(req: SpecValidateRequest): Promise<SpecValidateResponse> {
      return fetchJson(joinUrl(cfg.baseUrl, "/v1/spec/validate"), { method: "POST", body: JSON.stringify(req) });
    },

    async compileSpec(req: SpecValidateRequest): Promise<SpecCompileResponse> {
      return fetchJson(joinUrl(cfg.baseUrl, "/v1/spec/compile"), { method: "POST", body: JSON.stringify(req) });
    },
  };
}

