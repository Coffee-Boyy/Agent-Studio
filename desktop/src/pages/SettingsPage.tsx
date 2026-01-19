import { useState } from "react";
import { AppSettings, saveSettings } from "../lib/storage";
import { LLM_PROVIDERS, LLM_PROVIDER_DEFS, LLM_PROVIDER_LABELS } from "../lib/llm";
import { Card } from "../components/Card";
import { Field } from "../components/Field";
import { Button } from "../components/Button";

export function SettingsPage(props: { settings: AppSettings; setSettings: (s: AppSettings) => void }) {
  const [baseUrl, setBaseUrl] = useState(props.settings.backendBaseUrl);
  const [llmProvider, setLlmProvider] = useState<AppSettings["llmProvider"]>(props.settings.llmProvider);
  const [connections, setConnections] = useState(props.settings.llmConnections);
  const [msg, setMsg] = useState<string | null>(null);

  function save() {
    const nextConnections = { ...connections };
    for (const provider of LLM_PROVIDERS) {
      const def = LLM_PROVIDER_DEFS[provider];
      const cfg = { ...nextConnections[provider] };
      for (const field of def.fields) {
        const value = cfg[field.key];
        if (typeof value === "string") {
          cfg[field.key] = value.trim();
        }
      }
      nextConnections[provider] = cfg;
    }
    const next = {
      ...props.settings,
      backendBaseUrl: baseUrl.trim() || "http://127.0.0.1:37123",
      llmProvider,
      llmConnections: nextConnections,
    };
    props.setSettings(next);
    saveSettings(next);
    setMsg("Saved.");
    setTimeout(() => setMsg(null), 1200);
  }

  return (
    <div className="asStack">
      <Card title="Settings">
        <Field label="Backend base URL" hint="Default backend port is 37123 (see backend/README.md).">
          <input className="asInput" value={baseUrl} onChange={(e) => setBaseUrl(e.currentTarget.value)} />
        </Field>
        <div className="asSectionTitle">LLM connections</div>
        <Field label="Provider">
          <select className="asSelect" value={llmProvider} onChange={(e) => setLlmProvider(e.currentTarget.value as AppSettings["llmProvider"])}>
            {LLM_PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {LLM_PROVIDER_LABELS[provider]}
              </option>
            ))}
          </select>
        </Field>
        {LLM_PROVIDER_DEFS[llmProvider].fields.map((field) => (
          <Field key={`${llmProvider}-${field.key}`} label={field.label}>
            <input
              className="asInput"
              type={field.inputType ?? "text"}
              placeholder={field.placeholder}
              value={connections[llmProvider]?.[field.key] ?? ""}
              onChange={(e) =>
                setConnections((prev) => ({
                  ...prev,
                  [llmProvider]: {
                    ...prev[llmProvider],
                    [field.key]: e.currentTarget.value,
                  },
                }))
              }
            />
          </Field>
        ))}
        <div className="asSmall asMuted">
          Credentials are stored locally in this browser profile.
        </div>
        <div className="asRow">
          <Button tone="primary" onClick={save}>
            Save
          </Button>
          {msg ? <div className="asSmall asMuted">{msg}</div> : null}
        </div>
      </Card>
    </div>
  );
}