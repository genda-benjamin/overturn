import type { CaptureResult } from "@overturn-ai/shared";
import { describe, expect, it } from "vitest";
import type { CanvasComponent, CanvasPayload } from "./canvas";
import { COMPONENT } from "./canvas";
import { type CanvasRequest, type IntercomConversation, STORED_DRAFT_KEY } from "./capture";
import { handleCanvasRequest, pendingSend, runtimeFrom } from "./main";

const draftText =
  "Hi Dana, the duplicate charge is refunded and should land in 5 business days. Sorry for the trouble.";
const sentText = "Hi Dana, the duplicate charge is refunded and lands in 2 business days.";

function conversation(over: Partial<IntercomConversation> = {}): IntercomConversation {
  return {
    id: "21547896",
    source: {
      subject: "Where is my refund?",
      body: "<p>I was charged twice for order 8841.</p>",
      author: { type: "user", email: "dana@example.com" },
    },
    conversation_parts: {
      conversation_parts: [
        {
          id: "p1",
          part_type: "comment",
          body: "<p>The duplicate is refunded and lands within 5 business days.</p>",
          author: { type: "admin", email: "ray@carrier.com", is_ai_answer: true },
          created_at: 1_761_900_120,
        },
      ],
    },
    tags: { tags: [{ name: "billing" }, { name: "ai_drafted" }] },
    contacts: [{ id: "5f1", email: "dana@example.com" }],
    ...over,
  };
}

const recorded = {
  items: [{ id: "0199a0d0-0000-7000-8000-000000000000", output: draftText, model: "gpt-4.1-mini" }],
};

const captured: CaptureResult = {
  runId: "0199a0d0-0000-7000-8000-000000000001",
  stepId: "0199a0d0-0000-7000-8000-000000000002",
  kind: "edit",
  changed: true,
  changedFields: [],
  correction: {} as CaptureResult["correction"],
  case: { title: "Refund promised in 5 days" } as CaptureResult["case"],
  deduplicated: false,
};

interface Route {
  match: string;
  body?: unknown;
  status?: number;
}

function harness(routes: Route[], config: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes.find((r) => url.includes(r.match));
    if (!route) return new Response("not found", { status: 404 });
    const status = route.status ?? 200;
    return new Response(status === 200 ? JSON.stringify(route.body ?? {}) : "failed", { status });
  }) as typeof fetch;
  const runtime = runtimeFrom(
    { overturn_api_key: "ov_live_test", ...config },
    { fetchImpl, now: () => 1_761_900_300_000 },
  );
  return {
    runtime,
    calls,
    captureCall: () => calls.find((c) => c.url.endsWith("/v1/capture")),
    captureBody: () =>
      JSON.parse(String(calls.find((c) => c.url.endsWith("/v1/capture"))?.init?.body ?? "{}")) as Record<
        string,
        unknown
      >,
  };
}

function submit(
  previous: CanvasPayload,
  componentId: string,
  values: Record<string, string> = {},
  conv: IntercomConversation = conversation(),
): CanvasRequest {
  return {
    workspace_id: "abcd123",
    admin: { type: "admin", email: "ray@carrier.com" },
    conversation: conv,
    current_canvas: previous.canvas,
    input_values: values,
    component_id: componentId,
  };
}

const texts = (payload: CanvasPayload): string[] =>
  (payload.canvas.content?.components ?? []).filter((c) => c.type === "text").map((c) => String(c.text));

const component = (payload: CanvasPayload, id: string): CanvasComponent | undefined =>
  (payload.canvas.content?.components ?? []).find((c) => c.id === id);

const storedDraftJson = (payload: CanvasPayload): Record<string, unknown> =>
  JSON.parse(String(payload.canvas.stored_data?.[STORED_DRAFT_KEY] ?? "{}")) as Record<string, unknown>;

describe("initialize", () => {
  it("asks for the draft when nothing recorded one", async () => {
    const h = harness([]);
    const canvas = await handleCanvasRequest(
      { workspace_id: "abcd123", conversation: conversation() },
      h.runtime,
    );
    expect(texts(canvas)[0]).toBe("Waiting for the draft");
    expect(h.calls[0]?.url).toContain("/v1/runs?externalId=ic%3A21547896&agent=support-reply&limit=1");
    expect(component(canvas, COMPONENT.nameDraft)).toBeDefined();
  });

  it("shows Draft inserted · N words when the drafting agent recorded its run", async () => {
    const h = harness([{ match: "/v1/runs", body: recorded }]);
    const canvas = await handleCanvasRequest(
      { workspace_id: "abcd123", conversation: conversation() },
      h.runtime,
    );
    expect(texts(canvas)[0]).toBe(`Draft inserted · ${draftText.split(/\s+/).length} words`);
    expect(storedDraftJson(canvas)).toMatchObject({
      origin: "ai",
      evidence: "recorded",
      runId: "0199a0d0-0000-7000-8000-000000000000",
      model: "gpt-4.1-mini",
    });
    expect(texts(canvas).some((t) => t.includes("recorded with the Overturn SDK"))).toBe(true);
    // The reply Intercom already has is offered as what went out.
    expect(component(canvas, COMPONENT.sent)).toMatchObject({
      value: "The duplicate is refunded and lands within 5 business days.",
    });
  });

  it("reads a partial conversation back from the Intercom API when a token is configured", async () => {
    const h = harness([{ match: "/conversations/21547896", body: conversation() }], {
      intercom_token: "dG9r",
    });
    const canvas = await handleCanvasRequest(
      { workspace_id: "abcd123", conversation: { id: "21547896" } },
      h.runtime,
    );
    expect(h.calls[0]?.url).toBe("https://api.intercom.io/conversations/21547896?display_as=plaintext");
    expect(h.calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer dG9r" });
    expect(storedDraftJson(canvas)).toEqual({});
    expect(texts(canvas).some((t) => t.includes("is_ai_answer"))).toBe(true);
  });

  it("does nothing at all for a conversation the install does not watch", async () => {
    const h = harness([], { scope_tag: "ai_drafted" });
    const canvas = await handleCanvasRequest(
      { workspace_id: "abcd123", conversation: conversation({ tags: { tags: [{ name: "billing" }] } }) },
      h.runtime,
    );
    expect(texts(canvas)[0]).toContain('no "ai_drafted" tag');
    expect(h.calls).toHaveLength(0);
  });
});

describe("naming the draft", () => {
  it("asks who wrote it, then tags only what it was told", async () => {
    const h = harness([]);
    const idle = await handleCanvasRequest({ conversation: conversation() }, h.runtime);
    const naming = await handleCanvasRequest(submit(idle, COMPONENT.nameDraft), h.runtime);
    expect(texts(naming)[0]).toBe("Which draft?");
    expect(component(naming, COMPONENT.draftText)).toMatchObject({ type: "textarea" });

    const ready = await handleCanvasRequest(
      submit(naming, COMPONENT.originManual, {
        [COMPONENT.draftText]: draftText,
        [COMPONENT.sent]: sentText,
      }),
      h.runtime,
    );
    expect(storedDraftJson(ready)).toMatchObject({ origin: "manual", evidence: "typed" });
    expect(texts(ready).some((t) => t.includes("draft:manual"))).toBe(true);

    const unknown = await handleCanvasRequest(
      submit(naming, COMPONENT.originUnknown, { [COMPONENT.draftText]: draftText }),
      h.runtime,
    );
    expect(storedDraftJson(unknown)).toMatchObject({ origin: "unknown", evidence: "not-stated" });
  });

  it("calls it ai with Intercom's own signal when an assist wrote it", async () => {
    const h = harness([]);
    const naming = await handleCanvasRequest(
      submit(await handleCanvasRequest({ conversation: conversation() }, h.runtime), COMPONENT.nameDraft),
      h.runtime,
    );
    const ready = await handleCanvasRequest(
      submit(naming, COMPONENT.originAi, { [COMPONENT.draftText]: draftText }),
      h.runtime,
    );
    expect(storedDraftJson(ready)).toMatchObject({ origin: "ai", evidence: "fin" });
    expect(texts(ready).some((t) => t.includes("generated the last reply"))).toBe(true);
  });

  it("refuses a draft that is too short to be one", async () => {
    const h = harness([]);
    const naming = await handleCanvasRequest(
      submit(await handleCanvasRequest({ conversation: conversation() }, h.runtime), COMPONENT.nameDraft),
      h.runtime,
    );
    const again = await handleCanvasRequest(
      submit(naming, COMPONENT.originAi, { [COMPONENT.draftText]: "Hi Dana," }),
      h.runtime,
    );
    expect(texts(again)[0]).toBe("Which draft?");
    expect(texts(again).some((t) => t.includes("at least 80 characters"))).toBe(true);
  });
});

describe("recording the fix", () => {
  it("posts the payload for a reply sent as drafted, then reports it", async () => {
    const h = harness([
      { match: "/v1/runs", body: recorded },
      { match: "/v1/capture", body: { ...captured, kind: "approve", changed: false, case: null } },
    ]);
    const ready = await handleCanvasRequest(
      { workspace_id: "abcd123", conversation: conversation() },
      h.runtime,
    );
    const done = await handleCanvasRequest(
      submit(ready, COMPONENT.save, { [COMPONENT.sent]: draftText }, conversation()),
      h.runtime,
    );
    const body = h.captureBody();
    expect(body).toMatchObject({
      source: "intercom",
      externalId: "ic:21547896",
      agent: "support-reply",
      actor: "ray@carrier.com",
      subject: "Where is my refund?",
      tags: ["draft:ai", "public-reply"],
      draftRunId: "0199a0d0-0000-7000-8000-000000000000",
      draftModel: "gpt-4.1-mini",
      url: "https://app.intercom.com/a/inbox/abcd123/inbox/conversation/21547896",
      reasonCode: null,
    });
    expect(body.draft).toEqual({ text: draftText });
    expect(body.sent).toEqual({ text: draftText });
    expect(body.metadata).toMatchObject({
      workspace: "abcd123",
      requester: "dana@example.com",
      draftEvidence: "recorded",
    });
    expect((body.context as unknown[]).length).toBe(2);
    expect(texts(done)[0]).toBe("Sent as drafted · approved");
    expect(done.event).toEqual({ type: "completed" });
    expect(h.calls.filter((c) => c.url.endsWith("/v1/capture"))).toHaveLength(1);
  });

  it("carries the reason code for a changed reply, and the case it became", async () => {
    const h = harness([
      { match: "/v1/runs", body: recorded },
      { match: "/v1/capture", body: captured },
    ]);
    const ready = await handleCanvasRequest(
      { workspace_id: "abcd123", conversation: conversation() },
      h.runtime,
    );
    const picked = await handleCanvasRequest(
      submit(ready, `${COMPONENT.reasonPrefix}wrong_amount_or_date`, {
        [COMPONENT.note]: "refunds settle in 2 days",
        [COMPONENT.sent]: sentText,
      }),
      h.runtime,
    );
    expect(component(picked, `${COMPONENT.reasonPrefix}wrong_amount_or_date`)).toMatchObject({
      style: "primary",
    });
    const done = await handleCanvasRequest(
      submit(picked, COMPONENT.save, {
        [COMPONENT.note]: "refunds settle in 2 days",
        [COMPONENT.sent]: sentText,
      }),
      h.runtime,
    );
    const body = h.captureBody();
    expect(body.reasonCode).toBe("wrong_amount_or_date");
    expect(body.reason).toBe("refunds settle in 2 days");
    expect(body.sent).toEqual({ text: sentText });
    expect(texts(done)[0]).toBe("Captured · edit saved as a case");
    expect(texts(done).some((t) => t === "Case: Refund promised in 5 days")).toBe(true);
  });

  it("holds the capture, never the send, when a changed reply has no reason", async () => {
    const h = harness([{ match: "/v1/runs", body: recorded }]);
    const ready = await handleCanvasRequest(
      { workspace_id: "abcd123", conversation: conversation() },
      h.runtime,
    );
    const held = await handleCanvasRequest(
      submit(ready, COMPONENT.save, { [COMPONENT.sent]: sentText }),
      h.runtime,
    );
    expect(h.captureCall()).toBeUndefined();
    expect(texts(held).some((t) => t.includes("nothing is recorded without a reason"))).toBe(true);
    // The canvas still answers with the form, so the teammate can pick a chip and send on.
    expect(component(held, COMPONENT.save)).toBeDefined();
    expect(component(held, `${COMPONENT.reasonPrefix}wrong_answer`)).toBeDefined();
  });

  it("reports a failed capture and keeps what the teammate typed", async () => {
    const h = harness([
      { match: "/v1/runs", body: recorded },
      { match: "/v1/capture", status: 503 },
    ]);
    const ready = await handleCanvasRequest(
      { workspace_id: "abcd123", conversation: conversation() },
      h.runtime,
    );
    const failed = await handleCanvasRequest(
      submit(ready, COMPONENT.save, { [COMPONENT.note]: "kept", [COMPONENT.sent]: draftText }),
      h.runtime,
    );
    expect(texts(failed).some((t) => t.includes("could not save this correction (503)"))).toBe(true);
    expect(texts(failed).some((t) => t.includes("reply is untouched"))).toBe(true);
    expect(component(failed, `${COMPONENT.reasonPrefix}wrong_answer`)).toBeDefined();
    expect(failed.event).toBeUndefined();
  });

  it("won't record an internal note unless the install asked for notes", async () => {
    const noteLast = conversation({
      conversation_parts: {
        conversation_parts: [
          {
            id: "p2",
            part_type: "note",
            body: "refunded twice, second one is a mistake",
            author: { type: "admin", email: "ray@carrier.com" },
            created_at: 1_761_900_200,
          },
        ],
      },
    });
    const h = harness([{ match: "/v1/runs", body: recorded }]);
    const ready = await handleCanvasRequest({ workspace_id: "abcd123", conversation: noteLast }, h.runtime);
    const held = await handleCanvasRequest(submit(ready, COMPONENT.save, {}, noteLast), h.runtime);
    expect(h.captureCall()).toBeUndefined();
    expect(texts(held).some((t) => t.includes("internal note"))).toBe(true);
  });

  it("records a note when the install asked for them", async () => {
    const noteLast = conversation({
      conversation_parts: {
        conversation_parts: [
          {
            id: "p2",
            part_type: "note",
            body: "refunded twice, second one is a mistake",
            author: { type: "admin", email: "ray@carrier.com" },
            created_at: 1_761_900_200,
          },
        ],
      },
    });
    const h = harness(
      [
        { match: "/v1/runs", body: recorded },
        { match: "/v1/capture", body: { ...captured, changed: true, deduplicated: true } },
      ],
      { capture_notes: "true", require_reason: "false" },
    );
    const ready = await handleCanvasRequest({ workspace_id: "abcd123", conversation: noteLast }, h.runtime);
    const done = await handleCanvasRequest(submit(ready, COMPONENT.save, {}, noteLast), h.runtime);
    expect(h.captureBody().tags).toEqual(["draft:ai", "internal-note"]);
    expect(texts(done)[0]).toBe("Captured · already in the suite");
  });
});

describe("pendingSend", () => {
  it("prefers what the teammate corrected, else the thread", () => {
    expect(pendingSend(conversation(), "  typed  ")).toMatchObject({ text: "typed", type: "publicReply" });
    expect(pendingSend(conversation(), "")?.text).toContain("5 business days");
    expect(pendingSend({ id: "1" }, "")).toBeNull();
    // A note is handed on as a note: the decision is what refuses it when notes are off.
    expect(
      pendingSend(
        conversation({
          conversation_parts: {
            conversation_parts: [{ id: "n", part_type: "note", body: "note", created_at: 2 }],
          },
        }),
        "",
      ),
    ).toMatchObject({ type: "note" });
  });
});
