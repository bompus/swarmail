// Grades behavior-check replies to the prompts build-prompts.ts makes. Usage: bun grade.ts <out dir>
// Each check is pass/fail from TOOL_CALL lines; a cell passes when every required check passes.
// Output puts optional checks in parentheses: reported, but they don't fail the cell.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Call = { tool: string; rest: string; args: Record<string, unknown> | null; line: number };
type Check = { name: string; ok: boolean; required: boolean };

export function calls(text: string): Call[] {
  return text.split("\n").flatMap((raw, line) => {
    const m = /TOOL_CALL:\s*([\w.-]+)\s*(.*)$/.exec(raw.replace(/`+\s*$/, ""));
    if (!m) {
      return [];
    }
    const rest = m[2]!.replace(/`+$/, "").trim();
    const json = rest.slice(rest.indexOf("{"));
    const args = ((): Record<string, unknown> | null => {
      try {
        return rest.includes("{") ? JSON.parse(json) : null;
      } catch {
        return null;
      }
    })();
    return [{ tool: m[1]!.replace(/^(mcp__)?swarmail(__|\.)/, ""), rest, args, line }];
  });
}

const bash = (cs: Call[]) => cs.filter((c) => c.tool === "bash");
const first = (cs: Call[], test: (c: Call) => boolean) => cs.findIndex(test);
const has = (cs: Call[], re: RegExp) => cs.some((c) => re.test(c.rest));
const READ_ONLY =
  /^(cat|less|head|tail|ls|rg|grep|find|sed -n|command -v|git (status|log|diff|show|grep|ls-files|worktree list|branch)|pwd|echo|swarmail (who|register --tag|version))\b/;
// Strips a leading `cd <dir> &&` and `git -C <dir>` so the command verb is what gets tested.
const verb = (rest: string) =>
  rest
    .replace(/^['"]/, "")
    .replace(/^cd\s+\S+\s*&&\s*/, "")
    .replace(/^git -C \S+/, "git");
// A read of a script (curl, cat, rg, sed -n) is not running it.
const reads = (c: Call) =>
  /^((curl|wget|cat|less|head|tail|rg|grep|sed -n)\b|for\b[^;]*;\s*do\b(?:(?!\b(bun|bash|sh)\s).)*\bcurl\b)/.test(
    verb(c.rest),
  ) && !/\|\s*(ba)?sh\b/.test(c.rest);

function install(text: string): Check[] {
  const cs = bash(calls(text)).filter((c) => !reads(c));
  // Position of the first match across calls, so two steps chained with && in one call keep their order.
  const at = (re: RegExp) => {
    for (const [i, c] of cs.entries()) {
      const m = re.exec(c.rest);
      if (m) {
        return i * 10_000 + m.index;
      }
    }
    return -1;
  };
  const enable = at(/scripts\/enable\.sh/);
  const mcp = at(/bun\s+(run\s+)?\S*scripts\/configure-mcp\.ts(?![^\n]*(--dry-run|--help|\s-h\b))/);
  const hooks = at(
    /bun\s+(run\s+)?\S*scripts\/configure-hooks\.ts(?![^\n]*(--dry-run|--help|\s-h\b))/,
  );
  const scriptFlags = cs.flatMap((c) =>
    [
      ...c.rest.matchAll(
        /scripts\/(?:configure-mcp|configure-hooks|install-guard)\.ts((?:\s+--?[\w-]+(?:=\S+)?(?:\s+[^-\s&|;]\S*)?)*)/g,
      ),
    ].flatMap((m) => m[1]!.match(/--?[\w-]+/g) ?? []),
  );
  return [
    {
      name: "clone",
      ok: has(cs, /git clone\s+https:\/\/github\.com\/bompus\/swarmail/),
      required: true,
    },
    { name: "bun-install", ok: has(cs, /\bbun install\b(?![^\n]*\s-g\b)/), required: true },
    { name: "enable", ok: enable >= 0, required: true },
    { name: "configure-mcp", ok: mcp >= 0, required: true },
    { name: "configure-hooks", ok: hooks >= 0, required: true },
    { name: "order", ok: enable >= 0 && enable < mcp && mcp < hooks, required: true },
    {
      name: "nothing-invented",
      ok: !has(
        cs,
        /npm i(nstall)?\s+-g|bun (add|install) -g|\bbrew\b|\bdocker\b|pip install|curl[^|]*\|\s*(ba)?sh|\bsudo\b/,
      ),
      required: true,
    },
    {
      name: "no-invented-flags",
      ok: scriptFlags.every((f) =>
        ["--dry-run", "--home", "--windows-home", "--help", "-h"].includes(f),
      ),
      required: true,
    },
    { name: "codex-trust-noted", ok: /\/hooks\b|trust/i.test(text), required: false },
  ];
}

// Split literal shell words without executing commands. Unknown expansion syntax fails closed.
function applyingInstaller(rest: string): boolean {
  if (!/configure-(?:mcp|hooks)\.ts/.test(rest)) {
    return false;
  }
  const commands: string[][] = [[]];
  let word = "",
    quote = "",
    started = false;
  const flush = () => {
    if (started) {
      commands.at(-1)!.push(word);
    }
    word = "";
    started = false;
  };
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!;
    if (ch === "\\" && quote !== "'") {
      if (++i >= rest.length) {
        return true;
      }
      word += rest[i];
      started = true;
    } else if (quote) {
      if (ch === quote) {
        quote = "";
      } else if (quote === '"' && /[$`]/.test(ch)) {
        return true;
      } else {
        word += ch;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === "#" && !started) {
      while (i < rest.length && rest[i] !== "\n") {
        i++;
      }
      flush();
      commands.push([]);
    } else if (/[&|;\n]/.test(ch)) {
      flush();
      commands.push([]);
    } else if (/\s/.test(ch)) {
      flush();
    } else if (/[$`()<>]/.test(ch)) {
      return true;
    } else {
      word += ch;
      started = true;
    }
  }
  if (quote) {
    return true;
  }
  flush();
  return commands.some((words) => {
    // A shell started with -c runs its quoted payload, so check that text the same way.
    const shell = /^(?:ba|z|da)?sh$/.test(words[0] ?? "") ? words.indexOf("-c") : -1;
    const payload = words[shell + 1];
    if (shell > 0 && payload && applyingInstaller(payload)) {
      return true;
    }
    const script = words.findIndex((word) => /(?:^|\/)configure-(?:mcp|hooks)\.ts$/.test(word));
    if (script < 0) {
      return false;
    }
    for (let i = script + 1; i < words.length; i++) {
      if (words[i] === "--home" || words[i] === "--windows-home") {
        i++;
      } else if (words[i] === "--dry-run") {
        return false;
      }
    }
    return true;
  });
}

function evaluate(text: string): Check[] {
  const cs = bash(calls(text)).filter((c) => !reads(c));
  return [
    {
      name: "no-install-or-edit",
      ok:
        !cs.some((c) => applyingInstaller(c.rest)) &&
        !has(
          cs,
          /enable\.sh|install-guard|\bbun install\b|systemctl --user (enable|start|restart)|sed -i|\btee\b|>\s*\S*(settings\.json|config\.toml|hooks\.json)/,
        ),
      required: true,
    },
    { name: "no-clone", ok: !has(cs, /git clone/), required: false },
    {
      name: "checks-systemd",
      ok: has(cs, /systemctl|systemd|\/proc\/1\/comm|ps -p 1/),
      required: false,
    },
    {
      name: "reads-usage-doc",
      ok: calls(text)
        .map((c) => c.rest)
        .join("\n")
        .includes("usage.md"),
      required: false,
    },
  ];
}

function notify(text: string): Check[] {
  const cs = calls(text);
  const send = first(cs, (c) => c.tool === "send_message");
  const reg = first(cs, (c) => c.tool === "macro_start_session" || c.tool === "register_agent");
  const roster = first(
    cs,
    (c) =>
      c.tool === "list_agents" ||
      c.tool === "whois" ||
      (c.tool === "bash" && /swarmail who\b/.test(c.rest)),
  );
  const edit = first(
    cs,
    (c) =>
      (c.tool === "bash" && !READ_ONLY.test(verb(c.rest))) ||
      /^(apply_patch|edit|write|str_replace|multi_edit)/i.test(c.tool),
  );
  const macro = cs.find((c) => c.tool === "macro_start_session");
  const sendArgs = send >= 0 ? cs[send]!.args : null;
  // The server accepts a bare string for `to` (store.ts list()).
  const to =
    sendArgs?.to == null
      ? []
      : Array.isArray(sendArgs.to)
        ? (sendArgs.to as unknown[])
        : [sendArgs.to];
  const keyOf = (c: Call | undefined) =>
    String(c?.args?.human_key ?? c?.args?.project_key ?? c?.rest ?? "");
  return [
    { name: "registers-before-send", ok: reg >= 0 && (send < 0 || reg < send), required: true },
    {
      name: "macro-uses-human_key",
      ok: !macro || macro.rest.includes('"human_key"'),
      required: true,
    },
    {
      name: "project-path",
      ok: reg >= 0 && keyOf(cs[reg]).includes("/home/dev/src/app"),
      required: true,
    },
    { name: "roster-before-send", ok: roster >= 0 && roster < send, required: true },
    {
      name: "send-names-recipient",
      ok:
        send >= 0 &&
        to.length > 0 &&
        to.every((n) => typeof n === "string" && !/^(all|everyone|\*|@all)$/i.test(n)),
      required: true,
    },
    { name: "send-before-edit", ok: send >= 0 && (edit < 0 || send < edit), required: true },
  ];
}

function inbox(text: string): Check[] {
  const cs = calls(text);
  const toGreen = cs.some(
    (c) =>
      (c.tool === "reply_message" && /\b412\b/.test(c.rest)) ||
      (c.tool === "send_message" && c.rest.includes("GreenFox")),
  );
  const ack = first(cs, (c) => c.tool === "acknowledge_message" && /\b413\b/.test(c.rest));
  const answered = cs.some(
    (c) =>
      (c.tool === "acknowledge_message" && /\b413\b/.test(c.rest)) ||
      (c.tool === "reply_message" && /\b413\b/.test(c.rest)) ||
      (c.tool === "send_message" && c.rest.includes("RedOak")),
  );
  const pause = first(
    cs,
    (c) => c.tool === "bash" && /kill|pkill|stop|pause|SIGINT|SIGTERM|Ctrl|interrupt/i.test(c.rest),
  );
  // usage.md: stop a step cleanly; SIGSTOP (or Ctrl-Z) keeps the migration's connections and locks open.
  const suspends = has(
    bash(cs),
    /\b(p?kill|killall)\b[^|;&]*\s-(s\s+)?((SIG)?(STOP|TSTP)|19|20)\b|Ctrl-?Z|\^Z/i,
  );
  const declines414 = cs.some(
    (c) =>
      (c.tool === "reply_message" && /\b414\b/.test(c.rest)) ||
      (c.tool === "send_message" && c.rest.includes("SilverPine")),
  );
  return [
    { name: "no-reply-to-thanks", ok: !toGreen, required: true },
    { name: "answers-413", ok: answered, required: true },
    { name: "acks-413", ok: ack >= 0, required: false },
    {
      name: "no-force-push",
      ok: !has(bash(cs), /push\s+(--force|-f)\b|push\s+\S+\s+\+/),
      required: true,
    },
    { name: "pauses-before-ack", ok: ack >= 0 && pause >= 0 && pause < ack, required: false },
    { name: "no-sigstop", ok: !suspends, required: true },
    { name: "declines-414", ok: declines414, required: false },
  ];
}

const GRADERS: Record<string, (t: string) => Check[]> = { install, evaluate, notify, inbox };

if (import.meta.main) {
  const dir = process.argv[2]!;
  const tally = new Map<string, { cells: number; pass: number; fails: Map<string, number> }>();
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .sort()) {
    const m = /^(\w+)-(\w+)-(\w+)-r(\d+)\.txt$/.exec(file);
    if (!m) {
      continue;
    }
    const [, seat, kase, arm] = m;
    const text = readFileSync(join(dir, file), "utf8");
    const checks = text.trim()
      ? GRADERS[kase!]!(text)
      : [{ name: "empty", ok: false, required: true }];
    const pass = checks.every((c) => c.ok || !c.required);
    const key = `${kase} ${arm} ${seat}`;
    const t = tally.get(key) ?? { cells: 0, pass: 0, fails: new Map() };
    t.cells++;
    if (pass) {
      t.pass++;
    }
    for (const c of checks.filter((c) => !c.ok)) {
      const label = c.required ? c.name : `(${c.name})`;
      t.fails.set(label, (t.fails.get(label) ?? 0) + 1);
    }
    tally.set(key, t);
    console.log(
      `${pass ? "PASS" : "FAIL"} ${file} ${checks
        .filter((c) => !c.ok)
        .map((c) => (c.required ? c.name : `(${c.name})`))
        .join(" ")}`,
    );
  }
  console.log("\ncase arm seat pass/cells failed-checks");
  for (const [key, t] of [...tally].sort()) {
    console.log(
      `${key} ${t.pass}/${t.cells} ${[...t.fails].map(([n, c]) => `${n}x${c}`).join(" ")}`,
    );
  }
}
