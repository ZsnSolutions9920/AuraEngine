import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, handleCors } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TRACKING_BASE_URL = Deno.env.get("TRACKING_BASE_URL") ?? "";

// Fallback env vars (used when no per-user config exists)
const ENV_SENDGRID_API_KEY = Deno.env.get("SENDGRID_API_KEY") ?? "";
const ENV_SMTP_HOST = Deno.env.get("SMTP_HOST") ?? "";
const ENV_SMTP_PORT = parseInt(Deno.env.get("SMTP_PORT") ?? "587");
const ENV_SMTP_USER = Deno.env.get("SMTP_USER") ?? "";
const ENV_SMTP_PASS = Deno.env.get("SMTP_PASS") ?? "";

// In-memory rate limiting: 30 emails/min per user
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(userId) ?? [];
  const recent = timestamps.filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  rateLimitMap.set(userId, recent);
  return true;
}

// ── Provider credentials (per-user DB config or env fallback) ──
interface ProviderCreds {
  api_key?: string;
  smtp_host?: string;
  smtp_port?: number;
  smtp_user?: string;
  smtp_pass?: string;
  from_email?: string;
  from_name?: string;
}

async function loadProviderCreds(
  supabaseAdmin: ReturnType<typeof createClient>,
  userId: string,
  provider: string
): Promise<ProviderCreds> {
  // Try per-user config from DB
  const { data } = await supabaseAdmin
    .from("email_provider_configs")
    .select("*")
    .eq("owner_id", userId)
    .eq("provider", provider)
    .eq("is_active", true)
    .single();

  if (data) {
    return {
      api_key: data.api_key ?? undefined,
      smtp_host: data.smtp_host ?? undefined,
      smtp_port: data.smtp_port ?? 587,
      smtp_user: data.smtp_user ?? undefined,
      smtp_pass: data.smtp_pass ?? undefined,
      from_email: data.from_email ?? undefined,
      from_name: data.from_name ?? undefined,
    };
  }

  // Fallback to env vars
  if (provider === "sendgrid") {
    return { api_key: ENV_SENDGRID_API_KEY || undefined };
  }
  return {
    smtp_host: ENV_SMTP_HOST || undefined,
    smtp_port: ENV_SMTP_PORT,
    smtp_user: ENV_SMTP_USER || undefined,
    smtp_pass: ENV_SMTP_PASS || undefined,
  };
}

// ── Phase 3.2.2: load creds from sender_account_secrets (canonical path) ──
//
// Joins sender_accounts → sender_account_secrets so we get from_email +
// from_name from the public side and the credentials from the secret side
// in a single round-trip. Returns null if either row is missing — caller
// falls back to loadProviderCreds (legacy email_provider_configs).
async function loadSenderAccountCreds(
  supabaseAdmin: ReturnType<typeof createClient>,
  senderAccountId: string,
): Promise<ProviderCreds | null> {
  try {
    const { data } = await supabaseAdmin
      .from("sender_accounts")
      .select(`
        from_email, from_name,
        sender_account_secrets ( api_key, smtp_host, smtp_port, smtp_user, smtp_pass )
      `)
      .eq("id", senderAccountId)
      .maybeSingle();

    if (!data) return null;
    const secrets = Array.isArray((data as any).sender_account_secrets)
      ? (data as any).sender_account_secrets[0]
      : (data as any).sender_account_secrets;
    if (!secrets) return null;

    // At minimum a usable cred path must be present (API key OR SMTP host+user).
    const hasUsable = !!secrets.api_key || (!!secrets.smtp_host && !!secrets.smtp_user);
    if (!hasUsable) return null;

    return {
      api_key:    secrets.api_key   ?? undefined,
      smtp_host:  secrets.smtp_host ?? undefined,
      smtp_port:  secrets.smtp_port ?? 587,
      smtp_user:  secrets.smtp_user ?? undefined,
      smtp_pass:  secrets.smtp_pass ?? undefined,
      from_email: (data as any).from_email ?? undefined,
      from_name:  (data as any).from_name  ?? undefined,
    };
  } catch (err) {
    console.warn("[send-email] sender_account_secrets read failed:", (err as Error).message);
    return null;
  }
}

// ── Link rewriting + pixel injection (server-side instrumentation) ──
function instrumentHtml(
  html: string,
  messageId: string,
  linkRows: { id: string; destination_url: string }[],
  trackOpens: boolean,
  trackClicks: boolean
): string {
  let result = html;

  if (trackClicks && TRACKING_BASE_URL && linkRows.length > 0) {
    for (const link of linkRows) {
      const trackingUrl = `${TRACKING_BASE_URL}/t/c/${link.id}`;
      result = result.replace(
        new RegExp(
          `(href\\s*=\\s*["'])${escapeRegex(link.destination_url)}(["'])`,
          "i"
        ),
        `$1${trackingUrl}$2`
      );
    }
  }

  if (trackOpens && TRACKING_BASE_URL) {
    const pixel = `<img src="${TRACKING_BASE_URL}/t/p/${messageId}.png" width="1" height="1" style="display:none" alt="" />`;
    if (result.includes("</body>")) {
      result = result.replace("</body>", `${pixel}</body>`);
    } else {
      result += pixel;
    }
  }

  return result;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Extract links from HTML ──
function extractLinks(
  html: string
): { url: string; label: string; index: number }[] {
  const anchorRegex =
    /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const links: { url: string; label: string; index: number }[] = [];
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = anchorRegex.exec(html)) !== null) {
    const url = match[1];
    if (/^(mailto:|tel:|#|javascript:)/i.test(url)) continue;
    const label = match[2].replace(/<[^>]*>/g, "").trim();
    links.push({ url, label, index: idx++ });
  }
  return links;
}

// ── Send via SendGrid ──
async function sendViaSendGrid(
  to: string,
  from: string,
  subject: string,
  html: string,
  creds: ProviderCreds
): Promise<{ success: boolean; providerMessageId?: string; error?: string }> {
  const apiKey = creds.api_key;
  if (!apiKey)
    return {
      success: false,
      error:
        "SendGrid API key not configured. Go to Settings → Integrations → SendGrid to add your key.",
    };

  const fromObj: { email: string; name?: string } = { email: from };
  if (creds.from_name) fromObj.name = creds.from_name;

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: fromObj,
      subject,
      content: [{ type: "text/html", value: html }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    return { success: false, error: `SendGrid ${res.status}: ${errText}` };
  }

  const messageId = res.headers.get("x-message-id") ?? undefined;
  return { success: true, providerMessageId: messageId };
}

// ── Send via SMTP (with STARTTLS support) ──
async function sendViaSmtp(
  to: string,
  from: string,
  subject: string,
  html: string,
  creds: ProviderCreds
): Promise<{ success: boolean; providerMessageId?: string; error?: string }> {
  const host = creds.smtp_host;
  if (!host)
    return {
      success: false,
      error:
        "SMTP host not configured. Go to Settings → Integrations → SMTP/Gmail to add your credentials.",
    };

  try {
    const port = creds.smtp_port ?? 587;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Port 465 = implicit TLS (SMTPS) — connect with TLS directly
    // Port 587/25 = plain connect, then upgrade via STARTTLS
    let activeConn: Deno.Conn;
    if (port === 465) {
      activeConn = await Deno.connectTls({ hostname: host, port });
    } else {
      activeConn = await Deno.connect({ hostname: host, port });
    }

    // Read a full SMTP response (handles multi-line responses like EHLO)
    // Multi-line: "250-..." continuation, final line: "250 ..."
    async function readResponse(): Promise<string> {
      let full = "";
      const buf = new Uint8Array(4096);
      while (true) {
        const n = await activeConn.read(buf);
        if (!n) break;
        full += decoder.decode(buf.subarray(0, n));
        // Check if we have a complete response:
        // Final line starts with "NNN " (code + space) or is a single-line response
        const lines = full.trimEnd().split("\n");
        const lastLine = lines[lines.length - 1].trimStart();
        if (/^\d{3}\s/.test(lastLine) || /^\d{3}$/.test(lastLine)) break;
      }
      return full.trim();
    }

    async function send(cmd: string): Promise<string> {
      await activeConn.write(encoder.encode(cmd + "\r\n"));
      return await readResponse();
    }

    // Read server greeting
    await readResponse();

    // Initial EHLO
    const ehloResp = await send("EHLO localhost");

    // For non-465 ports: upgrade to TLS if server supports STARTTLS
    if (port !== 465 && (ehloResp.includes("STARTTLS") || port === 587)) {
      const starttlsResp = await send("STARTTLS");
      if (starttlsResp.startsWith("220")) {
        const tlsConn = await (Deno as any).startTls(activeConn, { hostname: host });
        activeConn = tlsConn;
        // Re-issue EHLO after TLS upgrade (required by RFC 3207)
        await send("EHLO localhost");
      }
    }

    if (creds.smtp_user && creds.smtp_pass) {
      await send("AUTH LOGIN");
      await send(btoa(creds.smtp_user));
      const authResp = await send(btoa(creds.smtp_pass));
      if (authResp.startsWith("535") || authResp.startsWith("534")) {
        activeConn.close();
        return { success: false, error: `SMTP authentication failed: ${authResp}` };
      }
    }

    const fromDisplay = creds.from_name
      ? `${creds.from_name} <${from}>`
      : from;

    await send(`MAIL FROM:<${from}>`);
    await send(`RCPT TO:<${to}>`);
    await send("DATA");

    const boundary = `boundary-${crypto.randomUUID()}`;
    const message = [
      `From: ${fromDisplay}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset=UTF-8`,
      ``,
      html,
      ``,
      `--${boundary}--`,
      `.`,
    ].join("\r\n");

    const resp = await send(message);
    await send("QUIT");
    activeConn.close();

    const idMatch = resp.match(/<([^>]+)>/);
    return {
      success: true,
      providerMessageId: idMatch?.[1] ?? undefined,
    };
  } catch (err) {
    return { success: false, error: `SMTP error: ${(err as Error).message}` };
  }
}

serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const corsHeaders = getCorsHeaders(req);

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  try {
    // Validate JWT
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const token = authHeader.replace("Bearer ", "");

    // Check if this is a service role token by decoding the JWT payload
    function isServiceRoleToken(jwt: string): boolean {
      try {
        if (jwt === SUPABASE_SERVICE_ROLE_KEY) return true;
        const parts = jwt.split(".");
        if (parts.length !== 3) return false;
        const payload = JSON.parse(atob(parts[1]));
        return payload.role === "service_role";
      } catch {
        return false;
      }
    }

    // Allow service role key for internal calls (e.g. from process-scheduled-emails)
    let userId: string;
    if (isServiceRoleToken(token)) {
      const body = await req.json();
      if (!body.owner_id) {
        return new Response(
          JSON.stringify({ error: "owner_id required for service role calls" }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
      userId = body.owner_id;
      // Re-assign body fields below from the already-parsed body
      var {
        lead_id,
        to_email,
        from_email,
        subject,
        html_body,
        provider = "sendgrid",
        track_opens = true,
        track_clicks = true,
      } = body;
    } else {
      const {
        data: { user },
        error: authError,
      } = await supabaseAdmin.auth.getUser(token);

      if (authError || !user) {
        return new Response(
          JSON.stringify({ error: "Invalid token" }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
      userId = user.id;

      var body = await req.json();
      var {
        lead_id,
        to_email,
        from_email,
        subject,
        html_body,
        provider = "sendgrid",
        track_opens = true,
        track_clicks = true,
      } = body;
    }

    // Rate limit: 30 emails/min per user
    if (!checkRateLimit(userId)) {
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded. Please wait before sending more emails." }),
        {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!to_email || !subject || !html_body) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields: to_email, subject, html_body",
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // ── Phase 3.2.1: resolve workspace_id + sender_account_id ──
    // We resolve these first so we can attempt the canonical credential
    // path (sender_account_secrets) before falling back to the legacy
    // email_provider_configs source. Lookups are best-effort — failures
    // leave the IDs null and the legacy path runs.
    let workspaceId: string | null = null;
    let senderAccountId: string | null = null;

    // We need an early guess at senderEmail to look up the matching sender_account.
    // Final senderEmail is computed once creds are loaded below.
    const senderEmailHint = from_email ?? null;

    try {
      const { data: wm } = await supabaseAdmin
        .from("workspace_members")
        .select("workspace_id")
        .eq("user_id", userId)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      workspaceId = (wm?.workspace_id as string | undefined) ?? null;

      if (workspaceId) {
        let q = supabaseAdmin
          .from("sender_accounts")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("provider", provider)
          .eq("status", "connected")
          .eq("use_for_outreach", true);
        if (senderEmailHint) q = q.ilike("from_email", senderEmailHint);
        const { data: sa } = await q
          .order("is_default", { ascending: false })
          .order("health_score", { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle();
        senderAccountId = (sa?.id as string | undefined) ?? null;
      }
    } catch (lookupErr) {
      console.warn("[send-email] sender_account lookup failed:", (lookupErr as Error).message);
    }

    // ── Phase 3.2.2: load credentials, preferring sender_account_secrets ──
    // Falls back to the legacy email_provider_configs path if the
    // canonical path returns null (no sender_account match, no secrets row,
    // or no usable cred fields).
    let creds: ProviderCreds | null = null;
    if (senderAccountId) {
      creds = await loadSenderAccountCreds(supabaseAdmin, senderAccountId);
    }
    if (!creds) {
      creds = await loadProviderCreds(supabaseAdmin, userId, provider);
    }

    const senderEmail =
      from_email || creds.from_email || creds.smtp_user || "noreply@example.com";

    // 1. Create email_messages record
    const { data: emailMsg, error: msgError } = await supabaseAdmin
      .from("email_messages")
      .insert({
        lead_id: lead_id || null,
        owner_id: userId,
        workspace_id: workspaceId,
        sender_account_id: senderAccountId,
        provider,
        subject,
        to_email,
        from_email: senderEmail,
        status: "sent",
        track_opens,
        track_clicks,
      })
      .select()
      .single();

    if (msgError || !emailMsg) {
      return new Response(
        JSON.stringify({
          error: `Failed to create message record: ${msgError?.message}`,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 2. Extract and insert tracked links
    let linkRows: { id: string; destination_url: string }[] = [];
    if (track_clicks && TRACKING_BASE_URL) {
      const links = extractLinks(html_body);
      if (links.length > 0) {
        const { data: inserted } = await supabaseAdmin
          .from("email_links")
          .insert(
            links.map((l) => ({
              message_id: emailMsg.id,
              destination_url: l.url,
              link_label: l.label || null,
              link_index: l.index,
            }))
          )
          .select("id, destination_url");
        linkRows = inserted ?? [];
      }
    }

    // 3. Instrument the HTML
    const instrumentedHtml = instrumentHtml(
      html_body,
      emailMsg.id,
      linkRows,
      track_opens,
      track_clicks
    );

    // 4. Send via chosen provider
    let sendResult: {
      success: boolean;
      providerMessageId?: string;
      error?: string;
    };

    if (provider === "sendgrid") {
      sendResult = await sendViaSendGrid(
        to_email,
        senderEmail,
        subject,
        instrumentedHtml,
        creds
      );
    } else if (provider === "smtp" || provider === "gmail") {
      sendResult = await sendViaSmtp(
        to_email,
        senderEmail,
        subject,
        instrumentedHtml,
        creds
      );
    } else {
      sendResult = { success: true };
    }

    // 5. Update message record
    if (sendResult.success) {
      if (sendResult.providerMessageId) {
        await supabaseAdmin
          .from("email_messages")
          .update({
            provider_message_id: sendResult.providerMessageId,
            updated_at: new Date().toISOString(),
          })
          .eq("id", emailMsg.id);
      }

      // ── Phase 3.2.1: tick sender counters on success ──
      // Fire-and-forget. Failure to update counters must not break sending.
      if (senderAccountId) {
        supabaseAdmin.rpc("increment_sender_daily_sent", {
          p_sender_id: senderAccountId,
        }).then(({ error }) => {
          if (error) console.warn("increment_sender_daily_sent failed:", error.message);
        });
        supabaseAdmin.rpc("reset_sender_failures", {
          p_sender_id: senderAccountId,
        }).then(({ error }) => {
          if (error) console.warn("reset_sender_failures failed:", error.message);
        });
      }
    } else {
      await supabaseAdmin
        .from("email_messages")
        .update({
          status: "failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", emailMsg.id);

      // ── Phase 3.2.1: tick failure counter ──
      if (senderAccountId) {
        supabaseAdmin.rpc("increment_sender_failures", {
          p_sender_id: senderAccountId,
        }).then(({ error }) => {
          if (error) console.warn("increment_sender_failures failed:", error.message);
        });
      }
    }

    return new Response(
      JSON.stringify({
        success: sendResult.success,
        message_id: emailMsg.id,
        provider_message_id: sendResult.providerMessageId ?? null,
        error: sendResult.error ?? null,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("send-email error:", err);
    return new Response(
      JSON.stringify({ error: `Internal error: ${(err as Error).message}` }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
