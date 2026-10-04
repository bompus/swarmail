#!/usr/bin/env node
// Stdio MCP relay for MCP clients that install servers from a registry: each newline-delimited
// JSON-RPC message on stdin is POSTed to a running Swarmail server, and its response is written to
// stdout as one line. It installs and starts nothing; the server comes from the Swarmail README.
// Agents name themselves in tool arguments, so relaying changes nothing about who is calling.
import { createInterface } from "node:readline";

const url = process.env.SWARMAIL_URL || "http://127.0.0.1:18765/mcp/";
const install = "https://github.com/bompus/swarmail#install";
// Tool calls answer in milliseconds; nothing on /mcp/ long-polls.
const TIMEOUT_MS = 30_000;

const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const fail = (id, message) => write({ jsonrpc: "2.0", id, error: { code: -32000, message } });

async function relay(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    // The server answers malformed input with its own parse error.
  }
  const id = msg && typeof msg === "object" && !Array.isArray(msg) ? msg.id : null;
  let res, text;
  try {
    // One deadline covers the headers and the body, so a stalled server cannot hold the queue.
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: line,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text();
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    const reason = timedOut
      ? `no answer within ${TIMEOUT_MS / 1000} s`
      : e instanceof Error
        ? (e.cause?.code ?? e.message)
        : String(e);
    process.stderr.write(`swarmail-mcp: ${url}: ${reason}\n`);
    if (id !== undefined) {
      fail(
        id,
        res || timedOut
          ? `The Swarmail server at ${url} did not finish its answer (${reason}).`
          : `The Swarmail server is not reachable at ${url} (${reason}). Start it first: ${install}`,
      );
    }
    return;
  }
  if (res.status === 202 || id === undefined) {
    return;
  }
  try {
    write(JSON.parse(text));
  } catch {
    fail(id, `The Swarmail server at ${url} answered ${res.status}: ${text.slice(0, 200)}`);
  }
}

// One message at a time, so responses keep the order of their requests.
let queue = Promise.resolve();
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (line.trim()) {
    queue = queue.then(() => relay(line));
  }
});
