/// <reference types="vite/client" />

interface Window {
  agentStudio?: {
    selectFolder: () => Promise<string | null>;
  };
}
