"use strict";

// Read-only public integration checks. Does not log in, send email, create
// bookings, or mutate data. Node.js >=20 required (built-in fetch).
// Usage: node scripts/check-three-projects.cjs http://localhost:3000
//        node scripts/check-three-projects.cjs https://api.onetrue.ph

const input = process.argv[2] || "http://localhost:3000";
let base;
try {
  base = new URL(input);
  if (!/^https?:$/.test(base.protocol)) throw new Error("HTTP(S) only");
  if (base.pathname.replace(/\/+$/, "").endsWith("/api")) {
    base.pathname = base.pathname.replace(/\/api\/?$/, "/");
  }
  base.search = "";
  base.hash = "";
} catch {
  console.error("Supply an HTTP(S) backend URL, e.g. http://localhost:3000");
  process.exit(2);
}

function route(path) {
  return new URL(path.replace(/^\//, ""), `${base.origin}${base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`}`);
}

const checks = [
  { name: "HTTP process", path: "/", validate: (r) => r.status === 200 },
  { name: "Express API", path: "/api/test", validate: (r) => r.status === 200 },
  { name: "MongoDB readiness", path: "/health/database", validate: (r) => r.status === 200, important: true },
  { name: "Storage + MongoDB readiness", path: "/health", validate: (r) => r.status === 200, important: true },
  { name: "Login validation", path: "/api/auth/login", method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", validate: (r) => r.status === 400 },
  ...[
    "https://admin.onetrue.ph",
    "https://onetrue.ph",
    "http://localhost:5173",
  ].map((origin) => ({
    name: `CORS ${origin}`,
    path: "/api/auth/login",
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,authorization" },
    validate: (r) => r.status === 204 && r.headers.get("access-control-allow-origin") === origin,
  })),
  {
    name: "Socket.IO HTTP polling",
    path: "/socket.io/?EIO=4&transport=polling",
    validate: (r, body) => r.status === 200 && body.startsWith("0{"),
  },
];

async function runCheck(c) {
  const started = performance.now();
  const url = route(c.path);
  try {
    const response = await fetch(url, {
      method: c.method || "GET",
      headers: c.headers || {},
      body: c.body,
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    const body = (await response.text()).slice(0, 128);
    return {
      name: c.name,
      passed: c.validate(response, body),
      status: response.status,
      elapsed: Math.round(performance.now() - started),
      important: Boolean(c.important),
    };
  } catch (error) {
    return {
      name: c.name,
      passed: false,
      status: error?.cause?.code || error?.name || "NETWORK_ERROR",
      elapsed: Math.round(performance.now() - started),
      important: Boolean(c.important),
    };
  }
}

(async () => {
  console.log(`OneTrue public integration checks -> ${base.origin}${base.pathname}`);
  console.log("No credentials are used and no email or transaction is sent.\n");
  const results = await Promise.all(checks.map(runCheck));
  for (const r of results) {
    console.log(`${r.passed ? "PASS" : "FAIL"} ${r.name.padEnd(34)} status=${String(r.status).padEnd(15)} ${r.elapsed}ms`);
  }
  const failures = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failures.length}/${results.length} public checks passed.`);
  if (failures.length) {
    console.log("If the API is unreachable, check its DNS/SSL/Hostinger deployment before debugging login.");
    console.log("If API works but database checks fail, inspect MongoDB Atlas connectivity.");
    console.log("If HTTP works but Socket.IO fails, inspect Hostinger proxy support for /socket.io polling.");
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error(`Unexpected check error: ${error?.name || "Error"}`);
  process.exitCode = 1;
});
