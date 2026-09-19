// The one Durable Object. Holds every watched session, asks Jev, and pushes rows
// to whoever has the page open.

import { DurableObject } from "cloudflare:workers";
import {
  LIMITS,
  QUESTIONS,
  buildState,
  oneLine,
  planSentence,
  progress,
  toActions,
  unwrapAnswers,
  type Action,
  type Answers,
  type ToolCall,
} from "./meters";

export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  HUB: DurableObjectNamespace<Hub>;
  INGEST_TOKEN: string;
  VIEW_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

/** What client/hook.py sends. */
export interface HookEvent {
  event: "UserPromptSubmit" | "PostToolBatch" | "PostCompact" | "Stop" | "SessionEnd";
  session_id: string;
  cwd?: string;
  sent_at: number;
  prompt?: string;
  compact_summary?: string;
  tool_calls?: ToolCall[];
}

/** One line on the page. Markers and steps share the shape; `kind` tells them apart. */
export interface Row {
  seq: number;
  sent_at: number;
  kind: "step" | "prompt" | "goal" | "compact" | "stop" | "end";
  text?: string; // markers: the prompt / goal / summary head
  tools?: { tool: string; input: string; failed: boolean }[];
  progress?: 0 | 1 | 2;
  info?: number;
  info_conf?: number;
  recovery?: number;
  jev_ms?: number;
  jev_error?: string;
}

const GOAL_MIN_CHARS = 12;
const SESSIONS_KEPT = 50;
const SESSIONS_LISTED = 10;
const JEV_TIMEOUT_MS = 15_000;

export class Hub extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions(
        session TEXT PRIMARY KEY, cwd TEXT, started_at INTEGER, last_at INTEGER,
        goal TEXT DEFAULT '', seq INTEGER DEFAULT 0, ended INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS rows(
        session TEXT, seq INTEGER, sent_at INTEGER, kind TEXT, line TEXT, body TEXT,
        PRIMARY KEY(session, seq));
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/ingest") {
      const event = (await request.json()) as HookEvent;
      this.ingest(event);
      return new Response(null, { status: 202 });
    }
    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/sessions") return Response.json(this.sessions());
    if (url.pathname === "/history") {
      const session = url.searchParams.get("session") ?? "";
      return Response.json(this.history(session));
    }
    return new Response("not found", { status: 404 });
  }

  // The page sends nothing we act on; closing is the only message that matters.
  webSocketMessage() {}
  webSocketError() {}
  webSocketClose(ws: WebSocket) {
    try {
      ws.close();
    } catch {}
  }

  private broadcast(message: unknown) {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {}
    }
  }

  private ingest(event: HookEvent) {
    const session = String(event.session_id ?? "");
    if (!session) return;
    const now = Number(event.sent_at) || Date.now();
    this.sql.exec(
      `INSERT INTO sessions(session, cwd, started_at, last_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(session) DO UPDATE SET last_at = excluded.last_at, ended = 0`,
      session,
      String(event.cwd ?? ""),
      now,
      now,
    );
    // Sessions are kept to a number; the oldest go, rows and all.
    this.sql.exec(
      `DELETE FROM rows WHERE session IN (
         SELECT session FROM sessions ORDER BY last_at DESC LIMIT -1 OFFSET ?)`,
      SESSIONS_KEPT,
    );
    this.sql.exec(`DELETE FROM sessions WHERE session IN (
         SELECT session FROM sessions ORDER BY last_at DESC LIMIT -1 OFFSET ?)`, SESSIONS_KEPT);

    switch (event.event) {
      case "UserPromptSubmit": {
        const prompt = String(event.prompt ?? "").trim();
        this.marker(session, now, "prompt", prompt.slice(0, 200));
        if (prompt.length >= GOAL_MIN_CHARS && !this.goal(session)) this.setGoal(session, prompt, now);
        return;
      }
      case "PostCompact":
        this.marker(session, now, "compact", String(event.compact_summary ?? "").slice(0, LIMITS.compact));
        return;
      case "Stop":
        // One turn ended. The session is still there.
        this.marker(session, now, "stop", "");
        return;
      case "SessionEnd":
        this.marker(session, now, "end", "");
        this.sql.exec(`UPDATE sessions SET ended = 1 WHERE session = ?`, session);
        return;
      case "PostToolBatch":
        this.step(session, now, event.tool_calls ?? []);
        return;
    }
  }

  private goal(session: string): string {
    const row = this.sql.exec<{ goal: string }>(`SELECT goal FROM sessions WHERE session = ?`, session).toArray()[0];
    return row?.goal ?? "";
  }

  private setGoal(session: string, goal: string, at: number) {
    this.sql.exec(`UPDATE sessions SET goal = ? WHERE session = ?`, goal.slice(0, LIMITS.goal), session);
    this.marker(session, at, "goal", goal.slice(0, LIMITS.goal));
  }

  private nextSeq(session: string): number {
    this.sql.exec(`UPDATE sessions SET seq = seq + 1 WHERE session = ?`, session);
    return this.sql.exec<{ seq: number }>(`SELECT seq FROM sessions WHERE session = ?`, session).one().seq;
  }

  private insert(session: string, row: Row, line: string) {
    this.sql.exec(
      `INSERT OR REPLACE INTO rows(session, seq, sent_at, kind, line, body) VALUES (?, ?, ?, ?, ?, ?)`,
      session,
      row.seq,
      row.sent_at,
      row.kind,
      line,
      JSON.stringify(row),
    );
    // Cap per session. Old rows go; the page never asked for more than the recent ones.
    this.sql.exec(
      `DELETE FROM rows WHERE session = ? AND seq <= (
         SELECT seq FROM rows WHERE session = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
      session,
      session,
      LIMITS.rowsPerSession,
    );
    this.broadcast({ type: "row", session, row });
  }

  private marker(session: string, at: number, kind: Row["kind"], text: string) {
    const row: Row = { seq: this.nextSeq(session), sent_at: at, kind, text };
    this.insert(session, row, "");
  }

  private step(session: string, at: number, calls: ToolCall[]) {
    const actions = toActions(calls);
    if (!actions.length) return;
    const seq = this.nextSeq(session);
    const row: Row = {
      seq,
      sent_at: at,
      kind: "step",
      tools: actions.map((a) => ({ tool: a.tool, input: a.input.slice(0, 120), failed: a.failed })),
      progress: progress(actions),
    };
    // First message: the step is on the page before Jev has said anything.
    this.insert(session, row, oneLine(seq, actions));

    const sentence = planSentence(actions);
    if (sentence && sentence !== this.goal(session)) this.setGoal(session, sentence, at);

    // Second message, after Jev. The request has already been answered with 202.
    this.ctx.waitUntil(this.score(session, row, actions));
  }

  private async score(session: string, row: Row, actions: Action[]) {
    const recent = this.sql
      .exec<{ line: string }>(
        `SELECT line FROM rows WHERE session = ? AND kind = 'step' AND seq < ? ORDER BY seq DESC LIMIT ?`,
        session,
        row.seq,
        LIMITS.recent,
      )
      .toArray()
      .map((r) => r.line)
      .reverse();
    const state = buildState(this.goal(session), recent, actions);
    const started = Date.now();
    try {
      const answers = await this.askJev(state);
      row.info = answers.information_gain?.score;
      row.info_conf = answers.information_gain?.confidence;
      row.recovery = answers.recovery?.noul;
    } catch (error) {
      row.jev_error = String(error instanceof Error ? error.message : error).slice(0, 200);
    }
    row.jev_ms = Date.now() - started;
    this.sql.exec(`UPDATE rows SET body = ? WHERE session = ? AND seq = ?`, JSON.stringify(row), session, row.seq);
    this.broadcast({ type: "row", session, row });
  }

  private async askJev(state: unknown): Promise<Answers> {
    const input = { state, questions: QUESTIONS };
    let payload: unknown;
    if (this.env.CLOUDFLARE_API_TOKEN && this.env.CLOUDFLARE_ACCOUNT_ID) {
      // REST: the same call the binding makes, for when the binding cannot reach this model.
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/ai/run`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "typesafe/jev", input }),
          signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
        },
      );
      if (!response.ok) throw new Error(`jev rest ${response.status}: ${(await response.text()).slice(0, 200)}`);
      payload = await response.json();
    } else {
      const ai = this.env.AI as unknown as { run(model: string, inputs: unknown): Promise<unknown> };
      payload = await Promise.race([
        ai.run("typesafe/jev", input),
        new Promise((_, reject) => setTimeout(() => reject(new Error("jev binding timed out")), JEV_TIMEOUT_MS)),
      ]);
    }
    const answers = unwrapAnswers(payload);
    if (!answers) throw new Error(`no answers in ${JSON.stringify(payload).slice(0, 200)}`);
    return answers;
  }

  private sessions() {
    const list = this.sql
      .exec<{ session: string; cwd: string; started_at: number; last_at: number; goal: string; ended: number }>(
        `SELECT session, cwd, started_at, last_at, goal, ended FROM sessions ORDER BY last_at DESC LIMIT ?`,
        SESSIONS_LISTED,
      )
      .toArray();
    return list.map((s) => ({
      ...s,
      spark: this.sql
        .exec<{ body: string }>(
          `SELECT body FROM rows WHERE session = ? AND kind = 'step' ORDER BY seq DESC LIMIT 40`,
          s.session,
        )
        .toArray()
        .map((r) => (JSON.parse(r.body) as Row).info ?? null)
        .reverse(),
    }));
  }

  private history(session: string) {
    return this.sql
      .exec<{ body: string }>(
        `SELECT body FROM rows WHERE session = ? ORDER BY seq DESC LIMIT 300`,
        session,
      )
      .toArray()
      .map((r) => JSON.parse(r.body) as Row)
      .reverse();
  }
}
