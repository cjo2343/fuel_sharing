// Mission control's tiny web server (GV-471) — only started with --serve.
//
// Three routes, no framework, no dependency, localhost only:
//
//   GET /        dashboard.html, served verbatim from disk
//   GET /events  Server-Sent Events. Replays the journal FROM LINE 1, then follows the
//                file. That single choice is what makes "live view" and "report view"
//                the same page: opening the dashboard after a run replays the whole run
//                and then simply has nothing more to follow.
//   GET /state   the current snapshot (workspaces, balances, counters) as JSON
//
// It binds 127.0.0.1 explicitly. The journal holds synthetic fixture data only, but a
// run's data is still a workspace's data in shape, and a dashboard is not a thing to
// expose on a network interface by accident.

import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD = path.join(HERE, "..", "dashboard.html");

const POLL_MS = 250;

export function startServer({ port, journalPath, getState }) {
  const clients = new Set();

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (!existsSync(DASHBOARD)) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("dashboard.html is missing");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      createReadStream(DASHBOARD).pipe(res);
      return;
    }

    if (url.pathname === "/state") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(getState()));
      return;
    }

    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(": simulator stream\n\n");
      const client = { res, offset: 0 };
      clients.add(client);
      pump(client);
      req.on("close", () => clients.delete(client));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  // Each client tracks its own byte offset into the journal, so a page opened mid-run
  // and a page opened after the run take the identical code path: start at 0, stream
  // everything, keep going.
  let carry = new Map();
  function pump(client) {
    if (!existsSync(journalPath)) return;
    const size = statSync(journalPath).size;
    if (size <= client.offset) return;
    const chunk = readFileSync(journalPath, "utf8").slice(client.offset);
    client.offset = size;
    const pendingText = (carry.get(client) ?? "") + chunk;
    const lines = pendingText.split("\n");
    // A partial trailing line (the writer is mid-append) is carried to the next poll.
    carry.set(client, lines.pop() ?? "");
    for (const line of lines) {
      if (line.trim() === "") continue;
      try { client.res.write(`data: ${line}\n\n`); } catch { clients.delete(client); return; }
    }
  }

  const timer = setInterval(() => {
    for (const client of clients) pump(client);
  }, POLL_MS);
  timer.unref?.();

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/`,
        port: server.address().port,
        close: () => { clearInterval(timer); for (const c of clients) c.res.end(); server.close(); },
      });
    });
  });
}
