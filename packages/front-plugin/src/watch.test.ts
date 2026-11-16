import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import { describe, expect, it } from "vitest";
import type { FrontCommentLike, FrontDraftLike, FrontMessageLike, SingleContextLike } from "./capture";
import { createWatcher } from "./watch";

const DRAFT_ID = "drf_1";
const draftText =
  "<p>Hi Dana,</p><p>Thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 5 business days.</p>";

/** What the panel says for that draft, which is 26 words. */
const insertedStatus = "Draft inserted · 26 words";
const preloadedStatus = "Draft found in the composer · 26 words";

/**
 * A Front context and the SDK calls behind it, with the least a browser can give them: the
 * composer's draft, the conversation's messages and comments, and the capture call.
 */
class FakeFront {
  posted: CaptureCreate[] = [];
  reads = { drafts: 0, messages: 0, comments: 0 };
  draft: FrontDraftLike | null;
  messages: FrontMessageLike[];
  comments: FrontCommentLike[] = [];
  fail: number | null = null;

  constructor(options: { messages?: readonly FrontMessageLike[]; draft?: FrontDraftLike | null } = {}) {
    this.draft = options.draft ?? null;
    this.messages = [...(options.messages ?? [])];
  }

  /** A context update, as Front pushes it: a fresh object over the same conversation. */
  context(
    draftId: string | null,
    options: {
      id?: string;
      tags?: ReadonlyArray<{ name: string }>;
      attributes?: SingleContextLike["conversation"]["customFieldAttributes"];
    } = {},
  ): SingleContextLike {
    return {
      type: "singleConversation",
      teammate: { email: "ray@carrier.com", name: "Ray" },
      conversation: {
        id: options.id ?? "cnv_48213",
        subject: "Roof leak after storm",
        recipient: { handle: "dana@example.com", name: "Dana" },
        tags: options.tags ?? [],
        customFieldAttributes: options.attributes ?? [],
        draftId: draftId ?? undefined,
      },
      fetchDraft: async (id) => {
        this.reads.drafts += 1;
        return this.draft && this.draft.id === id ? this.draft : undefined;
      },
      listMessages: async () => {
        this.reads.messages += 1;
        return { results: this.messages };
      },
      listComments: async () => {
        this.reads.comments += 1;
        return { results: this.comments };
      },
    };
  }

  async send(body: CaptureCreate): Promise<CaptureResult> {
    if (this.fail !== null) throw Object.assign(new Error("capture failed"), { status: this.fail });
    this.posted.push(body);
    return captured(body.sent.text !== body.draft.text);
  }
}

/** Only the fields the panel reads: the API fills in the run, the step and the case. */
function captured(
  changed: boolean,
  options: { dedup?: boolean; caseTitle?: string | null } = {},
): CaptureResult {
  return {
    kind: changed ? "edit" : "approve",
    changed,
    deduplicated: options.dedup ?? false,
    case: options.caseTitle ? { title: options.caseTitle } : null,
  } as CaptureResult;
}

const draft = (body: string): FrontDraftLike => ({ id: DRAFT_ID, content: { body, type: "html" } });

const inbound: FrontMessageLike = {
  id: "msg_1",
  status: "inbound",
  content: { body: "<div>Water came through the ceiling.</div>", type: "html" },
  from: { handle: "dana@example.com", name: "Dana" },
  date: new Date("2026-10-01T10:00:00Z"),
};

const sent = (body: string, at = "2026-10-01T11:00:00Z"): FrontMessageLike => ({
  id: "msg_2",
  status: "outbound",
  content: { body, type: "html" },
  from: { handle: "ray@carrier.com", name: "Ray" },
  date: new Date(at),
});

/** A watcher over the fake SDK, with a clock the test moves by hand. */
function harness(options: {
  front: FakeFront;
  settings?: Partial<Parameters<typeof createWatcher>[0]["settings"]>;
}) {
  let clock = Date.parse("2026-10-01T10:59:00Z");
  const watcher = createWatcher({
    post: (body) => options.front.send(body),
    settings: {
      baseUrl: "https://api.overturn.run",
      agent: "support-reply",
      requireReason: true,
      captureComments: false,
      decisionFields: [],
      minDraftChars: 80,
      scopeTag: null,
      reasonPack: "support",
      apiKey: "ov_live_123",
      ...options.settings,
    },
    origin: "https://app.frontapp.com",
    now: () => clock,
    log: () => {},
  });
  return { front: options.front, watcher, at: (iso: string) => (clock = Date.parse(iso)) };
}

/** Open on a conversation that already holds the AI's draft. */
function watching(options: { settings?: Partial<Parameters<typeof createWatcher>[0]["settings"]> } = {}) {
  const front = new FakeFront({ messages: [inbound], draft: draft(draftText) });
  const h = harness({ front, ...options });
  return { ...h, open: () => h.watcher.onContext(front.context(DRAFT_ID)) };
}

describe("a draft landing in the composer", () => {
  it("says so in the panel, and the conversation is not read yet", async () => {
    const h = watching();
    await h.open();
    const state = h.watcher.state();
    expect(state.watching).toBe(true);
    expect(state.status).toBe(preloadedStatus);
    expect(state.draft?.origin).toBe("preloaded");
    expect(h.front.reads.messages).toBe(0);
    expect(h.front.reads.comments).toBe(0);
  });

  it("shows nothing but the wait while the teammate is only typing", async () => {
    const front = new FakeFront({ messages: [inbound], draft: draft("<p>Hi</p>") });
    const h = harness({ front });
    await h.watcher.onContext(front.context(DRAFT_ID));
    expect(h.watcher.state().draft).toBeNull();
    expect(h.watcher.state().status).toBe("Waiting for a draft");
  });

  it("picks up a draft that lands after the plugin is already watching", async () => {
    const front = new FakeFront({ messages: [inbound] });
    const h = harness({ front });
    await h.watcher.onContext(front.context(null));
    expect(h.watcher.state().status).toBe("Waiting for a draft");
    front.draft = draft(draftText);
    await h.watcher.onContext(front.context(DRAFT_ID));
    expect(h.watcher.state().draft?.origin).toBe("inserted");
    expect(h.watcher.state().status).toBe(insertedStatus);
    expect(front.reads.messages).toBe(0);
  });

  it("takes the teammate's word for it when they mark the text by hand", async () => {
    const front = new FakeFront({ messages: [inbound], draft: draft("Hi Dana, one moment please.") });
    const h = harness({ front });
    await h.watcher.onContext(front.context(DRAFT_ID));
    await h.watcher.markDraft();
    expect(h.watcher.state().draft?.origin).toBe("manual");
    expect(h.watcher.state().status).toBe("Draft marked by you · 5 words");
  });
});

describe("a send", () => {
  it("posts the draft, the reply and the conversation to /v1/capture", async () => {
    const h = watching();
    await h.open();
    h.at("2026-10-01T11:00:10Z");
    h.front.messages = [...h.front.messages, sent(draftText)];
    h.front.draft = null; // the teammate sent it: Front takes the draft away
    await h.watcher.poll();

    expect(h.front.posted).toHaveLength(1);
    const body = h.front.posted[0]!;
    expect(body.source).toBe("front");
    expect(body.externalId).toBe("fr:cnv_48213");
    expect(body.actor).toBe("ray@carrier.com");
    expect(body.subject).toBe("Roof leak after storm");
    expect(body.draft.text).toContain("5 business days");
    expect(body.sent.text).toContain("5 business days");
    expect(body.context.map((m) => m.role)).toEqual(["customer", "agent"]);
    expect(body.secondsToSend).toBe(70);
    expect(h.watcher.state().status).toBe("Sent as drafted · approved");
    expect(h.front.reads.messages).toBe(1);
    expect(h.front.reads.comments).toBe(0);
  });

  it("records an edit with the reason code the teammate picked before sending", async () => {
    const h = watching();
    await h.open();
    await h.watcher.pickReason("wrong_amount_or_date", "Storm SLA is 2 days");
    h.front.messages = [...h.front.messages, sent(draftText.replace("5 business days", "2 business days"))];
    h.front.draft = null;
    await h.watcher.poll();

    expect(h.front.posted).toHaveLength(1);
    const body = h.front.posted[0]!;
    expect(body.reasonCode).toBe("wrong_amount_or_date");
    expect(body.reason).toBe("Storm SLA is 2 days");
    expect(body.sent.text).toContain("2 business days");
    expect(h.watcher.state().status).toBe("Captured · edit saved as a case");
  });

  it("holds a changed reply until there is a reason, without holding up Front", async () => {
    const h = watching();
    await h.open();
    h.front.messages = [...h.front.messages, sent(draftText.replace("covered", "not covered"))];
    h.front.draft = null;
    await h.watcher.poll();

    expect(h.front.posted).toHaveLength(0);
    expect(h.watcher.state().held).toBe(true);
    expect(h.watcher.state().status).toBe("Changed · pick why before Overturn records it");

    await h.watcher.pickReason("missed_exclusion", "");
    expect(h.front.posted).toHaveLength(1);
    const body = h.front.posted[0]!;
    expect(body.reasonCode).toBe("missed_exclusion");
    expect(body.sent.text).toContain("not covered");
    expect(h.watcher.state().held).toBe(false);
    expect(h.watcher.state().status).toBe("Captured · edit saved as a case");
  });

  it("keeps the held capture when the reason is cleared again", async () => {
    const h = watching();
    await h.open();
    h.front.messages = [...h.front.messages, sent(draftText.replace("covered", "not covered"))];
    h.front.draft = null;
    await h.watcher.poll();
    await expect(h.watcher.pickReason(null, "exclusion")).resolves.toBe(false);
    expect(h.front.posted).toHaveLength(0);
    expect(h.watcher.state().held).toBe(true);
  });

  it("tells the panel when the reason went out with the capture", async () => {
    const h = watching();
    await h.open();
    h.front.messages = [...h.front.messages, sent(draftText.replace("covered", "not covered"))];
    h.front.draft = null;
    await h.watcher.poll();
    await expect(h.watcher.pickReason("missed_exclusion", "exclusion")).resolves.toBe(true);
    // Nothing is held any more, so a second pick has nothing to send.
    await expect(h.watcher.pickReason("tone_wording", "")).resolves.toBe(false);
    expect(h.front.posted).toHaveLength(1);
  });

  it("keeps the held capture when Overturn is down, so the reason is not thrown away", async () => {
    const h = watching();
    await h.open();
    h.front.messages = [...h.front.messages, sent(draftText.replace("covered", "not covered"))];
    h.front.draft = null;
    await h.watcher.poll();
    h.front.fail = 500;
    await h.watcher.pickReason("missed_exclusion", "");
    expect(h.front.posted).toHaveLength(0);
    expect(h.watcher.state().held).toBe(true);
    expect(h.watcher.state().status).toBe("Not recorded (HTTP 500) · the reply went out");
  });

  it("records nothing when the draft was closed without sending", async () => {
    const h = watching();
    await h.open();
    h.front.draft = null;
    await h.watcher.poll();
    expect(h.front.posted).toHaveLength(0);
    expect(h.watcher.state().draft).toBeNull();
    expect(h.watcher.state().status).toBe("Waiting for a draft");
    expect(h.watcher.state().held).toBe(false);
  });

  it("does not record a reply another teammate sent on the same thread", async () => {
    const h = watching();
    await h.open();
    h.front.messages = [
      ...h.front.messages,
      { ...sent(draftText), from: { handle: "sam@carrier.com", name: "Sam" } },
    ];
    h.front.draft = null;
    await h.watcher.poll();
    expect(h.front.posted).toHaveLength(0);
    expect(h.watcher.state().status).toBe("Waiting for a draft");
  });

  it("never blocks or throws when the capture fails, and says what happened", async () => {
    const h = watching();
    await h.open();
    h.front.fail = 401;
    h.front.messages = [...h.front.messages, sent(draftText)];
    h.front.draft = null;
    await expect(h.watcher.poll()).resolves.toBeUndefined();
    expect(h.watcher.state().status).toBe("Not recorded (HTTP 401) · the reply went out");
  });

  it("sends the comments as internal notes when the admin turns them on", async () => {
    const h = watching({ settings: { captureComments: true } });
    await h.open();
    h.front.comments = [
      {
        id: "cmt_1",
        content: { body: "HO-3, no prior claims." },
        author: { name: "Ray", email: "ray@carrier.com" },
        createdAt: new Date("2026-10-01T10:30:00Z"),
      },
    ];
    h.front.messages = [...h.front.messages, sent(draftText)];
    h.front.draft = null;
    await h.watcher.poll();
    expect(h.front.reads.comments).toBe(1);
    expect(h.front.posted[0]?.context.map((m) => m.role)).toEqual(["customer", "note", "agent"]);
  });

  it("reads the decision fields with the draft and with the send, so a changed field is a change", async () => {
    const attribute = (value: unknown) => [{ id: "cfa_1", name: "coverage", value }];
    const front = new FakeFront({ messages: [inbound], draft: draft(draftText) });
    const h = harness({ front, settings: { decisionFields: ["coverage"], requireReason: false } });
    await h.watcher.onContext(front.context(DRAFT_ID, { attributes: attribute("covered") }));
    front.messages = [...front.messages, sent(draftText)];
    await h.watcher.onContext(front.context(null, { attributes: attribute("denied") }));
    expect(front.posted).toHaveLength(1);
    const body = front.posted[0]!;
    expect(body.draft.fields).toEqual({ coverage: "covered" });
    expect(body.sent.fields).toEqual({ coverage: "denied" });
  });
});

describe("what the plugin refuses to watch", () => {
  it("never reads a conversation that is out of scope", async () => {
    const front = new FakeFront({ messages: [inbound], draft: draft(draftText) });
    const h = harness({ front, settings: { scopeTag: "ai_drafted" } });
    await h.watcher.onContext(front.context(DRAFT_ID, { tags: [{ name: "billing" }] }));
    expect(h.watcher.state().watching).toBe(false);
    expect(h.watcher.state().status).toBe('Not watching: no "ai_drafted" tag');
    await h.watcher.poll();
    expect(front.reads.drafts).toBe(0);
    expect(front.posted).toHaveLength(0);
  });

  it("watches a scoped conversation that carries the tag", async () => {
    const front = new FakeFront({ messages: [inbound], draft: draft(draftText) });
    const h = harness({ front, settings: { scopeTag: "ai_drafted" } });
    await h.watcher.onContext(front.context(DRAFT_ID, { tags: [{ name: "ai_drafted" }] }));
    expect(h.watcher.state().watching).toBe(true);
    expect(h.watcher.state().draft).not.toBeNull();
  });

  it("says so when no single conversation is selected", async () => {
    const h = harness({ front: new FakeFront() });
    await h.watcher.onContext(null);
    expect(h.watcher.state().status).toBe("Select one conversation to watch the composer");
    expect(h.watcher.state().watching).toBe(false);
  });

  it("drops the last conversation's draft when another one is selected", async () => {
    const h = watching();
    await h.open();
    expect(h.watcher.state().draft).not.toBeNull();
    await h.watcher.onContext(h.front.context(null, { id: "cnv_999" }));
    expect(h.watcher.state().draft).toBeNull();
    expect(h.front.posted).toHaveLength(0);
  });

  it("a reply that arrives while a draft is open is not mistaken for a send", async () => {
    const h = watching();
    await h.open();
    h.front.messages = [...h.front.messages, sent("Another teammate's reply", "2026-10-01T10:59:30Z")];
    await h.watcher.poll();
    expect(h.front.posted).toHaveLength(0);
    expect(h.watcher.state().draft?.text).toContain("5 business days");
  });
});
