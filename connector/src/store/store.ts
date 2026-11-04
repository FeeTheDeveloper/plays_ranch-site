import type {
  Availability,
  Company,
  Handoff,
  Plugin,
  PluginSummary,
  Release,
  ReleaseStatus,
  VerificationReport,
} from "../domain.js";

/**
 * The set of companies the calling user may read. Every store method takes this
 * scope and must never return a record whose company_id is outside it.
 * Records outside the scope are indistinguishable from records that do not exist.
 */
export interface AccessScope {
  userSubject: string;
  companyIds: readonly string[];
}

export interface PluginSearch {
  query?: string;
  companySlug?: string;
  capability?: string;
  availability?: Availability;
  limit: number;
}

export interface ReleaseQuery {
  pluginId?: string;
  companySlug?: string;
  status?: ReleaseStatus;
  limit: number;
}

/** "live" = production records; "fixture" = labeled demo data, never presented as real. */
export type DataStatus = "live" | "fixture";

export interface RegistryStore {
  readonly kind: string;
  readonly dataStatus: DataStatus;

  /** Company ids the subject holds a membership for. Source of truth for AccessScope. */
  companyIdsForSubject(userSubject: string): Promise<string[]>;

  listCompanies(scope: AccessScope): Promise<Company[]>;
  searchPlugins(scope: AccessScope, search: PluginSearch): Promise<PluginSummary[]>;
  getPlugin(scope: AccessScope, pluginId: string): Promise<Plugin | null>;
  getVerificationReport(
    scope: AccessScope,
    pluginId: string,
    version: string,
  ): Promise<VerificationReport | null>;
  listReleases(scope: AccessScope, query: ReleaseQuery): Promise<Release[]>;
  /** Returns only handoffs whose approval_status is "approved". */
  getApprovedHandoff(scope: AccessScope, handoffId: string): Promise<Handoff | null>;

  ping(): Promise<void>;
  close(): Promise<void>;
}

export const MAX_LIMIT = 50;
