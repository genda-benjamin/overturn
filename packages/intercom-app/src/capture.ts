import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

// ---------- the Intercom side: only the fields this app reads ----------

/** An author as Intercom returns it on a conversation part. */
export interface IntercomAuthor {
  type?: string | null;
  id?: string | null;
  name?: string | null;
  email?: string | null;
  /** Intercom's own word on AI involvement on this part. */
  from_ai_agent?: boolean | null;
  is_ai_answer?: boolean | null;
}

/** One message of the conversation. `part_type` is "comment" | "note" | "assignment" | ... */
export interface IntercomPart {
  id?: string | null;
  part_type?: string | null;
  body?: string | null;
  author?: IntercomAuthor | null;
  created_at?: number | null;
  redacted?: boolean | null;
}

export interface IntercomContact {
  id?: string | null;
  name?: string | null;
  email?: string | null;
  role?: string | null;
}

export interface IntercomTag {
  name?: string | null;
}

/** The conversation object Intercom sends on every Canvas Kit request. */
export interface IntercomConversation {
  id: string | number;
  title?: string | null;
  source?: { body?: string | null; subject?: string | null; author?: IntercomAuthor | null } | null;
  conversation_parts?: {
    total_count?: number | null;
    conversation_parts?: IntercomPart[] | null;
  } | null;
  /** `{ tags: [...] }` on the API model; some payloads inline the array. */
  tags?: IntercomTag[] | { tags?: IntercomTag[] | null } | null;
  custom_attributes?: unknown;
  teammates?: IntercomContact[] | null;
  contacts?: IntercomContact[] | null;
  /** Intercom's own word on whether an AI agent took part at all. */
  ai_agent_participated?: boolean | null;
}

/** A component as this app sends it; Canvas Kit ignores nothing it does not know. */
export interface CanvasComponent {
  type: string;
  [key: string]: unknown;
}

/** A canvas object: the components to show, and whatever we want handed back to us next time. */
export interface CanvasObject {
  content?: { components?: CanvasComponent[] } | null;
  stored_data?: Record<string, unknown> | null;
}

/** The Canvas Kit request body, narrowed to what this app uses. */
export interface CanvasRequest {
  workspace_id?: string | null;
  admin?: IntercomAuthor | null;
  conversation?: IntercomConversation | null;
  contact?: IntercomContact | null;
  /** The canvas the teammate is looking at, with whatever we stored on it. */
  current_canvas?: CanvasObject | null;
  /** Every input on the current canvas, by component id. */
  input_values?: Record<string, unknown> | null;
  component_id?: string | null;
}

// ---------- settings ----------

export interface AppSettings {
  baseUrl: string;
  /** Project API key. In production the host can proxy the call instead and keep this empty. */
  apiKey: string;
  /** The workflow name; one regression suite per workflow. */
  agent: string;
  /** Hold a changed capture until a reason code is picked. Never blocks the send. */
  requireReason: boolean;
  /** Which quick-pick reasons the teammate sees: the vendor-neutral support pack, or claims. */
  reasonPack: ReasonPack;
  /** Also record teammate notes, not only replies sent to the customer. */
  captureNotes: boolean;
  /** Notes/replies shorter than this never count as a draft (a typed greeting is not a draft). */
  minDraftChars: number;
  /** When set, only conversations carrying this Intercom tag are watched at all. */
  scopeTag: string | null;
  /** How many of the most recent messages ride along as context. */
  maxContextParts: number;
  /** Conversation custom attributes that are the decision, by attribute name → label. */
  decisionFields: Array<{ id: string; label: string }>;
  /** Intercom access token; when set, a partial conversation is read back in full from the API. */
  intercomToken: string;
  /** Intercom API host, for a workspace in another region. */
  intercomApiBase: string;
}

export const DEFAULT_INTERCOM_API_BASE = "https://api.intercom.io";

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  apiKey: "",
  agent: "support-reply",
  requireReason: true,
  reasonPack: "support",
  captureNotes: false,
  minDraftChars: 80,
  scopeTag: null,
  maxContextParts: 40,
  decisionFields: [],
  intercomToken: "",
  intercomApiBase: DEFAULT_INTERCOM_API_BASE,
};

/** Parses the app's configuration (strings and booleans; Intercom has no app parameters). */
export function settingsFrom(raw: Record<string, unknown>): AppSettings {
  const str = (k: string): string | null => {
    const v = raw[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const bool = (k: string, d: boolean): boolean => {
    const v = raw[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v === "true" || v === "1";
    return d;
  };
  const int = (k: string, d: number, min: number): number => {
    const n = Number(str(k) ?? "");
    return Number.isFinite(n) && n >= min ? Math.floor(n) : d;
  };
  const fields = (str("decision_fields") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, label] = s.split(":").map((x) => x.trim());
      return { id: id!, label: label || id! };
    });
  return {
    baseUrl: (str("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    apiKey: str("overturn_api_key") ?? DEFAULT_SETTINGS.apiKey,
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    reasonPack: reasonPackFrom(str("reason_pack")),
    captureNotes: bool("capture_notes", DEFAULT_SETTINGS.captureNotes),
    minDraftChars: int("min_draft_chars", DEFAULT_SETTINGS.minDraftChars, 1),
    scopeTag: str("scope_tag"),
    maxContextParts: int("max_context_parts", DEFAULT_SETTINGS.maxContextParts, 1),
    decisionFields: fields,
    intercomToken: str("intercom_token") ?? DEFAULT_SETTINGS.intercomToken,
    intercomApiBase: (str("intercom_api_base") ?? DEFAULT_SETTINGS.intercomApiBase).replace(/\/+$/, ""),
  };
}

/** Intercom keeps the tag list in either shape depending on the endpoint. */
export function tagNames(conversation: IntercomConversation): string[] {
  const raw = conversation.tags;
  const list = Array.isArray(raw) ? raw : (raw?.tags ?? []);
  return list.map((t) => (t?.name ?? "").trim()).filter(Boolean);
}

/**
 * Whether the app should watch this conversation at all. With no scope tag every conversation
 * is watched, but nothing is recorded until a draft is named (see decideOnCapture). With a scope
 * tag, a conversation without it is never recorded, not even when a teammate asks for it.
 */
export function inScope(conversation: IntercomConversation, settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tagNames(conversation).includes(settings.scopeTag);
}

// ---------- the thread ----------

/** Intercom mixes HTML into bodies; the case wants the text the human read. */
export function stripHtml(html: string): string {
  return normalizeCaptureText(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

/** Bots (Fin) answer as the team; anything we were not told about is a system message, not a guess. */
export function authorRole(type: string | null | undefined): CaptureMessage["role"] {
  switch (type) {
    case "user":
    case "lead":
    case "contact":
      return "customer";
    case "admin":
    case "team":
    case "bot":
      return "agent";
    default:
      return "system";
  }
}

function partRole(part: IntercomPart): CaptureMessage["role"] {
  const type = part.part_type ?? "";
  if (type.endsWith("note")) return "note";
  return authorRole(part.author?.type);
}

function isoAt(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function authorOf(a: IntercomAuthor | null | undefined): string | null {
  return a?.email?.trim() || a?.name?.trim() || null;
}

/** Conversation parts oldest first, skipping the ones Intercom redacted or emptied. */
export function partsOf(conversation: IntercomConversation): IntercomPart[] {
  const parts = conversation.conversation_parts?.conversation_parts ?? [];
  return parts
    .filter((p) => !p.redacted && !!p.body?.trim())
    .slice()
    .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
}

/** The thread the teammate saw, oldest first, as capture context. */
export function contextFrom(
  conversation: IntercomConversation,
  settings: Pick<AppSettings, "maxContextParts"> = DEFAULT_SETTINGS,
): CaptureMessage[] {
  const messages: CaptureMessage[] = [];
  const source = conversation.source;
  const sourceText = source?.body ? stripHtml(source.body) : "";
  if (sourceText) {
    messages.push({
      role: authorRole(source?.author?.type),
      author: authorOf(source?.author),
      content: sourceText,
      at: null,
    });
  }
  for (const part of partsOf(conversation)) {
    const content = stripHtml(part.body ?? "");
    if (!content) continue;
    messages.push({
      role: partRole(part),
      author: authorOf(part.author),
      content,
      at: isoAt(part.created_at),
    });
  }
  // The decision is about the end of the thread; keep the most recent messages.
  return messages.slice(-Math.max(1, settings.maxContextParts));
}

/** The conversation attributes an admin named as the decision, by label. */
export function fieldsFrom(
  conversation: IntercomConversation,
  settings: Pick<AppSettings, "decisionFields">,
): Record<string, unknown> {
  if (settings.decisionFields.length === 0) return {};
  const attrs = attributeRecord(conversation.custom_attributes);
  return Object.fromEntries(settings.decisionFields.map((f) => [f.label, attrs[f.id] ?? null]));
}

/** Intercom nests attributes under `custom_attributes` on some payloads and inlines them on others. */
function attributeRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const nested = (raw as Record<string, unknown>).custom_attributes;
  if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return raw as Record<string, unknown>;
}

/** What the teammate actually sent: the newest non-empty reply in the thread. */
export interface SentReply {
  text: string;
  type: "publicReply" | "note";
  at: string | null;
}

export function sentFrom(conversation: IntercomConversation): SentReply | null {
  for (const part of partsOf(conversation).reverse()) {
    const role = partRole(part);
    if (role !== "agent" && role !== "note") continue;
    return {
      text: stripHtml(part.body ?? ""),
      type: role === "note" ? "note" : "publicReply",
      at: isoAt(part.created_at),
    };
  }
  return null;
}

/** A link back to the conversation, only when Intercom told us the workspace. */
export function conversationUrl(
  conversation: IntercomConversation,
  workspaceId: string | null | undefined,
): string | null {
  if (!workspaceId) return null;
  return `https://app.intercom.com/a/inbox/${workspaceId}/inbox/conversation/${conversation.id}`;
}

/**
 * What Intercom itself says about AI involvement. The composer is never exposed, but these
 * flags are: they cannot tell us the draft's text, and they do not pretend to. They say whether
 * the AI agent wrote the body of the last reply that went out, and whether Fin took part at all.
 */
export interface AiSignals {
  /** `author.is_ai_answer` on the newest reply: the AI agent generated that body. */
  answerGenerated: boolean;
  /** `author.from_ai_agent` on the newest reply: the AI agent sent it. */
  sentByAgent: boolean;
  /** `ai_agent_participated` on the conversation. */
  participated: boolean;
}

export function aiSignals(conversation: IntercomConversation): AiSignals {
  const reply = [...partsOf(conversation)].reverse().find((p) => {
    const role = partRole(p);
    return role === "agent" || role === "note";
  });
  return {
    answerGenerated: reply?.author?.is_ai_answer === true,
    sentByAgent: reply?.author?.from_ai_agent === true,
    participated: conversation.ai_agent_participated === true,
  };
}

// ---------- draft detection ----------

/**
 * Where the draft came from. Intercom never shows an app the reply composer, so the app only
 * claims what it was told and says `unknown` otherwise: guessing an origin is worse than saying
 * we do not know. "ai" = an assist inserted it (an SDK-recorded run, or the teammate says Fin
 * wrote it), "manual" = the teammate says they wrote it themselves, "unknown" = they said a
 * draft is there without saying who wrote it.
 */
export type DraftOrigin = "ai" | "manual" | "unknown";

/** How we came to know about the draft; recorded as metadata, never used to guess the origin. */
export type DraftEvidence = "recorded" | "fin" | "assist" | "typed" | "not-stated";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  evidence: DraftEvidence;
  at: number;
  runId?: string | null;
  model?: string | null;
  /** The decision fields as they read when the draft appeared, so a later change is visible. */
  fields?: Record<string, unknown> | null;
}

/** The `draft:*` tag the scorecard reads. */
export function draftTag(origin: DraftOrigin): string {
  return `draft:${origin}`;
}

/** A draft the teammate named by hand, in the canvas. */
export function draftFromTeammate(
  text: string,
  origin: DraftOrigin,
  evidence: DraftEvidence,
  now = Date.now(),
  fields: Record<string, unknown> = {},
): DraftState {
  return { text: normalizeCaptureText(text), origin, evidence, at: now, fields };
}

/** A draft an assist recorded with the Overturn SDK; the run is the source of truth. */
export function draftFromRun(
  run: { id: string; output: string; model?: string | null },
  now = Date.now(),
  fields: Record<string, unknown> = {},
): DraftState {
  return {
    text: normalizeCaptureText(run.output),
    origin: "ai",
    evidence: "recorded",
    at: now,
    runId: run.id,
    model: run.model ?? null,
    fields,
  };
}

/** Anything reply-sized is worth naming; a typed greeting is not a draft. */
export function isDraftSized(text: string, settings: Pick<AppSettings, "minDraftChars">): boolean {
  return normalizeCaptureText(text).length >= settings.minDraftChars;
}

/** The keys this app stores on the canvas so the next request can see them again. */
export const STORED_DRAFT_KEY = "overturn_draft";
export const STORED_ISSUE_KEY = "overturn_issue";

/** `stored_data` accepts strings; everything is JSON under one key so a bad value cannot throw. */
export function storeDraft(draft: DraftState): Record<string, string> {
  return { [STORED_DRAFT_KEY]: JSON.stringify(draft) };
}

export function storedDraft(current: CanvasRequest["current_canvas"]): DraftState | null {
  const raw = current?.stored_data?.[STORED_DRAFT_KEY];
  const parsed = typeof raw === "string" ? safeJson(raw) : raw;
  if (!parsed || typeof parsed !== "object") return null;
  const d = parsed as Partial<DraftState>;
  if (typeof d.text !== "string" || !d.text.trim()) return null;
  const origin: DraftOrigin = d.origin === "ai" || d.origin === "manual" ? d.origin : "unknown";
  const evidence: DraftEvidence =
    d.evidence === "recorded" || d.evidence === "fin" || d.evidence === "assist" || d.evidence === "typed"
      ? d.evidence
      : "not-stated";
  return {
    text: normalizeCaptureText(d.text),
    origin,
    evidence,
    at: typeof d.at === "number" ? d.at : 0,
    ...(typeof d.runId === "string" ? { runId: d.runId } : {}),
    ...(typeof d.model === "string" ? { model: d.model } : {}),
    ...(d.fields && typeof d.fields === "object" ? { fields: d.fields as Record<string, unknown> } : {}),
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------- the decision ----------

export interface PendingSend {
  text: string;
  type: "publicReply" | "note";
  /** When the reply landed in the thread, when Intercom said. */
  at?: string | null;
}

export type CaptureDecision =
  | { action: "skip"; why: "empty" | "no-draft" | "note" | "out-of-scope" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/**
 * What to do when the teammate records the capture. Pure: the Canvas Kit glue only forwards the
 * answer. Nothing here can stop Intercom from sending a reply, so with `require_reason` on a
 * changed capture is held back — and said so in the canvas — until a reason code is picked.
 */
export function decideOnCapture(input: {
  conversation: IntercomConversation;
  draft: DraftState | null;
  sent: PendingSend | null;
  /** The reason code the teammate picked; required for a changed capture when requireReason is on. */
  reasonCode: string | null;
  /** Optional free-text note. */
  reason: string;
  actor: string | null;
  workspaceId?: string | null;
  settings: AppSettings;
  /** When the teammate recorded it; with the draft's `at`, how long it sat in front of them. */
  now?: number;
}): CaptureDecision {
  const { conversation, draft, sent, settings } = input;
  if (!inScope(conversation, settings)) return { action: "skip", why: "out-of-scope" };
  if (!draft || !normalizeCaptureText(draft.text)) return { action: "skip", why: "no-draft" };
  if (!sent || !stripHtml(sent.text)) return { action: "skip", why: "empty" };
  if (sent.type === "note" && !settings.captureNotes) return { action: "skip", why: "note" };

  const hasFields = settings.decisionFields.length > 0;
  const currentFields = fieldsFrom(conversation, settings);
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields ? { fields: draft.fields ?? currentFields } : {}),
  };
  const sentAnswer: CaptureAnswer = {
    text: stripHtml(sent.text),
    ...(hasFields ? { fields: currentFields } : {}),
  };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;
  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const body: CaptureCreate = {
    source: "intercom",
    externalId: `ic:${conversation.id}`,
    agent: settings.agent,
    actor: input.actor,
    subject: subjectFrom(conversation),
    context: contextFrom(conversation, settings),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: reason || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend: Math.max(0, Math.round(((input.now ?? Date.now()) - draft.at) / 100) / 10),
    draftRunId: draft.runId ?? null,
    draftModel: draft.model ?? null,
    url: conversationUrl(conversation, input.workspaceId),
    tags: [draftTag(draft.origin), sent.type === "note" ? "internal-note" : "public-reply"],
    metadata: {
      workspace: input.workspaceId ?? null,
      requester: requesterOf(conversation),
      draftEvidence: draft.evidence,
      sentAt: sent.at ?? null,
    },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

function subjectFrom(conversation: IntercomConversation): string | null {
  return conversation.source?.subject?.trim() || conversation.title?.trim() || null;
}

function requesterOf(conversation: IntercomConversation): string | null {
  const c = conversation.contacts?.[0];
  return c?.email?.trim() || c?.name?.trim() || authorOf(conversation.source?.author);
}

// ---------- canvas copy ----------

export function wordCount(text: string): number {
  const t = normalizeCaptureText(text);
  return t ? t.split(/\s+/).length : 0;
}

/** Short status line for the canvas. */
export function statusLine(
  draft: DraftState | null,
  last: { changed: boolean; dedup: boolean } | null,
): string {
  if (last) {
    if (!last.changed) return "Sent as drafted · approved";
    return last.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!draft) return "Waiting for the draft";
  const words = wordCount(draft.text);
  if (draft.origin === "ai") return `Draft inserted · ${words} words`;
  if (draft.origin === "manual") return `Draft typed by you · ${words} words`;
  return `Draft · ${words} words · origin not stated`;
}

/** One line on where the draft came from, so the teammate can see why the tag is what it is. */
export function originLine(draft: DraftState | null): string | null {
  if (!draft) return null;
  switch (draft.evidence) {
    case "recorded":
      return `From the drafting run${draft.model ? ` (${draft.model})` : ""}, recorded with the Overturn SDK.`;
    case "fin":
      return "You said an assist wrote it, and Intercom says the AI agent generated the last reply: draft:ai.";
    case "assist":
      return "You said an assist (Fin or another AI draft) wrote it: recorded as draft:ai.";
    case "typed":
      return "You said you wrote it: recorded as draft:manual.";
    default:
      return "Nobody said who wrote it: recorded as draft:unknown, never guessed.";
  }
}

/** The chips the teammate clicks, for the installed pack. */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
