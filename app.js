/* Réviseur de QCM — vanilla JS, no build step, no network. State in localStorage. */
(() => {
"use strict";

const KEY = "reviseur-qcm.v1";
const SEEDED = "reviseur-qcm.seeded";
/* Dotation de départ : la liste vit dans exemples/index.json, pour n'avoir qu'un seul endroit à tenir à jour. */
const SEED_INDEX = "exemples/index.json";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const letter = (i) => String.fromCharCode(65 + i);
const uid = () => "q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const isDesktop = () => window.matchMedia("(min-width:900px)").matches;

const PROMPT = "« Génère un QCM de 10 questions sur [thème], au format JSON du réviseur : titre, matiere, questions[] avec enonce, propositions[], reponses[] en index, explication, theme. »";
const MODEL = `{
  "titre": "Restructurations — QCM 1",
  "matiere": "Fusion / Consolidation",
  "questions": [
    {
      "enonce": "…",
      "propositions": ["…", "…", "…"],
      "reponses": [0],
      "explication": "…",
      "theme": "…"
    }
  ]
}`;

/* ── State ──────────────────────────────────────────────────────── */
let db = { quizzes: [], settings: { correction: true, shuffle: true, swipe: true, size: "M" } };
let ui = { view: "home", sheet: null, quizId: null, pending: null, launch: { exam: false, shuffle: true, missedOnly: false }, detail: null };
let ses = null;

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (raw && Array.isArray(raw.quizzes)) db = Object.assign(db, raw, { settings: Object.assign(db.settings, raw.settings) });
  } catch (_) { /* corrupt payload: start clean */ }
}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (_) {} };
const quiz = (id) => db.quizzes.find((q) => q.id === id) || null;

/* Dotation de départ : au tout premier lancement seulement, et jamais après un effacement volontaire. */
async function seed() {
  if (db.quizzes.length || localStorage.getItem(SEEDED)) return;
  let files = [];
  try {
    const r = await fetch(SEED_INDEX);
    if (r.ok) files = JSON.parse(await r.text());
  } catch (_) { /* pas de manifeste, ou app ouverte sans serveur */ }
  if (!Array.isArray(files) || !files.length) return;
  const loaded = [];
  for (const name of files) {
    const path = "exemples/" + encodeURIComponent(String(name));
    try {
      const r = await fetch(path);
      if (r.ok) loaded.push(...readPayload(await r.text(), String(name)));
      else console.warn("[QCM] exemple introuvable :", path, r.status);
    } catch (e) { console.warn("[QCM] exemple illisible :", path, e.message); }
  }
  if (!loaded.length) return;
  db.quizzes = loaded.map(({ skipped, ...q }) => q);
  try { localStorage.setItem(SEEDED, "1"); } catch (_) {}
  save();
  render();
}

/* ── Import: tolerant parsing of Claude output ──────────────────── */
function stripFence(text) {
  const m = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : text).trim();
}
function firstJson(text) {
  const t = stripFence(text);
  try { return JSON.parse(t); } catch (_) {}
  const a = t.search(/[[{]/);
  if (a < 0) throw new Error("Aucun JSON trouvé dans le fichier.");
  for (let b = t.length; b > a; b--) {
    const slice = t.slice(a, b);
    if (!/[\]}]$/.test(slice.trim())) continue;
    try { return JSON.parse(slice.trim()); } catch (_) {}
  }
  throw new Error("JSON illisible — vérifie les virgules et les guillemets.");
}
const pickKey = (o, keys) => { for (const k of keys) if (o[k] != null) return o[k]; return undefined; };

function normQuestion(raw) {
  if (!raw || typeof raw !== "object") return null;
  const enonce = pickKey(raw, ["enonce", "énoncé", "question", "intitule", "intitulé", "prompt"]);
  let props = pickKey(raw, ["propositions", "options", "choix", "choices", "answers", "reponses_possibles"]);
  let reps = pickKey(raw, ["reponses", "réponses", "reponse", "correct", "correctAnswers", "answer", "solution", "bonnes_reponses"]);
  if (!enonce || !Array.isArray(props) || props.length < 2) return null;
  props = props.map((p) => (p && typeof p === "object" ? String(pickKey(p, ["texte", "text", "label", "value"]) ?? "") : String(p)));
  if (reps == null && Array.isArray(pickKey(raw, ["propositions", "options"]))) {
    const flagged = (pickKey(raw, ["propositions", "options"]) || [])
      .map((p, i) => (p && typeof p === "object" && (p.correct || p.juste || p.isCorrect) ? i : -1)).filter((i) => i >= 0);
    if (flagged.length) reps = flagged;
  }
  if (reps == null) return null;
  if (!Array.isArray(reps)) reps = [reps];
  const rep = reps.map((r) => {
    if (typeof r === "number") return r;
    const s = String(r).trim();
    if (/^[A-Za-z]$/.test(s)) return s.toUpperCase().charCodeAt(0) - 65;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    const hit = props.findIndex((p) => p.trim().toLowerCase() === s.toLowerCase());
    return hit >= 0 ? hit : -1;
  }).filter((i) => i >= 0 && i < props.length);
  if (!rep.length) return null;
  return {
    enonce: String(enonce),
    props,
    rep: [...new Set(rep)].sort((a, b) => a - b),
    expl: String(pickKey(raw, ["explication", "explanation", "correction", "justification"]) ?? ""),
    theme: String(pickKey(raw, ["theme", "thème", "chapitre", "topic"]) ?? "")
  };
}

function normQuiz(raw, fallbackName) {
  if (Array.isArray(raw)) raw = { questions: raw };
  if (!raw || typeof raw !== "object") return null;
  const list = pickKey(raw, ["questions", "items", "qcm", "cards"]) || [];
  if (!Array.isArray(list)) return null;
  const questions = [];
  let skipped = 0;
  list.forEach((q) => { const n = normQuestion(q); if (n) questions.push(n); else skipped++; });
  if (!questions.length) return null;
  return {
    id: uid(),
    titre: String(pickKey(raw, ["titre", "title", "nom", "name"]) ?? fallbackName ?? "QCM importé"),
    matiere: String(pickKey(raw, ["matiere", "matière", "subject", "cours", "module"]) ?? "Sans matière"),
    questions, best: null, history: [], missed: [], skipped
  };
}

function readPayload(text, fileName) {
  const data = firstJson(text);
  const base = (fileName || "").replace(/\.json$/i, "");
  const many = Array.isArray(data) && data.some((d) => d && (d.questions || d.items))
    ? data : (data && Array.isArray(data.qcms) ? data.qcms : null);
  const quizzes = (many || [data]).map((d, i) => normQuiz(d, many ? base + " " + (i + 1) : base)).filter(Boolean);
  if (!quizzes.length) throw new Error("Aucune question exploitable : il faut un énoncé, au moins deux propositions et la bonne réponse.");
  return quizzes;
}

async function ingestFiles(files) {
  const out = []; const errs = [];
  for (const f of files) {
    try { out.push(...readPayload(await f.text(), f.name)); }
    catch (e) { errs.push(f.name + " — " + e.message); }
  }
  ui.pending = out.length ? { quizzes: out, errors: errs } : { quizzes: [], errors: errs.length ? errs : ["Fichier vide."] };
  ui.sheet = "import";
  render();
}

/* ── Session ────────────────────────────────────────────────────── */
const shuffled = (n) => { const a = [...Array(n).keys()]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function startSession(q, opt) {
  let order = opt.missedOnly && q.missed.length ? [...q.missed] : [...Array(q.questions.length).keys()];
  if (opt.shuffle) order = shuffled(order.length).map((i) => order[i]);
  ses = { quizId: q.id, order, i: 0, exam: !!opt.exam, shuffle: !!opt.shuffle, picks: [], validated: false, results: [] };
  ui.view = "session"; ui.sheet = null; ui.detail = null;
  render();
}

const current = () => { const q = quiz(ses.quizId); return q ? q.questions[ses.order[ses.i]] : null; };
const same = (a, b) => a.length === b.length && [...a].sort().every((v, i) => [...b].sort()[i] === v);

function pick(i) {
  if (ses.validated) return;
  const q = current();
  if (q.rep.length > 1) {
    const p = ses.picks.indexOf(i);
    p >= 0 ? ses.picks.splice(p, 1) : ses.picks.push(i);
  } else ses.picks = ses.picks.length === 1 && ses.picks[0] === i ? [] : [i];
  render();
}

function validate() {
  if (!ses.picks.length) return;
  const qi = ses.order[ses.i], q = current(), juste = same(ses.picks, q.rep);
  ses.results = ses.results.filter((r) => r.qi !== qi).concat([{ qi, picks: [...ses.picks], juste }]);
  if (ses.exam || !db.settings.correction) return next();
  ses.validated = true;
  render();
}

function next() {
  if (ses.i >= ses.order.length - 1) return finish();
  ses.i++;
  const prev = ses.results.find((r) => r.qi === ses.order[ses.i]);
  ses.picks = prev ? [...prev.picks] : [];
  ses.validated = !!prev && !ses.exam && db.settings.correction;
  render();
}

function back() {
  if (ses.i === 0) return;
  ses.i--;
  const prev = ses.results.find((r) => r.qi === ses.order[ses.i]);
  ses.picks = prev ? [...prev.picks] : [];
  ses.validated = !!prev && !ses.exam && db.settings.correction;
  render();
}

function finish() {
  const q = quiz(ses.quizId);
  const score = ses.results.filter((r) => r.juste).length, total = ses.order.length, p = pct(score, total);
  q.best = q.best === null ? p : Math.max(q.best, p);
  q.history = [{ date: new Date().toISOString(), score, total }, ...(q.history || [])].slice(0, 20);
  const missed = ses.results.filter((r) => !r.juste).map((r) => r.qi);
  const solved = ses.results.filter((r) => r.juste).map((r) => r.qi);
  q.missed = [...new Set([...(q.missed || []).filter((i) => !solved.includes(i)), ...missed])].sort((a, b) => a - b);
  save();
  ses.validated = false;
  ui.view = "results"; ui.detail = null;
  render();
}

const replayWrong = () => {
  const wrong = ses.results.filter((r) => !r.juste).map((r) => r.qi);
  const q = quiz(ses.quizId);
  if (!wrong.length) return startSession(q, { exam: ses.exam, shuffle: ses.shuffle, missedOnly: false });
  ses = { quizId: q.id, order: wrong, i: 0, exam: ses.exam, shuffle: false, picks: [], validated: false, results: [] };
  ui.view = "session"; ui.detail = null;
  render();
};

/* ── Aggregates ─────────────────────────────────────────────────── */
function overall() {
  let s = 0, t = 0;
  db.quizzes.forEach((q) => (q.history || []).forEach((h) => { s += h.score; t += h.total; }));
  return { played: t, pct: pct(s, t) };
}
function bySubject() {
  const m = new Map();
  db.quizzes.forEach((q) => {
    const e = m.get(q.matiere) || { s: 0, t: 0 };
    (q.history || []).forEach((h) => { e.s += h.score; e.t += h.total; });
    m.set(q.matiere, e);
  });
  return [...m].filter(([, e]) => e.t).map(([nom, e]) => ({ nom, pct: pct(e.s, e.t) }));
}
function recent() {
  const all = [];
  db.quizzes.forEach((q) => (q.history || []).forEach((h) => all.push({ titre: q.titre, ...h })));
  return all.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
}
const when = (iso) => {
  const d = new Date(iso), today = new Date();
  const days = Math.round((today.setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 864e5);
  if (days <= 0) return "Aujourd'hui";
  if (days === 1) return "Hier";
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
};

/* ── Views ──────────────────────────────────────────────────────── */
function ring(value, size = 78) {
  const C = 2 * Math.PI * 34;
  const dash = ((value || 0) / 100) * C;
  return `<div class="ring" style="width:${size}px;height:${size}px">
    <svg viewBox="0 0 78 78" width="${size}" height="${size}" aria-hidden="true">
      <circle cx="39" cy="39" r="34" fill="none" stroke="var(--n-300)" stroke-width="5"></circle>
      <circle cx="39" cy="39" r="34" fill="none" stroke="var(--accent)" stroke-width="5"
        stroke-dasharray="${dash.toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 39 39)"></circle>
    </svg><span>${value === null || value === undefined ? "—" : value + " %"}</span></div>`;
}

function viewHome() {
  if (!db.quizzes.length) {
    return `<div class="screen">
      <div class="hd"><div class="kicker">Réviseur de QCM</div><h1 class="h-xl" style="margin-top:9px">Aucun QCM pour l'instant</h1></div>
      <div class="scroll"><div class="empty">
        <p style="font:400 13.5px/1.6 var(--body);color:var(--n-800);max-width:52ch">Demande un QCM à Claude au format du réviseur, enregistre sa réponse en fichier <b>.json</b>, puis importe-le ici. Tout reste sur cet appareil.</p>
        <div class="prompt">${esc(PROMPT)}</div>
      </div></div>
      <div class="foot">
        <button class="btn" data-act="import">Importer un fichier .json</button>
        <button class="btn btn-ghost" data-act="format">Voir le format attendu</button>
      </div></div>`;
  }
  const cells = db.quizzes.map((q) => {
    const hot = (q.missed || []).length >= 3;
    return `<button class="cell${hot ? " cell-hot" : ""}" data-act="launch" data-id="${q.id}">
      <span><span class="cell-kicker">${esc(hot ? "À reprendre" : q.matiere)}</span><span class="cell-title" style="display:block;margin-top:8px">${esc(q.titre)}</span></span>
      <span class="cell-foot">
        <span class="${q.best === null ? "cell-score-none" : "cell-score"}">${q.best === null ? "jamais joué" : q.best + " %"}</span>
        <span class="cell-sub">${(q.missed || []).length ? (q.missed.length + " à revoir") : (q.questions.length + " quest.")}</span>
      </span></button>`;
  }).join("");
  const o = overall();
  return `<div class="screen">
    <div class="hd"><div class="hd-row">
      <div><div class="kicker">Réviseur de QCM</div><h1 class="h-xl" style="margin-top:9px">Mes QCM</h1></div>
      <span style="font:800 15px/1 var(--head);color:var(--n-700)">${o.played ? o.pct + " %" : "—"}</span>
    </div></div>
    <div class="scroll"><div class="grid">${cells}
      <button class="cell cell-add" data-act="import">+ Importer<br>un fichier .json</button>
    </div><p class="hint" style="padding:18px 20px 26px">Hors-ligne. Les QCM importés restent sur l'appareil.</p></div>
  </div>`;
}

function viewSession() {
  const q = quiz(ses.quizId), cur = current();
  const done = ses.validated;
  const juste = done && same(ses.picks, cur.rep);
  const opts = cur.props.map((t, i) => {
    const picked = ses.picks.includes(i), right = cur.rep.includes(i);
    let cls = "opt";
    if (!done && picked) cls += " is-picked";
    if (done && right) cls += " is-right";
    if (done && picked && !right) cls += " is-wrong";
    return `<button class="${cls}" data-act="pick" data-i="${i}"${done ? " disabled" : ""}>
      <span class="opt-letter">${letter(i)}</span><span class="opt-text">${esc(t)}</span></button>`;
  }).join("");
  const label = !done
    ? (ses.picks.length ? "Valider " + [...ses.picks].sort().map(letter).join(", ") : "Valider")
    : (ses.i >= ses.order.length - 1 ? "Voir mon bilan" : "Question suivante");
  return `<div class="screen">
    <div class="q-top">
      <div class="q-num">${String(ses.i + 1).padStart(2, "0")}</div>
      <div class="q-meta">sur ${String(ses.order.length).padStart(2, "0")}<br>${ses.exam ? "Mode examen" : "Entraînement"}
        <div class="bar" style="margin-top:8px;width:150px;margin-left:auto"><i style="width:${((ses.i + (done ? 1 : 0)) / ses.order.length) * 100}%"></i></div>
      </div>
    </div>
    <div class="scroll" id="swipe">
      <div class="q-body" id="q-body">
        <div class="rule"></div>
        <div class="q-kicker">${esc([cur.theme || q.matiere, cur.rep.length > 1 ? "Plusieurs réponses attendues" : "Une seule réponse"].join(" · "))}</div>
        <h2 class="q-title">${esc(cur.enonce)}</h2>
        <div class="opts">${opts}</div>
        ${done ? `<div class="verdict${juste ? "" : " bad"}"><div class="verdict-t">${juste ? "Bonne réponse" : "Réponse incorrecte"}</div>
          <p>${juste ? "" : "Attendu : " + esc(cur.rep.map((i) => cur.props[i]).join(" ; ")) + ". "}${esc(cur.expl)}</p></div>` : ""}
        ${db.settings.swipe ? `<p class="swipe-hint">${done ? "Glisse vers la gauche pour continuer, vers la droite pour revoir." : "Glisse vers la droite pour revoir la question précédente."}</p>` : ""}
      </div>
    </div>
    <div class="foot">
      <button class="btn${!done && !ses.picks.length ? "" : done ? " btn-ink" : ""}" data-act="${done ? "next" : "validate"}"${!done && !ses.picks.length ? " disabled" : ""}>${label}</button>
      <button class="btn btn-ghost" data-act="home">Arrêter la session</button>
    </div>
  </div>`;
}

function fiche(withDetail) {
  const q = quiz(ses.quizId);
  return ses.results.slice().sort((a, b) => ses.order.indexOf(a.qi) - ses.order.indexOf(b.qi)).map((r) => {
    const qq = q.questions[r.qi], open = ui.detail === r.qi;
    const row = `<button class="tbl-row${r.juste ? "" : " bad"}" data-act="detail" data-i="${r.qi}">
      <span class="tbl-n">${String(ses.order.indexOf(r.qi) + 1).padStart(2, "0")}</span>
      <span class="tbl-q">${esc(qq.enonce)}</span>
      <span class="tbl-s">${r.juste ? "Juste" : "Faux"}</span></button>`;
    if (!withDetail || !open) return row;
    return row + `<div class="detail">
      ${r.juste ? "" : `<div class="mine">Ta réponse : ${esc(r.picks.length ? r.picks.map((i) => qq.props[i]).join(" ; ") : "aucune réponse")}</div>`}
      <div class="good">Bonne réponse : ${esc(qq.rep.map((i) => qq.props[i]).join(" ; "))}</div>
      ${qq.expl ? `<p>${esc(qq.expl)}</p>` : ""}</div>`;
  }).join("");
}

function viewResults() {
  const q = quiz(ses.quizId);
  const score = ses.results.filter((r) => r.juste).length, total = ses.order.length, p = pct(score, total);
  const wrong = ses.results.filter((r) => !r.juste).length;
  const note = p === 100 ? "Sans faute. Chapitre acquis, passe au suivant."
    : p >= 75 ? "Solide. Reprends seulement les questions manquées."
    : p >= 50 ? "La base est là, mais plusieurs notions restent floues : relis le cours avant de rejouer."
    : "Chapitre non acquis. Reprends le support avant de refaire le QCM.";
  return `<div class="screen">
    <div class="banner"><div class="kicker" style="color:#fff">${esc(q.titre)}</div>
      <div class="banner-score"><b>${score} / ${total}</b><span>${p} %</span></div><p>${note}</p></div>
    <div class="scroll">
      <div class="tbl-head"><span>Nº</span><span>${wrong ? wrong + " à revoir" : "Tout est juste"}</span><span>État</span></div>
      ${fiche(true)}
      <p class="hint" style="padding:16px 20px">Touche une ligne pour lire la correction détaillée.</p>
    </div>
    <div class="foot">
      <button class="btn" data-act="replay">${wrong ? "Rejouer mes " + wrong + " erreurs" : "Refaire ce QCM"}</button>
      <button class="btn btn-ghost" data-act="home">Revenir à la liste</button>
    </div>
  </div>`;
}

function viewStats() {
  const o = overall(), subs = bySubject(), hist = recent();
  return `<div class="screen">
    <div class="hd"><div class="kicker">Progression</div>
      <div class="stat-hero"><b>${o.played ? o.pct + " %" : "—"}</b><span>de réussite sur<br>${o.played} questions jouées</span></div></div>
    <div class="scroll">
      <div class="kicker-mute" style="padding:16px 20px 8px">Par matière</div>
      ${subs.length ? subs.map((m) => `<div class="meter"><div class="meter-top"><b>${esc(m.nom)}</b><span>${m.pct} %</span></div>
        <div class="meter-track"><i class="${m.pct < 70 ? "low" : ""}" style="width:${m.pct}%"></i></div></div>`).join("")
      : `<p class="hint" style="padding:0 20px 12px">Aucune session terminée pour l'instant.</p>`}
      <div class="kicker-mute" style="padding:20px 20px 8px;border-top:2px solid var(--ink)">Dernières sessions</div>
      ${hist.map((h) => `<div class="hist"><span>${when(h.date)} · ${esc(h.titre)}</span><b>${h.score} / ${h.total}</b></div>`).join("")}
      <div style="height:24px"></div>
    </div>
    <div class="foot desktop-only"><button class="btn btn-ghost" data-act="home">Revenir à la liste</button></div>
  </div>`;
}

function viewSettings() {
  const s = db.settings;
  return `<div class="screen">
    <div class="hd"><div class="kicker">Réglages</div><h1 class="h-xl" style="margin-top:9px">Comment je révise</h1></div>
    <div class="scroll">
      <button class="check" data-act="set" data-k="correction"><span class="box${s.correction ? " on" : ""}">${s.correction ? "✓" : ""}</span>
        <span><span class="check-t">Correction immédiate</span><span class="check-s">Désactivé = mode examen par défaut</span></span></button>
      <button class="check" data-act="set" data-k="shuffle"><span class="box${s.shuffle ? " on" : ""}">${s.shuffle ? "✓" : ""}</span>
        <span><span class="check-t">Mélanger les questions</span></span></button>
      <button class="check" data-act="set" data-k="swipe"><span class="box${s.swipe ? " on" : ""}">${s.swipe ? "✓" : ""}</span>
        <span><span class="check-t">Glisser pour changer de question</span><span class="check-s">Vers la gauche après validation, vers la droite pour revoir</span></span></button>
      <div style="padding:16px 20px;border-bottom:1px solid var(--n-300)">
        <div class="check-t">Taille du texte</div>
        <div class="seg" style="margin-top:10px">
          ${["S", "M", "L"].map((k, i) => `<button data-act="size" data-k="${k}" class="${s.size === k ? "on" : ""}">${["Compact", "Normal", "Grand"][i]}</button>`).join("")}
        </div>
      </div>
      <button class="row" data-act="export">Exporter tous mes QCM</button>
      <button class="row danger" data-act="wipe">Effacer mes données</button>
      <p class="hint" style="padding:18px 20px">Version 1.0 — aucune donnée ne quitte l'appareil.</p>
    </div>
    <div class="foot desktop-only"><button class="btn btn-ghost" data-act="home">Revenir à la liste</button></div>
  </div>`;
}

/* ── Sheets ─────────────────────────────────────────────────────── */
function sheetImport() {
  const p = ui.pending;
  let readout = "";
  if (p) {
    readout = p.quizzes.map((q) => `<div class="readout"><b>${esc(q.titre)} — ${q.questions.length} question${q.questions.length > 1 ? "s" : ""}</b>
      <span>${esc(q.matiere)}${q.skipped ? " · " + q.skipped + " question(s) ignorée(s) : énoncé, propositions ou bonne réponse manquants" : ""}</span></div>`).join("")
      + p.errors.map((e) => `<div class="readout bad"><b>Non lu</b><span>${esc(e)}</span></div>`).join("");
  }
  return `<div class="sheet-top"><h3 class="h-lg">Importer un QCM</h3><button class="link" data-act="close">Fermer</button></div>
    <p class="lead">Demande le QCM à Claude, enregistre sa réponse en fichier .json, puis dépose-le ici. La lecture est tolérante : blocs de code, un ou plusieurs QCM par fichier.</p>
    <div class="step"><b>01</b><span>Génère le QCM avec la phrase type ci-dessous.</span></div>
    <div class="step"><b>02</b><span>Enregistre la réponse en fichier .json.</span></div>
    <div class="step"><b>03</b><span>Vérifie ce qui a été lu, puis ajoute à ta liste.</span></div>
    <div class="drop" id="drop"><b>Dépose le fichier .json</b><span>Ou parcours tes fichiers — plusieurs QCM dans un même fichier sont acceptés.</span>
      <button class="btn btn-auto" style="margin-top:14px" data-act="browse">Parcourir les fichiers</button></div>
    ${readout}
    ${p && p.quizzes.length ? `<button class="btn btn-ink" style="margin-top:12px" data-act="confirm">Ajouter ${p.quizzes.length > 1 ? "les " + p.quizzes.length + " QCM" : "à ma liste"}</button>` : ""}
    <div class="prompt">${esc(PROMPT)}</div>
    <div class="code">${esc(MODEL)}</div>`;
}

function sheetLaunch() {
  const q = quiz(ui.quizId), l = ui.launch, missed = (q.missed || []).length;
  return `<div style="display:flex;gap:18px;align-items:flex-start">
      <div style="flex:1"><div class="kicker">${esc(q.matiere)}</div><h3 class="h-lg" style="margin-top:9px">${esc(q.titre)}</h3>
        <p class="lead">${q.questions.length} questions${missed ? " · " + missed + " à revoir" : ""}</p></div>
      <div style="flex:0 0 auto">${ring(q.best)}<div class="ring-cap">Meilleur score</div></div>
    </div>
    <button class="check" style="margin-top:18px;border-top:1px solid var(--n-300);padding-left:0;padding-right:0" data-act="opt" data-k="exam">
      <span class="box${l.exam ? " on" : ""}">${l.exam ? "✓" : ""}</span><span><span class="check-t">Mode examen</span><span class="check-s">Aucun retour avant la fin</span></span></button>
    <button class="check" style="padding-left:0;padding-right:0" data-act="opt" data-k="shuffle">
      <span class="box${l.shuffle ? " on" : ""}">${l.shuffle ? "✓" : ""}</span><span><span class="check-t">Mélanger les questions</span></span></button>
    <button class="check" style="padding-left:0;padding-right:0" data-act="opt" data-k="missedOnly"${missed ? "" : " disabled"}>
      <span class="box${l.missedOnly && missed ? " on" : ""}">${l.missedOnly && missed ? "✓" : ""}</span>
      <span><span class="check-t">Ne reprendre que mes questions ratées</span><span class="check-s">${missed ? missed + " question(s) en attente" : "aucune pour l'instant"}</span></span></button>
    <div class="inline">
      <button class="btn btn-auto" data-act="start">${l.missedOnly && missed ? "Réviser " + missed + " questions ratées" : "Commencer les " + q.questions.length + " questions"}</button>
      <button class="btn btn-ghost btn-auto" data-act="close">Annuler</button>
    </div>`;
}

const sheetFormat = () => `<div class="sheet-top"><h3 class="h-lg">Format attendu</h3><button class="link" data-act="close">Fermer</button></div>
  <p class="lead">Colle cette phrase dans une conversation, enregistre la réponse en .json, reviens l'importer.</p>
  <div class="prompt">${esc(PROMPT)}</div><div class="code">${esc(MODEL)}</div>
  <button class="btn btn-ink" style="margin-top:16px" data-act="copy">Copier la phrase</button>`;

/* ── Desktop side panes ─────────────────────────────────────────── */
function paneList() {
  const o = overall();
  const rows = db.quizzes.map((q) => {
    const hot = (q.missed || []).length >= 3;
    const cls = q.id === (ses ? ses.quizId : ui.quizId) ? " on" : "";
    return `<button class="list-row${cls}" data-act="launch" data-id="${q.id}">
      <span><span class="cell-kicker" style="color:${hot ? "var(--accent)" : "var(--n-600)"}">${esc(hot ? "À reprendre" : q.matiere)}</span>
        <span class="t" style="display:block;margin-top:6px">${esc(q.titre)}</span>
        <span class="s">${q.questions.length} questions${(q.missed || []).length ? " · " + q.missed.length + " à revoir" : ""}</span></span>
      <span class="v ${q.best === null ? "none" : q.best < 75 ? "low" : ""}">${q.best === null ? "—" : q.best + " %"}</span></button>`;
  }).join("");
  return `<div class="hd"><div class="hd-row"><div><div class="kicker">QCM</div><h1 class="h-lg" style="margin-top:9px">Mes QCM</h1></div>
      <span style="font:800 14px/1 var(--head);color:var(--n-700)">${o.played ? o.pct + " %" : "—"}</span></div></div>
    <div class="scroll">${rows || `<p class="hint" style="padding:18px 20px">Aucun QCM importé.</p>`}</div>
    <div style="border-top:2px solid var(--ink);padding:14px 20px"><button class="btn" data-act="import">Importer un fichier</button></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--n-300)">
      <button class="tabbar-like ${ui.view === "stats" ? "on" : ""}" data-act="stats" style="padding:13px 14px;text-align:left;background:none;border:0;border-right:1px solid var(--n-300);font:${ui.view === "stats" ? 700 : 600} 11.5px/1 var(--head);letter-spacing:.06em;text-transform:uppercase;color:${ui.view === "stats" ? "var(--ink)" : "var(--n-600)"};cursor:pointer">Progression</button>
      <button data-act="settings" style="padding:13px 14px;text-align:left;background:none;border:0;font:${ui.view === "settings" ? 700 : 600} 11.5px/1 var(--head);letter-spacing:.06em;text-transform:uppercase;color:${ui.view === "settings" ? "var(--ink)" : "var(--n-600)"};cursor:pointer">Réglages</button>
    </div>`;
}

function paneSide() {
  const q = ses ? quiz(ses.quizId) : quiz(ui.quizId) || db.quizzes[0];
  if (!q) return `<div class="hd"><div class="kicker-mute">Session</div></div><p class="hint" style="padding:18px 20px">Importe un QCM pour commencer.</p>`;
  const cur = ses && ui.view === "session" ? current() : null;
  const done = !!(ses && ses.validated && cur);
  const juste = done && same(ses.picks, cur.rep);
  const bilan = ses && ui.view === "results";
  return `<div class="side-head">${ring(q.best, 72)}<div><div class="kicker-mute">Meilleur score</div>
      <div style="margin-top:6px;font:700 14px/1.25 var(--head)">${esc(q.titre)}</div></div></div>
    <div class="scroll">
      ${done ? `<div style="padding:18px 20px;border-bottom:1px solid var(--n-300)">
        <div class="verdict-t" style="color:${juste ? "var(--ink)" : "var(--accent-700)"}">${juste ? "Bonne réponse" : "Réponse incorrecte"}</div>
        <p style="margin-top:8px;font:400 13px/1.55 var(--body);color:var(--n-800)">${juste ? "" : "Attendu : " + esc(cur.rep.map((i) => cur.props[i]).join(" ; ")) + ". "}${esc(cur.expl)}</p></div>` : ""}
      ${bilan ? `<div style="padding:18px 20px;border-bottom:1px solid var(--n-300)">
        <div class="kicker-mute">Session terminée</div>
        <div style="display:flex;align-items:baseline;gap:10px;margin-top:8px">
          <b style="font:800 30px/1 var(--head);letter-spacing:-.03em">${ses.results.filter((r) => r.juste).length} / ${ses.order.length}</b>
          <span style="font:700 13px/1 var(--head);color:var(--n-700)">${pct(ses.results.filter((r) => r.juste).length, ses.order.length)} %</span>
        </div></div>` : ""}
      <div class="kicker-mute" style="padding:16px 20px 8px">Fiche de session</div>
      <div class="side-rows">${ses && ses.results.length ? fiche(false) : `<p class="hint" style="padding:0 20px 12px">La colonne se remplit à mesure que tu valides.</p>`}</div>
    </div>`;
}

/* ── Render ─────────────────────────────────────────────────────── */
function viewDesktopHome() {
  const o = overall(), nb = db.quizzes.length;
  const hot = db.quizzes.filter((q) => (q.missed || []).length).sort((a, b) => b.missed.length - a.missed.length)[0];
  return `<div class="screen">
    <div class="hd"><div class="kicker">Réviseur de QCM</div><h1 class="h-xl" style="margin-top:9px">${nb ? "Choisis un QCM à gauche" : "Importe ton premier QCM"}</h1></div>
    <div class="scroll"><div style="padding:24px 36px 32px;max-width:64ch;display:flex;flex-direction:column;gap:18px">
      <p style="font:400 14px/1.6 var(--body);color:var(--n-800)">${nb
        ? "La colonne de gauche liste tes QCM et leur meilleur score. Ouvre-en un pour régler la session — mode examen, mélange, reprise des seules questions ratées."
        : "Demande un QCM à Claude au format du réviseur, enregistre sa réponse en fichier .json, puis dépose-le ici. Tout reste sur cet appareil."}</p>
      ${nb ? `<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-top:2px solid var(--ink)">
        <div style="padding:14px 0;border-right:1px solid var(--n-300)"><b style="font:800 24px/1 var(--head)">${nb}</b><div class="kicker-mute" style="margin-top:6px">QCM importés</div></div>
        <div style="padding:14px 16px;border-right:1px solid var(--n-300)"><b style="font:800 24px/1 var(--head)">${o.played ? o.pct + " %" : "—"}</b><div class="kicker-mute" style="margin-top:6px">score moyen</div></div>
        <div style="padding:14px 16px"><b style="font:800 24px/1 var(--head);color:var(--accent-700)">${db.quizzes.reduce((a, q) => a + (q.missed || []).length, 0)}</b><div class="kicker-mute" style="margin-top:6px">à revoir</div></div>
      </div>` : `<div class="prompt">${esc(PROMPT)}</div>`}
      <div class="inline" style="margin-top:0">
        ${hot ? `<button class="btn btn-auto" data-act="launch" data-id="${hot.id}">Reprendre ${esc(hot.titre)}</button>` : ""}
        <button class="btn${hot ? " btn-ghost" : ""} btn-auto" data-act="import">Importer un fichier</button>
        <button class="btn btn-ghost btn-auto" data-act="format">Format attendu</button>
      </div>
    </div></div>
  </div>`;
}

function render() {
  if ((ui.view === "session" || ui.view === "results") && (!ses || !quiz(ses.quizId))) ui.view = "home";
  const main = ui.view === "session" ? viewSession()
    : ui.view === "results" ? viewResults()
    : ui.view === "stats" ? viewStats()
    : ui.view === "settings" ? viewSettings()
    : isDesktop() ? viewDesktopHome() : viewHome();

  const sheet = ui.sheet === "import" ? sheetImport() : ui.sheet === "launch" ? sheetLaunch() : ui.sheet === "format" ? sheetFormat() : null;
  const desktopSheetInline = isDesktop() && ui.sheet;

  $("pane-main").innerHTML = desktopSheetInline
    ? `<div class="screen"><div class="scroll"><div style="padding:26px 36px 32px;max-width:860px">${sheet}</div></div></div>`
    : main;
  $("pane-list").innerHTML = isDesktop() ? paneList() : "";
  $("pane-side").innerHTML = isDesktop() ? paneSide() : "";

  document.querySelectorAll(".sheet-back").forEach((n) => n.remove());
  if (sheet && !desktopSheetInline) {
    const back = document.createElement("div");
    back.className = "sheet-back";
    back.innerHTML = `<div class="sheet">${sheet}</div>`;
    back.addEventListener("pointerdown", (e) => { if (e.target === back) closeSheet(); });
    document.body.appendChild(back);
  }

  const tabs = [["home", "QCM"], ["stats", "Progression"], ["settings", "Réglages"]];
  const inSession = ui.view === "session" || ui.view === "results";
  $("tabbar").hidden = isDesktop() || inSession;
  $("tabbar").innerHTML = isDesktop() || inSession ? "" : tabs
    .map(([k, l]) => `<button data-act="${k === "home" ? "home" : k}" class="${ui.view === k ? "on" : ""}">${l}</button>`).join("");

  document.documentElement.style.fontSize = db.settings.size === "S" ? "15px" : db.settings.size === "L" ? "18px" : "16px";
  bindSwipe();
}

let toastT;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, 2600);
}
const closeSheet = () => { ui.sheet = null; ui.pending = null; render(); };

/* ── Swipe ──────────────────────────────────────────────────────── */
function bindSwipe() {
  const host = $("swipe"), body = $("q-body");
  if (!host || !body || !db.settings.swipe) return;
  let x0 = null;
  host.addEventListener("pointerdown", (e) => { x0 = e.clientX; body.classList.add("dragging"); });
  host.addEventListener("pointermove", (e) => { if (x0 !== null) body.style.transform = `translateX(${(e.clientX - x0) * 0.5}px)`; });
  const end = (e) => {
    if (x0 === null) return;
    const dx = (e.clientX || x0) - x0; x0 = null;
    body.classList.remove("dragging"); body.style.transform = "";
    if (dx < -70) { if (ses.validated || ses.exam || !db.settings.correction) next(); else toast("Valide d'abord ta réponse"); }
    else if (dx > 70) back();
  };
  host.addEventListener("pointerup", end);
  host.addEventListener("pointercancel", end);
}

/* ── Events ─────────────────────────────────────────────────────── */
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  const handlers = {
    home: () => { ui.view = "home"; ui.sheet = null; ses = ui.view === "home" && ui.sheet === null ? ses : ses; render(); },
    stats: () => { ui.view = ui.view === "stats" ? "home" : "stats"; ui.sheet = null; render(); },
    settings: () => { ui.view = ui.view === "settings" ? "home" : "settings"; ui.sheet = null; render(); },
    import: () => { ui.sheet = "import"; ui.pending = null; render(); },
    format: () => { ui.sheet = "format"; render(); },
    close: closeSheet,
    browse: () => $("file-input").click(),
    confirm: () => {
      db.quizzes = [...ui.pending.quizzes.map((q) => { const { skipped, ...rest } = q; return rest; }), ...db.quizzes];
      const n = ui.pending.quizzes.reduce((a, q) => a + q.questions.length, 0);
      save(); ui.sheet = null; ui.pending = null; render();
      toast(n + " questions ajoutées à ta liste");
    },
    launch: () => {
      ui.quizId = el.dataset.id; ui.sheet = "launch";
      ui.launch = { exam: !db.settings.correction, shuffle: db.settings.shuffle, missedOnly: false };
      render();
    },
    opt: () => { const k = el.dataset.k; ui.launch[k] = !ui.launch[k]; render(); },
    start: () => startSession(quiz(ui.quizId), ui.launch),
    pick: () => pick(+el.dataset.i),
    validate: validate,
    next: next,
    detail: () => { ui.detail = ui.detail === +el.dataset.i ? null : +el.dataset.i; render(); },
    replay: replayWrong,
    set: () => { const k = el.dataset.k; db.settings[k] = !db.settings[k]; save(); render(); },
    size: () => { db.settings.size = el.dataset.k; save(); render(); },
    copy: () => { navigator.clipboard?.writeText(PROMPT).then(() => toast("Phrase copiée")); },
    export: () => {
      const blob = new Blob([JSON.stringify({ qcms: db.quizzes.map(({ id, best, history, missed, ...q }) => q) }, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = "mes-qcm.json"; a.click();
      URL.revokeObjectURL(a.href);
    },
    wipe: () => {
      if (!confirm("Effacer tous les QCM et l'historique de révision ?")) return;
      db = { quizzes: [], settings: db.settings }; ses = null; ui.view = "home";
      try { localStorage.setItem(SEEDED, "1"); } catch (_) {}
      save(); render();
      toast("Données effacées");
    }
  };
  if (handlers[act]) { e.preventDefault(); handlers[act](); }
});

$("file-input").addEventListener("change", (e) => { ingestFiles([...e.target.files]); e.target.value = ""; });

document.addEventListener("dragover", (e) => {
  if (!ui.sheet) return;
  e.preventDefault();
  document.getElementById("drop")?.classList.add("over");
});
document.addEventListener("dragleave", () => document.getElementById("drop")?.classList.remove("over"));
document.addEventListener("drop", (e) => {
  const files = [...(e.dataTransfer?.files || [])].filter((f) => /json|text/.test(f.type) || /\.json$/i.test(f.name));
  if (!files.length) return;
  e.preventDefault();
  if (ui.sheet !== "import") { ui.sheet = "import"; ui.pending = null; }
  ingestFiles(files);
});

document.addEventListener("keydown", (e) => {
  if (ui.sheet) { if (e.key === "Escape") closeSheet(); return; }
  if (ui.view !== "session") return;
  const cur = current();
  if (/^[a-z]$/i.test(e.key)) {
    const i = e.key.toUpperCase().charCodeAt(0) - 65;
    if (i < cur.props.length) return pick(i);
  }
  if (e.key === "Enter") return ses.validated ? next() : validate();
  if (e.key === "ArrowRight") return ses.validated || ses.exam ? next() : null;
  if (e.key === "ArrowLeft") return back();
});

window.matchMedia("(min-width:900px)").addEventListener("change", render);

load();
render();
seed();
})();
