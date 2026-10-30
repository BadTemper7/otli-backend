"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const path = require("node:path");

function runScript(url) {
  return new Promise((resolve, reject) => {
    const script = path.resolve(__dirname, "../scripts/check-three-projects.cjs");
    const child = spawn(process.execPath, [script, url]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("public integration smoke script validates API/CORS/Socket.IO without sending email", async () => {
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": req.headers.origin || "" });
      return res.end();
    }
    if (req.url === "/api/auth/login" && req.method === "POST") {
      res.writeHead(400);
      return res.end(JSON.stringify({ message: "Email and password required" }));
    }
    if (req.url.startsWith("/socket.io/?")) {
      res.writeHead(200);
      return res.end('0{"sid":"test-session"}');
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end('{"status":"healthy"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const result = await runScript(`http://127.0.0.1:${port}`);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /9\/9 public checks passed/);
    assert.match(result.stdout, /Socket.IO HTTP polling/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
