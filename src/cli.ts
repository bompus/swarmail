#!/usr/bin/env bun
// The swarmail command, and the entry for its single binary: scripts/build.ts builds ~/.local/bin/swarmail.
// It runs on Linux and Windows. Another entry can import main() and pass it
// commands of its own.
// Modules load on demand, so a waiting hook does not load the server's. No top-level await: `--bytecode` builds CommonJS.

/** One subcommand: its usage lines and what it runs with the arguments after its name. */
export interface Command {
  usage: string[];
  run: (args: string[]) => Promise<void>;
}

/**
 * Standard input as text. On Windows (Bun 1.4.2), Bun.stdin.text() outside a top-level await lets the process exit
 * before reading, and readFileSync(0) reads nothing from a PowerShell pipeline; reading the stream does neither.
 */
const stdin = () => new Response(Bun.stdin.stream()).text();

const mail = (name: string, usage: string): [string, Command] => [
  name,
  {
    usage: [usage],
    run: async (args) => {
      const { mail } = await import("./mail.ts");
      process.exit(await mail([name, ...args], stdin));
    },
  },
];

const serve: Command = {
  usage: ["swarmail [serve]                                 run the server (server.ts)"],
  run: async (args) => {
    const { main } = await import("./server.ts");
    main(args);
  },
};

const COMMANDS: Record<string, Command> = {
  serve,
  "wake-bridge": {
    usage: [
      "swarmail wake-bridge <config.json>              deliver mail notices to one explicit local target",
    ],
    run: async (args) => {
      const { wakeBridge } = await import("./wake-bridge.ts");
      process.exit(await wakeBridge(args));
    },
  },
  hook: {
    usage: [
      "swarmail hook wake <claude|cursor> [seconds]     the wake hook (wake-hook.ts)",
      "swarmail hook rearm                              the Claude PostToolUse re-arm where there is no shell",
      "swarmail hook context <cursor|devin|agy> [stop]  check mail at the next native context point",
    ],
    run: async (args) => {
      // The Windows Claude hooks end in `; exit $LASTEXITCODE` (configure-hooks.ts). cmd has no `;` separator and
      // passes that through as arguments, so the command ends at the first word ending in `;`.
      const end = args.findIndex((arg) => arg.endsWith(";"));
      const [kind, host, seconds] =
        end === -1 ? args : [...args.slice(0, end), args[end]!.slice(0, -1)];
      if (
        !["wake", "rearm", "context"].includes(kind ?? "") ||
        (kind === "context"
          ? seconds !== undefined && seconds !== "stop"
          : seconds && !(Number(seconds) > 0))
      ) {
        usage(64);
      }
      const { contextHook, rearmHook, wakeHook } = await import("./wake-hook.ts");
      const input = await stdin();
      process.exit(
        kind === "context"
          ? await contextHook(host, seconds === "stop", input)
          : kind === "rearm"
            ? await rearmHook(input)
            : await wakeHook(host, seconds ? Number(seconds) : undefined, input),
      );
    },
  },
  register: {
    usage: [
      "swarmail register [--host <host> | --tag <host> [session id]]  register a hook session or print its tag",
    ],
    run: async (args) => {
      const { registerHook } = await import("./register-hook.ts");
      await registerHook(args, stdin);
    },
  },
  guard: {
    usage: [
      "swarmail guard <pre-commit|pre-push>             refuse commits touching others' reservations (guard.ts)",
    ],
    run: async ([hook]) => {
      const { guard } = await import("./guard.ts");
      process.exit(guard(hook, hook === "pre-push" ? await stdin() : ""));
    },
  },
  who: {
    usage: [
      "swarmail who [repo] [--all] [--json]             which name is which session (who.ts)",
    ],
    run: async (args) => {
      const { main } = await import("./who.ts");
      try {
        main(args);
      } catch (err) {
        console.error(`swarmail who: ${(err as Error).message}`);
        process.exit(1);
      }
    },
  },
  updates: {
    usage: [
      "swarmail updates --session [--json] [--reset-context] [--ack COMPONENT --revision REVISION]  approved targets and loaded attestations",
    ],
    run: async (args) => {
      const { updatesCommand } = await import("./updates.ts");
      try {
        await updatesCommand(args);
      } catch (error) {
        console.error(`swarmail updates: ${(error as Error).message}`);
        process.exit(1);
      }
    },
  },
  ...Object.fromEntries([
    mail(
      "inbox",
      "swarmail inbox [--all] [--peek] [--json] [--as NAME]  this session's mail in the current repository (mail.ts)\n  swarmail inbox --session [--limit N] [--json]     drain all session inboxes; --peek/--all preview one page",
    ),
    mail(
      "send",
      "swarmail send <to[,to]> <subject> [body] [--delivery-policy checked|durable] [--notification-policy wake|quiet] [--json]  send with availability feedback; body from stdin when omitted (mail.ts)",
    ),
    mail(
      "ping",
      "swarmail ping <agent> [--timeout S]              whether the agent's wake hook is waiting (mail.ts)",
    ),
    mail(
      "withdraw",
      "swarmail withdraw <id> --idempotency-key KEY [--recipients A,B] [--json]  withdraw unclaimed deliveries",
    ),
    mail(
      "importance",
      "swarmail importance <id> <level> --expected-revision N --idempotency-key KEY [--json]  edit message priority",
    ),
    mail(
      "search",
      "swarmail search <words> [--limit N] [--cursor CURSOR] [--json | --json-page]     past mail in the current repository, best match first (mail.ts)",
    ),
    mail(
      "thread",
      "swarmail thread <id> [--limit N] [--json]        a thread's messages, oldest first (mail.ts)",
    ),
  ]),
  version: {
    usage: [
      "swarmail version                                 the source hash the binary was built from, or `source`",
    ],
    run: async () => {
      const { buildSource } = await import("./build.ts");
      console.log(buildSource ?? "source");
    },
  },
};

/** The commands main() runs: COMMANDS plus the extra ones it was given. */
let commands = COMMANDS;

/** The command named `name`; an own-property check, so `constructor` and the like are unknown commands. */
const find = (name: string | undefined): Command | undefined =>
  name !== undefined && Object.hasOwn(commands, name) ? commands[name] : undefined;

const USAGE = () =>
  `Usage:\n  ${Object.values(commands)
    .flatMap((c) => c.usage)
    .join("\n  ")}`;

function usage(code: number): never {
  console.error(USAGE());
  process.exit(code);
}

/** `--help` anywhere prints usage and runs nothing, so no command acts on it by accident. */
function help(args: string[]): boolean {
  if (args[0] !== "help" && !args.some((a) => a === "--help" || a === "-h")) {
    return false;
  }
  const command = find(args[0] === "help" ? args[1] : args[0]);
  console.log(command ? command.usage.join("\n") : USAGE());
  return true;
}

/** Runs the command `args` names, from COMMANDS or `extra`; an extra command cannot replace a built-in one. */
export async function main(
  args = process.argv.slice(2),
  extra: Record<string, Command> = {},
): Promise<void> {
  // Keys keep COMMANDS' order, then the extras'; spreading COMMANDS last keeps its values.
  commands = { ...COMMANDS, ...extra, ...COMMANDS };
  if (help(args)) {
    return;
  }
  if (args[0] === undefined) {
    return serve.run([]);
  }
  const command = find(args[0]);
  if (!command) {
    usage(64);
  }
  await command.run(args.slice(1));
}

if (import.meta.main) {
  void main();
}
