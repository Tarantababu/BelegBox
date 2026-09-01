import { cookies } from "next/headers";

const API_URL = process.env["API_URL"] ?? "http://localhost:8082";

export const TENANT_COOKIE = "belegbox_tenant";

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

export async function currentTenantId(): Promise<string | undefined> {
  return (await cookies()).get(TENANT_COOKIE)?.value;
}

/**
 * Calls /v1 with the tenant from the session cookie.
 *
 * The cookie carries a tenant id and nothing else, which is a placeholder for
 * sessions, not a security boundary - anyone who edits it becomes another
 * tenant. Real authentication lands before this is exposed to anyone; it is
 * marked here so it cannot be mistaken for finished.
 */
async function call<T>(path: string, tenantId?: string): Promise<T | undefined> {
  const tenant = tenantId ?? (await currentTenantId());
  if (!tenant) return undefined;

  const response = await fetch(`${API_URL}${path}`, {
    headers: { "x-belegbox-tenant": tenant },
    cache: "no-store",
  });
  if (response.status === 404 || response.status === 401) return undefined;
  if (!response.ok) throw new Error(`${path} responded ${response.status}`);
  return (await response.json()) as T;
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

export async function createTenantAccount(body: {
  name: string;
  taxId?: string;
  industry?: string;
  locale?: string;
}): Promise<{ tenantId: string; inboxAddress: string; supplierNotice: string }> {
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
  return (await response.json()) as {
    tenantId: string;
    inboxAddress: string;
    supplierNotice: string;
  };
}
