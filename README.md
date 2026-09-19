# jev-sscope

Watch a Claude Code session while it runs.

**A step that finishes in a watched Claude Code session appears on the page within a
few seconds, with Jev's answers beside it.**

A session is *watched* when you start it with this repository's hook settings; nothing
is installed globally. Each step (one batch of tool calls by the main agent; steps taken
inside subagents are not shown) goes from a Claude Code hook to a Cloudflare Worker. The Worker asks [Jev](https://developers.cloudflare.com/ai/models/typesafe/jev/)
(TypeSafe's typed-judgment model on Workers AI) two fixed questions about the step and
pushes the row to the page over a WebSocket.

```
claude --settings client/settings.json          the session you chose to watch
   │ UserPromptSubmit / PostToolBatch / PostCompact / Stop / SessionEnd, all async
   ▼
client/hook.py        trims, redacts, posts. Prints nothing. Gives up after 3 s.
   ▼
src/worker.ts         two tokens: one for the hook, one for the viewer
   ▼
src/hub.ts            one Durable Object: rows, Jev, WebSocket fan-out
   ▼
public/               the page: headline, two waveforms, one line per step
```

## What the page shows

- **Headline**: steps and minutes since the last *decisive* step (a test or check that
  passed or failed, a cause found, a person who answered), and the current goal.
- **Two waveforms**, one column per step, newest on the right: `information_gain`
  (0–3, from Jev) and `recovery` (0–1, from Jev). A step Jev has not answered is `·`.
- **One line per step**: time, first tool and its arguments, `info` bar, a thin block
  for `progress` (from the kind of step: failed ▁, read ▃, edit █), and `RECOVERY` when
  the step answers an earlier failure.

The goal is the user's prompt until the session writes a plan file under
`.claude/plans/`; from then on it is the sentence in that file's name.

## Run it locally

```sh
npm install
cp .dev.vars.example .dev.vars        # fill in two random tokens and Workers AI credentials
npm run dev                            # http://localhost:8787
```

Open `http://localhost:8787/?t=<VIEW_TOKEN>` once; the token moves into a cookie (30 days)
and the address bar is clean afterwards. Then follow [client/README.md](client/README.md)
to start a watched session.

Jev is billed through Cloudflare's Unified Billing (prepaid credits); the free Workers AI
allocation does not cover it. Each step is one call whose input is the trimmed step plus
the two questions; see the model's price in your Cloudflare dashboard.

The page logs every row's arrival to the browser console (`jev-sscope row …`) with the
time the hook sent it; that line is how the "within a few seconds" above is measured.

## Checks

```sh
npm test          # Worker meters (node --test) and the hook (unittest)
npm run check     # TypeScript
```

## What leaves the machine

Only what the hook sends, and only from sessions started with the hook's settings file:
the session id and working directory, the prompt (400 chars), each tool's arguments
(300 chars) and result (600 chars, 2,400 per step), and the head of a compaction summary.
Strings shaped like credentials are replaced with `[redacted]` before the cut, so a long
secret does not survive by losing the part that identifies it. Rows live in your own
Cloudflare account's Durable Object and, for scoring, pass through Cloudflare to TypeSafe.

The hook verifies HTTPS normally. Behind a TLS-intercepting proxy whose CA fails Python's
strict RFC 5280 check, `JEV_SSCOPE_RELAX_TLS=1` drops only that flag; chain and host name
are still verified.

Not done yet: deploying to `workers.dev`. Everything above runs against `wrangler dev`.
