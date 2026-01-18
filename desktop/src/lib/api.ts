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

    async createRun(req: RunCreateRequest): Promise<RunResponse> {
      return fetchJson(joinUrl(cfg.baseUrl, "/v1/runs"), { method: "POST", body: JSON.stringify(req) });
    },

    async getRun(runId: string): Promise<RunResponse> {
      return fetchJson(joinUrl(cfg.baseUrl, `/v1/runs/${encodeURIComponent(runId)}`));
    },

    async listRuns(revisionId: string | null, limit = 100, offset = 0): Promise<RunResponse[]> {
      const params = new URLSearchParams();
      if (revisionId) params.set("revision_id", revisionId);
      params.set("limit", String(limit));
      params.set("offset", String(offset));
      const suffix = params.toString();
      const url = suffix ? `/v1/runs?${suffix}` : "/v1/runs";
      return fetchJson(joinUrl(cfg.baseUrl, url));
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

    async validateSpec(req: SpecValidateRequest): Promise<SpecValidateResponse> {
      return fetchJson(joinUrl(cfg.baseUrl, "/v1/spec/validate"), { method: "POST", body: JSON.stringify(req) });
    },

    async compileSpec(req: SpecValidateRequest): Promise<SpecCompileResponse> {
      return fetchJson(joinUrl(cfg.baseUrl, "/v1/spec/compile"), { method: "POST", body: JSON.stringify(req) });
    },
  };
}

