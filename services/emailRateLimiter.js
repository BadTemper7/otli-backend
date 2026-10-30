"use strict";
const { redis, prefix } = require("./emailQueue.js");
const { policy, effectiveLimits } = require("./emailPolicy.js");
const rateLua = `
local clock = redis.call('TIME')
local now = tonumber(clock[1])*1000 + math.floor(tonumber(clock[2])/1000)
if redis.call('EXISTS', KEYS[6]) == 1 or redis.call('EXISTS',KEYS[7]) == 1 then return {-1, 60000} end
if redis.call('GET',KEYS[8]) ~= ARGV[6] then return {-2, 60000} end
local cooldown = redis.call('PTTL',KEYS[5]); if cooldown > 0 then return {0,cooldown} end
local waits = 0
local windows = {1000,60000,3600000,86400000}
for i=1,4 do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now-windows[i])
  if redis.call('ZCARD', KEYS[i]) >= tonumber(ARGV[i+1]) then
    local oldest = redis.call('ZRANGE',KEYS[i],0,0,'WITHSCORES')
    if #oldest > 0 then
      local delay = tonumber(oldest[2])+windows[i]-now+1
      if delay > waits then waits = delay end
    end
  end
end
if waits > 0 then return {0,waits} end
for i=1,4 do
  redis.call('ZADD',KEYS[i],now,ARGV[1]); redis.call('PEXPIRE',KEYS[i],windows[i]+5000)
end
return {1,0}
`;
const marketingLua = `
local clock=redis.call('TIME')
local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
local periods={86400000,604800000}
for i=1,2 do
 redis.call('ZREMRANGEBYSCORE',KEYS[i],'-inf',now-periods[i])
end
if redis.call('ZSCORE',KEYS[1],ARGV[1]) then return 1 end
for i=1,2 do if redis.call('ZCARD',KEYS[i]) >= tonumber(ARGV[i+1]) then return 0 end end
for i=1,2 do
 redis.call('ZADD',KEYS[i],now,ARGV[1]); redis.call('PEXPIRE',KEYS[i],periods[i]+5000)
end
return 1
`;
const lockReleaseLua = `if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`;
const k = name => `${prefix()}:${name}`;
async function reserveGlobal(id, category) {
  const p = policy();
  const keys = p.limits.map((_, i) => k(`rate:${i}`));
  const { digest } = require("./emailPolicy.js");
  const { secret } = require("./emailCrypto.js");
  const providerId = digest(`${process.env.SMTP_HOST || ""}|${process.env.SMTP_USER || ""}`, secret());
  const args = [String(id), ...effectiveLimits(p, category).map(([, limit]) => String(limit)), providerId];
  const answer = await redis().eval(rateLua, 8, ...keys, k("cooldown"), k("paused:all"), k(`paused:${category}`), k("quota-sentinel"), ...args);
  return { allowed: answer[0] === 1, paused: answer[0] === -1, quotaStateLost: answer[0] === -2, delayMs: Math.max(1000, Number(answer[1]) || 1000) };
}
async function reserveMarketing(addressHash, id) {
  const p = policy();
  return (await redis().eval(marketingLua, 2, k(`mday:${addressHash}`), k(`mweek:${addressHash}`), String(id), p.marketingDaily, p.marketingWeekly)) === 1;
}
async function leaseSender(owner) { return (await redis().set(k("sender-lock"), owner, "PX", 60000, "NX")) === "OK"; }
async function releaseSender(owner) { return redis().eval(lockReleaseLua, 1, k("sender-lock"), owner); }
async function setCooldown(ms) { return redis().psetex(k("cooldown"), Math.max(1000, ms), "throttled"); }
async function paused(category) { return Boolean(await redis().exists(k("paused:all"), k(`paused:${category}`))); }
async function getRateState() {
  const r = redis();
  const counts = await Promise.all([0,1,2,3].map(i => r.zcard(k(`rate:${i}`))));
  const cooldown = await r.pttl(k("cooldown"));
  const p = policy();
  const marketingLimits = effectiveLimits(p, "marketing");
  return { limits: p.limits.map(([durationMs, max], i) => ({ durationMs, max, marketingMax: marketingLimits[i][1], consumed: counts[i] })), cooldownMs: Math.max(0, cooldown) };
}
module.exports = { reserveGlobal, reserveMarketing, leaseSender, releaseSender, setCooldown, paused, getRateState, k };
