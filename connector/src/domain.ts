/**
 * Plays Ranch registry domain model.
 *
 * These types mirror db/migrations/0001_registry.sql. Every record that can be
 * returned to a caller carries a company_id so access can be enforced per company.
 */

export type Availability = "internal" | "private_beta" | "available" | "suspended" | "retired";
export const AVAILABILITY_VALUES: readonly Availability[] = [
  "internal",
  "private_beta",
  "available",
  "suspended",
  "retired",
];

export type ReleaseStatus =
  | "planned"
  | "in_review"
  | "approved"
  | "released"
  | "rolled_back"
  | "withdrawn";
export const RELEASE_STATUS_VALUES: readonly ReleaseStatus[] = [
  "planned",
  "in_review",
  "approved",
  "released",
  "rolled_back",
  "withdrawn",
];

export type VerificationStatus = "pending" | "passed" | "conditional" | "failed";
export type FindingSeverity = "low" | "medium" | "high" | "critical";
export type FindingStatus = "open" | "resolved" | "accepted_risk";

/** Handoff lifecycle statuses follow the FTD transfer protocol. */
export type HandoffStatus =
  | "DRAFT"
  | "READY"
  | "ACCEPTED"
  | "BLOCKED"
  | "REVIEW"
  | "COMPLETE"
  | "ARCHIVED";
export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface Company {
  id: string;
  slug: string;
  name: string;
}

export interface SupportInfo {
  owner: string;
  channel: string | null;
  docs_url: string | null;
}

export interface Plugin {
  id: string;
  company_id: string;
  slug: string;
  name: string;
  summary: string;
  capabilities: string[];
  availability: Availability;
  current_version: string | null;
  permissions: string[];
  dependencies: string[];
  support: SupportInfo;
  updated_at: string;
}

export interface PluginSummary {
  id: string;
  company_id: string;
  company_slug: string;
  slug: string;
  name: string;
  summary: string;
  capabilities: string[];
  availability: Availability;
  current_version: string | null;
}

export interface Evidence {
  kind: string;
  title: string;
  uri: string | null;
  recorded_at: string;
}

export interface Finding {
  id: string;
  severity: FindingSeverity;
  title: string;
  status: FindingStatus;
  detail: string | null;
}

export interface VerificationReport {
  id: string;
  company_id: string;
  plugin_id: string;
  version: string;
  status: VerificationStatus;
  verified_at: string | null;
  verifier: string | null;
  evidence: Evidence[];
  findings: Finding[];
}

export interface Release {
  id: string;
  company_id: string;
  plugin_id: string;
  version: string;
  channel: string;
  status: ReleaseStatus;
  notes: string | null;
  approved_by: string | null;
  released_at: string | null;
  created_at: string;
}

export interface Handoff {
  id: string;
  company_id: string;
  plugin_id: string | null;
  kind: "engineering" | "operations";
  title: string;
  status: HandoffStatus;
  approval_status: ApprovalStatus;
  approved_by: string | null;
  approved_at: string | null;
  summary: string;
  body: string;
  source_uri: string | null;
  updated_at: string;
}

export interface CompanyMembership {
  user_subject: string;
  company_id: string;
  role: "viewer" | "operator" | "owner";
}
