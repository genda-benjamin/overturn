import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  conversationFields,
  createDraftDetector,
  type DraftState,
  decideOnSend,
  draftText,
  entriesFrom,
  type FrontCommentLike,
  type FrontDraftLike,
  type FrontMessageLike,
  inScope,
  type PanelResult,
  type SingleContextLike,
  sentFrom,
  snapshotFrom,
  statusLine,
} from "./capture";

/**
 * The one thing the watcher needs from the plugin SDK besides the context itself: the capture
 * call. Mocking this is how the watcher is tested.
 */
export type CapturePost = (body: CaptureCreate) => Promise<CaptureResult>;

export interface WatcherState {
  /** One line for the panel. */
  status: string;
  /** The draft Overturn would record, once one landed. */
  draft: DraftState | null;
  /** A changed reply whose capture is waiting for a reason (`require_reason`). */
  held: boolean;
  /** False when there is nothing to watch: no conversation selected, or out of scope. */
  watching: boolean;
  last: PanelResult | null;
}

export interface Watcher {
  /** A context update from `Front.contextUpdates`; null for every context that is not one conversation. */
  onContext(context: SingleContextLike | null): Promise<void>;
  /** Called on a timer while a draft is open: sees the teammate's edits and the draft going away. */
  poll(): Promise<void>;
  /** "Use the current text as the draft": the teammate says this text is the draft. */
  markDraft(): Promise<void>;
  /** The reason chips and the optional note. True when a held capture went out with them. */
  pickReason(code: string | null, note: string): Promise<boolean>;
  state(): WatcherState;
}

/** Front pushes a draft into the composer and takes it away only through context updates, so the
 *  plugin also reads the open draft on a timer. */
export const POLL_INTERVAL_MS = 1500;

export interface WatcherOptions {
  /** `POST /v1/capture`, however this install authenticates it. */
  post: CapturePost;
  settings: AppSettings;
  /** The Front web app origin, used to link the case back to the conversation. */
  origin?: string | null;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

function describe(error: unknown): string {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return `HTTP ${status}`;
  }
  const message = error instanceof Error ? error.message : "";
  return message ? message.slice(0, 80) : "network";
}

export function createWatcher(opts: WatcherOptions): Watcher {
  const now = opts.now ?? ((): number => Date.now());
  const log = opts.log ?? ((message: string, error?: unknown): void => console.error(message, error ?? ""));
  const detector = createDraftDetector({ minDraftChars: opts.settings.minDraftChars });

  let context: SingleContextLike | null = null;
  let draftId: string | null = null;
  /** When the draft appeared in front of the teammate. */
  let draftAt: number | null = null;
  /** The decision fields as the draft left them, before the teammate touched anything. */
  let draftFields: Record<string, unknown> = {};
  let held: CaptureCreate | null = null;
  let last: PanelResult | null = null;
  let reasonCode: string | null = null;
  let note = "";

  const scoped = (): boolean =>
    context !== null &&
    inScope(
      context.conversation.tags.map((t) => t.name),
      opts.settings,
    );

  function clearDraftState(): void {
    draftId = null;
    draftAt = null;
    detector.set(null);
  }

  /**
   * An empty composer is the baseline that makes the next reply-sized text read as an insert
   * rather than as text that was already there when the plugin loaded.
   */
  function primeEmpty(): void {
    if (detector.current() !== null) return;
    detector.onComposer("", now());
  }

  /** Remembers what the panel should say, unless a capture is still waiting for a reason. */
  function forget(): void {
    if (held === null) last = null;
  }

  /** Reads the open draft into the detector. False means the draft is not in the composer any more. */
  async function readDraft(): Promise<boolean> {
    const ctx = context;
    if (!ctx || !draftId) return false;
    let draft: FrontDraftLike | undefined;
    try {
      draft = await ctx.fetchDraft(draftId);
    } catch (error) {
      // The conversation can change under us; the next context update settles it.
      log("overturn: could not read the draft", error);
      return true;
    }
    if (!draft) return false;
    detector.onComposer(draftText(draft), now());
    return true;
  }

  async function post(body: CaptureCreate): Promise<boolean> {
    try {
      const result = await opts.post(body);
      last = {
        kind: "captured",
        changed: result.changed,
        dedup: result.deduplicated,
        caseTitle: result.case?.title ?? null,
      };
      // This reply used the reason; the next one starts clean.
      reasonCode = null;
      note = "";
      return true;
    } catch (error) {
      // A failed capture never blocks the teammate's work; it says so and gets out of the way.
      log("overturn: capture failed", error);
      last = { kind: "failed", detail: describe(error) };
      return false;
    }
  }

  /** The draft left the composer: the teammate sent it, or closed it without sending. */
  async function record(): Promise<void> {
    const ctx = context;
    const draft = detector.current();
    const since = draftAt;
    const conversation = ctx?.conversation ?? null;
    const actor = ctx?.teammate.email ?? null;
    const fields = draftFields;
    clearDraftState();
    if (!ctx || !conversation || !draft) return;
    let messages: readonly FrontMessageLike[];
    let comments: readonly FrontCommentLike[] = [];
    try {
      messages = (await ctx.listMessages()).results;
      if (opts.settings.captureComments) comments = (await ctx.listComments()).results;
    } catch (error) {
      log("overturn: could not read the conversation", error);
      forget();
      return;
    }
    const sent = sentFrom(entriesFrom(messages, comments), since);
    if (!sent) {
      // The draft was closed without sending: nothing to record, and the thread is not read again.
      forget();
      return;
    }
    const decision = decideOnSend({
      conversation: snapshotFrom({
        conversation,
        messages,
        comments,
        fields,
        origin: opts.origin ?? null,
      }),
      draft,
      draftFields: fields,
      send: {
        text: sent.body,
        messageId: sent.id,
        authorHandle: sent.authorHandle,
        fields: conversationFields(conversation, opts.settings),
      },
      reasonCode,
      reason: note,
      actor,
      settings: opts.settings,
      now: now(),
    });
    if (decision.action === "skip") {
      log(`overturn: nothing to record (${decision.why})`);
      forget();
      return;
    }
    if (decision.action === "need-reason") {
      held = decision.body;
      last = { kind: "held" };
      return;
    }
    await post(decision.body);
  }

  async function onContext(next: SingleContextLike | null): Promise<void> {
    const previousConversation = context?.conversation.id ?? null;
    const previousDraft = draftId;
    const wasScoped = scoped();
    context = next;
    if (!next) {
      clearDraftState();
      forget();
      return;
    }
    if (previousConversation !== null && previousConversation !== next.conversation.id) {
      // A different thread: whatever was in the composer belonged to the last one.
      clearDraftState();
      forget();
    }
    if (!wasScoped) forget();
    if (!scoped()) {
      clearDraftState();
      return;
    }
    const nextDraft = next.conversation.draftId ?? null;
    if (nextDraft === previousDraft) {
      if (nextDraft) await readDraft();
      else primeEmpty();
      return;
    }
    if (nextDraft) {
      // A draft landed in the reply box.
      draftId = nextDraft;
      draftAt = now();
      draftFields = conversationFields(next.conversation, opts.settings);
      forget();
      await readDraft();
      return;
    }
    await record();
    primeEmpty();
  }

  async function poll(): Promise<void> {
    if (!scoped() || !draftId) return;
    if (!(await readDraft())) await record();
  }

  async function markDraft(): Promise<void> {
    const ctx = context;
    if (!scoped() || !ctx || !draftId) return;
    let draft: FrontDraftLike | undefined;
    try {
      draft = await ctx.fetchDraft(draftId);
    } catch (error) {
      log("overturn: could not read the draft", error);
      return;
    }
    const text = draft ? draftText(draft) : "";
    if (!text.trim()) return;
    detector.set({ text, origin: "manual", at: now() });
    draftFields = conversationFields(ctx.conversation, opts.settings);
    forget();
  }

  async function pickReason(code: string | null, text: string): Promise<boolean> {
    reasonCode = code?.trim() || null;
    note = text;
    const body = held;
    if (!body || !reasonCode) return false;
    held = null;
    if (!(await post({ ...body, reasonCode, reason: note.trim() || null }))) {
      // The reason stays picked and the capture stays held: a retry is one more click.
      held = body;
      return false;
    }
    return true;
  }

  function status(): string {
    if (!context) return "Select one conversation to watch the composer";
    if (!scoped()) return `Not watching: no "${opts.settings.scopeTag ?? ""}" tag`;
    return statusLine(detector.current(), last);
  }

  return {
    onContext,
    poll,
    markDraft,
    pickReason,
    state: () => ({
      status: status(),
      draft: detector.current(),
      held: held !== null,
      watching: scoped(),
      last,
    }),
  };
}
