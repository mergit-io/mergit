import { base } from "../api/client";

/** Resolves a relative URL the API handed the browser (`start_url` in the `human_approval_required` body)
 * against that same base, so it is never opened as a bare path. */
export function resolveApiUrl(path: string): string {
  return `${base()}${path}`;
}

export type ApprovalStatus = {
  status: string;
  reason: string | null;
  expires_at: string;
};

/** Polled while the popup cannot `postMessage` back to its opener (plan sec 1.7): session-cookie auth,
 * owner only. Anything other than `"pending"` is terminal. */
export async function getApprovalStatus(approvalId: string): Promise<ApprovalStatus> {
  const response = await fetch(resolveApiUrl(`/v0/world/approvals/${encodeURIComponent(approvalId)}`), {
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`Mergit answered ${String(response.status)} checking the World approval.`);
  }
  return (await response.json()) as ApprovalStatus;
}
