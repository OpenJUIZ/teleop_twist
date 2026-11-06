"""juiz で teleop_twist を起動し、HTTP から呼んで動作を確かめる

使い方:
  scripts/dev_plugin.sh && python3 scripts/integration_test.py [--juiz <juiz のパス>] [--port 18002]
      app/app.conf を juiz -f で起動する(mobile_sim にはつながない)
  python3 scripts/integration_test.py --juizapp dist/teleop_twist-<版>.juizapp --mobile-sim mobile_sim-<版>.juizapp
      mobile_sim を juiz run で起動し、このパッケージを juiz run でつないで、ロボットが動くことを確かめる
"""
import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SIM = "http://localhost:8000"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--juiz", default="juiz")
    ap.add_argument("--port", type=int, default=18002)
    ap.add_argument("--juizapp", help="test this package with `juiz run` instead of app/app.conf")
    ap.add_argument("--mobile-sim", help="mobile_sim .juizapp to run before this package (needs --juizapp)")
    args = ap.parse_args()
    if args.mobile_sim and not args.juizapp:
        sys.exit("--mobile-sim needs --juizapp")

    procs = []
    tmp = None
    try:
        if args.juizapp:
            # カレントディレクトリと展開先のキャッシュは空の一時ディレクトリにする(app/ の中身に頼らないことを確かめる)
            work = tempfile.mkdtemp()
            env = dict(os.environ, JUIZ_CACHE_DIR=os.path.join(work, "cache"))
            if args.mobile_sim:
                procs.append(start([args.juiz, "run", str(Path(args.mobile_sim).resolve())], work, env))
                wait_ready(SIM, procs[-1])
            base = "http://localhost:8002"
            procs.append(start([args.juiz, "run", str(Path(args.juizapp).resolve())], work, env))
        else:
            # ポートだけ変えた conf を app/ に置く(プラグインと web の相対パスを保つため)
            base = f"http://localhost:{args.port}"
            conf = (ROOT / "app" / "app.conf").read_text()
            conf = conf.replace('"port": 8002', f'"port": {args.port}')
            tmp = ROOT / "app" / ".integration_test.conf"
            tmp.write_text(conf)
            procs.append(start([args.juiz, "-f", tmp.name, "-d"], ROOT / "app", None))
        wait_ready(base, procs[-1])
        run_checks(base)
        check_web(base)
        if args.mobile_sim:
            check_drive(base)
        print("OK")
    finally:
        for p in reversed(procs):
            p.terminate()
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
        if tmp:
            tmp.unlink(missing_ok=True)


def start(cmd, cwd, env):
    log = tempfile.TemporaryFile()
    p = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
    p.log = log
    return p


def wait_ready(base, proc):
    for _ in range(150):
        if proc.poll() is not None:
            proc.log.seek(0)
            sys.exit("juiz exited:\n" + proc.log.read().decode(errors="replace"))
        try:
            with urllib.request.urlopen(f"{base}/api/container/list", timeout=1) as r:
                if json.load(r):
                    return
        except OSError:
            pass
        time.sleep(0.2)
    sys.exit(f"juiz did not become ready at {base}")


def call(base, name, kind, args=None, container="teleop0", ctype="teleop_twist"):
    """コンテナ `container` の ContainerProcess `name`(型 <ctype>_<kind>)を呼ぶ"""
    ident = f"{base}/container_process/{name}::{ctype}_{kind}:{container}"
    url = f"{base}/api/container_process/call?identifier=" + urllib.parse.quote(ident, safe="")
    req = urllib.request.Request(
        url, data=json.dumps(args or {}).encode(), method="PATCH", headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())


def api(base, path):
    with urllib.request.urlopen(f"{base}/api/{path}", timeout=5) as r:
        return json.loads(r.read())


def close(a, b):
    return abs(a - b) < 1e-9


def run_checks(base):
    s = call(base, "get_state0", "get_state")
    assert s["active"] is False and s["twist"] == {"vx": 0.0, "vy": 0.0, "omega": 0.0}, s
    assert s["scale"] == 0.5 and s["timeout"] == 0.5, s

    # 入力 × 最大速度 × 倍率。範囲の外は丸める
    s = call(base, "set_command0", "set_command", {"vx": 1.0, "vy": -0.5, "omega": 2.0})
    assert s["active"] is True, s
    assert close(s["twist"]["vx"], 0.25) and close(s["twist"]["vy"], -0.125) and close(s["twist"]["omega"], 0.5), s
    out = call(base, "output0", "output")
    assert close(out["linear"]["x"], 0.25) and close(out["angular"], 0.5), out

    s = call(base, "set_scale0", "set_scale", {"scale": 1.0})
    assert s["scale"] == 1.0 and close(s["twist"]["vx"], 0.5), s
    s = call(base, "set_scale0", "set_scale", {"scale": 0.0})
    assert close(s["scale"], 0.1), s

    # 止める
    s = call(base, "stop0", "stop")
    assert s["active"] is False and s["twist"]["vx"] == 0.0, s

    # 途切れたら 0
    call(base, "set_command0", "set_command", {"vx": 1.0})
    time.sleep(0.7)
    s = call(base, "get_state0", "get_state")
    assert s["active"] is False and s["twist"]["vx"] == 0.0, s
    call(base, "set_scale0", "set_scale", {"scale": 0.5})

    topics = [t["name"] for t in api(base, "topic/list")]
    assert "cmd_vel" in topics, topics


def check_web(base):
    for path in ["/", "/teleop.js", "/style.css"]:
        with urllib.request.urlopen(base + path, timeout=5) as r:
            assert r.status == 200 and r.read(), path


def sim_pose():
    """mobile_sim の robot0 の真の位置 (x, y, theta)"""
    p = call(SIM, "get_pose0", "get_pose", {"index": 0}, container="sim0", ctype="mobile_sim")
    q = p["pose"]
    return q["position"]["x"], q["position"]["y"], q["theta"]


def check_drive(base):
    """teleop の入力で mobile_sim の robot0 が動き、止めると止まる"""
    x0, y0, _ = sim_pose()
    t_end = time.time() + 1.5
    while time.time() < t_end:
        call(base, "set_command0", "set_command", {"vx": 1.0})
        time.sleep(0.05)
    x1, y1, _ = sim_pose()
    moved = math.hypot(x1 - x0, y1 - y0)
    assert moved > 0.1, f"robot0 did not move: {moved} m"
    call(base, "stop0", "stop")
    time.sleep(1.0)  # 減速を待つ
    xa, ya, _ = sim_pose()
    time.sleep(0.5)
    xb, yb, _ = sim_pose()
    assert math.hypot(xb - xa, yb - ya) < 0.01, "robot0 did not stop"

    # 旋回
    _, _, th0 = sim_pose()
    t_end = time.time() + 1.0
    while time.time() < t_end:
        call(base, "set_command0", "set_command", {"omega": 1.0})
        time.sleep(0.05)
    _, _, th1 = sim_pose()
    call(base, "stop0", "stop")
    turned = math.atan2(math.sin(th1 - th0), math.cos(th1 - th0))
    assert turned > 0.1, f"robot0 did not turn left: {turned} rad"
    print(f"drive: moved {moved:.2f} m, turned {turned:.2f} rad")


if __name__ == "__main__":
    main()
