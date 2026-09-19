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
const admin = createClient(SUPABASE_URL, SERVICE_KEY);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const normalizePhone = (value = "") => value.split("@")[0]?.replace(/\D/g, "") || "";
const isValidIndividualPhone = (value = "") => /^[1-9][0-9]{7,14}$/.test(value) && !value.includes("-");
const remoteJid = (item: any) => item?.id || item?.remoteJid || item?.jid || item?.key?.remoteJid || "";
const valueArray = (value: any) => Array.isArray(value) ? value : value?.chats || value?.contacts || value?.messages || value?.data || [];

const fetchProfilePicture = async (instance: string, phone: string) => {
  try {
    const response = await evolution(`/chat/fetchProfilePictureUrl/${encodeURIComponent(instance)}`, { number: phone });
    return response.data?.profilePictureUrl || response.data?.profilePicUrl || null;
  } catch {
    return null;
  }
};

const evolution = async (path: string, body: Record<string, unknown>) => {
  const response = await fetch(`${EVOLUTION_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: EVOLUTION_KEY },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: response.ok, data };
};

const persistHistoricalMedia = async (instance: string, key: any, userId: string, kind: string) => {
  if (!key || !["image", "audio", "video", "document", "sticker"].includes(kind)) return null;
  try {
    const response = await evolution(`/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`, { message: { key }, convertToMp4: kind === "video" });
    const base64 = String(response.data?.base64 || "").replace(/^data:[^;]+;base64,/, "");
    if (!response.ok || !base64) return null;
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const extension = kind === "audio" ? "ogg" : kind === "video" ? "mp4" : kind === "sticker" ? "webp" : "jpg";
    const contentType = kind === "audio" ? "audio/ogg" : kind === "video" ? "video/mp4" : kind === "sticker" ? "image/webp" : "image/jpeg";
    const path = `${userId}/inbox/history/${key.id}.${extension}`;
    const upload = await admin.storage.from("store-assets").upload(path, bytes, { contentType, upsert: true });
    return upload.error ? null : { url: admin.storage.from("store-assets").getPublicUrl(path).data.publicUrl, path };
  } catch { return null; }
};

const detectMessage = (message: any) => {
  const content = message?.message || message;
  const text = content?.conversation || content?.extendedTextMessage?.text || content?.imageMessage?.caption || content?.videoMessage?.caption || "";
  if (content?.audioMessage) return { kind: "audio", text };
  if (content?.imageMessage) return { kind: "image", text };
  if (content?.videoMessage) return { kind: "video", text };
  if (content?.documentMessage) return { kind: "document", text };
  if (content?.stickerMessage) return { kind: "sticker", text: "" };
  return { kind: "text", text };
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const authorization = req.headers.get("Authorization");
    const requestBody = await req.clone().json().catch(() => ({}));
    const internal = req.headers.get("x-internal-sync") === SERVICE_KEY && authorization === `Bearer ${SERVICE_KEY}`;
    if (!internal && !authorization?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authorization || "" } } });
    const { data: auth, error: authError } = internal ? { data: { user: { id: String(requestBody?.userId || "") } }, error: null } : await userClient.auth.getUser();
    if (authError || !auth.user?.id) return json({ error: "Unauthorized" }, 401);

    const actorUserId = auth.user.id;
    const { data: member } = await admin.from("business_members").select("business_id,role,status").eq("user_id", actorUserId).maybeSingle();
    if (member && member.status !== "active") return json({ error: "member_inactive" }, 403);
    const { data: owner } = member?.role === "attendant"
      ? await admin.from("business_members").select("user_id").eq("business_id", member.business_id).eq("role", "owner").eq("status", "active").single()
      : { data: null };
    const userId = owner?.user_id || actorUserId;
    const requestedInstance = String(requestBody?.instanceName || "");
    const { data: instance } = await admin.from("instances").select("instance_name").eq("user_id", userId).eq(requestedInstance ? "instance_name" : "user_id", requestedInstance || userId).maybeSingle();
    const instanceName = instance?.instance_name as string | undefined;
    if (!instanceName) return json({ error: "whatsapp_instance_not_connected" }, 409);

    const [chatsResponse, contactsResponse] = await Promise.all([
      evolution(`/chat/findChats/${encodeURIComponent(instanceName)}`, { where: {} }),
      evolution(`/chat/findContacts/${encodeURIComponent(instanceName)}`, { where: {} }),
    ]);
    if (!chatsResponse.ok && !contactsResponse.ok) return json({ error: "whatsapp_sync_failed" }, 502);

    const contactsByPhone = new Map<string, any>();
    for (const item of valueArray(contactsResponse.data)) {
      const phone = normalizePhone(remoteJid(item));
      if (phone) contactsByPhone.set(phone, item);
    }

    let conversations = 0;
    let messages = 0;
    for (const chat of valueArray(chatsResponse.data)) {
      const jid = remoteJid(chat);
      const isGroup = jid.endsWith("@g.us");
      const phone = isGroup ? jid : normalizePhone(jid);
      if (!phone || jid.includes("@broadcast")) continue;
      if (!isGroup && (!jid.endsWith("@s.whatsapp.net") || !isValidIndividualPhone(phone))) continue;
      const profile = contactsByPhone.get(phone);
      const name = chat?.name || chat?.pushName || profile?.pushName || profile?.name || profile?.notify || null;
      const profilePictureUrl = chat?.profilePictureUrl || chat?.profilePicUrl || profile?.profilePictureUrl || profile?.profilePicUrl || await fetchProfilePicture(instanceName, phone);
      const lastMessageAt = chat?.conversationTimestamp ? new Date(Number(chat.conversationTimestamp) * 1000).toISOString() : chat?.updatedAt || new Date().toISOString();
      const { data: contact } = await admin.from("whatsapp_contacts").upsert({ user_id: userId, instance_name: instanceName, remote_jid: jid, is_group: isGroup, phone_number: phone, name, profile_picture_url: profilePictureUrl, last_message_at: lastMessageAt }, { onConflict: "user_id,instance_name,phone_number" }).select("id").single();
      if (!contact?.id) continue;
      await admin.from("inbox_conversations").upsert({ user_id: userId, instance_name: instanceName, contact_id: contact.id, last_message_at: lastMessageAt }, { onConflict: "user_id,instance_name,contact_id", ignoreDuplicates: false });
      conversations += 1;

      const history = await evolution(`/chat/findMessages/${encodeURIComponent(instanceName)}`, { where: { key: { remoteJid: jid } }, page: 1, offset: 500 });
      for (const item of valueArray(history.data)) {
        const messageId = item?.key?.id || item?.id;
        if (!messageId) continue;
        const existing = await admin.from("messages").select("id").eq("user_id", userId).eq("external_id", messageId).maybeSingle();
        if (existing.data) continue;
        const detected = detectMessage(item);
        const storedMedia = await persistHistoricalMedia(instanceName, item?.key, userId, detected.kind);
        const timestamp = item?.messageTimestamp ? new Date(Number(item.messageTimestamp) * 1000).toISOString() : new Date().toISOString();
        await admin.from("messages").insert({ user_id: userId, phone_number: phone, direction: item?.key?.fromMe ? "outbound" : "inbound", kind: detected.kind, message_text: detected.text || null, media_url: storedMedia?.url || null, storage_path: storedMedia?.path || null, external_id: messageId, whatsapp_instance_id: instanceName, delivery_status: item?.key?.fromMe ? "sent" : "delivered", created_at: timestamp, media_metadata: { external_id: messageId, is_group: isGroup } });
        await admin.from("n8n_chat_histories").insert({ user_id: userId, phone_number: phone, session_id: `${userId}_${phone}`, message: { type: item?.key?.fromMe ? "human" : "user", data: { content: detected.text || "", kind: detected.kind, external_id: messageId } }, created_at: timestamp });
        messages += 1;
      }
    }
    return json({ ok: true, conversations, messages });
  } catch (error) {
    console.error("inbox-sync error", error);
    return json({ error: error instanceof Error ? error.message : "internal" }, 500);
  }
});
