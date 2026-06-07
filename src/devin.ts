import { config } from "./config.js";

export type DevinSession = {
  session_id?: string;
  devin_id?: string;
  id?: string;
  url?: string;
  status?: string;
  state?: string;
  pull_requests?: unknown;
  [key: string]: unknown;
};

const DEVIN_API_BASE = "https://api.devin.ai/v3";

function sessionsUrl(): string {
  return `${DEVIN_API_BASE}/organizations/${config.DEVIN_ORG_ID}/sessions`;
}

export async function createDevinSession(prompt: string): Promise<DevinSession> {
  const body: Record<string, unknown> = { prompt };

  if (config.DEVIN_CREATE_AS_USER_ID) {
    body.create_as_user_id = config.DEVIN_CREATE_AS_USER_ID;
  }

  const response = await fetch(sessionsUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.DEVIN_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to create Devin session (HTTP ${response.status} ${response.statusText}): ${text}`,
    );
  }

  return (await response.json()) as DevinSession;
}

export async function getDevinSession(devinId: string): Promise<DevinSession> {
  const response = await fetch(`${sessionsUrl()}/${devinId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.DEVIN_API_KEY}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to fetch Devin session ${devinId} (HTTP ${response.status} ${response.statusText}): ${text}`,
    );
  }

  return (await response.json()) as DevinSession;
}
