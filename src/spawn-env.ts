const BLOCKED_CODEX_AUTH_ENV_KEYS = new Set<string>([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "MINIMAX_API_KEY",
  "MISTRAL_API_KEY",
  "OLLAMA_API_KEY",
  "OPENAI_API_BASE",
  "OPENAI_API_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_API_KEYS",
  "OPENAI_BASE_URL",
  "OPENAI_OAUTH_TOKEN",
  "OPENAI_ORG_ID",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "OPENROUTER_API_KEY",
]);

const BLOCKED_CODEX_AUTH_ENV_PREFIXES = [
  "ANTHROPIC_API_KEY_",
  "GEMINI_API_KEY_",
  "GOOGLE_API_KEY_",
  "MINIMAX_API_KEY_",
  "MISTRAL_API_KEY_",
  "OLLAMA_API_KEY_",
  "OPENAI_API_KEY_",
  "OPENROUTER_API_KEY_",
] as const;

function isBlockedCodexAuthEnvKey(key: string): boolean {
  const upper = key.trim().toUpperCase();
  if (!upper) {
    return false;
  }
  if (BLOCKED_CODEX_AUTH_ENV_KEYS.has(upper)) {
    return true;
  }
  return BLOCKED_CODEX_AUTH_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export function buildCodexSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  options?: { inheritHostAuthEnv?: boolean },
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== "string") {
      continue;
    }
    next[key] = value;
  }
  if (options?.inheritHostAuthEnv) {
    return next;
  }
  for (const key of Object.keys(next)) {
    if (isBlockedCodexAuthEnvKey(key)) {
      delete next[key];
    }
  }
  return next;
}
