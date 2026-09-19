// The page. Plain DOM, everything through textContent: what arrives here is the
// session's own commands and output, and none of it may become markup.

"use strict";

const BLOCKS = " ▁▂▃▄▅▆▇█";
const DECISIVE = 2.5;
const ROWS_SHOWN = 300;

const state = {
  sessions: [], // from /sessions: session, cwd, ended, ...
  current: null,
  rows: new Map(), // session -> Map(seq -> row)
  hover: false,
  connected: false,
};

const el = {
  sessions: document.getElementById("sessions"),
  since: document.getElementById("since"),
  goal: document.getElementById("goal"),
  meta: document.getElementById("meta"),
  waves: document.getElementById("waves"),
  rows: document.getElementById("rows"),
};

el.rows.addEventListener("mouseenter", () => (state.hover = true));
el.rows.addEventListener("mouseleave", () => (state.hover = false));

function block(value, top) {
  if (value === null || value === undefined) return "·";
  const v = Math.max(0, Math.min(top, value));
  return BLOCKS[Math.max(1, Math.round((v / top) * 8))];
}

function clock(ms) {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function span(className, text) {
  const s = document.createElement("span");
  s.className = className;
  s.textContent = text;
  return s;
}

function rowsOf(session) {
  if (!state.rows.has(session)) state.rows.set(session, new Map());
  return state.rows.get(session);
}

function sortedRows(session) {
  return [...rowsOf(session).values()].sort((a, b) => a.sent_at - b.sent_at || a.seq - b.seq);
}

/** A row with Jev's answers wins over the same row without them, whichever arrived last. */
function keep(session, row) {
  const map = rowsOf(session);
  const had = map.get(row.seq);
  if (had && had.info !== undefined && row.info === undefined) return;
  map.set(row.seq, row);
}

function sessionOf(id) {
  return state.sessions.find((s) => s.session === id);
}

// ---- sessions band ----------------------------------------------------------

async function loadSessions() {
  const response = await fetch("/sessions");
  if (!response.ok) return;
  state.sessions = await response.json();
  renderSessions();
  if (!state.current && state.sessions.length) await selectSession(state.sessions[0].session);
}

function renderSessions() {
  el.sessions.replaceChildren();
  for (const s of state.sessions) {
    const button = document.createElement("button");
    button.className = s.session === state.current ? "active" : "";
    const repo = (s.cwd || "").split("/").filter(Boolean).pop() || s.session.slice(0, 8);
    const rows = sortedRows(s.session);
    const steps = rows.filter((r) => r.kind === "step");
    // Rows are held only for sessions that were opened here; the server's spark covers the rest.
    const values = steps.length ? steps.slice(-40).map((r) => r.info) : s.spark || [];
    const ended = s.ended || rows.some((r) => r.kind === "end");
    button.append(
      span("", `${repo} ${s.session.slice(0, 8)}`),
      span(ended ? "" : "live", ended ? "  ○" : "  ●"),
      span("spark", values.map((v) => block(v, 3)).join("")),
    );
    button.addEventListener("click", () => selectSession(s.session));
    el.sessions.append(button);
  }
}

async function selectSession(session) {
  state.current = session;
  renderSessions();
  const response = await fetch(`/history?session=${encodeURIComponent(session)}`);
  if (response.ok) for (const row of await response.json()) keep(session, row);
  render();
  renderSessions();
}

// ---- live feed --------------------------------------------------------------

function connect() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${scheme}://${location.host}/ws`);
  ws.addEventListener("open", async () => {
    state.connected = true;
    // Whatever arrived while this socket was down is in the hub, not here.
    await loadSessions();
    if (state.current) await selectSession(state.current);
    render();
  });
  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type !== "row") return;
    const received = Date.now();
    keep(message.session, message.row);
    // For measuring how long a step takes to get here.
    console.log("jev-sscope row", message.session, message.row.seq, message.row.kind, "sent_at", message.row.sent_at, "received", received, "lag_ms", received - message.row.sent_at, "info", message.row.info);
    if (!sessionOf(message.session)) loadSessions();
    if (!state.current) state.current = message.session;
    if (message.session === state.current) render();
    else renderSessions();
  });
  ws.addEventListener("close", () => {
    state.connected = false;
    renderHeadline(state.current ? sortedRows(state.current) : []);
    setTimeout(connect, 2000);
  });
}

// ---- rendering --------------------------------------------------------------

function render() {
  const rows = state.current ? sortedRows(state.current) : [];
  renderHeadline(rows);
  renderWaves(rows);
  renderRows(rows);
}

function minutes(ms) {
  return Math.max(0, Math.round((Date.now() - ms) / 60000));
}

function renderHeadline(rows) {
  const steps = rows.filter((r) => r.kind === "step");
  const goal = [...rows].reverse().find((r) => r.kind === "goal");
  const session = sessionOf(state.current);

  if (!state.current) {
    el.since.textContent = "—";
    el.goal.textContent = state.connected ? "connected · waiting for a watched session" : "connecting…";
    el.meta.textContent = "";
    return;
  }
  el.goal.textContent = goal ? `GOAL  ${goal.text.replace(/\s+/g, " ")}` : "GOAL  (not written down yet)";

  let sinceSteps = 0;
  let decisiveAt = null;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].info !== undefined && steps[i].info >= DECISIVE) {
      decisiveAt = steps[i].sent_at;
      break;
    }
    sinceSteps++;
  }
  const last = steps[steps.length - 1];
  if (!last) el.since.textContent = "no steps yet";
  else if (decisiveAt === null) el.since.textContent = `${sinceSteps} steps, nothing decisive · last step ${minutes(last.sent_at)} min ago`;
  else el.since.textContent = `${sinceSteps} steps / ${minutes(decisiveAt)} min since decisive · last step ${minutes(last.sent_at)} min ago`;

  const unanswered = steps.filter((r) => r.info === undefined).length;
  const ended = (session && session.ended) || rows.some((r) => r.kind === "end");
  el.meta.textContent =
    `${steps.length} steps · Jev unanswered ${unanswered}` +
    (ended ? " · session ended" : "") +
    (state.connected ? "" : " · reconnecting");
}

/**
 * How many columns fit beside the label. Measured from a real cell, not assumed:
 * block glyphs are wider than spaces in most monospace fonts, which is also why
 * each column is its own fixed-width cell instead of a character in a string.
 */
function waveColumns() {
  const probe = span("cell", "█");
  el.waves.append(probe);
  const cellWidth = probe.getBoundingClientRect().width || 10;
  probe.remove();
  return Math.max(20, Math.floor((el.waves.clientWidth - 7 * 8) / cellWidth));
}

function renderWaves(rows) {
  const columns = waveColumns();
  const recent = rows.slice(-columns);
  const lines = [
    ["info  ", (r) => (r.kind === "step" ? block(r.info, 3) : " ")],
    ["recov ", (r) => (r.kind === "step" ? block(r.recovery, 1) : " ")],
    ["marks ", (r) => ({ goal: "G", prompt: "U", compact: "C", stop: "S", end: "E" })[r.kind] || " "],
  ];
  el.waves.replaceChildren();
  for (const [label, pick] of lines) {
    const line = document.createElement("div");
    line.className = "line";
    const cells = document.createElement("span");
    cells.className = "cells";
    for (const r of recent) cells.append(span("cell", pick(r)));
    line.append(span("lbl", label), cells);
    el.waves.append(line);
  }
}

function bar(value, decisive) {
  const cell = span("info", "");
  if (value === undefined) {
    cell.append(span("empty", "···"));
    return cell;
  }
  const n = Math.max(0, Math.min(3, Math.round(value)));
  cell.append(span(decisive ? "filled bright" : "filled", "█".repeat(n)), span("empty", "░".repeat(3 - n)));
  return cell;
}

function renderRows(rows) {
  const session = sessionOf(state.current);
  const prefix = session && session.cwd ? `${session.cwd}/` : null;
  const goalText = [...rows].reverse().find((r) => r.kind === "goal")?.text;
  const lastStep = [...rows].reverse().find((r) => r.kind === "step");
  const atBottom = !state.hover;
  el.rows.replaceChildren();

  for (const row of rows.slice(-ROWS_SHOWN)) {
    if (row.kind !== "step") {
      // The first prompt is already the goal; saying it twice adds nothing.
      if (row.kind === "prompt" && row.text && goalText && goalText.startsWith(row.text.slice(0, 100))) continue;
      const label = { goal: "GOAL", prompt: "USER", compact: "COMPACT", stop: "TURN END", end: "SESSION END" }[row.kind] || row.kind;
      const sep = document.createElement("div");
      sep.className = `sep ${row.kind}`;
      sep.textContent = `${clock(row.sent_at)}  ── ${label}${row.text ? `: ${row.text.replace(/\s+/g, " ").slice(0, 140)}` : ""} ──`;
      el.rows.append(sep);
      continue;
    }
    const div = document.createElement("div");
    div.className = "row";
    const decisive = row.info !== undefined && row.info >= DECISIVE;
    if (decisive) div.classList.add("decisive");
    if (row === lastStep) div.classList.add("current");
    const failed = row.tools.some((t) => t.failed);
    const first = row.tools[0];
    let what = `${first.tool} ${first.input.replace(/\s+/g, " ")}`;
    if (prefix) what = what.split(prefix).join("");
    if (row.tools.length > 1) what += `  +${row.tools.length - 1}`;

    div.append(span("t", clock(row.sent_at)));
    if (row.jev_error) div.append(span("info err", "info err"));
    else div.append(bar(row.info, decisive));
    div.append(span("prog", ["▁▁", "▃▃", "██"][row.progress ?? 1]));
    const flag = row.recovery !== undefined && row.recovery >= 0.5 ? "RECOVERY" : failed ? "failed" : "";
    div.append(span(flag === "RECOVERY" ? "rec" : "fail", flag));
    div.append(span("what", what));
    el.rows.append(div);
  }
  if (atBottom) el.rows.scrollTop = el.rows.scrollHeight;
}

connect();
setInterval(() => render(), 5000);
window.addEventListener("resize", () => state.current && renderWaves(sortedRows(state.current)));
