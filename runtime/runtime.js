// Manyshape runtime v0 - hosts surfaces in a capability sandbox.
//
// Security model in one paragraph: a surface is untrusted generated code. It
// runs in a sandboxed srcdoc iframe (allow-scripts only - no same-origin, so
// no cookies/storage) under CSP default-src 'none' (no network at all). Its
// only doorway is postMessage to the capability bridge below, which refuses
// any call outside the surface's declared caps ∩ contract caps, and the
// authority plane re-validates server-side. The UI can be anything because it
// can't DO anything the contract doesn't permit.

let contract = null;
let referenceSurface = "";
let guestSdk = "";
let reactRuntime = ""; // lazily fetched Preact+compat bundle for framework: react
let currentUser = "jk";

// ------------------------------------------------------- platform account
// One Manyshape account, three doorways (runtime, chat SDK, extension). The
// runtime works logged-out (local agent + localStorage); signing in moves
// generation to the platform and saves experiences to the cloud.
const PLATFORM = location.hostname.endsWith("manyshape.com") ? "https://platform.manyshape.com" : "http://localhost:8600";
const token = () => localStorage.getItem("manyshape:token");
const accountEmail = () => localStorage.getItem("manyshape:email");

async function platformApi(pathname, opts = {}) {
  const res = await fetch(`${PLATFORM}${pathname}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      ...(token() ? { authorization: `Bearer ${token()}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && token()) {
    // session expired or revoked - drop the stale token
    localStorage.removeItem("manyshape:token");
    localStorage.removeItem("manyshape:email");
    renderAccount();
  }
  if (!res.ok) throw new Error(json.error ?? `platform error ${res.status}`);
  return json;
}

// frames the bridge will serve: Map<Window, {caps:Set, onFirstCap, onError}>
const frames = new Map();
// one staging run at a time: a newer activation cancels the in-flight one
// (two concurrent stagings would otherwise remove each other's iframes)
let pendingStage = null;

const $ = (id) => document.getElementById(id);
const store = {
  key: (u) => `facet:mail-app:${u}`,
  load(u) {
    try { return JSON.parse(localStorage.getItem(this.key(u))) ?? { intents: [], surface: null }; }
    catch { return { intents: [], surface: null }; }
  },
  save(u, state) { localStorage.setItem(this.key(u), JSON.stringify(state)); },
};

// ------------------------------------------------------------ surface utils
function parseHeader(surface) {
  const m = surface.match(/^<!--surface\s+([\s\S]*?)-->/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^\s*(\w+)\s*:\s*(.+?)\s*$/);
    if (kv) meta[kv[1]] = kv[2];
  }
  meta.caps = (meta.caps ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  meta.framework = meta.framework === "react" ? "react" : "vanilla";
  return meta;
}

const FORBIDDEN = [
  /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /EventSource/,
  /sendBeacon/, /\bimport\s*\(/, /src\s*=\s*["']https?:/i, /href\s*=\s*["']https?:/i,
];

function buildSrcdoc(surface, meta) {
  // custom property names are case-sensitive, so token keys map 1:1
  const vars = Object.entries(contract.tokens).map(([k, v]) => `--${k}: ${v};`).join(" ");
  const body = surface.replace(/^<!--surface[\s\S]*?-->/, "");
  // framework: react gets the runtime-provided Preact+compat bundle. Same
  // sandbox, same CSP - the framework is injected by us, never fetched by
  // the (network-less) surface.
  const frameworkScript = meta.framework === "react" ? `<script>${reactRuntime}<\/script>` : "";
  return `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>:root { ${vars} }</style>
<script>${guestSdk.replace("__FACET_USER__", currentUser)}<\/script>
${frameworkScript}
</head><body>${body}</body></html>`;
}

// -------------------------------------------------------- capability bridge
window.addEventListener("message", async (e) => {
  const rec = frames.get(e.source);
  if (!rec) return; // not one of ours
  const m = e.data;
  if (!m) return;

  if (m.type === "facet:error") { rec.onError?.(m.message); return; }
  if (m.type !== "facet:cap") return;

  const reply = (ok, dataOrError) =>
    e.source.postMessage(
      ok ? { type: "facet:cap:result", reqId: m.reqId, ok: true, data: dataOrError }
         : { type: "facet:cap:result", reqId: m.reqId, ok: false, error: dataOrError },
      "*"
    );

  if (!rec.caps.has(m.cap)) return reply(false, `policy declared-caps-only: surface did not declare ${m.cap}`);

  try {
    const res = await fetch(`/api/cap/${encodeURIComponent(m.cap)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-facet-user": currentUser,
        "x-facet-gesture-age": String(Math.round(m.gestureAge ?? 1e9)),
      },
      body: JSON.stringify({ args: m.args ?? {} }),
    });
    const json = await res.json();
    if (!res.ok) return reply(false, json.error ?? `capability failed (${res.status})`);
    rec.onFirstCap?.();
    rec.onFirstCap = null;
    reply(true, json.data);
  } catch (err) {
    reply(false, String(err.message));
  }
});

// ---------------------------------------------------------- activation gate
function gateMark(step, cls) {
  const li = document.querySelector(`#gate li[data-step="${step}"]`);
  if (li) li.className = cls;
}
function gateReset() {
  for (const li of document.querySelectorAll("#gate li")) li.className = "";
}

// Runs the full gate. Resolves with the promoted iframe, or rejects (old
// surface stays live - never a broken screen).
async function activate(surface) {
  gateReset();

  // 1. header + declared caps
  const meta = parseHeader(surface);
  if (!meta || !meta.caps.length) { gateMark("parse", "fail"); throw new Error("surface has no valid header"); }
  gateMark("parse", "pass");

  // 2. caps ⊆ contract
  const contractCaps = new Set(contract.capabilities.map((c) => c.id));
  const unknown = meta.caps.filter((c) => !contractCaps.has(c));
  if (unknown.length) { gateMark("caps", "fail"); throw new Error(`unknown capabilities: ${unknown.join(", ")}`); }
  gateMark("caps", "pass");

  // 3. static policy scan
  const code = surface.replace(/^<!--surface[\s\S]*?-->/, "");
  const hit = FORBIDDEN.find((re) => re.test(code));
  if (hit) { gateMark("static", "fail"); throw new Error(`policy no-ambient-network: matched ${hit}`); }
  gateMark("static", "pass");

  // React surfaces get the runtime-provided framework bundle (fetched once).
  if (meta.framework === "react" && !reactRuntime) {
    reactRuntime = await (await fetch("/react-runtime.js")).text();
  }

  return new Promise((resolve, reject) => {
    // 4. conformance: boots + first successful capability call within 8s
    if (pendingStage) pendingStage("superseded by a newer activation");
    gateMark("conformance", "busy");
    const iframe = document.createElement("iframe");
    iframe.className = "staging";
    iframe.setAttribute("sandbox", "allow-scripts");

    const cleanup = (ok, err) => {
      pendingStage = null;
      clearTimeout(timer);
      if (ok) {
        gateMark("conformance", "pass");
        iframe.classList.remove("staging");
        for (const old of $("frame-host").querySelectorAll("iframe")) {
          if (old !== iframe) { frames.delete(old.contentWindow); old.remove(); }
        }
        resolve({ iframe, meta });
      } else {
        gateMark("conformance", "fail");
        frames.delete(iframe.contentWindow);
        iframe.remove();
        reject(err);
      }
    };
    const timer = setTimeout(() => cleanup(false, new Error("conformance timeout: no successful capability call in 8s")), 8000);
    pendingStage = (reason) => cleanup(false, new Error(reason));

    $("frame-host").appendChild(iframe);
    frames.set(iframe.contentWindow, {
      caps: new Set(meta.caps),
      onFirstCap: () => cleanup(true),
      onError: (msg) => cleanup(false, new Error(`surface JS error: ${msg}`)),
    });
    iframe.srcdoc = buildSrcdoc(surface, meta);
  });
}

// ------------------------------------------------------------------- UI
function audit(html) {
  const li = document.createElement("li");
  const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  li.innerHTML = `<span class="t">${t}</span>${html}`;
  $("audit").prepend(li);
}

function renderSpec() {
  renderSpecFrom(store.load(currentUser).intents);
}

function setStatus(text, cls = "") {
  const el = $("agent-status");
  el.textContent = text;
  el.className = `status ${cls}`;
}

async function showUserSurface() {
  const { surface } = store.load(currentUser);
  renderSpec();
  try {
    const { meta } = await activate(surface ?? referenceSurface);
    audit(`activated <b>${meta.name}</b> [${meta.framework}] for <b>${currentUser}</b> - caps: ${meta.caps.join(", ")}`);
  } catch (err) {
    audit(`activation failed: ${err.message}. Reverting to reference`);
    await activate(referenceSurface).catch(() => {});
  }
}

async function generateSurface(state) {
  // Signed in: the platform's hosted agent (your account, your quota).
  if (token()) {
    try {
      const { surface, source } = await platformApi("/api/agent", {
        method: "POST",
        body: JSON.stringify({ contract, referenceSurface, currentSurface: state.surface, intents: state.intents }),
      });
      return { surface, source: `${source} · platform` };
    } catch (err) {
      audit(`platform agent unavailable (${err.message}) - using local agent`);
    }
  }
  // Logged out (or platform down): the app-local agent.
  const res = await fetch("/api/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: currentUser, intents: state.intents, currentSurface: state.surface }),
  });
  return await res.json();
}

async function onIntent(text) {
  const state = store.load(currentUser);
  state.intents.push(text);
  renderSpecFrom(state.intents);
  $("go").disabled = true;

  try {
    setStatus("agents compiling your surface…", "working");
    const { surface, source, note, error } = await generateSurface(state);
    if (error) throw new Error(error);

    setStatus("running the activation gate…", "working");
    const { meta } = await activate(surface);

    state.surface = surface;
    store.save(currentUser, state);
    setStatus(`activated “${meta.name}” (${source === "fallback" ? "canned fallback - no API key" : `generated by ${source}`})`, "ok");
    audit(`intent → surface <b>${meta.name}</b> [${meta.framework}] (${source}) - caps: ${meta.caps.join(", ")}`);
    if (note) audit(note);
    saveExperience(state, meta);
  } catch (err) {
    // Gate failed or agent failed: intent stays recorded, old surface stays live.
    store.save(currentUser, state);
    setStatus(`rejected: ${err.message}`, "err");
    audit(`gate rejected surface: ${err.message}. Previous surface still active`);
  } finally {
    $("go").disabled = false;
    renderSpec();
  }
}

function renderSpecFrom(intents) {
  const ol = $("intent-spec");
  ol.innerHTML = "";
  for (const s of intents) {
    const li = document.createElement("li");
    li.textContent = s;
    ol.appendChild(li);
  }
  $("spec-empty").style.display = intents.length ? "none" : "block";
}

// ------------------------------------------------------ cloud experiences
async function saveExperience(state, meta) {
  if (!token()) return;
  try {
    await platformApi("/api/experiences", {
      method: "POST",
      body: JSON.stringify({ app: contract.id, name: meta.name, framework: meta.framework, intents: state.intents, surface: state.surface }),
    });
    audit(`experience <b>${meta.name}</b> saved to your cloud account`);
    renderExperiences();
  } catch (err) {
    audit(`cloud save failed: ${err.message}`);
  }
}

async function renderExperiences() {
  const list = $("exp-list");
  const empty = $("exp-empty");
  list.innerHTML = "";
  if (!token()) { empty.style.display = "block"; return; }
  try {
    const items = await platformApi(`/api/experiences?app=${encodeURIComponent(contract.id)}`);
    empty.style.display = items.length ? "none" : "block";
    if (!items.length) { empty.textContent = "No saved experiences yet - rebuild your interface to create one."; return; }
    items.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    for (const e of items) {
      const row = document.createElement("div");
      row.className = "exp-row";
      row.innerHTML = `<span><b></b><small></small></span><button class="ghost small">Apply</button>`;
      row.querySelector("b").textContent = e.name;
      row.querySelector("small").textContent = ` ${e.framework} · ${e.intents.length} intent${e.intents.length > 1 ? "s" : ""}`;
      row.querySelector("button").onclick = async () => {
        try {
          setStatus(`applying “${e.name}” from your cloud…`, "working");
          const full = await platformApi(`/api/experiences/${e.id}`);
          const { meta } = await activate(full.surface);
          store.save(currentUser, { intents: full.intents, surface: full.surface });
          renderSpec();
          setStatus(`activated “${meta.name}” (from your cloud account)`, "ok");
          audit(`applied cloud experience <b>${e.name}</b>`);
        } catch (err) {
          setStatus(`rejected: ${err.message}`, "err");
        }
      };
      list.appendChild(row);
    }
  } catch (err) {
    empty.style.display = "block";
    empty.textContent = `platform unreachable: ${err.message}`;
  }
}

function renderAccount() {
  const box = $("account");
  box.innerHTML = "";
  if (token()) {
    const out = document.createElement("button");
    out.className = "ghost";
    out.textContent = `${accountEmail()} · sign out`;
    out.onclick = () => {
      platformApi("/api/auth/logout", { method: "POST" }).catch(() => {}); // kill the session server-side
      localStorage.removeItem("manyshape:token");
      localStorage.removeItem("manyshape:email");
      renderAccount(); renderExperiences();
      audit("signed out of Manyshape account");
    };
    box.appendChild(out);
  } else {
    const email = document.createElement("input");
    email.type = "email";
    email.placeholder = "you@email.com";
    const pw = document.createElement("input");
    pw.type = "password";
    pw.placeholder = "password";
    const btn = document.createElement("button");
    btn.className = "ghost";
    btn.textContent = "Sign in";
    btn.onclick = async () => {
      try {
        const { token: t, email: em } = await platformApi("/api/auth/login", { method: "POST", body: JSON.stringify({ email: email.value, password: pw.value }) });
        localStorage.setItem("manyshape:token", t);
        localStorage.setItem("manyshape:email", em);
        renderAccount();
        renderExperiences();
        audit(`signed in as <b>${em}</b> - experiences sync to the cloud`);
      } catch (err) {
        audit(`sign in failed: ${err.message} (create accounts at <a href="http://localhost:8600" target="_blank">the platform</a>)`);
      }
    };
    box.append(email, pw, btn);
  }
}

// ------------------------------------------------------------------- boot
async function boot() {
  const [contractRes, sdkRes] = await Promise.all([fetch("/api/contract"), fetch("/guest-sdk.js")]);
  ({ contract, referenceSurface } = await contractRes.json());
  guestSdk = await sdkRes.text();
  $("contract-version").textContent = `v${contract.version}`;

  $("user").addEventListener("change", async (e) => {
    currentUser = e.target.value;
    setStatus("");
    await showUserSurface();
  });

  $("intent-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("intent").value.trim();
    if (!text) return;
    $("intent").value = "";
    onIntent(text);
  });

  $("revert").addEventListener("click", async () => {
    store.save(currentUser, { intents: [], surface: null });
    setStatus("reset to vendor reference surface", "ok");
    audit(`<b>${currentUser}</b> reset to reference surface`);
    await showUserSurface();
  });

  renderAccount();
  renderExperiences();
  await showUserSurface();
}

boot();
