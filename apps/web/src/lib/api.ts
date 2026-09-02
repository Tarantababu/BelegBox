import { cookies } from "next/headers";
import { cache } from "react";

export const API_URL = process.env["API_URL"] ?? "http://localhost:8082";

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

export interface GiroCode {
  payload: string;
  svg: string;
  byteLength: number;
  beneficiary: string;
  iban: string;
  amount: number;
  reference: string;
  disclaimer: { de: string; tr: string };
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
  /** The business's default - what a new colleague inherits. */
  locale: string;
  /**
   * What THIS session should be rendered in: the signed-in person's own
   * setting, falling back to the tenant default. Read this, not `locale`.
   */
  language: string;
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

/**
 * Deduplicated for the render pass.
 *
 * Every page already called this once. The layout now calls it too, to know
 * which language and text direction to put on <html>, and so does the language
 * resolver - three fetches of the same thing for one screen. `cache` collapses
 * them back into one; the data is still `no-store` and nothing is held across
 * requests.
 */
export const getTenant = cache(function getTenant(): Promise<Tenant | undefined> {
  return call<Tenant>("/v1/tenant");
});

/**
 * Changes the signed-in person's interface language.
 *
 * Returns the code the API confirms, so the caller writes the cookie from what
 * was actually stored rather than from what it asked for - a rejected language
 * must not leave a cookie claiming otherwise.
 */
export async function setLanguage(
  language: string,
): Promise<{ ok: true; language: string } | { ok: false; error: string }> {
  const token = await currentSession();
  if (!token) return { ok: false, error: "unauthorized" };

  const response = await fetch(`${API_URL}/v1/account/language`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    },
    body: JSON.stringify({ language }),
    cache: "no-store",
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: detail.error ?? `language change failed (${response.status})` };
  }
  const body = (await response.json()) as { language: string };
  return { ok: true, language: body.language };
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

/**
 * Payment data for one document.
 *
 * Returns undefined when the invoice carries no account or amount - a document
 * that cannot be paid is an ordinary case, not an error.
 */
export async function getGiroCode(id: string): Promise<GiroCode | undefined> {
  const token = await currentSession();
  if (!token) return undefined;

  const response = await fetch(`${API_URL}/v1/documents/${id}/girocode`, {
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    cache: "no-store",
  });
  if (!response.ok) return undefined;
  return (await response.json()) as GiroCode;
}

export interface DatevExport {
  filename: string;
  encoding: string;
  bookings: number;
  chart: string;
  skipped: Array<{ id: string; reason: string }>;
  contentBase64: string;
}

export async function exportDatev(body: {
  from: string;
  to: string;
  beraterNumber: number;
  mandantNumber: number;
  chart?: string;
}): Promise<{ ok: true; export: DatevExport } | { ok: false; error: string }> {
  const token = await currentSession();
  if (!token) return { ok: false, error: "unauthorized" };

  const response = await fetch(`${API_URL}/v1/exports/datev`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
    return { ok: false, error: detail.message ?? detail.error ?? "export_failed" };
  }
  return { ok: true, export: (await response.json()) as DatevExport };
}

export interface DokuVersion {
  version: number;
  contentHash: string;
  previousHash: string | null;
  openItems: number;
  complete: boolean;
  generatedAt: string;
}

export interface DokuList {
  versions: DokuVersion[];
  chain: { ok: true } | { ok: false; brokenAt: number };
}

export async function listVerfahrensdoku(): Promise<DokuList | null> {
  const token = await currentSession();
  if (!token) return null;

  const response = await fetch(`${API_URL}/v1/verfahrensdokumentation`, {
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    cache: "no-store",
  });
  if (!response.ok) return null;
  return (await response.json()) as DokuList;
}

export async function generateVerfahrensdoku(): Promise<
  { ok: true; version: number } | { ok: false; error: string }
> {
  const token = await currentSession();
  if (!token) return { ok: false, error: "unauthorized" };

  const response = await fetch(`${API_URL}/v1/verfahrensdokumentation`, {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: detail.error ?? "generate_failed" };
  }
  const body = (await response.json()) as { version: number };
  return { ok: true, version: body.version };
}

export async function fetchVerfahrensdokuHtml(version: number): Promise<string | null> {
  const token = await currentSession();
  if (!token) return null;

  const response = await fetch(`${API_URL}/v1/verfahrensdokumentation/${version}`, {
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    cache: "no-store",
  });
  if (!response.ok) return null;
  return await response.text();
}

export type SearchMode = "exact" | "similar" | "filtered";

export interface ArchiveSearch {
  mode: SearchMode;
  total: number;
  totalIsLowerBound: boolean;
  limit: number;
  offset: number;
  amount: number | null;
  documents: DocumentSummary[];
}

export async function searchArchive(params: Record<string, string>): Promise<ArchiveSearch | null> {
  const token = await currentSession();
  if (!token) return null;

  const query = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== ""),
  );

  const response = await fetch(`${API_URL}/v1/documents/search?${query.toString()}`, {
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    cache: "no-store",
  });
  if (!response.ok) return null;
  return (await response.json()) as ArchiveSearch;
}

export interface BelegBundle {
  bytes: ArrayBuffer;
  filename: string;
  included: number;
  skipped: number;
  integrityFailures: number;
}

export async function exportBelege(body: {
  from: string;
  to: string;
}): Promise<{ ok: true; bundle: BelegBundle } | { ok: false; error: string }> {
  const token = await currentSession();
  if (!token) return { ok: false, error: "unauthorized" };

  const response = await fetch(`${API_URL}/v1/exports/belege`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
    return { ok: false, error: detail.message ?? detail.error ?? "export_failed" };
  }

  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);

  return {
    ok: true,
    bundle: {
      bytes: await response.arrayBuffer(),
      filename: match?.[1] ?? "belege.zip",
      included: Number(response.headers.get("x-belegbox-included") ?? 0),
      skipped: Number(response.headers.get("x-belegbox-skipped") ?? 0),
      integrityFailures: Number(response.headers.get("x-belegbox-integrity-failures") ?? 0),
    },
  };
}

export interface MfaStatus {
  enrolled: boolean;
  recoveryCodesLeft: number;
  pending: { startedAt: string } | null;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  environment: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

async function withSession(path: string, init: RequestInit = {}): Promise<Response | null> {
  const token = await currentSession();
  if (!token) return null;
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    },
    cache: "no-store",
  });
}

export async function getMfaStatus(): Promise<MfaStatus | null> {
  const response = await withSession("/v1/account/mfa");
  if (!response?.ok) return null;
  return (await response.json()) as MfaStatus;
}

export async function beginMfa(
  password: string,
): Promise<{ ok: true; secret: string; uri: string } | { ok: false; error: string }> {
  const response = await withSession("/v1/account/mfa/begin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!response) return { ok: false, error: "unauthorized" };
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
    return { ok: false, error: detail.message ?? detail.error ?? "failed" };
  }
  const body = (await response.json()) as { secret: string; uri: string };
  return { ok: true, ...body };
}

export async function confirmMfa(
  code: string,
): Promise<
  { ok: true; recoveryCodes: string[]; cookie: string | null } | { ok: false; error: string }
> {
  const response = await withSession("/v1/account/mfa/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!response) return { ok: false, error: "unauthorized" };
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: detail.error ?? "failed" };
  }
  const body = (await response.json()) as { recoveryCodes: string[] };
  // Rotating revokes every session, including this one; the API issues a
  // replacement, and it has to be passed on or the user is signed out while
  // reading codes they see only once.
  return { ok: true, recoveryCodes: body.recoveryCodes, cookie: response.headers.get("set-cookie") };
}

export async function listApiKeys(): Promise<ApiKeySummary[] | null> {
  const response = await withSession("/v1/api-keys");
  if (!response?.ok) return null;
  return ((await response.json()) as { keys: ApiKeySummary[] }).keys;
}

export async function createApiKey(input: {
  name: string;
  environment: string;
  password: string;
}): Promise<{ ok: true; token: string; name: string } | { ok: false; error: string }> {
  const response = await withSession("/v1/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response) return { ok: false, error: "unauthorized" };
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
    return { ok: false, error: detail.message ?? detail.error ?? "failed" };
  }
  const body = (await response.json()) as { token: string; name: string };
  return { ok: true, ...body };
}

export async function revokeApiKey(id: string): Promise<boolean> {
  const response = await withSession(`/v1/api-keys/${id}`, { method: "DELETE" });
  return Boolean(response?.ok);
}
