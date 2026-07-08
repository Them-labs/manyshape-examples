// Manyshape MVP - authority plane + agent service + runtime host.
// The authority plane is deliberately boring: in-memory data behind
// @manyshape/sdk's capability router. Everything interesting about the
// architecture is that surfaces can ONLY get here through those endpoints.

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { MongoClient } from "mongodb";
import { createAgent, finalizeSurface } from "@manyshape/agent";
import { validateContract, createAuthorityRouter, CapError } from "@manyshape/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const surfaceSdkDir = path.join(here, "../packages/surface-sdk");
const app = express();
app.use(express.json({ limit: "1mb" }));

// Load mvp/.env if present (KEY=value lines; real env vars win).
try {
  for (const line of fs.readFileSync(path.join(here, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* no .env - fine */ }

// ----------------------------------------------------------- contract plane
const contract = JSON.parse(fs.readFileSync(path.join(here, "contract/mail.contract.json"), "utf8"));
const contractErrors = validateContract(contract);
if (contractErrors.length) {
  console.error("contract invalid:\n" + contractErrors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}

const referenceSurface = fs.readFileSync(path.join(here, "contract/reference-surface.html"), "utf8");
const fallbackSurfaces = {
  kanban: fs.readFileSync(path.join(here, "contract/surfaces/kanban.html"), "utf8"),
  calendar: fs.readFileSync(path.join(here, "contract/surfaces/calendar.html"), "utf8"),
  // Transpile the React surface's JSX at load - the browser can't run
  // <script type="text/jsx"> directly (the agent path does this per-generation).
  kanbanReact: finalizeSurface(fs.readFileSync(path.join(here, "contract/surfaces/kanban-react.html"), "utf8")),
};

// In-sandbox SDK assets: the vanilla guest SDK, and the React runtime
// (Preact + compat + useCap) bundled once at boot and inlined per-surface.
const guestSdk = fs.readFileSync(path.join(surfaceSdkDir, "guest-sdk.js"), "utf8");
const reactRuntime = (await esbuild.build({
  entryPoints: [path.join(surfaceSdkDir, "react-entry.js")],
  bundle: true,
  write: false,
  format: "iife",
  minify: true,
  target: ["es2018"],
})).outputFiles[0].text;

// ---------------------------------------------------------------- mail data
// The vendor's data lives in its own MongoDB (MONGODB_URI, db manyshape-mail).
// Seeded on first boot; set RESEED=1 to reset the demo mailboxes.
const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const daysAhead = (d, hour = 18) => {
  const dt = new Date(Date.now() + d * 86400e3);
  dt.setHours(hour, 0, 0, 0);
  return dt.toISOString();
};

const SEED = [
  { user: "jk", id: "t1", sender: "Sarah Lin", subject: "Contract redline - round 2", snippet: "Attached the revised terms, main change is in §4…", receivedAt: hoursAgo(52), eventDate: null, category: "legal", state: "inbox", awaitingReply: true, snoozedUntil: null },
  { user: "jk", id: "t2", sender: "YC Admissions", subject: "Interview scheduling", snippet: "Congrats! Pick a slot for your interview…", receivedAt: hoursAgo(1), eventDate: daysAhead(3, 14), category: "work", state: "inbox", awaitingReply: false, snoozedUntil: null },
  { user: "jk", id: "t3", sender: "Legal Ops", subject: "NDA countersign needed", snippet: "Waiting on your signature to close this out…", receivedAt: hoursAgo(4), eventDate: null, category: "legal", state: "inbox", awaitingReply: true, snoozedUntil: null },
  { user: "jk", id: "t4", sender: "Ravi Patel", subject: "Pricing question from Acme", snippet: "They're asking about volume discounts on the…", receivedAt: hoursAgo(3), eventDate: null, category: "work", state: "inbox", awaitingReply: false, snoozedUntil: null },
  { user: "jk", id: "t5", sender: "Dana (recruiter)", subject: "Staff eng candidate - feedback?", snippet: "Panel wrapped yesterday, need your scores by…", receivedAt: hoursAgo(26), eventDate: null, category: "recruiting", state: "inbox", awaitingReply: true, snoozedUntil: null },
  { user: "jk", id: "t6", sender: "Board Ops", subject: "Board update sent ✓", snippet: "Thanks, deck looks great. See you Thursday…", receivedAt: hoursAgo(7), eventDate: daysAhead(2, 10), category: "work", state: "archived", awaitingReply: false, snoozedUntil: null },
  { user: "jk", id: "t7", sender: "SaaS Weekly", subject: "10 growth tactics you're ignoring", snippet: "This week's roundup features…", receivedAt: hoursAgo(9), eventDate: null, category: "promo", state: "inbox", awaitingReply: false, snoozedUntil: null },
  { user: "maya", id: "m1", sender: "Robotics Club", subject: "Tuesday build night", snippet: "We're finishing the drivetrain, bring your…", receivedAt: hoursAgo(20), eventDate: daysAhead(1, 18), category: "club", state: "inbox", awaitingReply: false, snoozedUntil: null },
  { user: "maya", id: "m2", sender: "CS 189 Staff", subject: "Problem set 4 due Wednesday", snippet: "Reminder: pset 4 covers kernels and…", receivedAt: hoursAgo(30), eventDate: daysAhead(2, 23), category: "class", state: "inbox", awaitingReply: false, snoozedUntil: null },
  { user: "maya", id: "m3", sender: "Career Center", subject: "Career fair RSVP closes soon", snippet: "200+ companies. RSVP by Wednesday to…", receivedAt: hoursAgo(50), eventDate: daysAhead(2, 12), category: "career", state: "inbox", awaitingReply: false, snoozedUntil: null },
  { user: "maya", id: "m4", sender: "Hackathon Team", subject: "Kickoff Thursday!", snippet: "We got a table! Kickoff is Thursday at…", receivedAt: hoursAgo(6), eventDate: daysAhead(3, 17), category: "club", state: "inbox", awaitingReply: true, snoozedUntil: null },
  { user: "maya", id: "m5", sender: "Prof. Okafor", subject: "Office hours question", snippet: "Good question - come by Thursday and we…", receivedAt: hoursAgo(70), eventDate: null, category: "class", state: "inbox", awaitingReply: true, snoozedUntil: null },
  { user: "maya", id: "m6", sender: "Campus Dining", subject: "New menu this week 🍜", snippet: "Ramen bar opens Monday in the west…", receivedAt: hoursAgo(12), eventDate: null, category: "promo", state: "inbox", awaitingReply: false, snoozedUntil: null },
];
const APP_USERS = new Set(SEED.map((t) => t.user));

const mongo = new MongoClient(process.env.MONGODB_URI || "mongodb://localhost:27017");
await mongo.connect();
const Threads = mongo.db(process.env.MONGODB_DB || "manyshape-mail").collection("threads");
await Threads.createIndex({ user: 1, id: 1 }, { unique: true });
if (process.env.RESEED) await Threads.deleteMany({});
if ((await Threads.countDocuments()) === 0) {
  await Threads.insertMany(SEED.map((t) => ({ ...t })));
  console.log(`seeded ${SEED.length} threads into MongoDB (${Threads.dbName ?? "manyshape-mail"})`);
}
const noMongoId = { projection: { _id: 0, user: 0 } };

// -------------------------------------------------- authority plane (caps)
const mustMatch = (r) => {
  if (!r.matchedCount) throw new CapError(404, "no such thread");
  return { ok: true };
};

app.use("/api/cap", createAuthorityRouter({
  contract,
  // Demo-grade identity: a self-asserted header. Replace with real sessions
  // before anything internet-facing (see mvp/README.md, known shortcuts).
  getUser: (req) => {
    const user = req.header("x-facet-user");
    return APP_USERS.has(user) ? user : null;
  },
  handlers: {
    "mail.query": async ({ user }, args) => {
      // Wake snoozed threads whose time has passed.
      await Threads.updateMany(
        { user, state: "snoozed", snoozedUntil: { $lt: new Date().toISOString() } },
        { $set: { state: "inbox", snoozedUntil: null } }
      );
      const f = args.filter ?? "all";
      const q =
        f === "all" ? { user }
        : f === "awaiting_reply" ? { user, state: "inbox", awaitingReply: true }
        : { user, state: f };
      return await Threads.find(q, noMongoId).sort({ receivedAt: -1 }).toArray();
    },
    "mail.archive": async ({ user }, { threadId }) =>
      mustMatch(await Threads.updateOne({ user, id: threadId }, { $set: { state: "archived" } })),
    "mail.unarchive": async ({ user }, { threadId }) =>
      mustMatch(await Threads.updateOne({ user, id: threadId }, { $set: { state: "inbox" } })),
    "mail.snooze": async ({ user }, { threadId, until }) => {
      if (typeof until !== "string" || isNaN(Date.parse(until))) throw new CapError(400, "snooze requires an ISO `until`");
      return mustMatch(await Threads.updateOne({ user, id: threadId }, { $set: { state: "snoozed", snoozedUntil: until } }));
    },
    "mail.send": async ({ user }, { threadId }) =>
      mustMatch(await Threads.updateOne({ user, id: threadId }, { $set: { awaitingReply: false } })),
  },
}));

// --------------------------------------------------------- contract + SDKs
app.get("/api/contract", (_req, res) => {
  res.json({ contract, referenceSurface });
});
app.get("/guest-sdk.js", (_req, res) => {
  res.type("application/javascript").send(guestSdk);
});
app.get("/react-runtime.js", (_req, res) => {
  res.type("application/javascript").send(reactRuntime);
});
app.get("/chat-sdk.js", (_req, res) => {
  res.type("application/javascript").send(fs.readFileSync(path.join(here, "../packages/chat-sdk/chat-sdk.js"), "utf8"));
});

// ------------------------------------------------------------------ agent
// Shared implementation from @manyshape/agent (same one the platform hosts).
// Credentials: GEMINI_API_KEY / GOOGLE_API_KEY, else Anthropic, else null.
const agent = createAgent();
const agentModel = agent?.model ?? null;

app.post("/api/agent", async (req, res) => {
  const { user, intents, currentSurface, framework } = req.body ?? {};
  if (!Array.isArray(intents) || intents.length === 0) {
    return res.status(400).json({ error: "intents[] required" });
  }

  if (!agentModel) {
    const surface = pickFallback(intents, framework);
    return res.json({ surface, source: "fallback", note: "No GEMINI_API_KEY or ANTHROPIC_API_KEY set - served a canned surface matched by keyword." });
  }

  try {
    const surface = await agent.generate({ contract, referenceSurface, currentSurface, intents, user, framework });
    return res.json({ surface, source: agentModel });
  } catch (err) {
    console.error("agent error:", err.message);
    const surface = pickFallback(intents, framework);
    return res.json({ surface, source: "fallback", note: `Agent call failed (${err.message}) - served a canned surface.` });
  }
});

function pickFallback(intents, framework) {
  const text = intents.join(" ").toLowerCase();
  // React demo: always return a React surface so the framework is visible offline.
  if (framework === "react") return fallbackSurfaces.kanbanReact;
  if (/kanban|task|board|todo|to-do/.test(text)) return fallbackSurfaces.kanban;
  if (/calendar|event|schedule|agenda/.test(text)) return fallbackSurfaces.calendar;
  return referenceSurface;
}

// Starter surface for a fresh demo, per framework (so the React demo opens on React).
app.get("/api/starter/:fw", (req, res) => {
  res.json({ surface: req.params.fw === "react" ? fallbackSurfaces.kanbanReact : referenceSurface });
});

// ------------------------------------------------------------------ static
app.use(express.static(path.join(here, "runtime")));

const port = process.env.PORT || 8484;
app.listen(port, async () => {
  console.log(`Manyshape runtime on http://localhost:${port} (agent: ${agentModel ?? "fallback mode - set GEMINI_API_KEY or ANTHROPIC_API_KEY for live generation"})`);

  // Publish this app's contract to the registry so the extension (and any
  // other client) can resolve "does this origin speak Manyshape?".
  const platform = process.env.PLATFORM_URL || "http://localhost:8600";
  const publicOrigin = process.env.PUBLIC_ORIGIN || `http://localhost:${port}`;
  try {
    await fetch(`${platform}/api/registry/contracts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contract,
        origins: [publicOrigin, `http://localhost:${port}`],
        contractUrl: `${publicOrigin}/api/contract`,
        capBase: `${publicOrigin}/api/cap`,
      }),
    });
    console.log(`contract ${contract.id}@${contract.version} published to registry at ${platform}`);
  } catch {
    console.log(`registry not reachable at ${platform} - publish skipped`);
  }
});
