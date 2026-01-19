import "./App.css";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  HealthResponse,
  WorkflowWithLatestRevisionResponse,
} from "./lib/types";
import { api, type BackendConfig } from "./lib/api";
import { loadSettings, saveSettings } from "./lib/storage";
import { formatRelativeTime, uniq } from "./lib/utils";
import { AgentEditorPage } from "./pages/AgentEditorPage";
import { SettingsPage } from "./pages/SettingsPage";
import { NavItem } from "./components/NavItem";
import { AgentRunnerPage } from "./pages/AgentRunnerPage";
import { DashboardPage } from "./pages/DashboardPage";

type Route = "editor" | "runner" | "dashboard" | "settings";

function App() {
  const [route, setRoute] = useState<Route>("dashboard");
  const [settings, setSettings] = useState(() => loadSettings());
  const backend: BackendConfig = useMemo(() => ({ baseUrl: settings.backendBaseUrl }), [settings.backendBaseUrl]);

  // Shared “recent runs” list (frontend-side, since backend MVP doesn’t have list-runs yet).
  const [recentRunIds, setRecentRunIds] = useState<string[]>(() => settings.recentRunIds);
  const [editorWorkflows, setEditorWorkflows] = useState<WorkflowWithLatestRevisionResponse[]>([]);
  const [editorSelectedWorkflowId, setEditorSelectedWorkflowId] = useState("");
  useEffect(() => {
    const next = { ...settings, recentRunIds };
    setSettings(next);
    saveSettings(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentRunIds]);

  const refreshEditorWorkflows = useCallback(async () => {
    const list = await api(backend).listWorkflows();
    setEditorWorkflows(list);
    return list;
  }, [backend]);

  // Global health status
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;

    async function checkHealthOnce() {
      try {
        const h = await api(backend).health();
        if (cancelled) return;
        setHealth(h);
        setHealthErr(null);
      } catch (e) {
        if (cancelled) return;
        setHealth(null);
        setHealthErr(e instanceof Error ? e.message : String(e));

        // Backend may still be booting (desktop app starts UI + backend together).
        // Keep retrying while we're in an error state.
        retryTimer = window.setTimeout(checkHealthOnce, 1000);
      }
    }

    // Give the backend a moment to boot before the first probe.
    retryTimer = window.setTimeout(checkHealthOnce, 1000);

    return () => {
      cancelled = true;
      if (retryTimer != null) window.clearTimeout(retryTimer);
    };
  }, [backend.baseUrl]);

  // Show loading screen while waiting for backend
  if (!health) {
    return (
      <div className="asApp">
        <div className="asLoadingScreen">
          <div className="asLoadingContent">
            <div className="asBrandTitle">LLM Agent Studio</div>
            <div className="asLoadingSpinner" />
            {healthErr ? (
              <div className="asLoadingError">{healthErr}</div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="asApp">
      <aside className="asSidebar">
        <div className="asBrand">
          <div className="asBrandTitle">LLM Agent Studio</div>
          <div className="asBrandSub">Create and manage your LLM agents</div>
        </div>

        <nav className="asNav">
          <NavItem active={route === "dashboard"} onClick={() => setRoute("dashboard")} label="Dashboard" />
          <NavItem active={route === "runner"} onClick={() => setRoute("runner")} label="Agent runner" />
          <NavItem active={route === "editor"} onClick={() => setRoute("editor")} label="Workflow editor" />
          <NavItem active={route === "settings"} onClick={() => setRoute("settings")} label="Settings" />
        </nav>

        {route === "editor" ? (
          <div className="asSidebarSection">
            <div className="asSidebarSectionTitle">Workflows</div>
            {editorWorkflows.length > 0 ? (
              <div className="asWorkflowList">
                {editorWorkflows.map((workflow) => (
                  <button
                    key={workflow.id}
                    className={`asWorkflowItem${editorSelectedWorkflowId === workflow.id ? " active" : ""}`}
                    onClick={() => setEditorSelectedWorkflowId(workflow.id)}
                  >
                    <div className="asWorkflowName">{workflow.name}</div>
                    <div className="asWorkflowMeta">
                      {formatRelativeTime(workflow.updated_at)}
                      <button
                        className="asWorkflowDelete"
                        type="button"
                        aria-label={`Delete ${workflow.name}`}
                        onClick={async (event) => {
                          event.stopPropagation();
                          if (!window.confirm(`Delete workflow "${workflow.name}" and all revisions?`)) return;
                          await api(backend).deleteWorkflow(workflow.id);
                          const updated = await refreshEditorWorkflows();
                          if (editorSelectedWorkflowId === workflow.id) {
                            const nextWorkflows = updated.filter((it) => it.id !== workflow.id);
                            setEditorSelectedWorkflowId(nextWorkflows[0]?.id ?? "");
                          }
                        }}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                          <path
                            d="M9 3h6l1 2h4v2H4V5h4l1-2zm2 7h2v7h-2v-7zm-4 0h2v7H7v-7zm8 0h2v7h-2v-7z"
                            fill="currentColor"
                          />
                          <path
                            d="M6 7h12l-1 13H7L6 7z"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="asMuted asSmall">No saved workflows yet.</div>
            )}
          </div>
        ) : null}

        <div className="asSidebarFooter">
          <div className="asPill">
            <span className="asPillLabel">Backend</span>
            <span className="asPillValue">{backend.baseUrl}</span>
          </div>
          <div className="asPill">
            <span className="asPillLabel">Health</span>
            <span className={`asPillValue ${health?.ok ? "ok" : "bad"}`}>{health?.ok ? "ok" : "down"}</span>
          </div>
        </div>
      </aside>

      <main className="asMain">
        {route === "editor" ? (
          <AgentEditorPage
            backend={backend}
            settings={settings}
            onStartRun={(runId) => setRecentRunIds((s) => uniq([runId, ...s]).slice(0, 50))}
            selectedWorkflowId={editorSelectedWorkflowId}
            onSelectWorkflow={setEditorSelectedWorkflowId}
            onWorkflowsChange={setEditorWorkflows}
          />
        ) : null}
        {route === "runner" ? (
          <AgentRunnerPage
            backend={backend}
            settings={settings}
            onStartRun={(runId) => setRecentRunIds((s) => uniq([runId, ...s]).slice(0, 50))}
          />
        ) : null}
        {route === "dashboard" ? <DashboardPage backend={backend} recentRunIds={recentRunIds} /> : null}
        {route === "settings" ? <SettingsPage settings={settings} setSettings={setSettings} /> : null}
      </main>
    </div>
  );
}

export default App;
