import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import { SYSTEM } from "./src/prompt.js";
import { polish } from "./src/polish.js";

for (const k of ["GEMINI_API_KEY", "MONGODB_URI"]) if (!process.env[k]) throw new Error(`Missing ${k} in environment`);

const mongo = new MongoClient(process.env.MONGODB_URI);
await mongo.connect();
const db = mongo.db(process.env.MONGODB_DB || "animator");
const animations = db.collection("animations");
const sessions = db.collection("sessions");
await sessions.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 });
await sessions.createIndex({ code: 1 });
await sessions.createIndex({ key: 1 });

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(express.static("public"));
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: e.message }); });

// ---- Gemini ----
async function askGemini(user) {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.7 },
    }),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  return JSON.parse(text.replace(/^```json|```$/g, "").trim());
}

// ---- simple per-IP rate limit (20 generations / minute) ----
const hits = new Map();
const limited = (ip) => {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 20;
};

app.post("/api/generate", wrap(async (req, res) => {
  const { prompt, previousId } = req.body ?? {};
  if (typeof prompt !== "string" || prompt.trim().length < 3 || prompt.length > 500) return res.status(400).json({ error: "Prompt must be 3 to 500 characters." });
  if (limited(req.ip)) return res.status(429).json({ error: "Too many requests. Wait a minute." });

  let user = `Create a combat animation: ${prompt.trim()}`;
  if (previousId && ObjectId.isValid(previousId)) {
    const prev = await animations.findOne({ _id: new ObjectId(previousId) });
    if (prev) user = `Revise this animation. Keep what works, change only what the instruction asks.\nCurrent animation:\n${JSON.stringify(prev.raw)}\nInstruction: ${prompt.trim()}`;
  }
  const raw = await askGemini(user);
  const anim = polish(raw);
  const { insertedId } = await animations.insertOne({ prompt, raw, anim, createdAt: new Date() });
  res.json({ id: insertedId.toString(), anim });
}));

// ---- Studio pairing: web holds session id, plugin enters the short code ----
app.post("/api/session", wrap(async (_req, res) => {
  const id = crypto.randomBytes(12).toString("hex");
  const code = Array.from(crypto.randomBytes(6), (b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
  await sessions.insertOne({ _id: id, code, key: crypto.randomBytes(24).toString("hex"), claimed: false, queue: [], createdAt: new Date() });
  res.json({ id, code });
}));

app.get("/api/session/:id", wrap(async (req, res) => {
  const s = await sessions.findOne({ _id: req.params.id });
  if (!s) return res.status(404).json({ error: "Session expired" });
  res.json({ code: s.code, claimed: s.claimed });
}));

app.post("/api/session/:id/send", wrap(async (req, res) => {
  const { animId } = req.body ?? {};
  if (!ObjectId.isValid(animId)) return res.status(400).json({ error: "Bad animation id" });
  const a = await animations.findOne({ _id: new ObjectId(animId) });
  if (!a) return res.status(404).json({ error: "Animation not found" });
  const r = await sessions.updateOne({ _id: req.params.id, claimed: true }, { $push: { queue: a.anim } });
  if (!r.matchedCount) return res.status(409).json({ error: "Studio is not linked yet." });
  res.json({ ok: true });
}));

app.post("/api/plugin/claim", wrap(async (req, res) => {
  const code = String(req.body?.code ?? "").toUpperCase().trim();
  const s = await sessions.findOneAndUpdate({ code, claimed: false }, { $set: { claimed: true } });
  if (!s) return res.status(404).json({ error: "Code not found or already used." });
  res.json({ key: s.key });
}));

app.get("/api/plugin/poll", wrap(async (req, res) => {
  const s = await sessions.findOneAndUpdate({ key: String(req.query.key ?? "") }, { $pop: { queue: -1 } }, { returnDocument: "before" });
  if (!s) return res.status(401).json({ error: "Not linked" });
  res.json({ anim: s.queue?.[0] ?? null });
}));

app.listen(process.env.PORT || 3000, () => console.log("Animator running on port", process.env.PORT || 3000));
