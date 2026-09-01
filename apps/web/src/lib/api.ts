import { cookies } from "next/headers";

const API_URL = process.env["API_URL"] ?? "http://localhost:8082";

export const SESSION_COOKIE = "belegbox_session";

export interface DocumentSummary {
  id: string;
  supplier: string | null;
  invoiceNumber: string | null;
  issuedAt: string | null;
  dueAt: string | null;
  totalGross: number | null;
  format: string | null;
  status: DocumentStatus;
  verdict: { form: Verdict; content: Verdict };
  findingCount: number;
  receivedAt: string;
}

export type DocumentStatus =
  | "clean"
  | "form_error"
  | "content_error"
  | "not_einvoice"
  | "pending";
export type Verdict = "pass" | "fail" | "n_a" | "unknown";

export interface Explanation {
  locale: string;
  observation: string;
  legalBasis: string;
  nextStep: string | null;
  disclaimer: string;
  fallback: boolean;
  approved: boolean;
  german: {
    observation: string;
    legalBasis: string;
    nextStep: string | null;
    disclaimer: string;
  };
}

export interface Finding {
  id: string;
  layer: string;
  code: string;
  severity: string;
  btRef: string | null;
  legalBasis: string | null;
  messageRaw: string;
  params: Record<string, string | number>;
  explanation: Explanation | null;
  versions: { validatorConfig: string; engine: string; ruleset: number | null };
}

export interface DocumentDetail {
  id: string;
  status: DocumentStatus;
  verdict: { form: Verdict; content: Verdict };
  format: string | null;
  profileUrn: string | null;
  receivedAt: string;
  archivedAt: string | null;
  findings: Finding[];
}

export interface Tenant {
  id: string;
  name: string;
  locale: string;
  industry: string | null;
  inboxAddress: string | null;
}

export async function currentSession(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/**
 * Calls /v1 with the caller's session cookie.
 *
 * The cookie is an opaque session token that the API resolves to a tenant. The
 * browser never sees a tenant id and editing the cookie yields nothing: an
 * unknown token is simply not a session.
 */
async function call<T>(path: string): Promise<T | undefined> {
  const token = await currentSession();
  if (!token) return undefined;

  const response = await fetch(`${API_URL}${path}`, {
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    cache: "no-store",
  });
  if (response.status === 404 || response.status === 401) return undefined;
  if (!response.ok) throw new Error(`${path} responded ${response.status}`);
  return (await response.json()) as T;
}

export interface LoginResult {
  ok: boolean;
  error?: string;
  setCookie?: string;
}

/**
 * Signs in against /v1 and passes the API's own Set-Cookie back to the browser.
 *
 * The session is minted by the API, not here: the web app has no database
 * credentials and no way to create one, which is what keeps it an ordinary
 * client of its own public API.
 */
export async function login(body: {
  email: string;
  password: string;
  totpCode?: string;
}): Promise<LoginResult> {
  const response = await fetch(`${API_URL}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: detail.error ?? "invalid_credentials" };
  }

  const setCookie = response.headers.get("set-cookie");
  return { ok: true, ...(setCookie ? { setCookie } : {}) };
}

export async function logout(): Promise<void> {
  const token = await currentSession();
  if (!token) return;
  await fetch(`${API_URL}/v1/auth/logout`, {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    cache: "no-store",
  }).catch(() => undefined);
}

export function getTenant(): Promise<Tenant | undefined> {
  return call<Tenant>("/v1/tenant");
}

export function getInbox(params: {
  status?: string;
  q?: string;
}): Promise<{ documents: DocumentSummary[]; counts: Record<string, number> } | undefined> {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.q) query.set("q", params.q);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return call(`/v1/documents${suffix}`);
}

export function getDocument(id: string): Promise<DocumentDetail | undefined> {
  return call<DocumentDetail>(`/v1/documents/${id}`);
}

export interface CreatedAccount {
  tenantId: string;
  inboxAddress: string;
  supplierNotice: string;
  mfa: { required: boolean; secret: string; uri: string };
}

export async function createTenantAccount(body: {
  name: string;
  email: string;
  password: string;
  taxId?: string;
  industry?: string;
  locale?: string;
}): Promise<CreatedAccount> {
  const response = await fetch(`${API_URL}/v1/tenants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `setup failed (${response.status})`);
  }
  return (await response.json()) as CreatedAccount;
}

export async function requestPasswordReset(email: string): Promise<{ ok: boolean; link?: string }> {
  const response = await fetch(`${API_URL}/v1/auth/password-reset/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
    cache: "no-store",
  });
  if (!response.ok) return { ok: false };
  const body = (await response.json()) as { link?: string };
  return { ok: true, ...(body.link ? { link: body.link } : {}) };
}

export async function confirmPasswordReset(body: {
  token: string;
  password: string;
  totpCode?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch(`${API_URL}/v1/auth/password-reset/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (response.ok) return { ok: true };
  const detail = (await response.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: detail.error ?? "invalid_or_expired_token" };
}
