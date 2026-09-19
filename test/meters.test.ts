// node --test. The pure parts of the Worker: what a step is cut down to, what
// counts as a failure, what Jev is shown.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LIMITS,
  buildState,
  failed,
  inputSummary,
  oneLine,
  planSentence,
  progress,
  shorten,
  toActions,
  unwrapAnswers,
} from "../src/meters.ts";

test("shorten keeps the head and the tail and says how much went", () => {
  const text = "a".repeat(500) + "\n" + "z".repeat(500);
  const cut = shorten(text, 300);
  assert.ok(cut.startsWith("a".repeat(200)));
  assert.ok(cut.endsWith("z".repeat(100)));
  assert.match(cut, /\.\.\.\[701 chars cut\]\.\.\./);
  assert.equal(shorten("short", 300), "short");
});

test("failed reads the head of the result, the way the tool itself reports it", () => {
  assert.equal(failed("<tool_use_error>String to replace not found in file.</tool_use_error>"), true);
  assert.equal(failed("Exit code 1\nerror: 1 of 42 tests failed"), true);
  assert.equal(failed("Exit code 0\nall good"), false);
  assert.equal(failed("Permission to use Bash with command rm -rf x has been denied."), true);
  assert.equal(failed("The user doesn't want to proceed with this tool use."), true);
  // A verdict named FAIL inside output is not a failure of the step.
  assert.equal(failed("ok   the README's block reached FAIL with nothing else set\nALL CHECKS PASSED"), false);
});

test("progress is decided by the kind of step: failed 0, edit 2, otherwise 1", () => {
  const ok = (tool: string) => ({ tool, input: "", result: "fine", failed: false });
  assert.equal(progress([ok("Bash")]), 1);
  assert.equal(progress([ok("Edit")]), 2);
  assert.equal(progress([ok("Bash"), ok("Write")]), 2);
  assert.equal(progress([{ ...ok("Edit"), failed: true }]), 0);
  assert.equal(progress([ok("AskUserQuestion")]), 1);
});

test("inputSummary shows what an edit changed, not only where", () => {
  const summary = inputSummary("Edit", { file_path: "src/a.zig", old_string: "old text", new_string: "new text" });
  assert.equal(summary, "src/a.zig: replace <<old text>> with <<new text>>");
  assert.equal(inputSummary("Bash", { command: "zig build test" }), "zig build test");
  assert.equal(inputSummary("Bash", { command: "x".repeat(1000) }).length, LIMITS.input);
  assert.equal(inputSummary("Write", { file_path: "notes.md", content: "hello" }), "notes.md: write <<hello>>");
});

test("toActions shares the result budget across the tools of one step", () => {
  const long = "r".repeat(5000);
  const one = toActions([{ tool_name: "Bash", tool_input: { command: "ls" }, tool_response: long }]);
  assert.ok(one[0].result.length <= LIMITS.result + 40);
  const five = toActions(Array.from({ length: 5 }, () => ({ tool_name: "Bash", tool_input: { command: "ls" }, tool_response: long })));
  assert.ok(five[0].result.length <= LIMITS.resultBudget / 5 + 40);
  assert.equal(five.length, 5);
  // Content blocks are flattened the way the model saw them.
  const blocks = toActions([{ tool_name: "Read", tool_input: { file_path: "a" }, tool_response: [{ type: "text", text: "line 1" }, { type: "image" }] }]);
  assert.equal(blocks[0].result, "line 1\n[image]");
});

test("oneLine carries the last line of the result, not a line picked for failure words", () => {
  const line = oneLine(7, [
    { tool: "Bash", input: "zig build test 2>&1 | tail", result: "=== FAIL section header ===\nAll 42 tests passed", failed: false },
  ]);
  assert.equal(line, "#7 Bash zig build test 2>&1 | tail -> ok | All 42 tests passed");
});

test("planSentence takes the goal from a plan file that was actually written", () => {
  const wrote = { tool: "Write", input: "/w/.claude/plans/2026-09-19-every-refusal-names-what-to-do-next.md: write <<# plan>>", result: "ok", failed: false };
  assert.equal(planSentence([wrote]), "every refusal names what to do next");
  assert.equal(planSentence([{ ...wrote, failed: true }]), null);
  assert.equal(planSentence([{ ...wrote, input: "/w/.claude/plans/2026-09-02-batch-b_a09-ledger.md: write <<x>>" }]), null);
  assert.equal(planSentence([{ tool: "Bash", input: "cat > ~/w/.claude/plans/2026-09-04-the-flags-do-not-ride.md <<'E'", result: "", failed: false }]), "the flags do not ride");
  assert.equal(planSentence([{ tool: "Read", input: "/w/.claude/plans/2026-09-04-x.md", result: "", failed: false }]), null);
});

test("buildState is the shape Jev was measured on", () => {
  const state = buildState("g".repeat(1000), ["#1 Bash ls -> ok | a"], [
    { tool: "Bash", input: "ls", result: "a\nb", failed: false },
  ]);
  assert.equal(state.goal.length, LIMITS.goal);
  assert.deepEqual(Object.keys(state), ["goal", "recent_steps", "current_step"]);
  assert.deepEqual(state.current_step[0], { tool: "Bash", input: "ls", outcome: "ok", result: "a\nb" });
});

test("unwrapAnswers finds answers however deep the gateway nested them", () => {
  const answers = { information_gain: { score: 2.9, confidence: 0.9 }, recovery: { noul: 0.1 } };
  assert.deepEqual(unwrapAnswers({ result: { state: "Completed", result: { answers } } }), answers);
  assert.deepEqual(unwrapAnswers({ answers }), answers);
  assert.equal(unwrapAnswers({ result: { errors: [] } }), null);
  assert.equal(unwrapAnswers(null), null);
});
