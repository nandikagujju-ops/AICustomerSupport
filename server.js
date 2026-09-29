// LifeMind backend: Express + SQLite. Run: npm install && npm start
const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");
try { process.loadEnvFile(path.join(__dirname, ".env")); } catch {}

const db = new Database(path.join(__dirname, "lifemind.db"));
db.exec("CREATE TABLE IF NOT EXISTS memory(user TEXT PRIMARY KEY, data TEXT NOT NULL, updated TEXT NOT NULL)");

const app = express();
app.use(express.json({ limit: "12mb" }));

const validUser = (req, res, next) =>
  /^[A-Za-z0-9-]{8,64}$/.test(req.params.user) ? next() : res.status(400).json({ error: "bad user id" });

app.get("/api/memory/:user", validUser, (req, res) => {
  const row = db.prepare("SELECT data FROM memory WHERE user = ?").get(req.params.user);
  row ? res.json(JSON.parse(row.data)) : res.status(404).json({ error: "no memory yet" });
});

app.put("/api/memory/:user", validUser, (req, res) => {
  db.prepare(`INSERT INTO memory(user,data,updated) VALUES(?,?,?)
    ON CONFLICT(user) DO UPDATE SET data=excluded.data, updated=excluded.updated`)
    .run(req.params.user, JSON.stringify(req.body), new Date().toISOString());
  res.json({ ok: true });
});

app.delete("/api/memory/:user", validUser, (req, res) => {
  db.prepare("DELETE FROM memory WHERE user = ?").run(req.params.user);
  res.json({ ok: true });
});


// ---- Azure OpenAI helper (set the 3 variables in .env) ----
const azureReady = () => process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_KEY && process.env.AZURE_OPENAI_DEPLOYMENT;
async function llm(messages, max = 500) {
  const url = `${process.env.AZURE_OPENAI_ENDPOINT.replace(/\/$/, "")}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2024-06-01`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": process.env.AZURE_OPENAI_KEY },
    body: JSON.stringify({ messages, max_tokens: max, temperature: 0.3 }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || "Azure OpenAI error");
  return j.choices[0].message.content;
}
const LANGS = { en: "English", hi: "Hindi", te: "Telugu" };

// Chat that reads the user's saved memory
app.post("/api/chat", async (req, res) => {
  const { message, lang, memory } = req.body || {};
  if (!message) return res.status(400).json({ error: "message required" });
  if (!azureReady()) return res.json({ reply: "Azure OpenAI is not set up yet. Copy .env.example to .env, add your endpoint, key and deployment name, then restart the server." });
  try {
    const system = `You are LifeMind, a warm assistant for everyday life (home devices, bills, health and life admin). Answer ONLY from the memory JSON below. Never suggest a fix marked "failed". If memory has no answer, say so and suggest a sensible next step. Reply in ${LANGS[lang] || "English"}, under 120 words, plain language.\nMEMORY:\n${JSON.stringify(memory || {}).slice(0, 12000)}`;
    res.json({ reply: await llm([{ role: "system", content: system }, { role: "user", content: message }]) });
  } catch (e) { res.json({ reply: "Sorry, the AI service failed: " + e.message }); }
});

// Read a bill photo
app.post("/api/scan", async (req, res) => {
  if (!azureReady()) return res.json({ error: "Set up Azure OpenAI (see .env.example) to scan photos." });
  try {
    const text = await llm([{ role: "user", content: [
      { type: "text", text: 'Read this bill. Reply ONLY with JSON: {"biller":string,"ref":string,"amount":number,"days":number|null} where days is days allowed to pay.' },
      { type: "image_url", image_url: { url: req.body.image } }] }], 200);
    res.json(JSON.parse(text.match(/\{[\s\S]*\}/)[0]));
  } catch (e) { res.json({ error: "Could not read the photo: " + e.message }); }
});

// Simple login: name + PIN -> stable private id. Same name+PIN on another device (or a family member) = same memory.
app.post("/api/login", (req, res) => {
  const { name, pin } = req.body || {};
  if (!name || !pin || String(pin).length < 4) return res.status(400).json({ error: "name and 4+ digit PIN required" });
  res.json({ uid: crypto.scryptSync(String(pin), "lifemind:" + String(name).trim().toLowerCase(), 16).toString("hex") });
});

app.use(express.static(path.join(__dirname, "public")));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LifeMind running at http://localhost:${PORT}`));
