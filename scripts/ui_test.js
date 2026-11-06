// ブラウザ画面のテスト(Playwright)。juiz で teleop_twist を起動してから動かす
// 使い方: node scripts/ui_test.js [<画面の URL>] [<スクリーンショットの出力先>]
"use strict";

const { chromium } = require("playwright");

const url = process.argv[2] || "http://localhost:8002/";
const shot = process.argv[3];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  // ゲームパッドの代わり(標準の割り当て)。window.fakePad.axes を書き換えて使う
  await page.addInitScript(() => {
    const pad = {
      id: "Fake Gamepad", index: 0, mapping: "standard", connected: true,
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    };
    window.fakePad = pad;
    navigator.getGamepads = () => [pad];
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById("connection").classList.contains("ok"));

  const state = () => page.evaluate(async () => {
    const id = client.ids.get_state;
    const r = await fetch("/api/container_process/call?identifier=" + encodeURIComponent(id), {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    return r.json();
  });

  // キーボード: W で前進、離すと止まる
  await page.click("body");
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(400);
  let s = await state();
  assert(s.active && s.twist.vx > 0, "W does not move forward: " + JSON.stringify(s));
  await page.keyboard.down("KeyA");
  await page.waitForTimeout(300);
  s = await state();
  assert(s.twist.omega > 0, "A does not turn left: " + JSON.stringify(s));
  await page.keyboard.up("KeyA");
  await page.keyboard.up("KeyW");
  await page.waitForTimeout(300);
  s = await state();
  assert(!s.active && s.twist.vx === 0, "releasing W does not stop: " + JSON.stringify(s));

  // 倍率: X で上げる
  const before = s.scale;
  await page.keyboard.press("KeyX");
  await page.waitForTimeout(300);
  s = await state();
  assert(Math.abs(s.scale - Math.min(1, before + 0.1)) < 1e-9, "X does not raise the scale: " + JSON.stringify(s));
  await page.keyboard.press("KeyZ");

  // ゲームパッド: 左スティックを前に倒す・右へ倒す
  await page.evaluate(() => { window.fakePad.axes[1] = -1; window.fakePad.axes[0] = 1; });
  await page.waitForTimeout(400);
  s = await state();
  assert(s.twist.vx > 0 && s.twist.omega < 0, "gamepad does not drive: " + JSON.stringify(s));
  assert((await page.textContent("#gamepad")).includes("Fake Gamepad"), "gamepad is not shown");
  if (shot) await page.screenshot({ path: shot });
  // 遊びの中は 0
  await page.evaluate(() => { window.fakePad.axes[1] = -0.1; window.fakePad.axes[0] = 0.05; });
  await page.waitForTimeout(300);
  s = await state();
  assert(!s.active && s.twist.vx === 0, "gamepad deadzone does not stop: " + JSON.stringify(s));

  // 画面のフォーカスが外れたら止まる(押しっぱなしでも)
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(300);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.waitForTimeout(300);
  s = await state();
  assert(!s.active, "blur does not stop: " + JSON.stringify(s));
  await page.keyboard.up("KeyW");

  // 停止ボタン
  await page.evaluate(() => { window.fakePad.axes[1] = -1; });
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.fakePad.axes[1] = 0; });
  await page.click("#stop");
  await page.waitForTimeout(200);
  s = await state();
  assert(!s.active, "stop button does not stop: " + JSON.stringify(s));

  assert(errors.length === 0, "page errors: " + errors.join("\n"));
  await browser.close();
  console.log("UI OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
