#!/usr/bin/env bun
// The swarmail command, and the entry for its single binary: scripts/build.ts builds ~/.local/bin/swarmail.
// It runs on Linux only, since sessions are identified through /proc.
// Modules load on demand, so a waiting hook does not load the server's. No top-level await: `--bytecode` builds CommonJS.
import { EXTRA_COMMANDS } from "./cli-extra.ts";

/** One subcommand: its usage lines and what it runs with the arguments after its name. */
export interface Command {
  usage: string[];
  run: (args: string[]) => Promise<void>;
}

const mail = (name: string, usage: string): [string, Command] => [
  name,
  {
    usage: [usage],
    run: async (args) => {
      const { mail } = await import("./mail.ts");
      process.exit(await mail([name, ...args], () => Bun.stdin.text()));
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
  hook: {
    usage: ["swarmail hook wake <claude|cursor> [seconds]     the wake hook (wake-hook.ts)"],
    run: async ([kind, host, seconds]) => {
      if (kind !== "wake") {
        usage(64);
      }
      const { wakeHook } = await import("./wake-hook.ts");
      process.exit(
        await wakeHook(host, seconds ? Number(seconds) : undefined, await Bun.stdin.text()),
      );
    },
  },
  register: {
    usage: [
      "swarmail register [--tag <host> [session id]]    the register hook, or the tag for a manual registration (register-hook.ts)",
    ],
    run: async (args) => {
      const { registerHook } = await import("./register-hook.ts");
      registerHook(args);
    },
  },
  guard: {
    usage: [
      "swarmail guard <pre-commit|pre-push>             refuse commits touching others' reservations (guard.ts)",
    ],
    run: async ([hook]) => {
      const { guard } = await import("./guard.ts");
      process.exit(guard(hook, hook === "pre-push" ? await Bun.stdin.text() : ""));
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
  ...Object.fromEntries([
    mail(
      "inbox",
      "swarmail inbox [--all] [--peek] [--json] [--as NAME]  this session's mail in the current repository (mail.ts)",
    ),
    mail(
      "send",
      "swarmail send <to[,to]> <subject> [body]         send as this session; body from stdin when omitted (mail.ts)",
    ),
    mail(
      "ping",
      "swarmail ping <agent> [--timeout S]              whether the agent's wake hook is waiting (mail.ts)",
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
  ...EXTRA_COMMANDS,
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

/** The command named `name`; an own-property check, so `constructor` and the like are unknown commands. */
const find = (name: string | undefined): Command | undefined =>
  name !== undefined && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;

const USAGE = () =>
  `Usage:\n  ${Object.values(COMMANDS)
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

async function run(args: string[]): Promise<void> {
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

void run(process.argv.slice(2));
