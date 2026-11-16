import {
  type AiSignals,
  type AppSettings,
  type CanvasComponent,
  type CanvasObject,
  type CanvasRequest,
  type DraftEvidence,
  type DraftOrigin,
  type DraftState,
  type IntercomConversation,
  originLine,
  quickReasons,
  STORED_DRAFT_KEY,
  STORED_ISSUE_KEY,
  statusLine,
  storeDraft,
  storedDraft,
} from "./capture";

/** Every component this app renders, so a click can be attributed to one place. */
export const COMPONENT = {
  /** "The draft is in the composer": start naming it. */
  nameDraft: "overturn_draft_name",
  /** The draft text, pasted by the teammate. */
  draftText: "overturn_draft_text",
  originAi: "overturn_origin_ai",
  originManual: "overturn_origin_manual",
  originUnknown: "overturn_origin_unknown",
  /** The chips: `overturn_reason_<code>`. */
  reasonPrefix: "overturn_reason_",
  note: "overturn_note",
  sent: "overturn_sent",
  save: "overturn_save",
  reset: "overturn_reset",
  startOver: "overturn_start_over",
} as const;

export const SCREEN_KEY = "overturn_screen";
export const REASON_KEY = "overturn_reason";

export type Screen = "idle" | "naming" | "ready" | "done";

/** What Intercom expects back: the canvas to show, and optionally "this app is done". */
export interface CanvasPayload {
  canvas: CanvasObject;
  event?: { type: "completed" };
}

export function text(
  value: string,
  opts: {
    id?: string;
    style?: "header" | "paragraph" | "muted" | "error";
    align?: "left" | "center" | "right";
    bottomMargin?: "none";
  } = {},
): CanvasComponent {
  return {
    type: "text",
    ...(opts.id ? { id: opts.id } : {}),
    text: value,
    ...(opts.style ? { style: opts.style } : {}),
    ...(opts.align ? { align: opts.align } : {}),
    ...(opts.bottomMargin ? { bottom_margin: opts.bottomMargin } : {}),
  };
}

/** Multiline text: the only way a teammate can hand us a whole reply. */
export function textarea(
  id: string,
  label: string,
  opts: { value?: string; placeholder?: string; error?: boolean } = {},
): CanvasComponent {
  return {
    type: "textarea",
    id,
    label,
    ...(opts.value ? { value: opts.value } : {}),
    ...(opts.placeholder ? { placeholder: opts.placeholder } : {}),
    ...(opts.error ? { error: true } : {}),
  };
}

/** A button that sends a Submit request back to the app. */
export function button(
  id: string,
  label: string,
  opts: { style?: "primary" | "secondary" | "link"; disabled?: boolean } = {},
): CanvasComponent {
  return {
    type: "button",
    id,
    label,
    action: { type: "submit" },
    style: opts.style ?? "secondary",
    ...(opts.disabled ? { disabled: true } : {}),
  };
}

export function divider(): CanvasComponent {
  return { type: "divider" };
}

export function spacer(size: "xs" | "s" | "m" | "l" | "xl" = "s"): CanvasComponent {
  return { type: "spacer", size };
}

export function canvasOf(
  components: CanvasComponent[],
  stored: Record<string, unknown> = {},
  opts: { completed?: boolean } = {},
): CanvasPayload {
  return {
    canvas: { content: { components }, stored_data: stored },
    ...(opts.completed ? { event: { type: "completed" as const } } : {}),
  };
}

/**
 * What the app can see when a request comes in: the screen the teammate is on, the draft it
 * stored on the canvas, the chip they picked, and everything they typed since.
 */
export interface CanvasState {
  screen: Screen;
  draft: DraftState | null;
  reasonCode: string | null;
  note: string;
  draftText: string;
  sentText: string;
  clicked: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function screenOf(raw: unknown): Screen | null {
  return raw === "idle" || raw === "naming" || raw === "ready" || raw === "done" ? raw : null;
}

export function readCanvasState(req: CanvasRequest): CanvasState {
  const stored = req.current_canvas?.stored_data ?? {};
  const draft = storedDraft(req.current_canvas);
  const inputs = req.input_values ?? {};
  const reason = str(stored[REASON_KEY]);
  return {
    // A canvas we did not render (a reload, another install) starts from what we know.
    screen: screenOf(stored[SCREEN_KEY]) ?? (draft ? "ready" : "idle"),
    draft,
    reasonCode: reason && reason.length <= 60 ? reason : null,
    note: str(inputs[COMPONENT.note]),
    draftText: str(inputs[COMPONENT.draftText]),
    sentText: str(inputs[COMPONENT.sent]),
    clicked: str(req.component_id),
  };
}

/** The reason code a chip click carries, when the click was on a chip. */
export function reasonCodeFromClick(clicked: string): string | null {
  if (!clicked.startsWith(COMPONENT.reasonPrefix)) return null;
  const code = clicked.slice(COMPONENT.reasonPrefix.length).trim();
  return code && /^[a-z0-9_]+$/.test(code) ? code : null;
}

export function clickedOrigin(clicked: string): { origin: DraftOrigin; evidence: DraftEvidence } | null {
  if (clicked === COMPONENT.originAi) return { origin: "ai", evidence: "assist" };
  if (clicked === COMPONENT.originManual) return { origin: "manual", evidence: "typed" };
  if (clicked === COMPONENT.originUnknown) return { origin: "unknown", evidence: "not-stated" };
  return null;
}

/** What the canvas holds on to between requests. */
function stored(
  screen: Screen,
  draft: DraftState | null,
  opts: { reasonCode?: string | null; issue?: string } = {},
): Record<string, unknown> {
  return {
    [SCREEN_KEY]: screen,
    ...(opts.reasonCode ? { [REASON_KEY]: opts.reasonCode } : {}),
    ...(opts.issue ? { [STORED_ISSUE_KEY]: opts.issue } : {}),
    ...(draft ? storeDraft(draft) : {}),
  };
}

/** What Intercom itself says about AI involvement here, in words the teammate can act on. */
export function aiHint(signals: AiSignals | null): string | null {
  if (!signals) return null;
  if (signals.answerGenerated) {
    return "Intercom says this thread's last reply was generated by the AI agent (author.is_ai_answer).";
  }
  if (signals.sentByAgent) return "Intercom says the AI agent sent this thread's last reply.";
  if (signals.participated) return "Intercom says the AI agent took part in this conversation.";
  return null;
}

/**
 * Nothing is claimed yet. Intercom never shows an app the reply composer, so the canvas says so
 * instead of inventing a draft; the first canvas stays small and avoids a primary button, as the
 * Inbox design rules ask.
 */
export function idleCanvas(draft: DraftState | null = null, signals: AiSignals | null = null): CanvasPayload {
  const components: CanvasComponent[] = [
    text(statusLine(draft, null), { style: "header" }),
    text(
      "Intercom gives an app no view of the reply composer, so a draft is only recorded once you say what it is.",
      { style: "muted" },
    ),
    text("A drafting agent that recorded its run with the Overturn SDK is found by itself.", {
      style: "muted",
    }),
  ];
  const hint = aiHint(signals);
  if (hint) components.push(text(hint, { style: "muted" }));
  components.push(divider(), button(COMPONENT.nameDraft, "The draft is in the composer"));
  return canvasOf(components, stored("idle", draft));
}

/** The teammate names the draft; only they can say who wrote it. */
export function namingCanvas(draftText = "", hint?: string | null): CanvasPayload {
  const components: CanvasComponent[] = [
    text("Which draft?", { style: "header" }),
    textarea(COMPONENT.draftText, "The draft in the composer", {
      value: draftText,
      placeholder: "Paste the draft",
      error: !!hint,
    }),
    text("Who wrote it? The tag on the run says exactly this, and nothing else.", { style: "muted" }),
  ];
  if (hint) components.push(text(hint, { style: "error" }));
  components.push(
    divider(),
    button(COMPONENT.originAi, "Fin or another AI assist", { style: "primary" }),
    button(COMPONENT.originManual, "I wrote it myself"),
    button(COMPONENT.originUnknown, "Not sure — record it as unknown", { style: "link" }),
  );
  return canvasOf(components, stored("naming", null));
}

export interface ReadyCanvasInput {
  draft: DraftState;
  settings: AppSettings;
  conversation: IntercomConversation;
  /** The reply Intercom already has; the teammate can still correct it. */
  sentText: string;
  reasonCode: string | null;
  note: string;
  /** What Intercom says about AI involvement in this thread, when it says anything. */
  signals?: AiSignals | null;
  /** Set once a capture happened, so the canvas reports instead of asking again. */
  last?: { changed: boolean; dedup: boolean } | null;
  /** Why the last attempt did not record, in the teammate's words. */
  hint?: string | null;
  caseTitle?: string | null;
}

/** The form: what the draft is, why it changed, and what actually went out. */
export function readyCanvas(input: ReadyCanvasInput): CanvasPayload {
  const { draft, settings, last } = input;
  const components: CanvasComponent[] = [
    text(statusLine(last ? null : draft, last ?? null), { style: "header" }),
    text(originLine(draft) ?? "", { style: "muted" }),
  ];
  if (last) {
    if (input.caseTitle) components.push(text(`Case: ${input.caseTitle}`));
    components.push(
      text("The run page in Overturn links back to this conversation.", { style: "muted" }),
      divider(),
      button(COMPONENT.startOver, "Record another", { style: "link" }),
    );
    return canvasOf(components, stored("done", null), { completed: true });
  }
  components.push(
    text(settings.requireReason ? "Pick why you changed it — one click." : "Why did you change it?"),
  );
  for (const reason of quickReasons(settings)) {
    components.push(
      button(`${COMPONENT.reasonPrefix}${reason.code}`, reason.label, {
        style: input.reasonCode === reason.code ? "primary" : "secondary",
      }),
    );
  }
  components.push(
    textarea(COMPONENT.note, "Anything else? Optional.", { value: input.note }),
    textarea(COMPONENT.sent, "What you sent", {
      value: input.sentText,
      placeholder: "The reply as it went out",
    }),
  );
  const hint = input.hint ?? aiHint(input.signals ?? null);
  if (hint) components.push(text(hint, { style: input.hint ? "error" : "muted" }));
  components.push(
    divider(),
    button(COMPONENT.save, "Record the fix", { style: "primary" }),
    button(COMPONENT.reset, "Start over", { style: "link" }),
    text("Recording never blocks your send: nothing leaves Intercom from here.", { style: "muted" }),
  );
  return canvasOf(components, stored("ready", draft, { reasonCode: input.reasonCode }));
}

/** A capture that failed must say so, and must not lose what the teammate typed. */
export function failedCanvas(message: string, input: ReadyCanvasInput): CanvasPayload {
  return readyCanvas({ ...input, last: null, hint: message });
}

/** A canvas for a conversation this install does not watch. */
export function notWatchingCanvas(scopeTag: string | null): CanvasPayload {
  return canvasOf([
    text(scopeTag ? `Not watching: this conversation has no "${scopeTag}" tag.` : "Not watching.", {
      style: "muted",
    }),
  ]);
}

export type { CanvasComponent };
export { STORED_DRAFT_KEY };
