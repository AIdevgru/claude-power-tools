#!/usr/bin/env node
// A tiny static file server for mockups and splash pages, with no dependencies and no caching,
// so a reload always shows the latest edit.
//
//   node serve.mjs <dir> [--port 5180] [--host 127.0.0.1] [--open]
//
// It takes the first free port from --port upward, prints the URL, and keeps serving until it is
// stopped. Run it in the background. --open also opens the URL in the default browser.
import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".mp4": "video/mp4", ".webm": "video/webm", ".pdf": "application/pdf",
};

// The file a request path maps to inside root, or null when it would escape root or doesn't exist.
export function resolveFile(root, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  } catch {
    return null;
  }
  const file = path.resolve(root, "." + path.posix.normalize("/" + rel));
  const r = path.resolve(root);
  if (file !== r && !file.startsWith(r + path.sep)) return null;
  if (!existsSync(file)) return null;
  if (statSync(file).isDirectory()) {
    const index = path.join(file, "index.html");
    return existsSync(index) ? index : null;
  }
  return file;
}

// True when something already accepts connections on host:port. Windows can let a second server
// bind a port that is in use, so listening alone doesn't prove the port is free.
export function portInUse(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host: host === "0.0.0.0" ? "127.0.0.1" : host, port });
    const done = (used) => {
      socket.destroy();
      resolve(used);
    };
    socket.setTimeout(400, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export function serve(root, { port = 5180, host = "127.0.0.1", tries = 20 } = {}) {
  const server = createServer((req, res) => {
    const file = resolveFile(root, req.url ?? "/");
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const next = (p) => (++attempt < tries ? listen(p + 1) : reject(new Error(`no free port from ${port} to ${p}`)));
    const listen = async (p) => {
      if (await portInUse(host, p)) return next(p);
      server.once("error", (e) => (e.code === "EADDRINUSE" ? next(p) : reject(e)));
      server.listen(p, host, () => resolve({ server, url: `http://${host === "0.0.0.0" ? "localhost" : host}:${p}/` }));
    };
    listen(port);
  });
}

export function openUrl(url) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const opts = {};
  let dir = null;
  let open = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") opts.port = Number(argv[++i]);
    else if (argv[i] === "--host") opts.host = argv[++i];
    else if (argv[i] === "--open") open = true;
    else dir = argv[i];
  }
  if (!dir || !existsSync(dir)) {
    console.error("usage: serve.mjs <dir> [--port N] [--host H] [--open]");
    process.exit(1);
  }
  serve(path.resolve(dir), opts).then(({ url }) => {
    console.log(`serving ${path.resolve(dir).replace(/\\/g, "/")} at ${url}`);
    if (open) openUrl(url);
  }, (e) => {
    console.error(`serve failed: ${e.message}`);
    process.exit(1);
  });
}
