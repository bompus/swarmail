// `swarmail pr-sessions`: read-only lookup of the T3 V2 pull request associations on this machine. Never reads
// conversation content. docs/pr-sessions.md describes the output.
import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { primaryCheckout } from "./checkout.ts";
import { databasePath, t3Home } from "./paths.ts";
import { isT3V2, t3StatePath } from "./t3-state.ts";
import { identity } from "./tag.ts";

// ACP registry/custom drivers do not identify a native program; only exact manual tags can match them.
const registrationHosts = new Map([
  ["claudeAgent", "claude"],
  ["antigravity", "agy"],
]);

type ObjectValue = Record<string, unknown>;
type Pr = { host: string; repository: string; number: number; url: string };
type Snapshot = {
  state: string;
  title: string;
  headBranch: string;
  baseBranch: string;
  isDraft: boolean;
  updatedAt: string | null;
  syncedAt: string;
};
type Stack = {
  kind: "native";
  id: string;
  number: number;
  url: string;
  base: string;
  layers: { number: number; headBranch: string; state: string }[];
};
type Link = Pr & {
  source: string;
  linkedAt: string;
  snapshot: Snapshot | null;
  stack: Stack | null;
};
type ThreadRow = {
  thread_id: string;
  project_id: string;
  active_provider_thread_id: string | null;
  payload_json: string;
};
type ProviderRow = {
  provider_thread_id: string;
  thread_id: string | null;
  owner_node_id: string | null;
  provider_session_id: string | null;
  payload_json: string;
};
type AgentRow = {
  name: string;
  program: string;
  model: string;
  task_description: string;
  retired_at: number | null;
  last_active_ts: number;
};

function requireValue(condition: unknown, context: string): asserts condition {
  if (!condition) {
    throw new Error(`Unsupported or malformed metadata: ${context}`);
  }
}
/** A problem with the command line or the machine, not with stored metadata. */
function requireArgument(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
function object(value: unknown, context: string): ObjectValue {
  requireValue(value && typeof value === "object" && !Array.isArray(value), context);
  return value as ObjectValue;
}
function string(value: unknown, context: string): string {
  requireValue(typeof value === "string", context);
  return value;
}
function nullableString(value: unknown, context: string): string | null {
  return value === null ? null : string(value, context);
}
function positive(value: unknown, context: string): number {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value > 0, context);
  return value;
}
function choice(value: unknown, allowed: readonly string[], context: string): string {
  requireValue(typeof value === "string" && allowed.includes(value), context);
  return value;
}
function array(value: unknown, context: string): unknown[] {
  requireValue(Array.isArray(value), context);
  return value;
}
function json(value: string, context: string): ObjectValue {
  return object(JSON.parse(value), context);
}
function prUrl(value: unknown): Pr {
  const text = string(value, "PR URL");
  const url = new URL(text);
  const match = /^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
  requireValue(
    url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      match,
    "expected an exact https://github.com/owner/repository/pull/number URL",
  );
  const repository = match[1]!;
  requireValue(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository), "GitHub repository");
  return {
    host: "github.com",
    repository: repository.toLowerCase(),
    number: positive(Number(match[2]), "PR number"),
    url: text,
  };
}
const key = (pr: Pr): string => `${pr.host}/${pr.repository}/${pr.number}`;

function pr(value: unknown, projectId: string, legacy = false): Pr {
  const v = object(value, "PR association");
  // Other hosts may be stored, but this command cannot validate their identities.
  const host = legacy ? "github.com" : string(v.host, "PR host").toLowerCase();
  requireValue(host === "github.com", "only local GitHub associations are supported");
  const parsed = prUrl(v.url);
  requireValue(
    string(v.repository, "PR repository").toLowerCase() === parsed.repository &&
      positive(v.number, "PR number") === parsed.number,
    "PR identity disagrees with URL",
  );
  if (legacy) {
    requireValue(v.projectId === projectId, "legacy PR project differs from thread project");
  }
  return parsed;
}
function snapshot(value: unknown): Snapshot | null {
  if (value === null) {
    return null;
  }
  const v = object(value, "PR snapshot");
  requireValue(typeof v.isDraft === "boolean", "snapshot.isDraft");
  return {
    state: choice(v.state, ["open", "closed", "merged"], "snapshot.state"),
    title: string(v.title, "snapshot.title"),
    headBranch: string(v.headBranch, "snapshot.headBranch"),
    baseBranch: string(v.baseBranch, "snapshot.baseBranch"),
    isDraft: v.isDraft,
    updatedAt: nullableString(v.updatedAt, "snapshot.updatedAt"),
    syncedAt: string(v.syncedAt, "snapshot.syncedAt"),
  };
}
function stack(value: unknown): Stack | null {
  if (value === null) {
    return null;
  }
  const v = object(value, "native stack");
  requireValue(v.kind === "native", "stack.kind");
  return {
    kind: "native",
    id: string(v.id, "stack.id"),
    number: positive(v.number, "stack.number"),
    url: string(v.url, "stack.url"),
    base: string(v.base, "stack.base"),
    layers: array(v.layers, "stack.layers").map((layer) => {
      const l = object(layer, "stack layer");
      return {
        number: positive(l.number, "stack layer number"),
        headBranch: string(l.headBranch, "stack layer headBranch"),
        state: choice(l.state, ["open", "closed", "merged"], "stack layer state"),
      };
    }),
  };
}
function links(thread: ObjectValue, projectId: string): Link[] {
  // Only T3 databases before migration 064 store the single linkedPullRequest instead of pullRequests.
  if (!("pullRequests" in thread)) {
    if (thread.linkedPullRequest == null) {
      return [];
    }
    return [
      {
        ...pr(thread.linkedPullRequest, projectId, true),
        source: "manual",
        linkedAt: "1970-01-01T00:00:00.000Z",
        snapshot: null,
        stack: null,
      },
    ];
  }
  return array(thread.pullRequests, "thread.pullRequests").map((value) => {
    const v = object(value, "PR link");
    return {
      ...pr(v, projectId),
      source: choice(
        v.source,
        ["manual", "created", "agent", "stack", "stack-dismissed"],
        "link.source",
      ),
      linkedAt: string(v.linkedAt, "link.linkedAt"),
      snapshot: snapshot(v.snapshot),
      stack: stack(v.stack),
    };
  });
}

function chains(visible: Link[]) {
  const native = new Map<
    string,
    { host: string; repository: string; stack: Stack; links: number[]; snapshotAgreement: boolean }
  >();
  for (const link of visible) {
    if (!link.stack) {
      continue;
    }
    const id = `${link.host}/${link.repository}/${link.stack.id}`;
    const group = native.get(id);
    if (group) {
      group.links.push(link.number);
      group.snapshotAgreement &&= JSON.stringify(group.stack) === JSON.stringify(link.stack);
    } else {
      native.set(id, {
        host: link.host,
        repository: link.repository,
        stack: link.stack,
        links: [link.number],
        snapshotAgreement: true,
      });
    }
  }
  const remaining = visible.filter((l) => !l.stack && l.snapshot);
  const groups = [];
  const visited = new Set<Link>();
  for (const first of remaining) {
    if (visited.has(first)) {
      continue;
    }
    const members = [first];
    visited.add(first);
    for (let i = 0; i < members.length; i++) {
      const member = members[i]!;
      for (const candidate of remaining) {
        if (
          visited.has(candidate) ||
          member.host !== candidate.host ||
          member.repository !== candidate.repository
        ) {
          continue;
        }
        const a = member.snapshot!,
          b = candidate.snapshot!;
        if (
          a.headBranch === b.baseBranch ||
          b.headBranch === a.baseBranch ||
          a.headBranch === b.headBranch
        ) {
          visited.add(candidate);
          members.push(candidate);
        }
      }
    }
    if (members.length < 2) {
      continue;
    }
    const heads = new Map<string, Link>();
    let ambiguous = false;
    for (const member of members) {
      if (heads.has(member.snapshot!.headBranch)) {
        ambiguous = true;
      }
      heads.set(member.snapshot!.headBranch, member);
    }
    const roots = members.filter((m) => !heads.has(m.snapshot!.baseBranch));
    const ordered: Link[] = [];
    let cursor = roots.length === 1 ? roots[0] : undefined;
    while (cursor && !ordered.includes(cursor)) {
      ordered.push(cursor);
      const children = members.filter(
        (m) => m.snapshot!.baseBranch === cursor!.snapshot!.headBranch,
      );
      cursor = children.length === 1 ? children[0] : undefined;
    }
    const isOrdered = !ambiguous && ordered.length === members.length;
    groups.push({
      kind: "derived",
      host: first.host,
      repository: first.repository,
      ordered: isOrdered,
      reason: isOrdered ? null : "ambiguous, cyclic or branching base/head relationships",
      links: (isOrdered ? ordered : members).map((l) => l.number),
    });
  }
  return {
    native: [...native.values()].map((group) => ({
      ...group,
      id: group.stack.id,
      stack: group.snapshotAgreement ? group.stack : null,
    })),
    derived: groups,
  };
}
function lineage(value: unknown) {
  const v = object(value, "thread.lineage");
  return {
    parentThreadId: nullableString(v.parentThreadId, "lineage.parentThreadId"),
    relationshipToParent:
      v.relationshipToParent === null
        ? null
        : choice(v.relationshipToParent, ["fork", "subagent"], "lineage.relationshipToParent"),
    rootThreadId: string(v.rootThreadId, "lineage.rootThreadId"),
  };
}
function forkedFrom(value: unknown) {
  if (value === null) {
    return null;
  }
  const v = object(value, "thread.forkedFrom");
  const type = choice(v.type, ["run", "node", "provider_thread"], "forkedFrom.type");
  if (type === "run") {
    return {
      type,
      threadId: string(v.threadId, "fork threadId"),
      runId: string(v.runId, "fork runId"),
    };
  }
  if (type === "node") {
    return { type, nodeId: string(v.nodeId, "fork nodeId") };
  }
  return {
    type,
    providerThreadId: string(v.providerThreadId, "fork providerThreadId"),
    ...(v.providerTurnId === undefined
      ? {}
      : { providerTurnId: string(v.providerTurnId, "fork providerTurnId") }),
  };
}
function provider(row: ProviderRow) {
  const v = json(row.payload_json, `provider ${row.provider_thread_id}`);
  requireValue(
    v.id === row.provider_thread_id &&
      v.appThreadId === row.thread_id &&
      v.ownerNodeId === row.owner_node_id &&
      v.providerSessionId === row.provider_session_id,
    "provider payload differs from projection",
  );
  const driver = string(v.driver, "provider.driver");
  requireValue(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(driver), "provider.driver slug");
  let nativeId: string | null = null;
  if (v.nativeThreadRef !== null) {
    const ref = object(v.nativeThreadRef, "provider.nativeThreadRef");
    requireValue(ref.driver === driver, "native reference driver differs");
    choice(ref.strength, ["strong", "weak", "none"], "native reference strength");
    nativeId = nullableString(ref.nativeId, "provider native ID");
  }
  const ordinal = (n: unknown) => (n === null ? null : positive(n, "provider run ordinal"));
  return {
    providerThreadId: row.provider_thread_id,
    appThreadId: row.thread_id,
    ownerNodeId: row.owner_node_id,
    driver,
    providerInstanceId: string(v.providerInstanceId, "provider instance"),
    providerSessionId: row.provider_session_id,
    nativeId,
    status: choice(
      v.status,
      ["not_loaded", "idle", "active", "archived", "closed", "error"],
      "provider status",
    ),
    firstRunOrdinal: ordinal(v.firstRunOrdinal),
    lastRunOrdinal: ordinal(v.lastRunOrdinal),
    createdAt: string(v.createdAt, "provider createdAt"),
    updatedAt: string(v.updatedAt, "provider updatedAt"),
  };
}
function projectPath(path: string): string {
  return realpathSync(primaryCheckout(path) || resolve(path));
}
function roster(path: string) {
  const file = databasePath();
  if (!existsSync(file)) {
    return { status: "unavailable", agents: [] as AgentRow[], database: file };
  }
  const db = new Database(file, { readonly: true });
  try {
    const rows = db
      .query<
        AgentRow,
        [string]
      >(`SELECT a.name,a.program,a.model,a.task_description,a.retired_at,a.last_active_ts
      FROM agents a JOIN projects p ON p.id=a.project_id WHERE p.human_key=? ORDER BY a.name`)
      .all(path);
    return { status: "available", agents: rows, database: file };
  } finally {
    db.close();
  }
}

function threadMetadata(row: ThreadRow, t: ObjectValue) {
  return {
    threadId: row.thread_id,
    projectId: row.project_id,
    title: string(t.title, "thread.title"),
    branch: nullableString(t.branch, "thread.branch"),
    worktreePath: nullableString(t.worktreePath, "thread.worktreePath"),
    lineage: lineage(t.lineage),
    forkedFrom: forkedFrom(t.forkedFrom),
    historyOrigin:
      t.historyOrigin === undefined
        ? null
        : choice(t.historyOrigin, ["native", "v1_import"], "thread.historyOrigin"),
    archivedAt: nullableString(t.archivedAt, "thread.archivedAt"),
    deletedAt: nullableString(t.deletedAt, "thread.deletedAt"),
    settledAt: t.settledAt === undefined ? null : nullableString(t.settledAt, "thread.settledAt"),
    settledOverride:
      t.settledOverride == null
        ? null
        : choice(t.settledOverride, ["settled", "active"], "thread.settledOverride"),
    createdAt: string(t.createdAt, "thread.createdAt"),
    updatedAt: string(t.updatedAt, "thread.updatedAt"),
  };
}

function matchThread(
  db: Database,
  row: ThreadRow,
  target: Pr,
  includeHidden: boolean,
  room: ReturnType<typeof roster>,
) {
  const t = json(row.payload_json, `thread ${row.thread_id}`);
  requireValue(
    t.id === row.thread_id &&
      t.projectId === row.project_id &&
      t.activeProviderThreadId === row.active_provider_thread_id,
    "thread payload differs from projection",
  );
  const all = links(t, row.project_id);
  const visible = all.filter((l) => l.source !== "stack-dismissed");
  const hidden = all.filter((l) => l.source === "stack-dismissed");
  const discovery =
    t.branchPullRequest == null ? null : pr(t.branchPullRequest, row.project_id, true);
  const associated = visible.filter((l) => key(l) === key(target));
  const dismissed = includeHidden ? hidden.filter((l) => key(l) === key(target)) : [];
  const discovered = discovery && key(discovery) === key(target) ? discovery : null;
  if (!associated.length && !dismissed.length && !discovered) {
    return null;
  }
  const providerColumns =
    "provider_thread_id,thread_id,owner_node_id,provider_session_id,payload_json";
  const activeRow =
    row.active_provider_thread_id === null
      ? null
      : db
          .query<ProviderRow, [string]>(
            `SELECT ${providerColumns} FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?`,
          )
          .get(row.active_provider_thread_id);
  const active = activeRow ? provider(activeRow) : null;
  const history = db
    .query<
      ProviderRow,
      [string]
    >(`SELECT ${providerColumns} FROM orchestration_v2_projection_provider_threads
            WHERE thread_id=? AND owner_node_id IS NULL ORDER BY updated_at,provider_thread_id`)
    .all(row.thread_id)
    .map(provider);
  const identities = room.agents
    .filter((agent) => {
      const tag = identity(agent.task_description);
      if (tag.t3_thread) {
        return tag.t3_thread === row.thread_id;
      }
      return (
        !!tag.session_id &&
        [active, ...history].some(
          (p) =>
            p &&
            tag.host === (registrationHosts.get(p.driver) ?? p.driver) &&
            tag.session_id === p.nativeId,
        )
      );
    })
    .map((a) => ({
      name: a.name,
      program: a.program,
      model: a.model,
      identity: identity(a.task_description),
      retiredAt: a.retired_at,
      lastActiveAt: a.last_active_ts,
    }));
  return {
    ...threadMetadata(row, t),
    associations: associated,
    branchDiscovery: discovered,
    ...(includeHidden ? { hiddenAssociations: dismissed } : {}),
    visibleLinks: visible,
    ...(includeHidden ? { hiddenLinks: hidden } : {}),
    chains: chains(visible),
    activeProviderThreadId: row.active_provider_thread_id,
    currentProvider: active,
    providerHistory: { coverage: "retained root conversations only", entries: history },
    swarmail: {
      status:
        room.status === "unavailable" ? "unavailable" : identities.length ? "matched" : "unknown",
      identities,
    },
  };
}

function collectMatches(
  db: Database,
  projects: { project_id: string }[],
  target: Pr,
  includeHidden: boolean,
  room: ReturnType<typeof roster>,
) {
  const matches = [];
  for (const project of projects) {
    const rows = db
      .query<
        ThreadRow,
        [string]
      >(`SELECT thread_id,project_id,active_provider_thread_id,payload_json
          FROM orchestration_v2_projection_threads WHERE project_id=? ORDER BY thread_id`)
      .all(project.project_id);
    for (const row of rows) {
      const match = matchThread(db, row, target, includeHidden, room);
      if (match) {
        matches.push(match);
      }
    }
  }
  return matches;
}

const usage =
  "swarmail pr-sessions <https://github.com/owner/repo/pull/number> --project <checkout> [--include-hidden] [--t3-home <local-profile>]";
export async function prSessions(args: string[]): Promise<number> {
  try {
    if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
      console.log(usage);
      return 0;
    }
    requireArgument(args[0] && !args[0].startsWith("-"), usage);
    let target: Pr;
    try {
      target = prUrl(args[0]);
    } catch {
      throw new Error("expected an exact https://github.com/owner/repository/pull/number URL");
    }
    let scope: string | undefined;
    let profile: string | undefined;
    let includeHidden = false;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--project" && !scope && args[i + 1] && !args[i + 1]!.startsWith("-")) {
        scope = args[++i];
      } else if (
        args[i] === "--t3-home" &&
        !profile &&
        args[i + 1] &&
        !args[i + 1]!.startsWith("-")
      ) {
        profile = args[++i];
      } else if (args[i] === "--include-hidden" && !includeHidden) {
        includeHidden = true;
      } else {
        throw new Error(usage);
      }
    }
    requireArgument(scope, "an explicit --project is required");
    const path = projectPath(scope);
    const file = t3StatePath(profile ? realpathSync(profile) : t3Home());
    requireArgument(existsSync(file), "local T3 store is missing");
    const db = new Database(file, { readonly: true });
    try {
      requireValue(isT3V2(db), "T3 V1 is unsupported");
      db.run("BEGIN");
      // Verify the required projection even when no association matches.
      db.query(`SELECT provider_thread_id,thread_id,owner_node_id,provider_session_id,updated_at,payload_json
        FROM orchestration_v2_projection_provider_threads LIMIT 0`).all();
      const projects = db
        .query<{ project_id: string; workspace_root: string }, []>(
          "SELECT project_id,workspace_root FROM projection_projects",
        )
        .all()
        .filter((p) => {
          try {
            return projectPath(p.workspace_root) === path;
          } catch {
            return false;
          }
        });
      requireArgument(projects.length > 0, "no local T3 project matches --project");
      const room = roster(path);
      const matches = collectMatches(db, projects, target, includeHidden, room);
      db.run("COMMIT");
      console.log(
        JSON.stringify(
          {
            pullRequest: target,
            project: path,
            coverage: {
              environment: "local T3 V2",
              database: file,
              rosterDatabase: room.database,
              limits:
                "Associations are not implementer ownership or checkout release evidence. Remote, V1, non-GitHub, hard-deleted and unlinked sessions are unsupported. Roster identities can be overwritten; historical coverage is incomplete.",
            },
            matches,
          },
          null,
          2,
        ),
      );
      return 0;
    } finally {
      db.close();
    }
  } catch (error) {
    console.error(`pr-sessions: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
