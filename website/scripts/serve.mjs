#!/usr/bin/env node
// Serve website/dist on http://127.0.0.1:4173 (or PORT) for a local preview.
// Run build.mjs first.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const port = Number(process.env.PORT) || 4173;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".webp": "image/webp", ".mp4": "video/mp4", ".woff2": "font/woff2",
  ".acpk": "application/octet-stream", ".txt": "text/plain; charset=utf-8",
};

if (!fs.existsSync(root)) {
  console.error("error: website/dist is missing. Run: node website/scripts/build.mjs");
  process.exit(1);
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) return void res.writeHead(403).end();
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) return void res.writeHead(404).end("Not found");
  const size = fs.statSync(file).size;
  const type = TYPES[path.extname(file)] || "application/octet-stream";
  // Safari plays video only from a server that answers range requests.
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { "Content-Type": type, "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes" });
    return void fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
  fs.createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`Agent Buddy website: http://127.0.0.1:${port}/`));
