// teleop_twist のブラウザ画面
//
// キーボード・ゲームパッド(Gamepad API)・画面のパッドの入力を 20 Hz で読み、
// juiz の HTTP ブローカーの /api/container_process/call でコンテナ teleop_twist の set_command を呼ぶ。
// 入力が 0 になったとき・画面が裏に回ったとき・フォーカスを失ったときは stop を呼ぶ。
// 何も送らなくなっても、コンテナが timeout(既定 0.5 秒)で 0 を出す。
"use strict";

const SEND_MS = 50; // 20 Hz
const STATE_MS = 250; // 入力が無いときに状態を読む間隔
const DEADZONE = 0.15;
const SCALE_STEP = 0.1;

// ---- juiz の呼び出し ----

class TeleopClient {
  constructor() {
    this.ids = {};
  }

  // ContainerProcess の一覧から teleop_twist_* の識別子を集める(最初に見つかったコンテナを使う)
  async discover() {
    const res = await fetch("/api/container_process/list");
    if (!res.ok) throw new Error(`container_process/list: ${res.status}`);
    let container = null;
    for (const e of await res.json()) {
      const [type, c] = e.type_name.split(":");
      if (!type.startsWith("teleop_twist_")) continue;
      if (container === null) container = c;
      if (c !== container) continue;
      const ns = e.namespace ? `${e.namespace}/` : "";
      this.ids[type.slice("teleop_twist_".length)] =
        `${e.broker_type_name}://${e.broker_name}/container_process/${ns}${e.name}::${e.type_name}`;
    }
    for (const k of ["set_command", "set_scale", "stop", "get_state"]) {
      if (!this.ids[k]) throw new Error(`teleop_twist_${k} が見つかりません`);
    }
    this.container = container;
  }

  async call(kind, args = {}, keepalive = false) {
    const url = "/api/container_process/call?identifier=" + encodeURIComponent(this.ids[kind]);
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      keepalive, // 画面を閉じるときの stop も届くように
    });
    if (!res.ok) throw new Error(`${kind}: ${res.status} ${await res.text()}`);
    return res.json();
  }
}

// ---- 入力 ----

const keys = new Set();
const KEY_AXES = {
  KeyW: ["vx", 1], ArrowUp: ["vx", 1],
  KeyS: ["vx", -1], ArrowDown: ["vx", -1],
  KeyA: ["omega", 1], ArrowLeft: ["omega", 1],
  KeyD: ["omega", -1], ArrowRight: ["omega", -1],
  KeyQ: ["vy", 1],
  KeyE: ["vy", -1],
};

function keyboardCommand() {
  const c = { vx: 0, vy: 0, omega: 0 };
  for (const k of keys) {
    const a = KEY_AXES[k];
    if (a) c[a[0]] += a[1];
  }
  for (const a in c) c[a] = Math.max(-1, Math.min(1, c[a]));
  return c;
}

// 遊びを除いて 0〜1 に引き伸ばす
function deadzone(v) {
  const a = Math.abs(v);
  if (a < DEADZONE) return 0;
  return Math.sign(v) * Math.min(1, (a - DEADZONE) / (1 - DEADZONE));
}

let gamepadIndex = null;
const prevButtons = {};

function currentGamepad() {
  const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
  if (pads.length === 0) return null;
  return pads.find((p) => p.index === gamepadIndex) || pads[0];
}

// 標準の割り当て(https://w3c.github.io/gamepad/#remapping)を前提にする
function gamepadCommand(pad) {
  const ax = (i) => deadzone(pad.axes[i] || 0);
  const btn = (i) => (pad.buttons[i] && pad.buttons[i].pressed ? 1 : 0);
  const c = {
    vx: -ax(1) + btn(12) - btn(13),
    omega: -ax(0) + btn(14) - btn(15),
    vy: -ax(2),
  };
  for (const a in c) c[a] = Math.max(-1, Math.min(1, c[a]));
  // LB / RB で倍率を変える(押した瞬間だけ)
  for (const [i, d] of [[4, -SCALE_STEP], [5, SCALE_STEP]]) {
    const now = btn(i) === 1;
    if (now && !prevButtons[i]) changeScale(d);
    prevButtons[i] = now;
  }
  return c;
}

// 画面のパッド
const pad = document.getElementById("pad");
const padCtx = pad.getContext("2d");
let padInput = null; // {x, y}(-1〜1、上が +y)

function padPoint(ev) {
  const r = pad.getBoundingClientRect();
  const x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  const y = -(((ev.clientY - r.top) / r.height) * 2 - 1);
  const n = Math.hypot(x, y);
  return n > 1 ? { x: x / n, y: y / n } : { x, y };
}
pad.addEventListener("pointerdown", (ev) => {
  pad.setPointerCapture(ev.pointerId);
  padInput = padPoint(ev);
});
pad.addEventListener("pointermove", (ev) => {
  if (padInput) padInput = padPoint(ev);
});
for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) {
  pad.addEventListener(t, () => { padInput = null; });
}

function padCommand() {
  if (!padInput) return { vx: 0, vy: 0, omega: 0 };
  return { vx: padInput.y, vy: 0, omega: -padInput.x };
}

function drawPad(c) {
  const w = pad.width, h = pad.height, r = w / 2 - 20;
  const css = getComputedStyle(document.documentElement);
  padCtx.clearRect(0, 0, w, h);
  padCtx.strokeStyle = css.getPropertyValue("--line").trim();
  padCtx.lineWidth = 1;
  padCtx.beginPath();
  padCtx.moveTo(w / 2, 12); padCtx.lineTo(w / 2, h - 12);
  padCtx.moveTo(12, h / 2); padCtx.lineTo(w - 12, h / 2);
  padCtx.stroke();
  // 今の指令(前後を上下、旋回を左右に)
  // 円の外に出ないように(斜めは長さ 1 に縮める)
  const n = Math.max(1, Math.hypot(c.omega, c.vx));
  const x = w / 2 - (c.omega / n) * r, y = h / 2 - (c.vx / n) * r;
  padCtx.fillStyle = css.getPropertyValue("--accent").trim();
  padCtx.beginPath();
  padCtx.arc(x, y, 16, 0, Math.PI * 2);
  padCtx.fill();
  // 平行移動は下の帯で
  if (c.vy !== 0) {
    padCtx.fillRect(w / 2, h - 8, -c.vy * r, 4);
  }
}

// ---- 倍率 ----

const client = new TeleopClient();
const scaleInput = document.getElementById("scale");
const scaleValue = document.getElementById("scale_value");
let scaleSending = Promise.resolve();

function showScale(s) {
  scaleInput.value = s;
  scaleValue.textContent = Number(s).toFixed(1);
}

function changeScale(delta) {
  const s = Math.round((Number(scaleInput.value) + delta) * 10) / 10;
  setScale(Math.max(0.1, Math.min(1, s)));
}

function setScale(s) {
  showScale(s);
  scaleSending = scaleSending
    .then(() => client.call("set_scale", { scale: s }))
    .then(showState)
    .catch(showError);
}

scaleInput.addEventListener("input", () => setScale(Number(scaleInput.value)));
document.getElementById("scale_down").addEventListener("click", () => changeScale(-SCALE_STEP));
document.getElementById("scale_up").addEventListener("click", () => changeScale(SCALE_STEP));

// ---- 表示 ----

const conn = document.getElementById("connection");
let lastState = null;

function showState(s) {
  lastState = s;
  document.getElementById("s_vx").textContent = s.twist.vx.toFixed(2);
  document.getElementById("s_vy").textContent = s.twist.vy.toFixed(2);
  document.getElementById("s_omega").textContent = s.twist.omega.toFixed(2);
  const m = s.max_velocity;
  document.getElementById("s_max").textContent =
    `vx ${m.vx} m/s、vy ${m.vy} m/s、ω ${m.omega} rad/s(倍率 1 のとき)`;
  if (document.activeElement !== scaleInput) showScale(s.scale);
  conn.textContent = `接続しています(${client.container})`;
  conn.className = "status ok";
}

function showError(e) {
  console.error(e);
  conn.textContent = `つながりません: ${e.message}`;
  conn.className = "status ng";
}

// ---- 送信のループ ----

let sending = false; // 前の呼び出しが返るまで次を送らない
let moving = false; // 前回 0 でない指令を送ったか
let lastStatePoll = 0;
let stopRequested = false;

function isZero(c) {
  return c.vx === 0 && c.vy === 0 && c.omega === 0;
}

function sourceOf(k, g, p) {
  const s = [];
  if (!isZero(k)) s.push("キーボード");
  if (g && !isZero(g)) s.push("ゲームパッド");
  if (!isZero(p)) s.push("画面のパッド");
  return s.length ? s.join("・") : "なし";
}

async function tick() {
  const gp = currentGamepad();
  const g = gp ? gamepadCommand(gp) : null;
  const k = keyboardCommand();
  const p = padCommand();
  const c = { vx: 0, vy: 0, omega: 0 };
  for (const src of [k, g, p]) {
    if (!src) continue;
    for (const a in c) c[a] = Math.max(-1, Math.min(1, c[a] + src[a]));
  }
  if (stopRequested) {
    for (const a in c) c[a] = 0;
  }
  drawPad(c);
  document.getElementById("s_source").textContent = sourceOf(k, g, p);
  if (sending || !client.ids.set_command) return;
  sending = true;
  try {
    if (!isZero(c)) {
      showState(await client.call("set_command", c));
      moving = true;
    } else if (moving) {
      showState(await client.call("stop"));
      moving = false;
    } else if (performance.now() - lastStatePoll > STATE_MS) {
      lastStatePoll = performance.now();
      showState(await client.call("get_state"));
    }
  } catch (e) {
    showError(e);
  } finally {
    sending = false;
  }
}

// すぐ止める: キーを全部離したことにして stop を送る
function stopNow() {
  keys.clear();
  padInput = null;
  moving = false;
  if (client.ids.stop) client.call("stop", {}, true).then(showState).catch(showError);
}

// ---- イベント ----

window.addEventListener("keydown", (ev) => {
  if (ev.target instanceof HTMLInputElement && ev.target.type !== "range") return;
  if (ev.code === "Space") {
    ev.preventDefault();
    stopRequested = true;
    stopNow();
    return;
  }
  if (ev.code === "KeyZ") { changeScale(-SCALE_STEP); return; }
  if (ev.code === "KeyX") { changeScale(SCALE_STEP); return; }
  if (KEY_AXES[ev.code]) {
    ev.preventDefault();
    keys.add(ev.code);
  }
});
window.addEventListener("keyup", (ev) => {
  if (ev.code === "Space") stopRequested = false;
  keys.delete(ev.code);
});
document.getElementById("stop").addEventListener("click", stopNow);

// 裏に回った・フォーカスを失った・閉じるときは止める(押しっぱなしのキーの keyup は届かないため)
const focusHint = document.getElementById("focus");
window.addEventListener("blur", () => { stopNow(); focusHint.hidden = false; });
window.addEventListener("focus", () => { focusHint.hidden = true; });
document.addEventListener("visibilitychange", () => { if (document.hidden) stopNow(); });
window.addEventListener("pagehide", stopNow);

const gpLabel = document.getElementById("gamepad");
function showGamepad() {
  const gp = currentGamepad();
  if (!gp) {
    gpLabel.textContent = "つながっていません(ボタンを押すと認識します)";
    return;
  }
  gamepadIndex = gp.index;
  const note = gp.mapping === "standard" ? "" : "(標準の割り当てでないため、軸が違うかもしれません)";
  gpLabel.textContent = `${gp.id}${note}`;
}
window.addEventListener("gamepadconnected", showGamepad);
window.addEventListener("gamepaddisconnected", () => { gamepadIndex = null; showGamepad(); stopNow(); });

async function start() {
  focusHint.hidden = document.hasFocus();
  drawPad({ vx: 0, vy: 0, omega: 0 });
  for (;;) {
    try {
      await client.discover();
      break;
    } catch (e) {
      showError(e);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  setInterval(tick, SEND_MS);
  setInterval(showGamepad, 1000);
}

start();
