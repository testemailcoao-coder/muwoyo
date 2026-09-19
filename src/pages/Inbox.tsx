import { useEffect, useMemo, useRef, useState } from "react";
import DashboardShell from "@/components/DashboardShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Paperclip,
  Image as ImageIcon,
  Send,
  Check,
  CheckCheck,
  Mic,
  FileText,
  MoreVertical,
  Smile,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { usePlanEntitlements } from "@/hooks/usePlanEntitlements";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useBusinessMembership } from "@/hooks/useBusinessMembership";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import DateTimeSelect from "@/components/DateTimeSelect";

const db = supabase as any;
type Conversation = {
  id: string;
  contact_id: string;
  status: string;
  assigned_to: string | null;
  instance_name?: string | null;
  is_group?: boolean;
  unread_count: number;
  last_message_at: string | null;
  response_mode?: "ai" | "human";
  contact?: {
    name: string | null;
    phone_number: string;
    profile_picture_url?: string | null;
    is_group?: boolean;
  };
};
type Message = {
  id: string;
  direction: string;
  message_text: string | null;
  ai_responded: boolean;
  created_at: string;
  kind?: string;
  media_url?: string | null;
  media_metadata?: { latitude?: number; longitude?: number; address?: string; name?: string } | null;
  delivery_status?: string | null;
  external_id?: string | null;
};

export default function Inbox() {
  const { user } = useAuth();
  const { membership, ownerUserId } = useBusinessMembership();
  const { entitlements, planName, loading } = usePlanEntitlements();
  const { toast } = useToast();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [instances, setInstances] = useState<{ instance_name: string; phone: string | null; connection_state: string | null }[]>([]);
  const [activeInstance, setActiveInstance] = useState("");
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [typing, setTyping] = useState(false);
  const [contactState, setContactState] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState(false);
  const [showCustomer, setShowCustomer] = useState(true);
  const [quickAction, setQuickAction] = useState<
    "order" | "appointment" | null
  >(null);
  const [quickForm, setQuickForm] = useState({
    service: "",
    item: "",
    scheduled_at: "",
    notes: "",
    location: "",
    price: "",
    quantity: "1",
  });
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaCaption, setMediaCaption] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupSubject, setGroupSubject] = useState("");
  const [groupParticipants, setGroupParticipants] = useState<string[]>([]);
  const [recording, setRecording] = useState(false);
  const [recordingPaused, setRecordingPaused] = useState(false);
  const [recordingPreviewUrl, setRecordingPreviewUrl] = useState<string | null>(
    null,
  );
  const recorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const discardRecordingRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef<Conversation | null>(null);

  const load = async () => {
    if (!user || !ownerUserId) return;
    const { data: instanceRows } = await db.from("instances").select("instance_name,phone,connection_state").eq("user_id", ownerUserId).order("created_at");
    const nextInstances = instanceRows || [];
    setInstances(nextInstances);
    const instanceName = activeInstance || nextInstances[0]?.instance_name;
    if (!instanceName) return;
    if (!activeInstance) setActiveInstance(instanceName);
    let conversationsQuery = db
      .from("inbox_conversations")
      .select("id,contact_id,status,assigned_to,unread_count,last_message_at,response_mode,instance_name")
      .eq("user_id", ownerUserId)
      .eq("instance_name", instanceName)
      .order("last_message_at", { ascending: false, nullsFirst: false });
    if (membership?.role === "attendant") conversationsQuery = conversationsQuery.eq("assigned_to", user.id);
    const [{ data: rows }, { data: contacts }] = await Promise.all([
      conversationsQuery,
      db
        .from("whatsapp_contacts")
        .select("id,name,phone_number,profile_picture_url,is_group")
        .eq("user_id", ownerUserId)
        .eq("instance_name", instanceName),
    ]);
    const contactMap = new Map(
      (contacts || []).map(
        (contact: {
          id: string;
          name: string | null;
          phone_number: string;
          is_group?: boolean;
        }) => [contact.id, contact],
      ),
    );
    setConversations(
      (rows || []).map((row: Conversation) => ({
        ...row,
        contact: contactMap.get(row.contact_id),
      })),
    );
  };

  const syncInbox = async () => {
    if (!user || !ownerUserId) return;
    await supabase.functions.invoke("inbox-sync", { body: { instanceName: activeInstance || undefined } });
  };

  useEffect(() => {
    void syncInbox();
    void load();
    if (!user || !ownerUserId) return;
    const channel = supabase
      .channel(`inbox-${user.id}`, { config: { presence: { key: user.id } } })
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "inbox_conversations",
          filter: `user_id=eq.${ownerUserId}`,
        },
        () => void load(),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "messages",
          filter: `user_id=eq.${ownerUserId}`,
        },
        (payload) => {
          if (selectedRef.current && (payload.new as Message)?.id)
            void loadMessages(selectedRef.current);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "inbox_contact_presence",
          filter: `user_id=eq.${ownerUserId}`,
        },
        (payload) => {
          const presence = payload.new as {
            phone_number?: string;
            state?: string;
          };
          if (
            presence.phone_number === selectedRef.current?.contact?.phone_number
          ) {
            setContactState(presence.state || null);
            setTyping(presence.state === "typing");
          }
        },
      )
      .on("presence", { event: "sync" }, () => {
        const states = channel.presenceState();
        const entries = Object.values(states).flat() as any[];
        const remote = entries.find((entry) => entry.user_id !== user.id);
        setTyping(Boolean(remote?.typing));
        setContactState(remote?.state || null);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED")
          await channel.track({
            user_id: user.id,
            typing: false,
            state: "online",
          });
      });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [user, ownerUserId, membership?.role, activeInstance]);

  const loadMessages = async (conversation: Conversation) => {
    if (!user || !ownerUserId) return;
    const { data } = await db
      .from("messages")
      .select(
        "id,direction,message_text,ai_responded,created_at,kind,media_url,media_metadata,delivery_status,external_id",
      )
      .eq("user_id", ownerUserId)
      .eq("phone_number", conversation.contact?.phone_number || "")
      .order("created_at", { ascending: false })
      .limit(100);
    setMessages((data || []).reverse());
    await db
      .from("inbox_conversations")
      .update({ unread_count: 0 })
      .eq("id", conversation.id)
      .eq("user_id", ownerUserId);
    setConversations((current) =>
      current.map((item) =>
        item.id === conversation.id ? { ...item, unread_count: 0 } : item,
      ),
    );
  };

  const selectConversation = (conversation: Conversation) => {
    selectedRef.current = conversation;
    setSelected(conversation);
    void loadMessages(conversation);
  };
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!mediaFile) {
      setRecordingPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(mediaFile);
    setRecordingPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [mediaFile]);

  const toggleRecording = async () => {
    if (recording && recorderRef.current) {
      if (recordingPaused) {
        recorderRef.current.resume();
        setRecordingPaused(false);
      } else {
        recorderRef.current.pause();
        const previewBlob = new Blob(recordingChunksRef.current, { type: recorderRef.current.mimeType || "audio/webm" });
        if (previewBlob.size) setRecordingPreviewUrl(URL.createObjectURL(previewBlob));
        setRecordingPaused(true);
      }
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recordingChunksRef.current = chunks;
    discardRecordingRef.current = false;
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onstop = () => {
      if (discardRecordingRef.current) {
        setRecording(false);
        setRecordingPaused(false);
        recorderRef.current = null;
        return;
      }
      const blob = new Blob(chunks, {
        type: recorder.mimeType || "audio/webm",
      });
      setMediaFile(
        new File([blob], `voice-${Date.now()}.webm`, { type: blob.type }),
      );
      setRecording(false);
      setRecordingPaused(false);
      recorderRef.current = null;
    };
    mediaStreamRef.current = stream;
    recorderRef.current = recorder;
    recorder.start();
    setRecording(true);
    setRecordingPaused(false);
  };

  const finishRecording = () => {
    recorderRef.current?.stop();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
  };

  const cancelRecording = () => {
    discardRecordingRef.current = true;
    recorderRef.current?.stop();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    recorderRef.current = null;
    setRecording(false);
    setRecordingPaused(false);
    setMediaFile(null);
  };
  const visible = useMemo(
    () =>
      conversations.filter((conversation) => {
        const term = search.toLowerCase();
        const matchesSearch =
          `${conversation.contact?.name || ""} ${conversation.contact?.phone_number || ""}`
            .toLowerCase()
            .includes(term);
        const matchesFilter =
          filter === "unread"
            ? conversation.unread_count > 0
            : filter === "mine"
              ? conversation.assigned_to === user?.id
              : filter === "unassigned"
                ? !conversation.assigned_to
                : filter === "ai"
                  ? conversation.status !== "human"
                  : filter === "human"
                    ? conversation.status === "human"
                    : filter === "resolved"
                      ? conversation.status === "closed"
                      : true;
        return matchesSearch && matchesFilter;
      }),
    [conversations, filter, search, user],
  );

  const assignToMe = async () => {
    if (!selected || !user || !ownerUserId) return;
    const { error } = await db
      .from("inbox_conversations")
      .update({ assigned_to: user.id, status: "human" })
      .eq("id", selected.id)
      .eq("user_id", ownerUserId);
    if (error)
      return toast({
        title: "Não foi possível atribuir a conversa",
        description: error.message,
        variant: "destructive",
      });
    setSelected({ ...selected, assigned_to: user.id });
    await load();
  };

  const toggleAi = async () => {
    if (!selected || !user || !ownerUserId) return;
    if (selected.is_group) return toast({ title: "A IA não responde a grupos", description: "Grupos ficam disponíveis apenas no Inbox." });
    const nextMode = selected.response_mode === "human" ? "ai" : "human";
    const { error } = await db
      .from("inbox_conversations")
      .update({ response_mode: nextMode })
      .eq("id", selected.id)
      .eq("user_id", ownerUserId);
    if (error)
      return toast({
        title: "Não foi possível alterar o atendimento",
        description: error.message,
        variant: "destructive",
      });
    setSelected({
      ...selected,
      response_mode: nextMode,
    });
    await load();
  };

  const resolveConversation = async () => {
    if (!selected || !user || !ownerUserId) return;
    await db
      .from("inbox_conversations")
      .update({ status: "closed" })
      .eq("id", selected.id)
      .eq("user_id", ownerUserId);
    setSelected({ ...selected, status: "closed" });
    await load();
  };

  const createQuickAction = async () => {
    if (!selected?.contact || !user || !quickAction) return;
    if (quickAction === "appointment" && !quickForm.scheduled_at) return;
    const result =
      quickAction === "appointment"
        ? await db
            .from("appointments")
            .insert({
              user_id: user.id,
              customer_name: selected.contact.name,
              customer_phone: selected.contact.phone_number,
              service: quickForm.service || "Atendimento",
              description: quickForm.notes || null,
              notes: quickForm.notes || null,
              location: quickForm.location || null,
              price: quickForm.price ? Number(quickForm.price) : null,
              scheduled_at: new Date(quickForm.scheduled_at).toISOString(),
              status: "confirmed",
            })
        : await db
            .from("store_orders")
            .insert({
              user_id: user.id,
              customer_name: selected.contact.name,
              customer_phone: selected.contact.phone_number,
              customer_location: quickForm.location || null,
              items: [
                { name: quickForm.item || "Pedido criado no Inbox", qty: Math.max(1, Number(quickForm.quantity) || 1), unit_price: Number(quickForm.price) || 0 },
              ],
              total: (Number(quickForm.price) || 0) * Math.max(1, Number(quickForm.quantity) || 1),
              delivery_address: quickForm.location || null,
              notes: quickForm.notes || null,
              status: "new",
            });
    if (result.error)
      return toast({
        title: "Não foi possível criar",
        description: result.error.message,
        variant: "destructive",
      });
    setQuickAction(null);
    setQuickForm({ service: "", item: "", scheduled_at: "", notes: "", location: "", price: "", quantity: "1" });
    toast({
      title:
        quickAction === "appointment" ? "Agendamento criado" : "Pedido criado",
    });
  };

  const publishTyping = async (value: string) => {
    setText(value);
    const channel = supabase
      .getChannels()
      .find((item) => item.topic === `realtime:inbox-${user?.id}`);
    if (channel && user)
      await channel.track({
        user_id: user.id,
        typing: Boolean(value.trim()),
        state: value.trim() ? "typing" : "online",
      });
  };

  const send = async () => {
    if (!selected || !user || (!text.trim() && !mediaFile)) return;
    setSending(true);
    const { data: instance } = await db
      .from("instances")
      .select("instance_name")
      .eq("user_id", ownerUserId || user.id)
      .eq("instance_name", activeInstance)
      .maybeSingle();
    if (!instance?.instance_name) {
      setSending(false);
      return toast({
        title: "WhatsApp não conectado",
        description: "Conecte o WhatsApp antes de enviar mensagens.",
        variant: "destructive",
      });
    }
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
      setSending(false);
      return toast({
        title: "Sessão expirada",
        description: "Faça login novamente para enviar mensagens.",
        variant: "destructive",
      });
    }
    let mediaUrl = "";
    if (mediaFile) {
      const path = `${user.id}/${Date.now()}-${mediaFile.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const upload = await supabase.storage
        .from("store-assets")
        .upload(path, mediaFile, {
          upsert: false,
          contentType: mediaFile.type,
        });
      if (upload.error) {
        setSending(false);
        return toast({
          title: "Não foi possível carregar o ficheiro",
          description: upload.error.message,
          variant: "destructive",
        });
      }
      mediaUrl = supabase.storage.from("store-assets").getPublicUrl(path)
        .data.publicUrl;
    }
    const kind = mediaFile
      ? mediaFile.type.startsWith("image/")
        ? "image"
        : mediaFile.type.startsWith("video/")
          ? "video"
          : mediaFile.type.startsWith("audio/")
            ? "audio"
            : "document"
      : "text";
    const { error } = await supabase.functions.invoke("inbox-send", {
        body: {
        instanceName: instance.instance_name,
        phoneNumber: selected.contact?.phone_number,
        messageText: text.trim(),
        caption: mediaCaption || text.trim(),
        kind,
        mediaUrl,
        fileName: mediaFile?.name,
        mimetype: mediaFile?.type,
      },
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    setSending(false);
    if (error)
      return toast({
        title: "Não foi possível enviar",
        description: error.message,
        variant: "destructive",
      });
    setText("");
    setMediaCaption("");
    setMediaFile(null);
    await loadMessages(selected);
  };

  const sendReaction = async (message: Message, reaction: string) => {
    if (!selected || !user || !ownerUserId || !message.external_id) return;
    const { data: instance } = await db.from("instances").select("instance_name").eq("user_id", ownerUserId).maybeSingle();
    if (!instance?.instance_name) return;
    const { error } = await supabase.functions.invoke("inbox-send", { body: { instanceName: instance.instance_name, phoneNumber: selected.contact?.phone_number, kind: "reaction", reaction, messageKey: { id: message.external_id, remoteJid: `${selected.contact?.phone_number}@s.whatsapp.net`, fromMe: message.direction === "outbound" } } });
    if (error) toast({ title: "Não foi possível reagir", description: error.message, variant: "destructive" });
  };

  const conversationAction = async (action: "archive" | "block" | "delete") => {
    if (!selected || !activeInstance) return;
    const { error } = await supabase.functions.invoke("inbox-actions", { body: { action, instanceName: activeInstance, phoneNumber: selected.contact?.phone_number } });
    if (error) return toast({ title: "Ação não concluída", description: error.message, variant: "destructive" });
    if (action === "delete") { setSelected(null); selectedRef.current = null; }
    await load();
  };

  const createGroup = async () => {
    if (!activeInstance || !groupSubject.trim() || groupParticipants.length < 1) return;
    const { error } = await supabase.functions.invoke("inbox-actions", { body: { action: "create_group", instanceName: activeInstance, subject: groupSubject, participants: groupParticipants } });
    if (error) return toast({ title: "Não foi possível criar o grupo", description: error.message, variant: "destructive" });
    setGroupOpen(false); setGroupSubject(""); setGroupParticipants([]); toast({ title: "Grupo criado" });
    await syncInbox(); await load();
  };

  if (loading)
    return (
      <DashboardShell title="Inbox" description="A carregar acesso...">
        A carregar...
      </DashboardShell>
    );
  if (!entitlements.inbox)
    return (
      <DashboardShell
        title="Inbox"
        description="Centro de conversas do negócio."
      >
        <Card>
          <CardContent className="p-6">
            A Inbox não está disponível no plano atual: {planName}.
          </CardContent>
        </Card>
      </DashboardShell>
    );

  return (
    <DashboardShell
      wide
      title={entitlements.sharedInbox ? "Shared Inbox" : "Inbox"}
      description="Converse com clientes e acompanhe o contexto do CRM."
    >
      <div
        data-inbox
        data-has-selection={selected ? "true" : "false"}
        className="grid h-[calc(100vh-10.5rem)] min-h-[560px] gap-3 overflow-hidden lg:grid-cols-[minmax(230px,30%)_minmax(0,70%)]"
      >
        <Card className="inbox-conversation-list min-h-0 min-w-0 overflow-hidden border-0 shadow-none">
          <CardHeader className="shrink-0 px-2 py-3">
            <div className="flex items-center justify-between gap-2"><CardTitle className="text-sm">Conversas</CardTitle><Button size="sm" className="h-7 px-2 text-[11px]" onClick={() => void syncInbox()}>Importar conversas</Button></div>
            {instances.length > 1 && <select className="h-8 rounded-md border bg-background px-2 text-xs" value={activeInstance} onChange={(event) => { setActiveInstance(event.target.value); setSelected(null); setMessages([]); }}>{instances.map((instance) => <option key={instance.instance_name} value={instance.instance_name}>{instance.phone || instance.instance_name}</option>)}</select>}
            <Input
              className="h-8 text-xs"
              placeholder="Pesquisar nome ou número"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="inbox-filters flex gap-1 overflow-x-auto pb-1">
              <Button
                className="h-7 shrink-0 px-2 text-[11px]"
                size="sm"
                variant={filter === "all" ? "default" : "outline"}
                onClick={() => setFilter("all")}
              >
                Todas
              </Button>
              <Button
                className="h-7 shrink-0 px-2 text-[11px]"
                size="sm"
                variant={filter === "unread" ? "default" : "outline"}
                onClick={() => setFilter("unread")}
              >
                Não lidas
              </Button>
              <Button
                className="h-7 shrink-0 px-2 text-[11px]"
                size="sm"
                variant={filter === "mine" ? "default" : "outline"}
                onClick={() => setFilter("mine")}
              >
                Minhas
              </Button>
              <Button
                className="h-7 shrink-0 px-2 text-[11px]"
                size="sm"
                variant={filter === "unassigned" ? "default" : "outline"}
                onClick={() => setFilter("unassigned")}
              >
                Sem dono
              </Button>
              <Button
                className="h-7 shrink-0 px-2 text-[11px]"
                size="sm"
                variant={filter === "ai" ? "default" : "outline"}
                onClick={() => setFilter("ai")}
              >
                IA
              </Button>
              <Button
                className="h-7 shrink-0 px-2 text-[11px]"
                size="sm"
                variant={filter === "human" ? "default" : "outline"}
                onClick={() => setFilter("human")}
              >
                Humano
              </Button>
            </div>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto px-2">
            {visible.map((conversation) => (
              <button
                type="button"
                key={conversation.id}
                onClick={() => selectConversation(conversation)}
                className={`inbox-conversation-row w-full p-2 text-left ${selected?.id === conversation.id ? "is-selected" : ""}`}
              >
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#d7b98e] text-xs font-semibold text-[#4a3d31]">
                    {conversation.contact?.profile_picture_url ? (
                      <img
                        src={conversation.contact.profile_picture_url}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      (
                        conversation.contact?.name ||
                        conversation.contact?.phone_number ||
                        "?"
                      )
                        .slice(0, 1)
                        .toUpperCase()
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {conversation.contact?.name ||
                          conversation.contact?.phone_number}
                      </span>
                      {conversation.unread_count > 0 && (
                        <Badge className="h-5 min-w-5 px-1 text-[10px]">
                          {conversation.unread_count}
                        </Badge>
                      )}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {conversation.contact?.phone_number} ·{" "}
                      {conversation.assigned_to
                        ? "Atribuída"
                        : "Sem responsável"}
                    </div>
                  </div>
                </div>
              </button>
            ))}
            {visible.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Nenhuma conversa encontrada.
              </div>
            )}
          </CardContent>
        </Card>
        <Card className="inbox-chat-panel flex min-h-0 min-w-0 flex-col overflow-hidden border-[#d8d0c4] bg-[#efeae2]">
          <CardHeader className="shrink-0 border-b border-[#d8d0c4] bg-[#f7f3ed] py-2">
            <div className="flex items-center gap-2">
              <Button
                className="lg:hidden"
                variant="ghost"
                size="icon"
                onClick={() => setSelected(null)}
                aria-label="Voltar para conversas"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                disabled={!selected}
                onClick={() => selected && setProfileOpen(true)}
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#d7b98e] text-sm font-semibold text-[#4a3d31]">
                  {selected?.contact?.profile_picture_url ? (
                    <img
                      src={selected.contact.profile_picture_url}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    (
                      selected?.contact?.name ||
                      selected?.contact?.phone_number ||
                      "?"
                    )
                      .slice(0, 1)
                      .toUpperCase()
                  )}
                </div>
                <div className="min-w-0">
                  <CardTitle className="truncate text-sm">
                    {selected?.contact?.name ||
                      selected?.contact?.phone_number ||
                      "Selecione uma conversa"}
                  </CardTitle>
                  {selected && (
                    <div className="truncate text-[11px] text-[#756b62]">
                      {typing
                        ? "A escrever..."
                        : contactState === "recording"
                          ? "A gravar áudio..."
                          : contactState === "online"
                            ? "online"
                            : selected.response_mode === "human" || selected.status === "human"
                              ? "Atendimento humano"
                              : "Muwoyo IA"}{" "}
                      · {selected.contact?.phone_number}
                    </div>
                  )}
                </div>
              </button>
              {selected && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="Ações da conversa"><MoreVertical className="h-4 w-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setProfileOpen(true)}>Abrir perfil</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => ownerUserId && void db.from("inbox_conversations").update({ unread_count: 1 }).eq("id", selected.id).eq("user_id", ownerUserId).then(() => void load())}>Marcar como não lida</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void toggleAi()}>{selected.response_mode === "human" || selected.status === "human" ? "Devolver para IA" : "Minha resposta"}</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void resolveConversation()}>Resolver conversa</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void conversationAction("archive")}>Arquivar conversa</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void conversationAction("block")}>Bloquear contacto</DropdownMenuItem>
                    <DropdownMenuItem className="text-destructive" onClick={() => void conversationAction("delete")}>Eliminar conversa</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-2 bg-[radial-gradient(#d8d0c4_0.7px,transparent_0.7px)] [background-size:16px_16px]">
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-1 py-2">
              {selected ? (
                messages.map((message) => (
                  <div
                    key={message.id}
                    className={`flex ${message.direction === "outbound" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[78%] rounded-lg px-2.5 py-1.5 text-sm shadow-sm ${message.direction === "outbound" ? "rounded-br-sm bg-[#d9fdd3] text-[#26342a]" : "rounded-bl-sm bg-white text-[#2e2b28]"}`}
                    >
                      {message.external_id && <div className="mb-1 flex justify-end gap-1 opacity-0 transition-opacity hover:opacity-100"><button type="button" className="text-xs" onClick={() => void sendReaction(message, "👍")}>👍</button><button type="button" className="text-xs" onClick={() => void sendReaction(message, "❤️")}>❤️</button><button type="button" className="text-xs" onClick={() => void sendReaction(message, "😂")}>😂</button></div>}
                      {message.media_url && message.kind === "image" && (
                        <img
                          src={message.media_url}
                          alt="Imagem enviada"
                          className="mb-1 max-h-72 rounded object-cover"
                        />
                      )}
                      {message.media_url && message.kind === "video" && (
                        <video
                          src={message.media_url}
                          controls
                          className="mb-1 max-h-72 rounded"
                        />
                      )}
                      {message.media_url && message.kind === "audio" && (
                        <audio
                          src={message.media_url}
                          controls
                          className="mb-1 w-full"
                        />
                      )}
                      {message.media_url && message.kind === "document" && (
                        <a
                          href={message.media_url}
                          target="_blank"
                          rel="noreferrer"
                          className="mb-1 flex items-center gap-2 text-xs underline"
                        >
                          <FileText className="h-4 w-4" /> Abrir documento
                        </a>
                      )}
                      {message.media_url && message.kind === "sticker" && <img src={message.media_url} alt="Sticker" className="mb-1 max-h-40 max-w-40 object-contain" />}
                      {message.kind === "location" && message.media_metadata?.latitude && message.media_metadata?.longitude && <a className="mb-1 block text-xs underline" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${message.media_metadata.latitude},${message.media_metadata.longitude}`}>Abrir localização{message.media_metadata.address ? ` · ${message.media_metadata.address}` : ""}</a>}
                      {message.message_text && <div>{message.message_text}</div>}
                      <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-[#748178]">
                        {new Date(message.created_at).toLocaleTimeString(
                          "pt-AO",
                          { hour: "2-digit", minute: "2-digit" },
                        )}
                        {message.direction === "outbound" &&
                          (message.delivery_status === "read" ? (
                            <CheckCheck className="h-3 w-3 text-[#53a548]" />
                          ) : message.delivery_status === "delivered" ? (
                            <CheckCheck className="h-3 w-3" />
                          ) : (
                            <Check className="h-3 w-3" />
                          ))}
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <p className="m-auto text-sm text-[#756b62]">
                  Escolha uma conversa para ver o histórico.
                </p>
              )}
              <div ref={messagesEndRef} />
            </div>
            {selected && (
              <div className="sticky bottom-0 rounded-lg border border-[#d8d0c4] bg-[#f7f3ed] p-1.5">
                <div className="flex items-center gap-1">
                  <div className="relative"><Button className="h-8 w-8" size="icon" variant="ghost" aria-label="Adicionar emoji" onClick={() => setEmojiOpen((value) => !value)}><Smile className="h-4 w-4" /></Button>{emojiOpen && <div className="absolute bottom-10 left-0 z-30 grid w-56 grid-cols-8 gap-1 rounded-md border bg-background p-2 shadow-lg">{["😀","😂","😍","😊","👍","❤️","🎉","🙏","😢","😮","🔥","✨","👏","✅","💬","📍"].map((emoji) => <button type="button" key={emoji} className="rounded p-1 text-lg hover:bg-accent" onClick={() => { setText((value) => `${value}${emoji}`); setEmojiOpen(false); }}>{emoji}</button>)}</div>}</div>
                  <label
                    className="cursor-pointer rounded-full p-1.5 text-[#5d6d61] hover:bg-[#e8e1d7]"
                    title="Anexar imagem, vídeo, áudio ou documento"
                  >
                    <Paperclip className="h-4 w-4" />
                    <input
                      type="file"
                      className="hidden"
                      accept="image/*,video/*,audio/*,.pdf,.doc,.docx"
                      onChange={(event) =>
                        setMediaFile(event.target.files?.[0] || null)
                      }
                    />
                  </label>
                  <Input
                    className="h-8 border-0 bg-white text-sm shadow-none focus-visible:ring-0"
                    value={text}
                    onChange={(event) => void publishTyping(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                    placeholder={
                      recording
                        ? "A gravar áudio..."
                        : mediaFile
                          ? mediaFile.name
                          : "Escrever mensagem"
                    }
                  />
                  <Button
                    className="h-8 w-8"
                    size="icon"
                    variant={recording ? "destructive" : "ghost"}
                    onClick={() => void toggleRecording()}
                    aria-label={recording ? (recordingPaused ? "Continuar gravação" : "Pausar gravação") : "Gravar áudio"}
                  >
                    {recording ? (recordingPaused ? "▶" : "Ⅱ") : <Mic className="h-4 w-4" />}
                  </Button>
                  {recording && <><Button className="h-8 px-2 text-[11px]" size="sm" variant="outline" onClick={finishRecording}>Usar áudio</Button><Button className="h-8 px-2 text-[11px]" size="sm" variant="ghost" onClick={cancelRecording}>Cancelar</Button></>}
                  {recording && recordingPaused && recordingPreviewUrl && <audio src={recordingPreviewUrl} controls className="h-8 max-w-32" />}
                  <Button
                    className="h-8 w-8 rounded-full bg-[#128c7e] hover:bg-[#0d766a]"
                    size="icon"
                    disabled={sending || (!text.trim() && !mediaFile)}
                    onClick={() => void send()}
                  >
                    {sending ? (
                      <Mic className="h-4 w-4 animate-pulse" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                {mediaFile && (
                  <div className="mt-2 space-y-2 rounded-md border bg-white/70 p-2 text-xs text-[#5d6d61]">
                    {mediaFile.type.startsWith("image/") && recordingPreviewUrl && <img src={recordingPreviewUrl} alt="Pré-visualização" className="max-h-36 max-w-full rounded object-contain" />}
                    {mediaFile.type.startsWith("video/") && recordingPreviewUrl && <video src={recordingPreviewUrl} controls className="max-h-36 max-w-full rounded" />}
                    {mediaFile.type.startsWith("audio/") && recordingPreviewUrl && <audio src={recordingPreviewUrl} controls className="w-full" />}
                    <div className="flex items-center gap-2"><ImageIcon className="h-4 w-4" />{mediaFile.name}
                    <Input
                      className="h-7"
                      placeholder="Legenda"
                      value={mediaCaption}
                      onChange={(event) => setMediaCaption(event.target.value)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setMediaFile(null)}
                    >
                      Remover
                    </Button>
                  </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      {selected && (
        <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Perfil do cliente</DialogTitle>
              <DialogDescription>
                Dados reais do contacto e ações da conversa.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-full bg-[#d7b98e] text-xl font-semibold">
                  {selected.contact?.profile_picture_url ? <img src={selected.contact.profile_picture_url} alt="" className="h-full w-full object-cover" /> : (
                    selected.contact?.name || selected.contact?.phone_number || "?"
                  ).slice(0, 1).toUpperCase()}
                </div>
                <div>
                  <div className="text-lg font-semibold">
                    {selected.contact?.name || "Sem nome"}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {selected.contact?.phone_number}
                  </div>
                </div>
              </div>
              <div className="grid gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Estado:</span>{" "}
                  {selected.response_mode === "human" || selected.status === "human"
                    ? "Atendimento humano"
                    : selected.status === "closed"
                      ? "Resolvida"
                      : "IA ativa"}
                </div>
                <div>
                  <span className="text-muted-foreground">Não lidas:</span>{" "}
                  {selected.unread_count}
                </div>
                <div>
                  <span className="text-muted-foreground">
                    Última interação:
                  </span>{" "}
                  {selected.last_message_at
                    ? new Date(selected.last_message_at).toLocaleString("pt-AO")
                    : "-"}
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  onClick={() => {
                    void toggleAi();
                    setProfileOpen(false);
                  }}
                >
                  {selected.response_mode === "human" || selected.status === "human"
                    ? "Devolver à IA"
                    : "Assumir atendimento"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    void resolveConversation();
                    setProfileOpen(false);
                  }}
                >
                  {selected.status === "closed" ? "Reabrir" : "Resolver"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setQuickAction("order");
                    setProfileOpen(false);
                  }}
                >
                  Criar pedido
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setQuickAction("appointment");
                    setProfileOpen(false);
                  }}
                >
                  Agendar
                </Button>
                <Button variant="outline" onClick={() => { setProfileOpen(false); setGroupOpen(true); }}>Criar grupo</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
      <Dialog open={groupOpen} onOpenChange={setGroupOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Criar grupo WhatsApp</DialogTitle></DialogHeader>
          <div className="space-y-3"><Input placeholder="Nome do grupo" value={groupSubject} onChange={(event) => setGroupSubject(event.target.value)} /><div className="max-h-56 overflow-y-auto rounded border p-2">{conversations.map((conversation) => { const phone = conversation.contact?.phone_number || ""; return <label key={conversation.id} className="flex items-center gap-2 border-b py-2 text-sm last:border-0"><input type="checkbox" checked={groupParticipants.includes(phone)} onChange={(event) => setGroupParticipants(event.target.checked ? [...groupParticipants, phone] : groupParticipants.filter((item) => item !== phone))} />{conversation.contact?.name || phone}</label>; })}</div><Button onClick={() => void createGroup()}>Criar grupo</Button></div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(quickAction)}
        onOpenChange={(open) => !open && setQuickAction(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {quickAction === "appointment"
                ? "Novo agendamento"
                : "Novo pedido"}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            {quickAction === "appointment" ? (
              <>
                <Input
                  placeholder="Serviço"
                  value={quickForm.service}
                  onChange={(event) =>
                    setQuickForm({ ...quickForm, service: event.target.value })
                  }
                />
                <DateTimeSelect
                  value={quickForm.scheduled_at}
                  onChange={(scheduled_at) =>
                    setQuickForm({ ...quickForm, scheduled_at })
                  }
                  required
                />
              </>
            ) : (
              <Input
                placeholder="Produto ou descrição"
                value={quickForm.item}
                onChange={(event) =>
                  setQuickForm({ ...quickForm, item: event.target.value })
                }
              />
            )}
            <Textarea
              placeholder="Nota interna"
              value={quickForm.notes}
              onChange={(event) =>
                setQuickForm({ ...quickForm, notes: event.target.value })
              }
            />
            <Button onClick={() => void createQuickAction()}>Criar</Button>
          </div>
        </DialogContent>
      </Dialog>
    </DashboardShell>
  );
}
