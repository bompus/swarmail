import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nativeTitles } from "../src/native-titles.ts";

function profile(run) {
  const home = mkdtempSync(join(tmpdir(), "native-titles-"));
  const json = (path, value) => {
    const file = join(home, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  };
  const sqlite = (path, sql) => {
    const file = join(home, path);
    mkdirSync(dirname(file), { recursive: true });
    const db = new Database(file, { create: true });
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
    return file;
  };
  try {
    run({ home, json, sqlite, env: { HOME: home } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("native titles join exact registered identities across five providers and schema generations", () => {
  profile(({ home, json, sqlite, env }) => {
    json(".codex/session_index.jsonl", { id: "shared", thread_name: "Codex name" });
    json(".grok/sessions/shortened-workspace/shared/summary.json", {
      info: { id: "shared" },
      generated_title: "Grok rename",
      session_summary: "Old summary",
    });
    sqlite(
      ".local/share/opencode/opencode.db",
      `
      create table session(id text, title text, time_updated integer);
      create table session_v2(id text, title text, time_updated integer);
      insert into session values('shared', 'OpenCode older', 10), ('legacy', 'Legacy title', 20), ('tie', 'Tie v1', 30);
      insert into session_v2 values('shared', 'OpenCode current', 20), ('legacy', 'Stale migration', 10), ('tie', 'Tie v2', 30);`,
    );
    const devin = process.platform === "win32" ? "AppData/Roaming/Devin" : ".local/share/devin";
    sqlite(
      `${devin}/cli-next/sessions.db`,
      `create table sessions(id text, title text, last_activity_at text);
      insert into sessions values('shared', 'Devin current', '2026-10-04T12:00:00Z');`,
    );
    sqlite(
      `${devin}/cli/sessions.db`,
      `create table sessions(id text, title text, last_activity_at text);
      insert into sessions values('shared', 'Devin older', '2026-10-03T12:00:00Z'), ('legacy', 'Devin legacy', '2026-10-04T12:00:00Z');`,
    );
    sqlite(
      ".gemini/antigravity-cli/conversation_summaries.db",
      `
      create table conversation_summaries(conversation_id text, title text, last_modified_time text);
      insert into conversation_summaries values('shared', 'AGY current', '2026-10-04T12:00:00Z');`,
    );
    json(".gemini/antigravity-cli/cache/conversation_metadata.json", {
      conversations: {
        shared: {
          summary: { ID: "shared", Title: "Stale cache", UpdatedAt: "2026-10-03T12:00:00Z" },
        },
        cached: { summary: { ID: "cached", Title: "Cache only" } },
      },
    });
    const identities = ["codex", "grok", "opencode", "devin", "agy"].map((host) => ({
      host,
      session_id: "shared",
    }));
    identities.push(
      { host: "opencode", session_id: "legacy" },
      { host: "opencode", session_id: "tie" },
      { host: "devin", session_id: "legacy" },
      { host: "agy", session_id: "cached" },
      { host: "cursor", session_id: "shared" },
      { host: "codex", session_id: "missing" },
    );
    const expected = [
      "Codex name",
      "Grok rename",
      "OpenCode current",
      "Devin current",
      "AGY current",
      "Legacy title",
      "Tie v1",
      "Devin legacy",
      "Cache only",
      null,
      null,
    ];
    expect(nativeTitles(identities, env)).toEqual(expected);
    expect(nativeTitles(identities, env)).toEqual(expected);
    expect(readdirSync(join(home, ".codex"))).toEqual(["session_index.jsonl"]);
  });
});

test("Codex renames beat SQLite titles and survive malformed index lines", () => {
  profile(({ home, json, sqlite, env }) => {
    json(".codex/session_index.jsonl", {
      id: "renamed",
      thread_name: "Old name",
      updated_at: "2030-01-01",
    });
    const file = join(home, ".codex/session_index.jsonl");
    writeFileSync(
      file,
      readFileSync(file, "utf8") +
        "\n{broken}\n" +
        JSON.stringify({ id: "renamed", thread_name: "New name", updated_at: "2020-01-01" }) +
        '\n{"id":',
    );
    sqlite(
      ".codex/state_5.sqlite",
      `create table threads(id text, name text, title text);
      insert into threads values('renamed', 'DB name', 'Stale title'), ('named', 'Explicit name', 'Initial title');`,
    );
    sqlite(
      ".codex/state_4.sqlite",
      `create table threads(id text, title text);
      insert into threads values('named', 'Older schema'), ('legacy', 'Legacy title');`,
    );
    expect(
      nativeTitles(
        ["renamed", "named", "legacy"].map((session_id) => ({ host: "codex", session_id })),
        env,
      ),
    ).toEqual(["New name", "Explicit name", "Legacy title"]);
  });
});

test("newer AGY metadata wins and mismatched identities never supply a title", () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "America/Denver";
  try {
    profile(({ json, sqlite, env }) => {
      sqlite(
        ".gemini/antigravity-cli/conversation_summaries.db",
        `
      create table conversation_summaries(conversation_id text, title text, last_modified_time text);
      insert into conversation_summaries values('s', 'Old database', '2026-10-04 12:00:00');`,
      );
      json(".gemini/antigravity-cli/cache/conversation_metadata.json", {
        conversations: {
          s: { summary: { ID: "s", Title: "New cache", UpdatedAt: "2026-10-04T13:00:00Z" } },
          wrong: { summary: { ID: "someone-else", Title: "Wrong identity" } },
        },
      });
      json(".grok/sessions/workspace/s/summary.json", {
        info: { id: "someone-else" },
        generated_title: "Wrong Grok",
      });
      expect(
        nativeTitles(
          [
            { host: "agy", session_id: "s" },
            { host: "agy", session_id: "wrong" },
            { host: "grok", session_id: "s" },
          ],
          env,
        ),
      ).toEqual(["New cache", null, null]);
    });
  } finally {
    if (previousTZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTZ;
    }
  }
});

test("provider home overrides work without reading transcripts or creating missing databases", () => {
  profile(({ home, json, sqlite }) => {
    json("codex-home/session_index.jsonl", { id: "s", thread_name: "Alternate Codex" });
    json("grok-home/sessions/workspace/s/summary.json", {
      info: { id: "s" },
      session_summary: "Summary fallback",
    });
    sqlite(
      "data/opencode/opencode.db",
      `create table session_v2(id text, title text, time_updated integer);
      insert into session_v2 values('s', 'Alternate OpenCode', 1);`,
    );
    const env = {
      HOME: home,
      CODEX_HOME: join(home, "codex-home"),
      GROK_HOME: join(home, "grok-home"),
      XDG_DATA_HOME: join(home, "data"),
    };
    expect(
      nativeTitles(
        ["codex", "grok", "opencode", "devin", "agy"].map((host) => ({ host, session_id: "s" })),
        env,
      ),
    ).toEqual(["Alternate Codex", "Summary fallback", "Alternate OpenCode", null, null]);
    expect(readdirSync(join(home, "data"))).toEqual(["opencode"]);
  });
});

test("missing, incompatible and corrupt metadata leave titles unknown", () => {
  profile(({ json, sqlite, env }) => {
    json(".grok/sessions/workspace/s/summary.json", { info: { id: "s" }, generated_title: 42 });
    json(".codex/session_index.jsonl", { id: "s", thread_name: " " });
    sqlite(".local/share/opencode/opencode.db", "create table unrelated(secret text)");
    json(".gemini/antigravity-cli/conversation_summaries.db", { invalid: true });
    expect(
      nativeTitles(
        ["codex", "grok", "opencode", "devin", "agy", "claude"].map((host) => ({
          host,
          session_id: "s",
        })),
        env,
      ),
    ).toEqual([null, null, null, null, null, null]);
    expect(
      nativeTitles(
        [{ host: "grok", session_id: "../../outside" }, {}, { host: "codex", session_id: null }],
        env,
      ),
    ).toEqual([null, null, null]);
  });
});
