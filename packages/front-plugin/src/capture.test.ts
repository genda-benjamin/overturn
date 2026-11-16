import { describe, expect, it } from "vitest";
import {
  type ConversationSnapshot,
  contextFrom,
  createDraftDetector,
  DEFAULT_SETTINGS,
  decideOnSend,
  entriesFrom,
  type FrontConversationLike,
  type FrontMessageLike,
  fieldsFrom,
  inScope,
  quickReasons,
  sentFrom,
  settingsFrom,
  snapshotFrom,
  statusLine,
  stripHtml,
} from "./capture";

const draftText =
  "<p>Hi Dana,</p><p>Thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 5 business days.</p>";

const conversation: FrontConversationLike = {
  id: "cnv_48213",
  subject: "Roof leak after storm",
  recipient: { handle: "dana@example.com", name: "Dana" },
  tags: [{ name: "billing" }],
  customFieldAttributes: [
    { id: "cfa_1", name: "coverage", value: "covered" },
    { id: "cfa_2", name: "reserve", value: 4000 },
    { id: "cfa_3", name: "reopened_at", value: new Date("2026-10-02T09:00:00Z") },
  ],
  draftId: "drf_1",
};

const messages: FrontMessageLike[] = [
  {
    id: "msg_1",
    status: "inbound",
    content: { body: "<div>Water came through the ceiling.<br>Photos attached.</div>", type: "html" },
    from: { handle: "dana@example.com", name: "Dana" },
    date: new Date("2026-10-01T10:00:00Z"),
  },
  {
    id: "msg_2",
    status: "outbound",
    content: { body: draftText, type: "html" },
    from: { handle: "ray@carrier.com", name: "Ray" },
    date: new Date("2026-10-01T11:00:00Z"),
  },
];

const snapshot = (): ConversationSnapshot =>
  snapshotFrom({ conversation, messages, origin: "https://app.frontapp.com" });

describe("settings", () => {
  it("reads the plugin URL, which is the only settings surface a Front plugin has", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      overturn_api_key: "ov_live_123",
      agent: "claims-reply",
      require_reason: "false",
      decision_fields: "coverage, reserve ,",
      min_draft_chars: "120",
      reason_pack: "claims",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.apiKey).toBe("ov_live_123");
    expect(s.agent).toBe("claims-reply");
    expect(s.requireReason).toBe(false);
    expect(s.decisionFields).toEqual(["coverage", "reserve"]);
    expect(s.minDraftChars).toBe(120);
    expect(s.reasonPack).toBe("claims");
  });

  it("falls back to the defaults, with require_reason on and no key", () => {
    expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.requireReason).toBe(true);
    expect(settingsFrom({ require_reason: "true" }).requireReason).toBe(true);
    expect(settingsFrom({ min_draft_chars: "0" }).minDraftChars).toBe(DEFAULT_SETTINGS.minDraftChars);
  });

  it("a scope tag limits which conversations are watched at all", () => {
    expect(inScope(["billing"], DEFAULT_SETTINGS)).toBe(true);
    const scoped = settingsFrom({ scope_tag: "ai_drafted" });
    expect(scoped.scopeTag).toBe("ai_drafted");
    expect(inScope(["billing"], scoped)).toBe(false);
    expect(inScope(["billing", "ai_drafted"], scoped)).toBe(true);
  });

  it("reason_pack picks the chips: support by default, claims when a claims team opts in", () => {
    const support = quickReasons(settingsFrom({}));
    const codes = support.map((r) => r.code);
    expect(codes).toContain("wrong_answer");
    expect(codes).toContain("should_escalate");
    expect(codes).not.toContain("reserve_too_low");
    expect(quickReasons(settingsFrom({ reason_pack: "claims" })).map((r) => r.code)).toContain(
      "wrong_coverage_decision",
    );
    // both packs keep tone/wording so the suite exclusion applies to either
    expect(codes).toContain("tone_wording");
    expect(settingsFrom({ reason_pack: "garbage" }).reasonPack).toBe("support");
  });
});

describe("draft detection", () => {
  const long = "x".repeat(200);
  it("a reply-sized insert into the composer is the draft; typing is not", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer("", 0)).toBeNull();
    let text = "";
    for (let i = 1; i <= 100; i++) {
      text += "ab";
      expect(d.onComposer(text, i * 100)).toBeNull();
    }
    expect(d.current()).toBeNull();
    const d2 = createDraftDetector({ minDraftChars: 80 });
    d2.onComposer("", 0);
    expect(d2.onComposer(long, 500)?.origin).toBe("inserted");
    expect(d2.onComposer(`${long} more`, 600)).toBeNull(); // only the first
  });

  it("a composer that already holds a reply when the plugin loads is a preloaded draft", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer(long, 10)?.origin).toBe("preloaded");
  });

  it("an insert after a pause, while a short greeting was typed, still counts", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    d.onComposer("", 0);
    d.onComposer("Hi Dana,", 1000);
    expect(d.onComposer(`Hi Dana,\n${long}`, 9000)?.origin).toBe("inserted");
  });
});

describe("the conversation", () => {
  it("keeps the thread oldest first and leaves drafts out of it", () => {
    const entries = entriesFrom([
      messages[1]!,
      { id: "drf_1", status: "outbound", content: { body: draftText, type: "html" } },
      messages[0]!,
      { id: "msg_3", status: "inbound", content: { body: "<p></p>", type: "html" }, date: new Date() },
    ]);
    expect(entries.map((e) => e.id)).toEqual(["msg_1", "msg_2"]);
    expect(entries[0]?.kind).toBe("inbound");
    expect(entries[1]?.kind).toBe("outbound");
  });

  it("reads comments as internal notes when the admin asks for them", () => {
    const entries = entriesFrom(messages, [
      {
        id: "cmt_1",
        content: { body: "HO-3, no prior claims." },
        author: { name: "Ray", email: "ray@carrier.com" },
        createdAt: new Date("2026-10-01T10:30:00Z"),
      },
    ]);
    expect(entries.map((e) => e.kind)).toEqual(["inbound", "comment", "outbound"]);
    expect(entries[1]?.format).toBe("markdown");
  });

  it("takes the newest reply the teammate sent after the draft appeared", () => {
    const entries = entriesFrom([
      messages[0]!,
      messages[1]!,
      {
        id: "msg_9",
        status: "outbound",
        content: { body: "Later reply", type: "html" },
        from: { handle: "sam@carrier.com" },
        date: new Date("2026-10-02T11:00:00Z"),
      },
    ]);
    expect(sentFrom(entries)?.id).toBe("msg_9");
    expect(sentFrom(entries, Date.parse("2026-10-02T00:00:00Z"))?.id).toBe("msg_9");
    expect(sentFrom(entries, Date.parse("2026-10-03T00:00:00Z"))).toBeNull();
  });

  it("maps the thread to capture roles, with html stripped", () => {
    expect(contextFrom(snapshot())).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "Water came through the ceiling.\nPhotos attached.",
        at: "2026-10-01T10:00:00.000Z",
      },
      {
        role: "agent",
        author: "ray@carrier.com",
        content: stripHtml(draftText),
        at: "2026-10-01T11:00:00.000Z",
      },
    ]);
  });

  it("links the case back to the conversation in Front", () => {
    const s = snapshot();
    expect(s.url).toBe("https://app.frontapp.com/open/cnv_48213");
    expect(s.recipientEmail).toBe("dana@example.com");
    expect(snapshotFrom({ conversation, messages, origin: null }).url).toBeNull();
  });

  it("reads the decision fields by name or id, and keeps dates as JSON", () => {
    expect(fieldsFrom(conversation, ["coverage", "cfa_2", "missing"])).toEqual({
      coverage: "covered",
      cfa_2: 4000,
      missing: null,
    });
    expect(fieldsFrom(conversation, ["reopened_at"])).toEqual({ reopened_at: "2026-10-02T09:00:00.000Z" });
  });

  it("strips html and entities", () => {
    expect(stripHtml("<p>a&nbsp;b</p><p>c<br>d</p>")).toBe("a b\nc\nd");
  });
});

describe("decideOnSend", () => {
  const draft = { text: stripHtml(draftText), origin: "inserted" as const, at: 1 };
  const base = {
    conversation: snapshot(),
    draft,
    draftFields: {},
    reasonCode: null as string | null,
    reason: "",
    actor: "ray@carrier.com",
    // The claims pack requires a reason by default; most cases here test the capture shape.
    settings: { ...DEFAULT_SETTINGS, requireReason: false },
  };

  it("skips without a draft, an empty send, and a reply another teammate sent", () => {
    const sent = { text: "<p>x</p>", fields: {} };
    expect(decideOnSend({ ...base, draft: null, send: sent })).toEqual({ action: "skip", why: "no-draft" });
    expect(decideOnSend({ ...base, send: { text: "<p></p>", fields: {} } })).toEqual({
      action: "skip",
      why: "empty",
    });
    expect(decideOnSend({ ...base, send: { ...sent, authorHandle: "sam@carrier.com" } })).toEqual({
      action: "skip",
      why: "someone-else",
    });
  });

  it("sending the draft unchanged is an approve capture", () => {
    const d = decideOnSend({
      ...base,
      send: { text: draftText, fields: {}, authorHandle: "ray@carrier.com" },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("front");
    expect(d.body.externalId).toBe("fr:cnv_48213");
    expect(d.body.agent).toBe("support-reply");
    expect(d.body.draft.text).toBe(d.body.sent.text);
    expect(d.body.reasonCode).toBeNull();
    expect(d.body.tags).toEqual(["draft:inserted", "public-reply"]);
    expect(d.body.url).toBe("https://app.frontapp.com/open/cnv_48213");
    expect(d.body.metadata).toEqual({ recipient: "dana@example.com" });
    expect(d.body.context).toHaveLength(2);
  });

  it("a changed reply is an edit capture carrying the reason", () => {
    const d = decideOnSend({
      ...base,
      reasonCode: "wrong_amount_or_date",
      reason: "Storm SLA is 2 days",
      send: { text: draftText.replace("5 business days", "2 business days"), fields: {} },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.body.reason).toBe("Storm SLA is 2 days");
    expect(d.body.reasonCode).toBe("wrong_amount_or_date");
    expect(d.body.sent.text).toContain("2 business days");
    expect(d.body.sent.fields).toBeUndefined();
  });

  it("require_reason holds a changed reply until a code arrives, and a note alone is not enough", () => {
    const settings = DEFAULT_SETTINGS;
    const sent = draftText.replace("covered", "not covered");
    const blocked = decideOnSend({ ...base, settings, send: { text: sent, fields: {} } });
    expect(blocked.action).toBe("need-reason");
    if (blocked.action !== "need-reason") return;
    expect(blocked.changedFields).toEqual([]);
    // The held body is ready: the panel only adds the picked code.
    expect(blocked.body.reasonCode).toBeNull();
    expect(blocked.body.sent.text).toContain("not covered");
    const noteOnly = decideOnSend({
      ...base,
      settings,
      reason: "exclusion",
      send: { text: sent, fields: {} },
    });
    expect(noteOnly.action).toBe("need-reason");
    const ok = decideOnSend({
      ...base,
      settings,
      reasonCode: "missed_exclusion",
      send: { text: sent, fields: {} },
    });
    expect(ok.action).toBe("capture");
    if (ok.action === "capture") expect(ok.body.reasonCode).toBe("missed_exclusion");
    const unchanged = decideOnSend({ ...base, settings, send: { text: draftText, fields: {} } });
    expect(unchanged.action).toBe("capture");
  });

  it("decision fields ride along and a changed field is a change", () => {
    const settings = { ...DEFAULT_SETTINGS, decisionFields: ["coverage"], requireReason: false };
    const d = decideOnSend({
      ...base,
      settings,
      reasonCode: "wrong_coverage_decision",
      draftFields: { coverage: "covered" },
      send: { text: draftText, fields: { coverage: "denied" } },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.changedFields).toEqual(["coverage"]);
    expect(d.body.draft.fields).toEqual({ coverage: "covered" });
    expect(d.body.sent.fields).toEqual({ coverage: "denied" });
  });

  it("records how long the draft sat in front of the expert", () => {
    const d = decideOnSend({
      ...base,
      draft: { text: stripHtml(draftText), origin: "inserted", at: 10_000 },
      now: 14_250,
      send: { text: draftText, fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.secondsToSend).toBe(4.3);
  });

  it("a hand-marked draft is tagged as such", () => {
    const d = decideOnSend({
      ...base,
      draft: { text: stripHtml(draftText), origin: "manual", at: 1 },
      send: { text: draftText, fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.tags).toEqual(["draft:manual", "public-reply"]);
  });
});

describe("statusLine", () => {
  it("describes the state", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine({ text: "one two three", origin: "manual", at: 1 }, null)).toBe(
      "Draft marked by you · 3 words",
    );
    expect(statusLine(null, { kind: "captured", changed: false, dedup: false, caseTitle: null })).toBe(
      "Sent as drafted · approved",
    );
    expect(statusLine(null, { kind: "captured", changed: true, dedup: true, caseTitle: null })).toBe(
      "Captured · already in the suite",
    );
    expect(statusLine(null, { kind: "held" })).toBe("Changed · pick why before Overturn records it");
    expect(statusLine(null, { kind: "failed", detail: "HTTP 401" })).toBe(
      "Not recorded (HTTP 401) · the reply went out",
    );
  });
});
