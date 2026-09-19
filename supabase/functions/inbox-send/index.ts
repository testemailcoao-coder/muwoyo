import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EVOLUTION_URL = (Deno.env.get("EVOLUTION_API_URL") || "https://api.muwoyo.com").replace(/\/+$/, "");
const EVOLUTION_KEY = Deno.env.get("EVOLUTION_API_KEY") || "";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

const evoFetch = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${EVOLUTION_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", apikey: EVOLUTION_KEY, ...(init.headers || {}) },
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Unauthorized" }, 401);

    const actorUserId = userData.user.id;
    const { data: actorMember } = await admin.from("business_members").select("business_id,role,status").eq("user_id", actorUserId).maybeSingle();
    if (actorMember && (actorMember.status !== "active" || (actorMember.role === "attendant" && !(await admin.rpc("has_business_permission", { p_permission: "inbox.send", p_business_id: actorMember.business_id })).data))) return json({ error: "inbox_send_not_allowed" }, 403);
    const { data: ownerMember } = actorMember?.role === "attendant" ? await admin.from("business_members").select("user_id").eq("business_id", actorMember.business_id).eq("role", "owner").eq("status", "active").single() : { data: null };
    const userId = ownerMember?.user_id || actorUserId;
    const body = await req.json().catch(() => ({}));
    const targetPhone = String(body?.phoneNumber || "").replace(/\D/g, "");
    const kind = String(body?.kind || body?.mediaType || "text");
    const text = typeof body?.messageText === "string" ? body.messageText.trim() : "";

    if (!targetPhone) return json({ error: "missing_fields" }, 400);

    const requestedInstance = String(body?.instanceName || "");
    const { data: instanceRow } = await admin.from("instances").select("instance_name,connection_state,status").eq("user_id", userId).eq(requestedInstance ? "instance_name" : "user_id", requestedInstance || userId).maybeSingle();
    const instanceName = instanceRow?.instance_name as string | undefined;
    if (!instanceName || !["open", "connected"].includes(String(instanceRow?.connection_state || instanceRow?.status))) {
      return json({ error: "whatsapp_disconnected" }, 409);
    }
    const { data: contact } = await admin.from("whatsapp_contacts").select("id").eq("user_id", userId).eq("phone_number", targetPhone).maybeSingle();
    if (!contact) return json({ error: "contact_not_owned" }, 403);
    const { data: targetContact } = await admin.from("whatsapp_contacts").select("is_group,remote_jid").eq("id", contact.id).maybeSingle();
    if (targetContact?.is_group || String(targetContact?.remote_jid || "").endsWith("@g.us")) return json({ error: "group_messages_not_allowed" }, 403);
    if (actorMember?.role === "attendant") {
      const { data: conversation } = await admin.from("inbox_conversations").select("assigned_to").eq("user_id", userId).eq("contact_id", contact.id).maybeSingle();
      if (conversation?.assigned_to !== actorUserId) return json({ error: "conversation_not_assigned" }, 403);
    }

    let sent: any = null;
    const payloadBase = { number: targetPhone } as Record<string, any>;

    if (kind === "text") {
      if (!text) return json({ error: "missing_text" }, 400);
      sent = await evoFetch(`/message/sendText/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: JSON.stringify({ ...payloadBase, text }),
      });
    } else if (kind === "location") {
      sent = await evoFetch(`/message/sendLocation/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: JSON.stringify({ ...payloadBase, name: String(body?.name || ""), address: String(body?.address || ""), latitude: Number(body?.latitude), longitude: Number(body?.longitude) }),
      });
    } else if (kind === "sticker") {
      sent = await evoFetch(`/message/sendSticker/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: JSON.stringify({ ...payloadBase, sticker: String(body?.mediaUrl || body?.sticker || "") }),
      });
    } else if (kind === "reaction") {
      sent = await evoFetch(`/message/sendReaction/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: JSON.stringify({ ...payloadBase, reaction: String(body?.reaction || ""), key: body?.messageKey }),
      });
    } else {
      const mediaUrl = String(body?.mediaUrl || "");
      const caption = typeof body?.caption === "string" ? body.caption : text;
      const fileName = String(body?.fileName || "media");

      if (kind === "audio") {
        const audioPayload = mediaUrl ? { ...payloadBase, audio: mediaUrl, caption } : { ...payloadBase, audio: body?.audioBase64 || body?.base64 || "", caption };
        sent = await evoFetch(`/message/sendWhatsAppAudio/${encodeURIComponent(instanceName)}`, {
          method: "POST",
          body: JSON.stringify(audioPayload),
        });
      } else {
        sent = await evoFetch(`/message/sendMedia/${encodeURIComponent(instanceName)}`, {
          method: "POST",
          body: JSON.stringify({
            ...payloadBase,
            media: mediaUrl || body?.mediaUrl || "",
            mediatype: kind,
            ...(caption ? { caption } : {}),
            fileName,
            mimetype: String(body?.mimetype || "application/octet-stream"),
            type: kind,
          }),
        });
      }
    }

    if (!sent || !sent.ok) return json({ error: "whatsapp_send_failed", details: sent?.data || null }, 502);

    if (kind !== "reaction") await admin.from("messages").insert({
      user_id: userId,
      phone_number: targetPhone,
      message_text: (text || (kind !== "text" ? String(body?.caption || "") : "")).slice(0, 4000),
      direction: "outbound",
      kind,
      media_url: body?.mediaUrl || null,
      storage_path: body?.storagePath || null,
      mime_type: body?.mimetype || null,
      file_name: body?.fileName || null,
      is_voice_note: kind === "audio",
      media_metadata: { caption: body?.caption || null, name: body?.fileName || null },
      delivery_status: "sent",
      whatsapp_instance_id: instanceName,
      external_id: sent.data?.key?.id || null,
    });
    await admin.from("n8n_chat_histories").insert({
      user_id: userId,
      phone_number: targetPhone,
      session_id: `${userId}_${targetPhone}`,
      message: { type: "human", data: { content: text || String(body?.caption || ""), kind, media_url: body?.mediaUrl || null } },
    });

    return json({ ok: true, data: sent.data });
  } catch (e: any) {
    console.error("inbox-send error", e);
    return json({ error: e?.message || "internal" }, 500);
  }
});
