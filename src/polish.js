const JOINTS = ["LowerTorso", "UpperTorso", "Head", "RightUpperArm", "RightLowerArm", "RightHand", "LeftUpperArm", "LeftLowerArm", "LeftHand", "RightUpperLeg", "RightLowerLeg", "RightFoot", "LeftUpperLeg", "LeftLowerLeg", "LeftFoot"];
const kind = (j) => j.replace(/^(Right|Left)/, "");

// Degrees [min,max] per axis (x,y,z). Keeps the AI inside human-ish limits.
const LIMITS = {
  LowerTorso: [[-30, 30], [-70, 70], [-20, 20]],
  UpperTorso: [[-35, 25], [-60, 60], [-25, 25]],
  Head: [[-40, 35], [-70, 70], [-30, 30]],
  UpperArm: [[-70, 180], [-100, 100], [-170, 170]],
  LowerArm: [[0, 145], [-40, 40], [-10, 10]],
  Hand: [[-60, 60], [-60, 60], [-60, 60]],
  UpperLeg: [[-110, 100], [-50, 50], [-50, 50]],
  LowerLeg: [[-145, 5], [-5, 5], [-5, 5]],
  Foot: [[-45, 45], [-20, 20], [-15, 15]],
};

// Overlapping action: outer joints trail the hips by a few frames.
const LAG = { UpperTorso: 0.02, Head: 0.05, UpperArm: 0.01, LowerArm: 0.03, Hand: 0.06, LowerLeg: 0.02, Foot: 0.03 };

const EASES = ["in", "out", "inout", "linear"];
const num = (v) => (Number.isFinite(+v) ? +v : 0);
const clamp = (v, a, b) => Math.min(b, Math.max(a, num(v)));
const r3 = (n) => Math.round(n * 1000) / 1000;

export function polish(raw) {
  if (!raw || !Array.isArray(raw.keys) || raw.keys.length < 2) throw new Error("The model returned too few keys");

  const keys = raw.keys
    .map((k) => ({ t: clamp(k.t, 0, 6), e: EASES.includes(k.ease) ? k.ease : "inout", pose: k.pose && typeof k.pose === "object" ? k.pose : {} }))
    .sort((a, b) => a.t - b.t);
  keys[0].t = 0;
  const duration = Math.max(0.2, keys.at(-1).t);

  const state = {};
  for (const j of JOINTS) state[j] = { r: [0, 0, 0], p: [0, 0, 0] };
  const tracks = {};

  for (const k of keys) {
    for (const [j, v] of Object.entries(k.pose)) {
      if (!JOINTS.includes(j) || !v) continue;
      const lim = LIMITS[kind(j)];
      if (Array.isArray(v.r)) state[j].r = [0, 1, 2].map((i) => clamp(v.r[i], lim[i][0], lim[i][1]));
      if (j === "LowerTorso" && Array.isArray(v.p)) state[j].p = [0, 1, 2].map((i) => clamp(v.p[i], -4, 4));
      const key = { t: k.t, r: [...state[j].r], e: k.e };
      if (j === "LowerTorso") key.p = [...state[j].p];
      (tracks[j] ??= []).push(key);
    }
  }

  for (const [j, tr] of Object.entries(tracks)) {
    // every animated joint starts at t=0 and ends at the full duration
    if (tr[0].t > 0) tr.unshift({ t: 0, r: [0, 0, 0], e: "linear", ...(j === "LowerTorso" ? { p: [0, 0, 0] } : {}) });
    const last = tr.at(-1);
    if (last.t < duration) tr.push({ ...structuredClone(last), t: duration, e: "linear" });

    const lag = LAG[kind(j)] ?? 0;
    const out = [tr[0]];
    for (let i = 1; i < tr.length; i++) {
      const x = { ...tr[i], t: Math.min(duration, tr[i].t + lag) };
      const prev = out.at(-1);
      if (x.t > prev.t + 0.009) out.push(x);
      else if (i === tr.length - 1) out[out.length - 1] = { ...x, t: prev.t };
    }
    for (const k of out) {
      k.t = r3(k.t);
      k.r = k.r.map(r3);
      if (k.p) k.p = k.p.map(r3);
    }
    tracks[j] = out;
  }

  const name = String(raw.name || "Combat").replace(/[^\w ]/g, "").trim().slice(0, 40) || "Combat";
  return { name, duration: r3(duration), loop: !!raw.loop, tracks };
}
