import { describe, expect, it } from "vitest";
import {
  aiHint,
  button,
  type CanvasComponent,
  COMPONENT,
  canvasOf,
  clickedOrigin,
  divider,
  failedCanvas,
  idleCanvas,
  namingCanvas,
  notWatchingCanvas,
  REASON_KEY,
  readCanvasState,
  readyCanvas,
  reasonCodeFromClick,
  SCREEN_KEY,
  text,
  textarea,
} from "./canvas";
import {
  type CanvasRequest,
  DEFAULT_SETTINGS,
  draftFromTeammate,
  STORED_DRAFT_KEY,
  storeDraft,
} from "./capture";

const draftText =
  "Hi Dana, the duplicate charge is refunded and should land in 5 business days. Sorry for the trouble.";

function components(payload: {
  canvas: { content?: { components?: CanvasComponent[] } | null };
}): CanvasComponent[] {
  return payload.canvas.content?.components ?? [];
}

function find(payload: { canvas: { content?: { components?: CanvasComponent[] } | null } }, id: string) {
  return components(payload).find((c) => c.id === id);
}

const aiDraft = draftFromTeammate(draftText, "ai", "assist", 1_761_900_000_000);

describe("Canvas Kit components", () => {
  it("renders the documented shapes only", () => {
    expect(text("hi", { style: "header" })).toEqual({ type: "text", text: "hi", style: "header" });
    expect(textarea(COMPONENT.note, "note", { value: "x", error: true })).toEqual({
      type: "textarea",
      id: COMPONENT.note,
      label: "note",
      value: "x",
      error: true,
    });
    expect(button("go", "Go", { style: "primary" })).toEqual({
      type: "button",
      id: "go",
      label: "Go",
      action: { type: "submit" },
      style: "primary",
    });
    expect(divider()).toEqual({ type: "divider" });
  });

  it("marks the app as completed only when it is", () => {
    expect(canvasOf([text("done")], {}, { completed: true }).event).toEqual({ type: "completed" });
    expect(canvasOf([text("waiting")]).event).toBeUndefined();
  });

  it("reads the state back from a submit request", () => {
    const req: CanvasRequest = {
      workspace_id: "abcd123",
      component_id: COMPONENT.save,
      current_canvas: {
        content: { components: [] },
        stored_data: { ...storeDraft(aiDraft), [REASON_KEY]: "wrong_answer", [SCREEN_KEY]: "ready" },
      },
      input_values: {
        [COMPONENT.note]: "two days here",
        [COMPONENT.sent]: "what went out",
        [COMPONENT.draftText]: "a pasted draft",
      },
    };
    expect(readCanvasState(req)).toEqual({
      screen: "ready",
      draft: aiDraft,
      reasonCode: "wrong_answer",
      note: "two days here",
      sentText: "what went out",
      draftText: "a pasted draft",
      clicked: COMPONENT.save,
    });
  });

  it("starts from what it knows when the canvas is not ours, and drops a reason it cannot trust", () => {
    expect(readCanvasState({})).toMatchObject({ screen: "idle", draft: null, reasonCode: null, note: "" });
    expect(readCanvasState({ current_canvas: { stored_data: storeDraft(aiDraft) } })).toMatchObject({
      screen: "ready",
      draft: aiDraft,
    });
    expect(
      readCanvasState({
        current_canvas: { stored_data: { [REASON_KEY]: "x".repeat(61), [SCREEN_KEY]: "nonsense" } },
      }),
    ).toMatchObject({ screen: "idle", reasonCode: null });
  });

  it("attributes a click", () => {
    expect(reasonCodeFromClick(`${COMPONENT.reasonPrefix}wrong_answer`)).toBe("wrong_answer");
    expect(reasonCodeFromClick(`${COMPONENT.reasonPrefix}not a code`)).toBeNull();
    expect(reasonCodeFromClick(COMPONENT.save)).toBeNull();
    expect(clickedOrigin(COMPONENT.originAi)).toEqual({ origin: "ai", evidence: "assist" });
    expect(clickedOrigin(COMPONENT.originManual)).toEqual({ origin: "manual", evidence: "typed" });
    expect(clickedOrigin(COMPONENT.originUnknown)).toEqual({ origin: "unknown", evidence: "not-stated" });
    expect(clickedOrigin("something else")).toBeNull();
  });

  it("reports what Intercom says about AI involvement, without claiming a draft", () => {
    expect(aiHint({ answerGenerated: true, sentByAgent: true, participated: true })).toContain(
      "is_ai_answer",
    );
    expect(aiHint({ answerGenerated: false, sentByAgent: true, participated: true })).toContain(
      "sent this thread",
    );
    expect(aiHint({ answerGenerated: false, sentByAgent: false, participated: true })).toContain("took part");
    expect(aiHint({ answerGenerated: false, sentByAgent: false, participated: false })).toBeNull();
    expect(aiHint(null)).toBeNull();
  });
});

describe("idleCanvas", () => {
  it("says the panel cannot see the composer, and keeps the first canvas to one secondary button", () => {
    const idle = idleCanvas(null, { answerGenerated: true, sentByAgent: true, participated: true });
    expect(components(idle)[0]).toMatchObject({ text: "Waiting for the draft", style: "header" });
    const buttons = components(idle).filter((c) => c.type === "button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatchObject({ id: COMPONENT.nameDraft, style: "secondary" });
    expect(components(idle).some((c) => c.type === "divider")).toBe(true);
    expect(components(idle).some((c) => String(c.text).includes("no view of the reply composer"))).toBe(true);
    expect(idle.canvas.stored_data?.[SCREEN_KEY]).toBe("idle");
  });
});

describe("namingCanvas", () => {
  it("asks who wrote it, with the draft in a textarea", () => {
    const naming = namingCanvas("pasted draft");
    expect(find(naming, COMPONENT.draftText)).toMatchObject({ type: "textarea", value: "pasted draft" });
    expect(components(naming).filter((c) => c.type === "button")).toHaveLength(3);
    expect(find(naming, COMPONENT.originAi)).toMatchObject({ style: "primary" });
    expect(find(naming, COMPONENT.originUnknown)).toMatchObject({ style: "link" });
    expect(naming.canvas.stored_data?.[SCREEN_KEY]).toBe("naming");
  });

  it("shows why a draft was refused", () => {
    const naming = namingCanvas("too short", "A draft this short is not worth a case.");
    expect(find(naming, COMPONENT.draftText)).toMatchObject({ error: true });
    expect(components(naming).some((c) => c.style === "error")).toBe(true);
  });
});

describe("readyCanvas", () => {
  const base = {
    draft: aiDraft,
    settings: { ...DEFAULT_SETTINGS, requireReason: true },
    conversation: { id: "1" },
    sentText: "what went out",
    reasonCode: null,
    note: "",
  };

  it("offers every chip of the installed pack, one click each", () => {
    const ready = readyCanvas(base);
    const chips = components(ready).filter((c) => String(c.id).startsWith(COMPONENT.reasonPrefix));
    expect(chips).toHaveLength(8);
    expect(chips.map((c) => c.id)).toContain(`${COMPONENT.reasonPrefix}wrong_answer`);
    expect(chips.map((c) => c.label)).toContain("Wrong answer");
    expect(components(ready).some((c) => String(c.text).includes("Pick why you changed it"))).toBe(true);
  });

  it("marks the chip the teammate picked, keeps what they typed, and can record", () => {
    const ready = readyCanvas({ ...base, reasonCode: "wrong_answer", note: "two days here" });
    expect(find(ready, `${COMPONENT.reasonPrefix}wrong_answer`)).toMatchObject({ style: "primary" });
    expect(find(ready, `${COMPONENT.reasonPrefix}missing_information`)).toMatchObject({ style: "secondary" });
    expect(find(ready, COMPONENT.note)).toMatchObject({ type: "textarea", value: "two days here" });
    expect(find(ready, COMPONENT.sent)).toMatchObject({ type: "textarea", value: "what went out" });
    expect(find(ready, COMPONENT.save)).toMatchObject({ style: "primary" });
    expect(ready.canvas.stored_data).toMatchObject({ ...storeDraft(aiDraft), [REASON_KEY]: "wrong_answer" });
  });

  it("reports a recorded capture, and finishes the app", () => {
    const done = readyCanvas({
      ...base,
      last: { changed: true, dedup: false },
      caseTitle: "Refund promised in 5 days",
    });
    expect(components(done)[0]).toMatchObject({ text: "Captured · edit saved as a case" });
    expect(components(done).some((c) => c.text === "Case: Refund promised in 5 days")).toBe(true);
    expect(done.event).toEqual({ type: "completed" });
    expect(components(done).some((c) => c.type === "textarea")).toBe(false);
    expect(done.canvas.stored_data?.[SCREEN_KEY]).toBe("done");
  });

  it("a failed capture keeps the form and says what happened", () => {
    const failed = failedCanvas("Overturn could not save this correction (network).", {
      ...base,
      reasonCode: "wrong_answer",
      note: "kept",
    });
    expect(
      components(failed).some((c) => c.style === "error" && String(c.text).includes("could not save")),
    ).toBe(true);
    expect(find(failed, COMPONENT.note)).toMatchObject({ value: "kept" });
    expect(find(failed, `${COMPONENT.reasonPrefix}wrong_answer`)).toMatchObject({ style: "primary" });
    expect(failed.event).toBeUndefined();
  });

  it("shows what Intercom says about AI, and nothing when it says nothing", () => {
    const withSignal = readyCanvas({
      ...base,
      signals: { answerGenerated: true, sentByAgent: false, participated: true },
    });
    expect(components(withSignal).some((c) => String(c.text).includes("is_ai_answer"))).toBe(true);
    const silent = readyCanvas({
      ...base,
      signals: { answerGenerated: false, sentByAgent: false, participated: false },
    });
    expect(components(silent).some((c) => String(c.text).includes("Intercom says"))).toBe(false);
  });

  it("does not ask for a reason when the install does not require one", () => {
    const loose = readyCanvas({ ...base, settings: { ...DEFAULT_SETTINGS, requireReason: false } });
    expect(components(loose).some((c) => String(c.text).includes("Why did you change it?"))).toBe(true);
  });
});

describe("notWatchingCanvas", () => {
  it("names the scope tag it is waiting for", () => {
    const scoped = notWatchingCanvas("ai_drafted");
    expect(components(scoped)).toHaveLength(1);
    expect(components(scoped)[0]?.text).toContain("ai_drafted");
    expect(components(notWatchingCanvas(null))[0]?.text).toBe("Not watching.");
  });
});

describe("stored draft key", () => {
  it("is the one the app writes and reads", () => {
    expect(storeDraft(aiDraft)[STORED_DRAFT_KEY]).toBeTypeOf("string");
  });
});
