import pg from "pg";
import type {
  Company,
  Handoff,
  Plugin,
  PluginSummary,
  Release,
  VerificationReport,
} from "../domain.js";
import type { AccessScope, PluginSearch, RegistryStore, ReleaseQuery } from "./store.js";

/**
 * Postgres-backed registry (schema: db/migrations/0001_registry.sql).
 *
 * Every query binds the caller's company ids as $1 and filters on
 * company_id = ANY($1). Connect with the read-only `plays_ranch_connector` role,
 * never a superuser or Supabase service-role credential.
 */
export class PostgresRegistryStore implements RegistryStore {
  readonly kind = "postgres";
  readonly dataStatus = "live" as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string, opts: { ssl: boolean; max?: number } = { ssl: true }) {
    this.pool = new pg.Pool({
      connectionString,
      max: opts.max ?? 5,
      ssl: opts.ssl ? { rejectUnauthorized: true } : undefined,
      statement_timeout: 5_000,
      idleTimeoutMillis: 10_000,
    });
  }

  private async q<T extends pg.QueryResultRow>(sql: string, params: unknown[]): Promise<T[]> {
    const res = await this.pool.query<T>(sql, params);
    return res.rows;
  }

  async companyIdsForSubject(userSubject: string): Promise<string[]> {
    const rows = await this.q<{ company_id: string }>(
      `select company_id from registry.company_memberships where user_subject = $1`,
      [userSubject],
    );
    return rows.map((r) => r.company_id);
  }

  async listCompanies(scope: AccessScope): Promise<Company[]> {
    return this.q<Company>(
      `select id, slug, name from registry.companies where id = any($1::uuid[]) order by name`,
      [scope.companyIds],
    );
  }

  async searchPlugins(scope: AccessScope, s: PluginSearch): Promise<PluginSummary[]> {
    return this.q<PluginSummary>(
      `select p.id, p.company_id, c.slug as company_slug, p.slug, p.name, p.summary,
              p.capabilities, p.availability, p.current_version
         from registry.plugins p
         join registry.companies c on c.id = p.company_id
        where p.company_id = any($1::uuid[])
          and ($2::text is null or c.slug = $2)
          and ($3::text is null or p.availability = $3)
          and ($4::text is null or exists (
                select 1 from unnest(p.capabilities) cap where lower(cap) = lower($4)))
          and ($5::text is null
               or p.name ilike '%' || $5 || '%'
               or p.summary ilike '%' || $5 || '%'
               or exists (select 1 from unnest(p.capabilities) cap where cap ilike '%' || $5 || '%'))
        order by p.name
        limit $6`,
      [
        scope.companyIds,
        s.companySlug ?? null,
        s.availability ?? null,
        s.capability ?? null,
        s.query ? escapeLike(s.query) : null,
        s.limit,
      ],
    );
  }

  async getPlugin(scope: AccessScope, pluginId: string): Promise<Plugin | null> {
    if (!isUuid(pluginId)) return null;
    const rows = await this.q<Plugin & { support_owner: string; support_channel: string | null; support_docs_url: string | null }>(
      `select id, company_id, slug, name, summary, capabilities, availability, current_version,
              permissions, dependencies, support_owner, support_channel, support_docs_url,
              to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at
         from registry.plugins
        where id = $2::uuid and company_id = any($1::uuid[])`,
      [scope.companyIds, pluginId],
    );
    const r = rows[0];
    if (!r) return null;
    const { support_owner, support_channel, support_docs_url, ...rest } = r;
    return {
      ...rest,
      support: { owner: support_owner, channel: support_channel, docs_url: support_docs_url },
    };
  }

  async getVerificationReport(
    scope: AccessScope,
    pluginId: string,
    version: string,
  ): Promise<VerificationReport | null> {
    if (!isUuid(pluginId)) return null;
    const rows = await this.q<VerificationReport>(
      `select id, company_id, plugin_id, version, status,
              to_char(verified_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as verified_at,
              verifier, evidence, findings
         from registry.verification_reports
        where plugin_id = $2::uuid and version = $3 and company_id = any($1::uuid[])
        order by created_at desc
        limit 1`,
      [scope.companyIds, pluginId, version],
    );
    return rows[0] ?? null;
  }

  async listReleases(scope: AccessScope, q: ReleaseQuery): Promise<Release[]> {
    if (q.pluginId !== undefined && !isUuid(q.pluginId)) return [];
    return this.q<Release>(
      `select r.id, r.company_id, r.plugin_id, r.version, r.channel, r.status, r.notes, r.approved_by,
              to_char(r.released_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as released_at,
              to_char(r.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
         from registry.releases r
         join registry.companies c on c.id = r.company_id
        where r.company_id = any($1::uuid[])
          and ($2::uuid is null or r.plugin_id = $2::uuid)
          and ($3::text is null or c.slug = $3)
          and ($4::text is null or r.status = $4)
        order by r.created_at desc
        limit $5`,
      [scope.companyIds, q.pluginId ?? null, q.companySlug ?? null, q.status ?? null, q.limit],
    );
  }

  async getApprovedHandoff(scope: AccessScope, handoffId: string): Promise<Handoff | null> {
    if (!isUuid(handoffId)) return null;
    const rows = await this.q<Handoff>(
      `select id, company_id, plugin_id, kind, title, status, approval_status, approved_by,
              to_char(approved_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as approved_at,
              summary, body, source_uri,
              to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at
         from registry.handoffs
        where id = $2::uuid and company_id = any($1::uuid[]) and approval_status = 'approved'`,
      [scope.companyIds, handoffId],
    );
    return rows[0] ?? null;
  }

  async ping(): Promise<void> {
    await this.pool.query("select 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Escape LIKE wildcards so user text is matched literally. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
