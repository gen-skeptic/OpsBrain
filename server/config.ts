// OpsBrain configuration, read once from environment variables.

function env(name: string, fallback?: string): string {
  const v = Deno.env.get(name);
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

function bool(name: string, fallback: boolean): boolean {
  const v = Deno.env.get(name);
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export type EmbeddingProvider = "openai" | "none" | "fake";

export const config = {
  get databaseUrl() { return env("DATABASE_URL"); },
  get host() { return env("OPSBRAIN_HOST", "0.0.0.0"); },
  get port() { return Number(env("OPSBRAIN_PORT", "8787")); },
  get publicUrl() { return env("OPSBRAIN_PUBLIC_URL", "http://localhost:8787").replace(/\/$/, ""); },
  get allowQueryKey() { return bool("OPSBRAIN_ALLOW_QUERY_KEY", true); },
  get maxRecordChars() { return Number(env("OPSBRAIN_MAX_RECORD_CHARS", "50000")); },

  // Embeddings: any OpenAI-compatible endpoint (Ollama, vLLM, LiteLLM, OpenRouter, OpenAI).
  get embeddingProvider() { return env("EMBEDDING_PROVIDER", "openai") as EmbeddingProvider; },
  get embeddingApiBase() { return env("EMBEDDING_API_BASE", "http://ollama:11434/v1").replace(/\/$/, ""); },
  get embeddingApiKey() { return env("EMBEDDING_API_KEY", ""); },
  get embeddingModel() { return env("EMBEDDING_MODEL", "nomic-embed-text"); },
  get embeddingDim() { return Number(env("EMBEDDING_DIM", "768")); },

  // Optional automatic tags for free-form notes (off by default: structured records don't need it).
  get metadataExtraction() { return bool("METADATA_EXTRACTION", false); },
  get llmApiBase() { return env("LLM_API_BASE", "http://ollama:11434/v1").replace(/\/$/, ""); },
  get llmApiKey() { return env("LLM_API_KEY", ""); },
  get llmModel() { return env("LLM_MODEL", "llama3.1:8b"); },

  // Web UI (CRM and approvals) for people. Agents use MCP.
  get uiEnabled() { return bool("OPSBRAIN_UI_ENABLED", true); },
  /** key: sign in with your OpsBrain key; header: SSO through a trusted reverse proxy; both. */
  get uiAuth() { return env("OPSBRAIN_UI_AUTH", "key") as "key" | "header" | "both"; },
  get uiUserHeader() { return env("OPSBRAIN_UI_USER_HEADER", "X-authentik-username"); },
  /** Required for header sign-in: the proxy must send it in X-OpsBrain-Proxy-Secret. */
  get uiProxySecret() { return env("OPSBRAIN_UI_PROXY_SECRET", ""); },
  get uiSessionHours() { return Number(env("OPSBRAIN_UI_SESSION_HOURS", "12")); },
  get uiTheme() { return env("OPSBRAIN_UI_THEME", "dautel"); },
  get uiTitle() { return env("OPSBRAIN_UI_TITLE", "OpsBrain"); },
};
