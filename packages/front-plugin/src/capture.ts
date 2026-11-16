import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/**
 * The pieces of Front the plugin reads, declared structurally so the payload builder stays
 * testable without the SDK: an `ApplicationConversation`, `ApplicationDraft`, `ApplicationMessage`
 * or `ApplicationComment` is assignable to these.
 */
export interface FrontRecipientLike {
  handle: string;
  name?: string | undefined;
}

export interface FrontTagLike {
  name: string;
}

/** A conversation custom attribute (`ApplicationCustomAttribute`). */
export interface FrontAttributeLike {
  id: string;
  name: string;
  value: unknown;
}

export interface FrontConversationLike {
  id: string;
  subject?: string | undefined;
  /** Main recipient of the conversation: the customer. */
  recipient?: FrontRecipientLike | undefined;
  tags: ReadonlyArray<FrontTagLike>;
  customFieldAttributes: ReadonlyArray<FrontAttributeLike>;
  /** ID of the draft in the composer, if any. A draft is a message that has not been sent yet. */
  draftId?: string | undefined;
}

export interface FrontMessageLike {
  id?: string | undefined;
  status: "inbound" | "outbound";
  /** Front leaves this undefined when it has not loaded the body; a draft has none. */
  content?: { body: string; type: "html" | "text" } | undefined;
  from?: FrontRecipientLike | undefined;
  /** Undefined for a draft. */
  date?: Date | string | undefined;
}

export interface FrontCommentLike {
  id?: string | undefined;
  /** Markdown, as the comment composer writes it. */
  content: { body: string };
  author?: { name?: string | undefined; email?: string | undefined } | undefined;
  createdAt?: Date | string | undefined;
}

export interface FrontDraftLike {
  id: string;
  content: { body: string; type: "html" | "text" };
}

/**
 * The slice of a Front context this plugin reads: one conversation selected. Front hands the
 * read functions back on the context itself, so the plugin calls the ones it was given instead
 * of reaching for the latest context on the `Front` object.
 */
export interface SingleContextLike {
  type: "singleConversation";
  teammate: { email: string; name?: string | undefined };
  conversation: FrontConversationLike;
  /** The composer's draft on this conversation, or undefined once Front has no such draft. */
  fetchDraft(draftId: string): Promise<FrontDraftLike | undefined>;
  /** The messages of this conversation. */
  listMessages(): Promise<{ results: ReadonlyArray<FrontMessageLike> }>;
  /** The comments (internal notes) of this conversation. */
  listComments(): Promise<{ results: ReadonlyArray<FrontCommentLike> }>;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Do not record a changed reply until a reason code is picked (claims pack default). */
  requireReason: boolean;
  /** Also send the conversation's comments as internal notes in the captured context. */
  captureComments: boolean;
  /** Custom attributes that *are* the decision, by name (or id): `status,reserve,denial_reason`. */
  decisionFields: string[];
  /** Composer text shorter than this never counts as a draft (a typed greeting is not a draft). */
  minDraftChars: number;
  /** When set, the plugin watches only conversations carrying this tag; every other one is never read. */
  scopeTag: string | null;
  /** Which quick-pick reasons the teammate sees: the claims pack or the vendor-neutral support pack. */
  reasonPack: ReasonPack;
  /**
   * Project API key, read from the plugin URL. When set, the capture goes straight to
   * `POST /v1/capture`; without it the request is relayed through Front, which holds the
   * credential as the app's security scheme.
   */
  apiKey: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  captureComments: false,
  decisionFields: [],
  minDraftChars: 80,
  scopeTag: null,
  reasonPack: "support",
  apiKey: null,
};

/**
 * Parses the plugin's settings. Front plugins have no settings object like a ZAF app has: the
 * admin configures the plugin URL in the developer app, so the settings ride in its query string
 * (`?overturn_api_key=…&agent=claims-reply&reason_pack=claims`).
 */
export function settingsFrom(params: Record<string, string | null | undefined>): AppSettings {
  const str = (k: string): string | null => {
    const v = params[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const bool = (k: string, d: boolean): boolean => {
    const v = params[k];
    if (typeof v !== "string") return d;
    return v === "true" || v === "1";
  };
  const min = Number(str("min_draft_chars") ?? "");
  return {
    baseUrl: (str("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    captureComments: bool("capture_comments", DEFAULT_SETTINGS.captureComments),
    decisionFields: (str("decision_fields") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    scopeTag: str("scope_tag"),
    reasonPack: reasonPackFrom(str("reason_pack")),
    apiKey: str("overturn_api_key"),
  };
}

/**
 * Whether the plugin should watch this conversation at all. With no scope tag every conversation
 * is watched, but nothing is read beyond the composer draft until a draft appears (see watch.ts).
 * With a scope tag, conversations without it are never read.
 */
export function inScope(tags: readonly string[], settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tags.includes(settings.scopeTag);
}

/**
 * Where the draft came from. The composer is watched while a draft exists: the first time the
 * draft goes from (nearly) empty to a reply-sized text in one change, that text was inserted
 * (an AI assist, a snippet, a paste), not typed, and it is the draft. The teammate can also mark
 * the current text as the draft by hand.
 */
export type DraftOrigin = "inserted" | "manual" | "preloaded";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  at: number;
}

export interface DraftDetector {
  /** Feed every composer value; returns a draft the first time one appears. */
  onComposer(text: string, now?: number): DraftState | null;
  current(): DraftState | null;
  set(d: DraftState | null): void;
}

export function createDraftDetector(opts: { minDraftChars: number; typingWindowMs?: number }): DraftDetector {
  const window = opts.typingWindowMs ?? 1500;
  let draft: DraftState | null = null;
  let last = { text: "", at: 0 };
  let seen = false;
  return {
    onComposer(text, now = Date.now()) {
      const prev = last;
      const firstSight = !seen;
      seen = true;
      last = { text, at: now };
      if (draft) return null;
      const grew = text.length - prev.text.length;
      // A jump of reply size in one change (or a reply-sized composer on first sight).
      const jump =
        grew >= opts.minDraftChars && (prev.text.length < opts.minDraftChars / 2 || now - prev.at > window);
      const first = firstSight && text.length >= opts.minDraftChars;
      if (jump || first) {
        draft = { text, origin: first ? "preloaded" : "inserted", at: now };
        return draft;
      }
      return null;
    },
    current: () => draft,
    set: (d) => {
      draft = d;
    },
  };
}

export type EntryKind = "inbound" | "outbound" | "comment";

/** One message or comment of the conversation, after the SDK has been read. */
export interface ConversationEntry {
  id: string | null;
  body: string;
  kind: EntryKind;
  /** What the SDK handed back: messages as html or text, comments as markdown. */
  format: "html" | "text" | "markdown";
  authorName: string | null;
  authorHandle: string | null;
  /** ISO 8601; null when Front did not date the entry (a draft). */
  at: string | null;
}

export interface ConversationSnapshot {
  id: string;
  subject: string | null;
  recipientEmail: string | null;
  recipientName: string | null;
  /** Oldest first: the thread the teammate saw when they answered. */
  entries: ConversationEntry[];
  /** The attributes the admin chose as decision fields, by label. */
  fields: Record<string, unknown>;
  url: string | null;
}

function iso(at: Date | string | null | undefined): string | null {
  if (at === null || at === undefined) return null;
  const date = at instanceof Date ? at : new Date(at);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function jsonValue(v: unknown): unknown {
  return v instanceof Date ? v.toISOString() : v;
}

/** The text the teammate reads: html through the tag stripper, markdown and text as they are. */
function textOf(part: { body: string; format: "html" | "text" | "markdown" }): string {
  return part.format === "html" ? stripHtml(part.body) : normalizeCaptureText(part.body);
}

/**
 * Messages and comments as one thread, oldest first. A draft has no date, and an empty body is
 * not a turn: either way it stays out of the captured context, while the send that follows a
 * draft does not.
 */
export function entriesFrom(
  messages: readonly FrontMessageLike[],
  comments: readonly FrontCommentLike[] = [],
): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  for (const m of messages) {
    const content = m.content;
    const at = iso(m.date);
    if (!content || !textOf({ body: content.body, format: content.type }).trim() || !at) continue;
    entries.push({
      id: m.id ?? null,
      body: content.body,
      kind: m.status,
      format: content.type,
      authorName: m.from?.name ?? null,
      authorHandle: m.from?.handle ?? null,
      at,
    });
  }
  for (const c of comments) {
    const at = iso(c.createdAt);
    if (!textOf({ body: c.content.body, format: "markdown" }).trim() || !at) continue;
    entries.push({
      id: c.id ?? null,
      body: c.content.body,
      kind: "comment",
      format: "markdown",
      authorName: c.author?.name ?? null,
      authorHandle: c.author?.email ?? null,
      at,
    });
  }
  return entries.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
}

/** The newest message the teammate sent at or after the draft appeared, if any. */
export function sentFrom(
  entries: readonly ConversationEntry[],
  since: number | null = null,
): ConversationEntry | null {
  let newest: ConversationEntry | null = null;
  for (const e of entries) {
    if (e.kind !== "outbound" || !e.at) continue;
    if (since !== null && Date.parse(e.at) < since) continue;
    if (!newest || e.at > (newest.at ?? "")) newest = e;
  }
  return newest;
}

/** The conversation's decision fields, by the label the admin configured. */
export function fieldsFrom(
  conversation: FrontConversationLike,
  names: readonly string[],
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const name of names) {
    const attribute = conversation.customFieldAttributes.find((a) => a.name === name || a.id === name);
    fields[name] = attribute ? jsonValue(attribute.value) : null;
  }
  return fields;
}

/** The decision fields as they stood at this moment, or none when the admin configured none. */
export function conversationFields(
  conversation: FrontConversationLike,
  settings: AppSettings,
): Record<string, unknown> {
  return settings.decisionFields.length > 0 ? fieldsFrom(conversation, settings.decisionFields) : {};
}

export function snapshotFrom(input: {
  conversation: FrontConversationLike;
  messages: readonly FrontMessageLike[];
  comments?: readonly FrontCommentLike[];
  fields?: Record<string, unknown>;
  /** The Front web app origin, from `location.ancestorOrigins[0]`. */
  origin?: string | null;
}): ConversationSnapshot {
  const { conversation } = input;
  const origin = input.origin?.replace(/\/+$/, "") ?? null;
  return {
    id: conversation.id,
    subject: conversation.subject ?? null,
    recipientEmail: conversation.recipient?.handle ?? null,
    recipientName: conversation.recipient?.name ?? null,
    entries: entriesFrom(input.messages, input.comments ?? []),
    fields: input.fields ?? {},
    url: origin ? `${origin}/open/${conversation.id}` : null,
  };
}

function role(e: ConversationEntry): CaptureMessage["role"] {
  if (e.kind === "comment") return "note";
  return e.kind === "outbound" ? "agent" : "customer";
}

/** The thread the teammate saw, oldest first, as capture context. */
export function contextFrom(conversation: ConversationSnapshot): CaptureMessage[] {
  return conversation.entries.map((e) => ({
    role: role(e),
    author: e.authorHandle ?? e.authorName ?? null,
    content: textOf(e),
    at: e.at,
  }));
}

/** Front hands email bodies back as HTML; the case wants the text the human read. */
export function stripHtml(html: string): string {
  return normalizeCaptureText(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

/** The text of a draft as the teammate reads it in the composer. */
export function draftText(draft: FrontDraftLike): string {
  return textOf({ body: draft.content.body, format: draft.content.type });
}

export interface PendingSend {
  /** What the teammate actually sent. */
  text: string;
  /** The message it came from, for the panel. */
  messageId?: string | null;
  /** Who sent it, when Front says: a reply another teammate sent is not this teammate's capture. */
  authorHandle?: string | null;
  fields: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "empty" | "no-draft" | "someone-else" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; body: CaptureCreate; changed: true; changedFields: string[] };

function sameActor(authorHandle: string | null | undefined, actor: string | null): boolean {
  if (!authorHandle || !actor) return true;
  return authorHandle.toLowerCase() === actor.toLowerCase();
}

/**
 * What to do once the draft has left the composer: the teammate sent it, or closed it. Pure —
 * the SDK glue only forwards the answer.
 */
export function decideOnSend(input: {
  conversation: ConversationSnapshot;
  draft: DraftState | null;
  draftFields: Record<string, unknown>;
  send: PendingSend;
  /** The picked reason code, required for a changed reply when requireReason is on. */
  reasonCode: string | null;
  /** Optional free-text note. */
  reason: string;
  actor: string | null;
  settings: AppSettings;
  /** When the send was seen; with the draft's `at`, gives how long it sat in front of the teammate. */
  now?: number;
}): SendDecision {
  const { conversation, draft, send, settings } = input;
  const sentText = stripHtml(send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (!draft) return { action: "skip", why: "no-draft" };
  if (!sameActor(send.authorHandle, input.actor)) return { action: "skip", why: "someone-else" };

  const hasFields = settings.decisionFields.length > 0;
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields ? { fields: input.draftFields } : {}),
  };
  const sentAnswer: CaptureAnswer = { text: sentText, ...(hasFields ? { fields: send.fields } : {}) };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;
  const body: CaptureCreate = {
    source: "front",
    externalId: `fr:${conversation.id}`,
    agent: settings.agent,
    actor: input.actor,
    subject: conversation.subject,
    context: contextFrom(conversation),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: reason || null,
    // A code only counts when something actually changed; a note never flips an approval.
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend: Math.max(0, Math.round(((input.now ?? Date.now()) - draft.at) / 100) / 10),
    draftRunId: null,
    draftModel: null,
    url: conversation.url,
    tags: [`draft:${draft.origin}`, "public-reply"],
    metadata: { recipient: conversation.recipientEmail ?? conversation.recipientName ?? null },
  };
  if (diff.changed && settings.requireReason && !reasonCode) {
    // Front's plugin SDK has no pre-send hook, so the send has already happened by the time the
    // plugin sees it: the capture is held and posted the moment the reason arrives, rather than
    // recording a change nobody explained.
    return { action: "need-reason", body, changed: true, changedFields: diff.changedFields };
  }
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/** What the panel says about the last thing that happened. */
export type PanelResult =
  | { kind: "captured"; changed: boolean; dedup: boolean; caseTitle: string | null }
  | { kind: "held" }
  | { kind: "failed"; detail: string };

/** Short status line for the panel. */
export function statusLine(draft: DraftState | null, last: PanelResult | null): string {
  if (last) {
    if (last.kind === "held") return "Changed · pick why before Overturn records it";
    if (last.kind === "failed") return `Not recorded (${last.detail}) · the reply went out`;
    if (!last.changed) return "Sent as drafted · approved";
    return last.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!draft) return "Waiting for a draft";
  const trimmed = draft.text.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  const from = {
    inserted: "inserted",
    manual: "marked by you",
    preloaded: "found in the composer",
  }[draft.origin];
  return `Draft ${from} · ${words} words`;
}

/** The chips the teammate clicks, for the installed pack. */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
