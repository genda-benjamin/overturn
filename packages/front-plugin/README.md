# Overturn for Front

QA for AI-drafted replies, in the conversation sidebar. It watches the composer for the AI draft, diffs it against what the teammate actually sent, asks for a one-line reason, and posts the result to `POST /v1/capture`. The draft becomes a recorded run, the difference becomes a case, and the suite replays it against any model before the next prompt or model change. The drafting agent never has to be instrumented, and it does not matter who wrote the draft: Front AI, a snippet, a homegrown drafter or a paste. The support lead gets the untouched rate and the fixes by reason, by team and by week, on the Capture page.

## What the teammate sees

A small panel in the conversation sidebar:

- **Draft inserted · 112 words** once a draft lands in the reply box reply-sized in one go (Front AI, a snippet, a paste). A composer that already holds a reply when the plugin loads is **found in the composer**; **Use the current text as the draft** marks a draft by hand.
- A **reason** picker with the installed pack's eight codes and an optional note.
- On send: sent as drafted → an `approve` capture, no prompt; changed → an `edit` capture with the reason as the case's title and the judge's rubric. With *require a reason* on, a changed reply is not recorded until a code is picked.

Overturn failing never blocks the send; the panel says what happened and gets out of the way.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build and host the plugin: `pnpm --filter @overturn-ai/front-plugin build` → `dist/overturn-front-plugin.zip`, unzipped on any static host (or your own). Front frames the page in the sidebar, so it has to be HTTPS and publicly reachable.
3. In Front: **Developers** → create an app → add a **plugin** feature of type **sidebar** with the plugin URL
   `https://<your-host>/index.html?overturn_api_key=<key>&agent=support-reply`.
4. Enable the plugin for the company, then open a conversation to see it.

Front plugins have no settings object like a Zendesk app has, so the settings ride in the plugin URL's query string:

| Parameter | Default | What it does |
| :-- | :-- | :-- |
| `overturn_api_key` | — | Project API key. Without it the capture is relayed through Front with the app's own security scheme, so no key sits in the plugin (`relayHttp`). |
| `agent` | `support-reply` | The workflow; one regression suite per workflow. A claims team might use `claims-reply`. |
| `reason_pack` | `support` | `support` (vendor-neutral) or `claims`, the chips the teammate clicks. |
| `decision_fields` | — | Conversation custom attributes that *are* the decision, by name or id, e.g. `coverage,reserve,denial_reason`. Changes to these are scored exactly; the prose is scored by the judge. |
| `require_reason` | `true` | Hold a changed reply's capture until a reason code is picked. |
| `capture_comments` | `false` | Also send the conversation's comments as internal notes in the captured context. |
| `min_draft_chars` | `80` | Composer text shorter than this never counts as a draft. |
| `scope_tag` | — | Watch only conversations carrying this tag; every other conversation is never read. |
| `overturn_base_url` | `https://api.overturn.run` | Self-hosting. |

Add `?debug=true` (or `&debug=true`) to show the context the SDK is sending under the panel.

## How it reads Front

- The plugin is a **sidebar plugin**, so it is live for the whole time a conversation is open. A draft is discovered from `conversation.draftId` and read with `fetchDraft`; while a draft is open the plugin also re-reads it every 1.5s, because Front pushes context updates when the conversation or the draft changes but not when the teammate edits the text.
- **Nothing is read before a draft appears.** The thread (`listMessages`, and `listComments` when comments are captured) is read only after a draft existed and then left the composer — so a human-only conversation never leaves Front and never enters Overturn.
- The sent body is the newest message the teammate sent after the draft appeared, not the text the plugin last saw in the composer: the conversation is the record. If the draft was closed without a send, nothing is recorded. A reply another teammate sent on the same thread is never captured as this teammate's fix.
- `secondsToSend` is measured from the moment the draft appeared in front of the teammate.

### About `require_reason`

Front's Plugin SDK has no pre-send hook. Verified against `@frontapp/plugin-sdk` 1.12.0: the only stream is `Front.contextUpdates`, the draft methods are `createDraft` / `updateDraft` / `fetchDraft` / `close` / `closeDraft`, and Front's send button is not the plugin's to hold. A plugin cannot veto a send.

So `require_reason` is enforced where it can be: a changed reply whose capture has no reason code is **held in the panel** ("Changed · pick why before Overturn records it") and posted the moment a chip is clicked, with the note. Nothing unexplained lands in the suite, and the teammate's send is never held up — a failed or blocked capture is never a failed reply. Recording an unexplained change instead, or pretending to block a send we cannot see, would both be worse.

## Development

```bash
pnpm --filter @overturn-ai/front-plugin test       # the payload builder and the watcher
pnpm --filter @overturn-ai/front-plugin typecheck
pnpm --filter @overturn-ai/front-plugin build      # dist/overturn-front-plugin.zip
```

`src/capture.ts` is the payload builder (pure, tested): settings, draft detection, the conversation as capture context, and the draft-versus-sent decision. `src/watch.ts` is the watcher that turns Front contexts, drafts and sends into those decisions, written against a small `FrontLike` interface so it is tested with a mocked SDK (`src/watch.test.ts`) — no live Front account needed. `src/main.ts` is the SDK and DOM glue, including the two ways to authenticate the capture. `app/` is the page Front frames.
