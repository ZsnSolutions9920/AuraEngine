// supabase/functions/v1-campaigns/index.ts — Phase 4.2
//
// GET /functions/v1/v1-campaigns   (scope: campaigns.read)
//   Lists email_sequence_runs (an active "campaign" in the customer's
//   vocabulary). Cursor-paginated.
//   ?limit, ?cursor (created_at), ?status

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { authenticateApiKey, adminClient } from "../_shared/api-auth.ts";

const COLUMNS = "id,status,lead_count,step_count,items_total,items_done,items_failed,started_at,completed_at,created_at,updated_at,sequence_config";
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed", code: "method_not_allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const auth = await authenticateApiKey(req, { requiredScope: "campaigns.read", corsHeaders });
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(MAX_LIMIT, limitRaw) : DEFAULT_LIMIT;
  const cursor = url.searchParams.get("cursor");
  const statusFilter = url.searchParams.get("status");

  let q = adminClient()
    .from("email_sequence_runs")
    .select(COLUMNS)
    .eq("workspace_id", auth.auth.workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit + 1);
  if (cursor) q = q.lt("created_at", cursor);
  if (statusFilter) q = q.eq("status", statusFilter);

  const { data, error } = await q;
  if (error) {
    return new Response(JSON.stringify({ error: "Query failed", code: "query_failed" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const rows = data ?? [];
  const has_more = rows.length > limit;
  const result = has_more ? rows.slice(0, limit) : rows;
  const next_cursor = has_more ? (result[result.length - 1] as { created_at: string }).created_at : null;

  return new Response(JSON.stringify({ data: result, next_cursor, has_more, limit }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
