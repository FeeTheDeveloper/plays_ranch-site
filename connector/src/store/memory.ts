import type {
  Company,
  CompanyMembership,
  Handoff,
  Plugin,
  PluginSummary,
  Release,
  VerificationReport,
} from "../domain.js";
import type {
  AccessScope,
  DataStatus,
  PluginSearch,
  RegistryStore,
  ReleaseQuery,
} from "./store.js";

export interface RegistryDataset {
  companies: Company[];
  memberships: CompanyMembership[];
  plugins: Plugin[];
  verification_reports: VerificationReport[];
  releases: Release[];
  handoffs: Handoff[];
}

function inScope(scope: AccessScope, companyId: string): boolean {
  return scope.companyIds.includes(companyId);
}

function includesFolded(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * In-memory registry used for tests and local development. Applies exactly the
 * same company scoping rules as the Postgres store.
 */
export class MemoryRegistryStore implements RegistryStore {
  readonly kind = "memory";

  constructor(
    private readonly data: RegistryDataset,
    readonly dataStatus: DataStatus = "fixture",
  ) {}

  async companyIdsForSubject(userSubject: string): Promise<string[]> {
    return this.data.memberships
      .filter((m) => m.user_subject === userSubject)
      .map((m) => m.company_id);
  }

  async listCompanies(scope: AccessScope): Promise<Company[]> {
    return this.data.companies.filter((c) => inScope(scope, c.id));
  }

  private companyBySlug(slug: string): Company | undefined {
    return this.data.companies.find((c) => c.slug === slug);
  }

  async searchPlugins(scope: AccessScope, s: PluginSearch): Promise<PluginSummary[]> {
    const company = s.companySlug ? this.companyBySlug(s.companySlug) : undefined;
    if (s.companySlug && !company) return [];
    return this.data.plugins
      .filter((p) => inScope(scope, p.company_id))
      .filter((p) => !company || p.company_id === company.id)
      .filter((p) => !s.availability || p.availability === s.availability)
      .filter(
        (p) =>
          !s.capability ||
          p.capabilities.some((c) => c.toLowerCase() === s.capability!.toLowerCase()),
      )
      .filter(
        (p) =>
          !s.query ||
          includesFolded(p.name, s.query) ||
          includesFolded(p.summary, s.query) ||
          p.capabilities.some((c) => includesFolded(c, s.query!)),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, s.limit)
      .map((p) => ({
        id: p.id,
        company_id: p.company_id,
        company_slug: this.data.companies.find((c) => c.id === p.company_id)?.slug ?? "",
        slug: p.slug,
        name: p.name,
        summary: p.summary,
        capabilities: p.capabilities,
        availability: p.availability,
        current_version: p.current_version,
      }));
  }

  async getPlugin(scope: AccessScope, pluginId: string): Promise<Plugin | null> {
    const p = this.data.plugins.find((x) => x.id === pluginId);
    return p && inScope(scope, p.company_id) ? p : null;
  }

  async getVerificationReport(
    scope: AccessScope,
    pluginId: string,
    version: string,
  ): Promise<VerificationReport | null> {
    const r = this.data.verification_reports.find(
      (x) => x.plugin_id === pluginId && x.version === version,
    );
    return r && inScope(scope, r.company_id) ? r : null;
  }

  async listReleases(scope: AccessScope, q: ReleaseQuery): Promise<Release[]> {
    const company = q.companySlug ? this.companyBySlug(q.companySlug) : undefined;
    if (q.companySlug && !company) return [];
    return this.data.releases
      .filter((r) => inScope(scope, r.company_id))
      .filter((r) => !company || r.company_id === company.id)
      .filter((r) => !q.pluginId || r.plugin_id === q.pluginId)
      .filter((r) => !q.status || r.status === q.status)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, q.limit);
  }

  async getApprovedHandoff(scope: AccessScope, handoffId: string): Promise<Handoff | null> {
    const h = this.data.handoffs.find((x) => x.id === handoffId);
    return h && inScope(scope, h.company_id) && h.approval_status === "approved" ? h : null;
  }

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}
