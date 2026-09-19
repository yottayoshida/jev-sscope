// What Jev is asked about a step, and the small amount of arithmetic done around it.
//
// The limits and the wording were measured once against hand labels before this
// app existed (information_gain agreed with the labels 82 % of the time, recovery
// found 5 of 5). Change a number or a sentence here and that measurement no
// longer applies.

export const LIMITS = {
  input: 300, // chars of one tool's arguments
  result: 600, // chars of one tool's result
  resultBudget: 2400, // chars of results per step, shared by its tools
  goal: 400,
  recent: 5, // previous steps shown to Jev, one line each
  compact: 500,
  rowsPerSession: 2000,
};

export const QUESTIONS = {
  information_gain: {
    type: "score",
    instructions:
      "How much new, useful information about the task does the `result` text in `current_step` give?",
    criteria: [
      "None: the result is empty, a bare confirmation such as 'file updated', or an error with no detail",
      "Routine: the result shows text the agent had already located and only needs in front of it to make the next edit, or repeats what `recent_steps` showed",
      "New facts: the result shows something about the code, the repository or the task that `recent_steps` did not show and that matters for `goal`",
      "Decisive: the result settles an open question: a test or check passes or fails, the cause of a problem is found, or a person answers a question",
    ],
  },
  recovery: {
    type: "noul",
    instructions:
      "Does `current_step` respond to a failure shown in `recent_steps` with an action aimed at fixing or working around that failure?",
    criteria: {
      true: "`recent_steps` contains a failed step and `current_step` investigates, fixes or works around that failure",
      false: "There is no failure in `recent_steps`, or `current_step` does not address it",
    },
  },
} as const;

export interface ToolCall {
  tool_name: string;
  tool_input?: unknown;
  tool_response?: unknown;
}

export interface Action {
  tool: string;
  input: string; // summary of the arguments, already cut
  result: string; // model-visible text, already cut
  failed: boolean;
}

export interface Answers {
  information_gain?: { score: number; confidence: number };
  recovery?: { noul: number };
}

/** Head and tail. Test output and errors put what matters at the end. */
export function shorten(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor((limit * 2) / 3);
  const tail = limit - head;
  return `${text.slice(0, head)}\n...[${text.length - limit} chars cut]...\n${text.slice(-tail)}`;
}

/** The text the model saw: a string, or content blocks. */
export function flattenResponse(response: unknown): string {
  if (typeof response === "string") return response;
  if (Array.isArray(response)) {
    return response
      .map((block) => {
        if (block && typeof block === "object" && "text" in block) return String((block as { text: unknown }).text);
        if (block && typeof block === "object" && (block as { type?: string }).type === "image") return "[image]";
        return "";
      })
      .join("\n");
  }
  if (response && typeof response === "object") return JSON.stringify(response);
  return "";
}

/** One line that says what the call was. The file name alone says nothing about an edit; what changed does. */
export function inputSummary(tool: string, input: unknown): string {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (key: string, max: number) => String(obj[key] ?? "").slice(0, max);
  if (tool === "Edit") {
    return `${str("file_path", 200)}: replace <<${str("old_string", 90)}>> with <<${str("new_string", 160)}>>`;
  }
  if (tool === "Write") return `${str("file_path", 200)}: write <<${str("content", 200)}>>`;
  for (const key of ["command", "file_path", "pattern", "prompt", "query", "url", "skill", "description"]) {
    if (key in obj) return str(key, LIMITS.input);
  }
  return JSON.stringify(obj).slice(0, LIMITS.input);
}

/**
 * Whether a result reads as a failure. PostToolBatch carries no flag, so this is
 * read from the text; the transcript's own flag comes from the same texts.
 */
export function failed(result: string): boolean {
  const head = result.trimStart().slice(0, 200);
  return (
    head.startsWith("<tool_use_error>") ||
    /^Exit code [1-9]/.test(head) ||
    /has been denied|doesn't want to proceed/.test(head)
  );
}

/** progress from the kind of step alone. Measured at 61/77 against hand labels; Jev did not beat it. */
export function progress(actions: Action[]): 0 | 1 | 2 {
  if (actions.some((a) => a.failed)) return 0;
  if (actions.some((a) => a.tool === "Edit" || a.tool === "Write")) return 2;
  return 1;
}

export function toActions(calls: ToolCall[]): Action[] {
  const perTool = Math.max(200, Math.min(LIMITS.result, Math.floor(LIMITS.resultBudget / Math.max(1, calls.length))));
  return calls.map((call) => {
    const result = flattenResponse(call.tool_response);
    return {
      tool: String(call.tool_name ?? "?"),
      input: inputSummary(String(call.tool_name ?? ""), call.tool_input),
      result: shorten(result, perTool),
      failed: failed(result),
    };
  });
}

/** The line a step leaves behind for the next few steps' `recent_steps`. Last line of the result only. */
export function oneLine(seq: number, actions: Action[]): string {
  const parts = actions.map((a) => {
    const lines = a.result.split("\n").filter((l) => l.trim());
    const last = lines.length ? ` | ${lines[lines.length - 1].trim().slice(0, 100)}` : "";
    return `${a.tool} ${a.input.slice(0, 80)} -> ${a.failed ? "failed" : "ok"}${last}`;
  });
  return `#${seq} ${parts.join("; ")}`;
}

const PLAN_FILE = /\/\.claude\/plans\/\d{4}-\d{2}-\d{2}-([a-z0-9][a-z0-9_-]*)\.md/;

/** The goal a step wrote down, if it created or edited a plan file. */
export function planSentence(actions: Action[]): string | null {
  for (const a of actions) {
    if (a.failed) continue;
    if (a.tool !== "Edit" && a.tool !== "Write" && a.tool !== "Bash") continue;
    const found = PLAN_FILE.exec(a.input);
    if (found && !found[1].startsWith("batch-")) return found[1].replace(/-/g, " ");
  }
  return null;
}

export function buildState(goal: string, recent: string[], actions: Action[]) {
  return {
    goal: goal.slice(0, LIMITS.goal),
    recent_steps: recent,
    current_step: actions.map((a) => ({
      tool: a.tool,
      input: a.input,
      outcome: a.failed ? "failed" : "ok",
      result: a.result,
    })),
  };
}

/** The object holding `answers`, wherever the gateway nested it. */
export function unwrapAnswers(payload: unknown): Answers | null {
  let node: unknown = payload;
  for (let depth = 0; depth < 4 && node && typeof node === "object"; depth++) {
    const obj = node as Record<string, unknown>;
    if (obj.answers && typeof obj.answers === "object") return obj.answers as Answers;
    node = obj.result;
  }
  return null;
}
