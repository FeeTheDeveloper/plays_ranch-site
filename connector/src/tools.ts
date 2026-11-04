import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AVAILABILITY_VALUES, RELEASE_STATUS_VALUES, type Availability, type ReleaseStatus } from "./domain.js";
import type { Logger } from "./log.js";
import { MAX_LIMIT, type AccessScope, type RegistryStore } from "./store/store.js";

export interface ToolContext {
  store: RegistryStore;
  scope: AccessScope;
  clientId: string;
  logger: Logger;
  now?: () => Date;
}

/** v1 is read-only. These annotations tell ChatGPT no tool mutates state or reaches outside the registry. */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const TOOL_NAMES = [
  "search_plugins",
  "get_plugin",
  "get_verification_report",
  "list_releases",
  "get_handoff",
] as const;

const id = z.string().trim().min(1).max(128);
const slug = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and hyphens");
const limit = z.number().int().min(1).max(MAX_LIMIT).optional();

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const now = ctx.now ?? (() => new Date());

  const meta = () => ({
    data_status: ctx.store.dataStatus,
    source: ctx.store.kind,
    retrieved_at: now().toISOString(),
    ...(ctx.store.dataStatus === "fixture"
      ? { notice: "Demo fixture data. These are not real Plays Ranch records." }
      : {}),
  });

  const ok = (tool: string, payload: Record<string, unknown>, summary: string): CallToolResult => {
    const structuredContent = { ...payload, meta: meta() };
    ctx.logger("info", "tool_call", { tool, outcome: "ok", subject: ctx.scope.userSubject, client: ctx.clientId });
    return {
      structuredContent,
      content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(structuredContent, null, 2)}` }],
    };
  };

  const notFound = (tool: string, message: string): CallToolResult => {
    ctx.logger("info", "tool_call", { tool, outcome: "not_found", subject: ctx.scope.userSubject, client: ctx.clientId });
    return { isError: true, content: [{ type: "text", text: message }] };
  };

  const guard =
    <A>(tool: string, fn: (args: A) => Promise<CallToolResult>) =>
    async (args: A): Promise<CallToolResult> => {
      try {
        return await fn(args);
      } catch (err) {
        ctx.logger("error", "tool_call", {
          tool,
          outcome: "error",
          subject: ctx.scope.userSubject,
          client: ctx.clientId,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          isError: true,
          content: [{ type: "text", text: "The Plays Ranch registry could not complete this request. Try again later." }],
        };
      }
    };

  server.registerTool(
    "search_plugins",
    {
      title: "Search plugins",
      description:
        "Search the Plays Ranch plugin registry by free text, company, capability or availability. " +
        "Returns only plugins belonging to companies the signed-in user is a member of. " +
        "Use get_plugin with a returned id for full details.",
      inputSchema: {
        query: z.string().trim().min(1).max(200).optional().describe("Free text matched against name, summary and capabilities."),
        company: slug.optional().describe("Company slug, e.g. \"plays-ranch\"."),
        capability: z.string().trim().min(1).max(100).optional().describe("Exact capability tag, case-insensitive."),
        availability: z.enum(AVAILABILITY_VALUES as [Availability, ...Availability[]]).optional(),
        limit: limit.describe(`Maximum results, 1-${MAX_LIMIT}. Default 20.`),
      },
      annotations: { title: "Search plugins", ...READ_ONLY },
    },
    guard("search_plugins", async (a) => {
      const plugins = await ctx.store.searchPlugins(ctx.scope, {
        query: a.query,
        companySlug: a.company,
        capability: a.capability,
        availability: a.availability,
        limit: a.limit ?? 20,
      });
      return ok("search_plugins", { count: plugins.length, plugins }, `Found ${plugins.length} plugin(s).`);
    }),
  );

  server.registerTool(
    "get_plugin",
    {
      title: "Get plugin",
      description:
        "Retrieve one plugin's capabilities, required permissions, dependencies, availability, current version and support contact.",
      inputSchema: { plugin_id: id.describe("Plugin id from search_plugins.") },
      annotations: { title: "Get plugin", ...READ_ONLY },
    },
    guard("get_plugin", async (a) => {
      const plugin = await ctx.store.getPlugin(ctx.scope, a.plugin_id);
      if (!plugin) return notFound("get_plugin", `No plugin with id ${a.plugin_id} is available to you.`);
      return ok("get_plugin", { plugin }, `Plugin ${plugin.name} (${plugin.availability}).`);
    }),
  );

  server.registerTool(
    "get_verification_report",
    {
      title: "Get verification report",
      description:
        "Retrieve the verification report for a plugin version: overall status, evidence records and findings, " +
        "with unresolved findings listed separately. Defaults to the plugin's current version.",
      inputSchema: {
        plugin_id: id.describe("Plugin id from search_plugins."),
        version: z.string().trim().min(1).max(64).optional().describe("Version string. Defaults to the plugin's current version."),
      },
      annotations: { title: "Get verification report", ...READ_ONLY },
    },
    guard("get_verification_report", async (a) => {
      const plugin = await ctx.store.getPlugin(ctx.scope, a.plugin_id);
      if (!plugin) return notFound("get_verification_report", `No plugin with id ${a.plugin_id} is available to you.`);
      const version = a.version ?? plugin.current_version;
      if (!version) {
        return notFound("get_verification_report", `Plugin ${plugin.name} has no current version; pass a version.`);
      }
      const report = await ctx.store.getVerificationReport(ctx.scope, plugin.id, version);
      if (!report) {
        return notFound("get_verification_report", `No verification report is recorded for ${plugin.name} ${version}.`);
      }
      const unresolved = report.findings.filter((f) => f.status === "open");
      return ok(
        "get_verification_report",
        { plugin: { id: plugin.id, name: plugin.name }, report, unresolved_findings: unresolved },
        `Verification for ${plugin.name} ${version}: ${report.status}, ${unresolved.length} unresolved finding(s).`,
      );
    }),
  );

  server.registerTool(
    "list_releases",
    {
      title: "List releases",
      description:
        "List documented releases, newest first, optionally filtered by plugin, company or status.",
      inputSchema: {
        plugin_id: id.optional().describe("Restrict to one plugin."),
        company: slug.optional().describe("Restrict to one company slug."),
        status: z.enum(RELEASE_STATUS_VALUES as [ReleaseStatus, ...ReleaseStatus[]]).optional(),
        limit: limit.describe(`Maximum results, 1-${MAX_LIMIT}. Default 20.`),
      },
      annotations: { title: "List releases", ...READ_ONLY },
    },
    guard("list_releases", async (a) => {
      const releases = await ctx.store.listReleases(ctx.scope, {
        pluginId: a.plugin_id,
        companySlug: a.company,
        status: a.status,
        limit: a.limit ?? 20,
      });
      return ok("list_releases", { count: releases.length, releases }, `Found ${releases.length} release(s).`);
    }),
  );

  server.registerTool(
    "get_handoff",
    {
      title: "Get handoff",
      description:
        "Retrieve an approved engineering or operations handoff by id. Drafts and unapproved handoffs are not returned.",
      inputSchema: { handoff_id: id.describe("Handoff id.") },
      annotations: { title: "Get handoff", ...READ_ONLY },
    },
    guard("get_handoff", async (a) => {
      const handoff = await ctx.store.getApprovedHandoff(ctx.scope, a.handoff_id);
      if (!handoff) {
        return notFound("get_handoff", `No approved handoff with id ${a.handoff_id} is available to you.`);
      }
      return ok("get_handoff", { handoff }, `Handoff "${handoff.title}" (${handoff.status}).`);
    }),
  );
}
