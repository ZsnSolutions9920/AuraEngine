// supabase/functions/admin-audit-export/index.ts
//
// Phase 4.4 — Streaming admin export of audit_logs.
//
//   GET /functions/v1/admin-audit-export?format=csv&start=...&end=...&action=...&workspace_id=...
//
// Auth: Supabase user JWT, with profile.role === 'admin' (or super_admin).
// Returns: CSV (default) or JSON, streamed in 500-row pages so a multi-
// year export doesn't blow memory.
//
// SOC2 readiness: this is the export-on-demand endpoint. A scheduled
// export-to-S3 hook is Phase 4.4.x — not in this ship.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, handleCors } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const PAGE_SIZE = 500;
const MAX_ROWS = 100_000; // safety ceiling; bigger exports → use scheduled S3 hook (Phase 4.4.x)

const COLUMNS = [
  "id", "created_at", "user_id", "workspace_id", "action",
  "entity_type", "entity_id", "team_id", "details", "payload",
] as const;

function csvEscape(val: unknown): string {
  if (val === null || val === undefined) return "";
  const s = typeof val === "string" ? val : JSON.stringify(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);
  const token = authHeader.replace(/^Bearer\s+/i, "");

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: userRes, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !userRes?.user) return json({ error: "Invalid token" }, 401);
  const userId = userRes.user.id;

  // Authorise: caller must have admin or super_admin role.
  const { data: profile } = await admin
    .from("profiles")
    .select("role, is_super_admin")
    .eq("id", userId)
    .maybeSingle();
  const isAdmin = profile?.role === "admin" || profile?.is_super_admin === true;
  if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);

  const url = new URL(req.url);
  const format = (url.searchParams.get("format") ?? "csv").toLowerCase();
  if (format !== "csv" && format !== "json") {
    return json({ error: "format must be csv or json" }, 400);
  }
  const startParam = url.searchParams.get("start");
  const endParam   = url.searchParams.get("end");
  const action     = url.searchParams.get("action");
  const workspaceFilter = url.searchParams.get("workspace_id");

  const fileTs = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `audit_logs_${fileTs}.${format}`;
  const contentType = format === "csv" ? "text/csv" : "application/x-ndjson";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      try {
        if (format === "csv") {
          controller.enqueue(enc.encode(COLUMNS.join(",") + "\n"));
        }

        let cursor: string | null = null;
        let total = 0;
        // Page through audit_logs by created_at DESC, cursor on created_at.
        while (total < MAX_ROWS) {
          let q = admin
            .from("audit_logs")
            .select(COLUMNS.join(","))
            .order("created_at", { ascending: false })
            .limit(PAGE_SIZE);

          if (startParam) q = q.gte("created_at", startParam);
          if (endParam)   q = q.lte("created_at", endParam);
          if (action)     q = q.eq("action", action);
          if (workspaceFilter) q = q.eq("workspace_id", workspaceFilter);
          if (cursor)     q = q.lt("created_at", cursor);

          const { data, error } = await q;
          if (error) {
            controller.enqueue(enc.encode(`\n# error: ${error.message}\n`));
            break;
          }
          const rows = (data ?? []) as Array<Record<string, unknown>>;
          if (rows.length === 0) break;

          for (const r of rows) {
            if (format === "csv") {
              controller.enqueue(
                enc.encode(COLUMNS.map((c) => csvEscape(r[c])).join(",") + "\n"),
              );
            } else {
              controller.enqueue(enc.encode(JSON.stringify(r) + "\n"));
            }
            total += 1;
            if (total >= MAX_ROWS) break;
          }

          if (rows.length < PAGE_SIZE) break;
          cursor = rows[rows.length - 1].created_at as string;
        }
      } catch (e) {
        const enc2 = new TextEncoder();
        controller.enqueue(enc2.encode(`\n# error: ${(e as Error).message}\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
});
