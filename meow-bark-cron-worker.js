export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        name: "meow-bark-cron",
        endpoints: ["/test", "/proactive/test", "/proactive/pending", "/report", "/app/open", "/app/close", "/activity", "/activity/summary", "/debug/last"]
      });
    }

    if (url.pathname === "/test") {
      return await sendBarkResponse(env, "Meow test", "Bark push is connected.");
    }

    if (url.pathname === "/proactive/test") {
      const auth = requireBearer(request, env, url);
      if (auth) return auth;
      return json(await createProactiveMessage(env, { manual: true }));
    }

    if (url.pathname === "/proactive/pending" && request.method === "GET") {
      const auth = requireBearer(request, env, url);
      if (auth) return auth;
      return json({ ok: true, messages: await loadPendingMessages(env) });
    }

    if (url.pathname === "/proactive/pending/ack" && request.method === "POST") {
      const auth = requireBearer(request, env, url);
      if (auth) return auth;
      const payload = await readPayload(request, url);
      return json(await ackPendingMessages(env, payload));
    }

    if (url.pathname === "/debug/last" && request.method === "GET") {
      const auth = requireBearer(request, env, url);
      if (auth) return auth;
      return json(await loadDebugState(env));
    }

    if (url.pathname === "/activity" && request.method === "GET") {
      const auth = requireBearer(request, env, url);
      if (auth) return auth;
      return json(await loadActivityRecords(env));
    }

    if (url.pathname === "/activity/summary" && request.method === "GET") {
      const auth = requireBearer(request, env, url);
      if (auth) return auth;
      return json(buildActivitySummary(await loadActivityRecords(env)));
    }

    if (url.pathname === "/report" && request.method === "POST") {
      const auth = requireBearer(request, env, url);
      await saveDebugRequest(request, env, url, { route: "report", auth: auth ? "failed" : "passed" });
      if (auth) return auth;
      return await saveActivityReport(request, env);
    }

    if (url.pathname === "/app/open" && (request.method === "GET" || request.method === "POST")) {
      const auth = requireBearer(request, env, url);
      await saveDebugRequest(request, env, url, { route: "app/open", auth: auth ? "failed" : "passed" });
      if (auth) return auth;
      return await markAppOpen(request, env, url);
    }

    if (url.pathname === "/app/close" && (request.method === "GET" || request.method === "POST")) {
      const auth = requireBearer(request, env, url);
      await saveDebugRequest(request, env, url, { route: "app/close", auth: auth ? "failed" : "passed" });
      if (auth) return auth;
      return await markAppClose(request, env, url);
    }

    return json({ ok: false, error: "Not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(env));
  }
};

async function handleCron(env) {
  if (isProactiveEnabled(env)) {
    const result = await createProactiveMessage(env, { manual: false });
    if (result.ok) return;
    await saveDebugState(env, {
      type: "proactive/skip",
      ok: false,
      error: result.error || "unknown",
      at: new Date().toISOString()
    });
  }

  const summary = buildActivitySummary(await loadActivityRecords(env));
  let body = "Cron triggered.";

  if (summary.count > 0) {
    const top = summary.topApps
      .slice(0, 3)
      .map((item) => `${item.app} ${formatMinutes(item.seconds)}`)
      .join(", ");
    const latest = summary.latest
      ? `Latest: ${summary.latest.app} ${formatWhen(summary.latest.endAt || summary.latest.startAt)}`
      : "";
    body = [top ? `Recent use: ${top}` : "", latest].filter(Boolean).join("\n");
  }

  await sendBark(env, "Meow scheduled reminder", body || "Cron triggered, but there are no app records yet.");
}

function isProactiveEnabled(env) {
  return String(env.PROACTIVE_ENABLED || "").toLowerCase() === "true";
}

async function createProactiveMessage(env, options = {}) {
  const store = getActivityStore(env);
  if (!store) return { ok: false, error: "Missing activity KV binding" };
  if (!env.CHAT_API_URL || !env.CHAT_API_KEY || !env.CHAT_MODEL) {
    return { ok: false, error: "Missing CHAT_API_URL / CHAT_API_KEY / CHAT_MODEL" };
  }

  const now = new Date();
  const cooldownMs = Math.max(1, Number(env.PROACTIVE_COOLDOWN_HOURS || 6)) * 60 * 60 * 1000;
  const lastAt = await store.get("proactive:lastAt");
  if (!options.manual && lastAt && now.getTime() - new Date(lastAt).getTime() < cooldownMs) {
    return { ok: false, skipped: true, error: "cooldown" };
  }

  const records = await loadActivityRecords(env);
  const summary = buildActivitySummary(records);
  const text = await generateProactiveText(env, summary);
  if (!text) return { ok: false, error: "empty model reply" };

  const roleName = String(env.PROACTIVE_ROLE_NAME || "喵喵酱").trim() || "喵喵酱";
  const msg = {
    id: `pm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    roleId: String(env.PROACTIVE_ROLE_ID || "default"),
    roleName,
    content: text.slice(0, 800),
    createdAt: now.toISOString(),
    source: "bark-cron",
    activity: summaryForMessage(summary)
  };

  const pending = await loadPendingMessages(env);
  pending.unshift(msg);
  await store.put("proactive:pending", JSON.stringify(pending.slice(0, 30)));
  await store.put("proactive:lastAt", now.toISOString());

  const bark = await sendBark(env, roleName, msg.content);
  await saveDebugState(env, {
    type: "proactive/create",
    ok: true,
    id: msg.id,
    roleName,
    barkOk: !!bark.ok,
    at: now.toISOString()
  });
  return { ok: true, message: msg, bark };
}

async function generateProactiveText(env, summary) {
  const roleName = String(env.PROACTIVE_ROLE_NAME || "喵喵酱").trim() || "喵喵酱";
  const persona = String(env.PROACTIVE_ROLE_PROMPT || "温柔、自然、有点黏人，像微信里真实的人。").trim();
  const userName = String(env.PROACTIVE_USER_NAME || "user").trim() || "user";
  const activityText = formatActivityForPrompt(summary);
  const messages = [
    {
      role: "system",
      content: `你是${roleName}。${persona}\n你正在微信里主动给${userName}发一条消息。只输出消息正文，不要解释，不要加角色名，不要使用列表。`
    },
    {
      role: "user",
      content: `现在是${formatWhen(new Date().toISOString())}。\n手机活动摘要：\n${activityText}\n\n请主动发一条自然的微信消息。可以关心、撒娇、吐槽、提醒休息，若看到小红书/短视频/游戏用得久，可以自然提一下；不要像系统通知。`
    }
  ];
  const res = await fetch(normalizeChatUrl(env.CHAT_API_URL), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.CHAT_API_KEY}`
    },
    body: JSON.stringify({
      model: env.CHAT_MODEL,
      messages,
      temperature: Number(env.PROACTIVE_TEMPERATURE || 0.85)
    })
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`chat api ${res.status}: ${raw.slice(0, 200)}`);
  const data = safeJson(raw);
  const text = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "";
  return cleanModelText(text);
}

function cleanModelText(text) {
  return String(text || "")
    .replace(/<thinking[\s\S]*?<\/thinking>/gi, "")
    .replace(/^["“”'「」]+|["“”'「」]+$/g, "")
    .replace(/^(?:角色|assistant|AI|喵喵酱)[:：]\s*/i, "")
    .trim();
}

function normalizeChatUrl(url) {
  const s = String(url || "").trim();
  if (!s) return s;
  if (/\/chat\/completions\/?$/.test(s)) return s;
  return s.replace(/\/+$/, "") + "/chat/completions";
}

function formatActivityForPrompt(summary) {
  if (!summary || !summary.count) return "暂无最近 App 活动记录。";
  const top = summary.topApps.slice(0, 5).map((x) => `- ${x.app}: ${formatMinutes(x.seconds)}`).join("\n");
  const recent = summary.recent.slice(0, 5).map((x) => `- ${x.app}: ${formatMinutes(x.seconds)}，${formatWhen(x.endAt || x.startAt)}`).join("\n");
  return [`常用排行：\n${top || "无"}`, `最近记录：\n${recent || "无"}`].join("\n");
}

function summaryForMessage(summary) {
  return {
    count: summary?.count || 0,
    latest: summary?.latest || null,
    topApps: (summary?.topApps || []).slice(0, 5)
  };
}

async function loadPendingMessages(env) {
  const store = getActivityStore(env);
  if (!store) return [];
  const raw = await store.get("proactive:pending");
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function ackPendingMessages(env, payload = {}) {
  const store = getActivityStore(env);
  if (!store) return { ok: false, error: "Missing activity KV binding" };
  const ids = Array.isArray(payload.ids)
    ? payload.ids.map(String)
    : String(payload.ids || payload.id || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!ids.length) return { ok: false, error: "Missing ids" };
  const set = new Set(ids);
  const old = await loadPendingMessages(env);
  const next = old.filter((m) => !set.has(String(m.id)));
  await store.put("proactive:pending", JSON.stringify(next));
  return { ok: true, acked: old.length - next.length, remaining: next.length };
}

async function saveActivityReport(request, env) {
  const store = getActivityStore(env);
  if (!store) return json({ ok: false, error: "Missing activity KV binding" }, 500);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const incoming = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload.records) ? payload.records : [payload]);

  const now = new Date().toISOString();
  const clean = incoming.map((item) => normalizeActivityRecord(item, now)).filter(Boolean);
  if (!clean.length) return json({ ok: false, error: "No valid records" }, 400);

  const oldRecords = await loadActivityRecords(env);
  const merged = [...clean, ...oldRecords]
    .sort((a, b) => String(b.endAt || b.startAt || "").localeCompare(String(a.endAt || a.startAt || "")))
    .slice(0, 200);

  await store.put("activity:records", JSON.stringify(merged));
  return json({ ok: true, saved: clean.length, total: merged.length });
}

async function markAppOpen(request, env, url) {
  const store = getActivityStore(env);
  if (!store) return json({ ok: false, error: "Missing activity KV binding" }, 500);

  const payload = await readPayload(request, url);

  const app = String(payload.app || payload.name || payload.title || "").trim();
  if (!app) return json({ ok: false, error: "Missing app" }, 400);

  const now = new Date().toISOString();
  const open = {
    app,
    device: String(payload.device || "iPhone"),
    startAt: String(payload.startAt || payload.time || now),
    note: String(payload.note || "").slice(0, 240)
  };

  await store.put("activity:open:" + app, JSON.stringify(open));
  await saveDebugState(env, {
    type: "app/open",
    ok: true,
    app,
    payloadKeys: Object.keys(payload),
    at: now
  });
  return json({ ok: true, state: "open", app, startAt: open.startAt });
}

async function markAppClose(request, env, url) {
  const store = getActivityStore(env);
  if (!store) return json({ ok: false, error: "Missing activity KV binding" }, 500);

  const payload = await readPayload(request, url);

  const app = String(payload.app || payload.name || payload.title || "").trim();
  if (!app) return json({ ok: false, error: "Missing app" }, 400);

  const now = new Date().toISOString();
  const rawOpen = await store.get("activity:open:" + app);
  let open = null;
  try {
    open = rawOpen ? JSON.parse(rawOpen) : null;
  } catch {
    open = null;
  }

  const endAt = String(payload.endAt || payload.time || now);
  const startAt = String(payload.startAt || open?.startAt || endAt);
  const diffMs = new Date(endAt).getTime() - new Date(startAt).getTime();
  const seconds = Number.isFinite(diffMs) ? Math.max(1, Math.round(diffMs / 1000)) : 1;

  const record = normalizeActivityRecord({
    app,
    seconds,
    startAt,
    endAt,
    device: payload.device || open?.device || "iPhone",
    note: payload.note || open?.note || "Shortcuts auto record"
  }, now);

  const oldRecords = await loadActivityRecords(env);
  const merged = [record, ...oldRecords]
    .filter(Boolean)
    .sort((a, b) => String(b.endAt || b.startAt || "").localeCompare(String(a.endAt || a.startAt || "")))
    .slice(0, 200);

  await store.put("activity:records", JSON.stringify(merged));
  await store.delete("activity:open:" + app);
  await saveDebugState(env, {
    type: "app/close",
    ok: true,
    app,
    seconds,
    hadOpen: !!open,
    payloadKeys: Object.keys(payload),
    at: now
  });
  return json({ ok: true, state: "close", saved: 1, record });
}

function normalizeActivityRecord(item, fallbackTime) {
  if (!item || typeof item !== "object") return null;
  const app = String(item.app || item.name || item.title || "").trim();
  if (!app) return null;

  const seconds = Number(item.seconds ?? item.durationSeconds ?? item.duration ?? 0) || 0;
  return {
    app,
    bundleId: String(item.bundleId || item.bundle || "").trim(),
    seconds: Math.max(0, Math.round(seconds)),
    startAt: String(item.startAt || item.startedAt || item.time || fallbackTime),
    endAt: String(item.endAt || item.endedAt || fallbackTime),
    device: String(item.device || "iPhone"),
    note: String(item.note || "").slice(0, 240)
  };
}

async function loadActivityRecords(env) {
  const store = getActivityStore(env);
  if (!store) return [];
  const raw = await store.get("activity:records");
  if (!raw) return [];
  try {
    const records = JSON.parse(raw);
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}

function getActivityStore(env) {
  return env.ACTIVITY_KV || env.MEOW_ACTIVITY || null;
}

async function readPayload(request, url) {
  const query = Object.fromEntries(url.searchParams.entries());
  if (request.method === "GET") {
    return query;
  }

  const contentType = request.headers.get("content-type") || "";
  const text = await request.text();
  if (!text.trim()) return query;

  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch {
    if (contentType.includes("application/x-www-form-urlencoded") || text.includes("=")) {
      try {
        payload = Object.fromEntries(new URLSearchParams(text).entries());
      } catch {
        payload = { raw: text };
      }
    } else {
      payload = { raw: text };
    }
  }

  return { ...query, ...normalizeShortcutPayload(payload) };
}

function normalizeShortcutPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};

  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    const cleanKey = String(key || "").trim();
    if (!cleanKey) continue;
    out[cleanKey] = unwrapShortcutValue(value);
  }

  return out;
}

function unwrapShortcutValue(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(unwrapShortcutValue).filter(Boolean).join(", ");
  if (typeof value === "object") {
    for (const key of ["text", "value", "string", "name", "content"]) {
      if (value[key] != null) return unwrapShortcutValue(value[key]);
    }
    return JSON.stringify(value).slice(0, 240);
  }
  return String(value);
}

async function saveDebugRequest(request, env, url, extra = {}) {
  const store = getActivityStore(env);
  if (!store) return;
  const auth = request.headers.get("Authorization") || "";
  await saveDebugState(env, {
    type: "request",
    route: extra.route || url.pathname,
    auth: extra.auth || "unknown",
    method: request.method,
    pathname: url.pathname,
    queryKeys: [...url.searchParams.keys()],
    hasAuthorization: !!auth,
    authorizationPrefix: auth ? auth.slice(0, 12) : "",
    contentType: request.headers.get("content-type") || "",
    at: new Date().toISOString()
  });
}

async function saveDebugState(env, data) {
  const store = getActivityStore(env);
  if (!store) return;
  const old = await loadDebugState(env);
  const events = Array.isArray(old.events) ? old.events : [];
  events.unshift(data);
  await store.put("activity:debug:last", JSON.stringify({
    ok: true,
    latest: data,
    events: events.slice(0, 20)
  }));
}

async function loadDebugState(env) {
  const store = getActivityStore(env);
  if (!store) return { ok: false, error: "Missing activity KV binding" };
  const raw = await store.get("activity:debug:last");
  if (!raw) return { ok: true, latest: null, events: [] };
  try {
    return JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid debug state", raw: raw.slice(0, 500) };
  }
}

function buildActivitySummary(records) {
  const topMap = new Map();
  for (const record of records) {
    const key = record.app || "Unknown";
    topMap.set(key, (topMap.get(key) || 0) + (Number(record.seconds) || 0));
  }

  return {
    ok: true,
    count: records.length,
    latest: records[0] || null,
    topApps: [...topMap.entries()]
      .map(([app, seconds]) => ({ app, seconds }))
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 10),
    recent: records.slice(0, 20)
  };
}

async function sendBarkResponse(env, title, body) {
  const result = await sendBark(env, title, body);
  return json(result, result.ok ? 200 : 500);
}

async function sendBark(env, title, body) {
  const key = env.BARK_KEY;
  if (!key) return { ok: false, error: "Missing BARK_KEY" };

  const icon = env.BARK_ICON_URL || "https://raw.githubusercontent.com/guoguofang3-ai/Meow/main/meow-bark-icon.png?v=1";
  const barkUrl =
    `https://api.day.app/${encodeURIComponent(key)}` +
    `/${encodeURIComponent(title)}` +
    `/${encodeURIComponent(body)}` +
    `?icon=${encodeURIComponent(icon)}`;

  const res = await fetch(barkUrl);
  const text = await res.text();
  return { ok: res.ok, status: res.status, response: safeJson(text) || text };
}

function requireBearer(request, env, url = null) {
  const token = env.REPORT_TOKEN;
  if (!token) return json({ ok: false, error: "Missing REPORT_TOKEN" }, 500);

  const auth = request.headers.get("Authorization") || "";
  const queryToken = url ? String(url.searchParams.get("token") || "") : "";
  if (auth !== `Bearer ${token}` && queryToken !== token) return json({ ok: false, error: "Unauthorized" }, 401);
  return null;
}

function json(data, status = 200) {
  return withCors(new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  }));
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function formatMinutes(seconds) {
  const mins = Math.max(1, Math.round((Number(seconds) || 0) / 60));
  return `${mins} min`;
}

function formatWhen(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}
