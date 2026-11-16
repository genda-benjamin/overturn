import type { CaptureResult } from "@overturn-ai/shared";
import {
  type CanvasPayload,
  COMPONENT,
  clickedOrigin,
  failedCanvas,
  idleCanvas,
  namingCanvas,
  notWatchingCanvas,
  type ReadyCanvasInput,
  readCanvasState,
  readyCanvas,
  reasonCodeFromClick,
} from "./canvas";
import {
  type AppSettings,
  aiSignals,
  type CanvasRequest,
  type DraftEvidence,
  type DraftState,
  decideOnCapture,
  draftFromRun,
  draftFromTeammate,
  fieldsFrom,
  type IntercomConversation,
  inScope,
  isDraftSized,
  type PendingSend,
  sentFrom,
  settingsFrom,
} from "./capture";

/** The small slice of the host this app needs, so the same code runs in a worker or in tests. */
export interface Runtime {
  settings: AppSettings;
  fetchImpl: typeof fetch;
  now: () => number;
}

export function runtimeFrom(
  config: Record<string, unknown>,
  opts: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Runtime {
  return {
    settings: settingsFrom(config),
    fetchImpl: opts.fetchImpl ?? fetch,
    now: opts.now ?? (() => Date.now()),
  };
}

function authHeaders(settings: AppSettings): Record<string, string> {
  return settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {};
}

/** Canvas Kit sends the conversation, but never promises the parts are in it. */
function hasParts(conversation: IntercomConversation): boolean {
  return (conversation.conversation_parts?.conversation_parts?.length ?? 0) > 0;
}

/**
 * The conversation the app reasons about. Canvas Kit already sends it; when the payload is a
 * partial and an access token is configured, the conversation is read back from the Intercom API
 * in plain text, so "what the teammate actually sent" is never a guess either.
 */
export async function conversationFor(
  req: CanvasRequest,
  runtime: Runtime,
): Promise<IntercomConversation | null> {
  const conversation = req.conversation ?? null;
  if (!conversation?.id || hasParts(conversation)) return conversation;
  const { settings } = runtime;
  if (!settings.intercomToken) return conversation;
  try {
    const res = await runtime.fetchImpl(
      `${settings.intercomApiBase}/conversations/${encodeURIComponent(String(conversation.id))}?display_as=plaintext`,
      {
        headers: {
          authorization: `Bearer ${settings.intercomToken}`,
          accept: "application/json",
          "intercom-version": "2.18",
        },
      },
    );
    if (!res.ok) return conversation;
    const full = (await res.json()) as IntercomConversation;
    return full?.id ? full : conversation;
  } catch {
    return conversation;
  }
}

/** A drafting agent that recorded its run with the SDK: the draft is its output. */
async function findRecordedDraft(
  conversation: IntercomConversation,
  runtime: Runtime,
): Promise<DraftState | null> {
  const { settings } = runtime;
  if (!settings.apiKey) return null;
  try {
    const url = `${settings.baseUrl}/v1/runs?externalId=${encodeURIComponent(`ic:${conversation.id}`)}&agent=${encodeURIComponent(settings.agent)}&limit=1`;
    const res = await runtime.fetchImpl(url, { headers: authHeaders(settings) });
    if (!res.ok) return null;
    const page = (await res.json()) as { items?: Array<{ id?: string; output?: unknown; model?: unknown }> };
    const run = page.items?.[0];
    const output = typeof run?.output === "string" ? run.output : "";
    if (!run?.id || !output.trim()) return null;
    return draftFromRun(
      { id: run.id, output, model: typeof run.model === "string" ? run.model : null },
      runtime.now(),
      fieldsFrom(conversation, settings),
    );
  } catch {
    // No recorded draft; the teammate names the one in the composer instead.
    return null;
  }
}

async function postCapture(runtime: Runtime, body: unknown): Promise<CaptureResult> {
  const res = await runtime.fetchImpl(`${runtime.settings.baseUrl}/v1/capture`, {
    method: "POST",
    headers: { ...authHeaders(runtime.settings), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const error = new Error(`capture ${res.status}`) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  return (await res.json()) as CaptureResult;
}

/**
 * What went out: the thread's newest reply, or what the teammate corrected by hand. A note stays
 * a note — the decision below is what refuses it when the install does not record notes.
 */
export function pendingSend(conversation: IntercomConversation, typed: string): PendingSend | null {
  const fromThread = sentFrom(conversation);
  const text = typed.trim();
  if (text) return { text, type: fromThread?.type ?? "publicReply", at: fromThread?.at ?? null };
  return fromThread;
}

function readyBase(
  conversation: IntercomConversation,
  draft: DraftState,
  settings: AppSettings,
  state: { sentText: string; reasonCode: string | null; note: string },
): ReadyCanvasInput {
  return {
    draft,
    settings,
    conversation,
    sentText: state.sentText.trim() || sentFrom(conversation)?.text || "",
    reasonCode: state.reasonCode,
    note: state.note,
    signals: aiSignals(conversation),
  };
}

/**
 * One Canvas Kit webhook for both flows: Initialize (no `component_id`) draws the canvas, and
 * Submit (a click, with `current_canvas`, `input_values` and `component_id`) answers it.
 *
 * Nothing here can stop Intercom from sending a reply, so `require_reason` holds the *capture*
 * back — visibly, in the canvas — and a failure to record is reported in the panel. The send
 * itself is never touched.
 */
export async function handleCanvasRequest(req: CanvasRequest, runtime: Runtime): Promise<CanvasPayload> {
  const { settings } = runtime;
  const conversation = await conversationFor(req, runtime);
  if (!conversation?.id) return idleCanvas(null);
  if (!inScope(conversation, settings)) return notWatchingCanvas(settings.scopeTag);

  const state = readCanvasState(req);
  const clicked = state.clicked;

  if (clicked === COMPONENT.nameDraft) return namingCanvas(state.draftText);
  if (clicked === COMPONENT.reset || clicked === COMPONENT.startOver) return idleCanvas(null);

  const told = clickedOrigin(clicked);
  if (told) {
    const named = state.draftText.trim() || state.draft?.text || "";
    if (!isDraftSized(named, settings)) {
      return namingCanvas(
        state.draftText,
        `A draft this short is not worth a case: paste at least ${settings.minDraftChars} characters.`,
      );
    }
    // Intercom's own flag upgrades "an assist wrote it" to a fact we were told, never the reverse.
    const evidence: DraftEvidence =
      told.evidence === "assist" && aiSignals(conversation).answerGenerated ? "fin" : told.evidence;
    const draft = draftFromTeammate(
      named,
      told.origin,
      evidence,
      runtime.now(),
      fieldsFrom(conversation, settings),
    );
    return readyCanvas(readyBase(conversation, draft, settings, { ...state, reasonCode: null }));
  }

  const chip = reasonCodeFromClick(clicked);
  if (chip && state.draft) {
    return readyCanvas(readyBase(conversation, state.draft, settings, { ...state, reasonCode: chip }));
  }

  if (clicked === COMPONENT.save) {
    const draft = state.draft;
    if (!draft) return idleCanvas(null, aiSignals(conversation));
    const base = readyBase(conversation, draft, settings, state);
    const decision = decideOnCapture({
      conversation,
      draft,
      sent: pendingSend(conversation, state.sentText),
      reasonCode: state.reasonCode,
      reason: state.note,
      actor: req.admin?.email?.trim() || req.admin?.name?.trim() || null,
      workspaceId: req.workspace_id ?? null,
      settings,
      now: runtime.now(),
    });
    if (decision.action === "skip") {
      if (decision.why === "note") {
        return failedCanvas(
          "The newest thing here is an internal note; notes are only recorded with capture_notes on.",
          base,
        );
      }
      return failedCanvas("No reply to compare against yet. Paste what you sent, then record it.", base);
    }
    if (decision.action === "need-reason") {
      return failedCanvas(
        "Pick why you changed it (one click) — nothing is recorded without a reason.",
        base,
      );
    }
    try {
      const result = await postCapture(runtime, decision.body);
      return readyCanvas({
        ...base,
        last: { changed: result.changed, dedup: result.deduplicated },
        caseTitle: result.case?.title ?? null,
      });
    } catch (error) {
      // Never hide a failure, and never lose what the teammate typed: hand the canvas straight back.
      const status = (error as { status?: number }).status ?? "network";
      return failedCanvas(
        `Overturn could not save this correction (${status}). Your reply is untouched.`,
        base,
      );
    }
  }

  // Initialize, or a click we do not know: find a recorded draft, else ask for the one in the composer.
  const liveDraft = state.draft ?? (await findRecordedDraft(conversation, runtime));
  if (liveDraft) return readyCanvas(readyBase(conversation, liveDraft, settings, state));
  return idleCanvas(null, aiSignals(conversation));
}
