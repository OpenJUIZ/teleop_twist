# teleop_twist

[JUIZ](https://github.com/OpenJUIZ/juiz) で動くロボットを、キーボードかゲームパッドで操作するアプリです。ブラウザの画面で入力を読み、`juiz_std.geometry.Twist2D` をトピック `cmd_vel` に 20 Hz で出します。[mobile_sim](https://github.com/OpenJUIZ/mobile_sim) を操作するために作りました。`.juizapp` として配布し、`juiz run` だけで動かせます。

## 使い方

[Releases](https://github.com/OpenJUIZ/teleop_twist/releases) から `teleop_twist-<版>.juizapp` を、[mobile_sim の Releases](https://github.com/OpenJUIZ/mobile_sim/releases) から 0.3 系の `mobile_sim-<版>.juizapp` を取ってきます。

```sh
pip install juiz-cli==0.2.4

juiz run mobile_sim-<版>.juizapp       # 先に動かしておく(ipc://mobile_sim、http://localhost:8000/)
juiz run teleop_twist-<版>.juizapp     # 別の端末で。ブラウザで http://localhost:8002/ を開く
```

- teleop_twist は `juizapp.yaml` の `depends`(`mobile_sim >=0.3.1, <0.4`)を見て、動いている mobile_sim の版を確かめてから IPC でつなぎます。mobile_sim が動いていないと起動しません。
- 先に `juiz install mobile_sim-<版>.juizapp` で入れておくと、`juiz run mobile_sim` と名前で起動できます。
- [mapper_gmapping](https://github.com/OpenJUIZ/mapper_gmapping) も一緒に動かせば、このアプリで走らせながら地図を作れます(画面は http://localhost:8001/)。
- Linux(x86_64・arm64)、macOS(Intel・Apple Silicon)、Windows(x86_64)のプラグインが入っています。プラグインは juiz の C ABI で作っているので、pip の `juiz-cli` でも `cargo install juiz_app` で入れた juiz でも動きます。

### 操作

| 動き | キーボード | ゲームパッド |
| --- | --- | --- |
| 前進・後退 | W / S、↑ / ↓ | 左スティック上下、十字キー上下 |
| 左旋回・右旋回 | A / D、← / → | 左スティック左右、十字キー左右 |
| 左右へ平行移動(全方向移動のロボットだけ) | Q / E | 右スティック左右 |
| 速度の倍率を下げる・上げる | Z / X | LB / RB |
| 止める | Space、「停止」ボタン | スティックを離す |

- 画面の丸いパッドをドラッグしても動かせます(タッチでも使えます)。
- キーボードで操作するときは、ブラウザの画面をクリックしてフォーカスを当てます。
- ゲームパッドはブラウザの [Gamepad API](https://developer.mozilla.org/ja/docs/Web/API/Gamepad_API) で読みます。つないだ後、ボタンを 1 回押すと認識されます。標準の割り当て(`mapping: "standard"`)のゲームパッド(Xbox・PlayStation のコントローラなど)を前提にしています。

### 止まるとき

- キーやスティックを離すと、すぐに 0 を出します。
- 画面が裏に回ったとき・別のウィンドウにフォーカスが移ったとき・画面を閉じたときも止めます。
- 画面から入力が `timeout`(既定 0.5 秒)届かないと、0 を出します(画面が固まったり、ネットワークが切れたりしたとき)。mobile_sim にも同じような仕組み(`command_timeout`)があります。
- teleop_twist は動いている間ずっと `cmd_vel` に出し続けます(入力が無いときは 0)。mobile_sim の画面のキー操作と同時に使うと指令がぶつかるので、どちらか一方で操作してください。

### 設定

`app/app.conf` のコンテナ `teleop0` の引数で変えられます(パッケージを展開した先の conf を直すか、このリポジトリから作り直します)。

| 引数 | 既定 | 意味 |
| --- | --- | --- |
| `max_velocity` | `{vx: 0.5, vy: 0.5, omega: 1.0}` | 入力いっぱい・倍率 1 のときの速度 [m/s, m/s, rad/s]。`vy` は全方向移動のロボットだけが使う |
| `scale` | `0.5` | 速度の倍率の初期値(0.1〜1)。画面で変えられる |
| `timeout` | `0.5` | 入力がこの秒数途切れたら 0 を出す |

出す速度は「入力(各軸 -1〜1)× `max_velocity` × 倍率」です。mobile_sim の robot0 の上限は `vx 1.0 m/s`・`omega 1.5 rad/s` なので、それを超える値は mobile_sim の側で切られます。

HTTP のポートは 8002 です(mobile_sim が 8000、mapper_gmapping が 8001)。

### 別の機械の mobile_sim を操作する

```sh
juiz run teleop_twist-<版>.juizapp --depend mobile_sim=http://192.168.0.10:8000
```

## 中身

コンテナ `teleop_twist`(インスタンス `teleop0`)の ContainerProcess:

| ContainerProcess | 引数 | 戻り値 |
| --- | --- | --- |
| `teleop_twist_output` | なし | `Twist2D`。main_loop_ec が 20 Hz で呼び、トピック `cmd_vel` に出す |
| `teleop_twist_set_command` | `vx`・`vy`・`omega`(各 -1〜1。前・左・反時計回りが正) | 状態 |
| `teleop_twist_set_scale` | `scale`(0.1〜1) | 状態 |
| `teleop_twist_stop` | なし | 状態 |
| `teleop_twist_get_state` | なし | 状態(readonly) |

状態は `{active, age, command, twist, scale, max_velocity, timeout}` です。画面を使わずに、`curl` などから `set_command` を呼んでも動かせます。

| パス | 中身 |
| --- | --- |
| `src/teleop.rs` | 入力から速度を作る部分(juiz に依存しない) |
| `src/lib.rs` | juiz のコンポーネント(cdylib) |
| `app/` | `juiz pack` の入力(`juizapp.yaml`、`app.conf`、ブラウザ画面 `web/`) |
| `scripts/` | 開発用のビルド、パッケージ作り、結合テスト、画面のテスト |

## 開発

```sh
cargo build   # target/debug/libteleop_twist.so などができる
cargo test
```

Rust 1.88 以降が要ります。juiz_sdk は `=0.2.4` に固定しています。

### juiz で動かす

```sh
pip install juiz-cli==0.2.4
scripts/dev_plugin.sh                 # プラグインをビルドして app/plugins/<target>/ に置く
cd app && juiz -f app.conf -d         # http://localhost:8002/ で画面が開く(mobile_sim にはつながない)
python3 scripts/integration_test.py   # 別の端末で。juiz を起動して HTTP から各プロセスを呼ぶ
node scripts/ui_test.js               # juiz を起動してから。Playwright が要る
```

`juiz -f` で動かしている mobile_sim(`juiz -f app.conf -d --ipc mobile_sim`)とつなぐときは、`app/app.conf` に `subsystems: [{type_name: ipc, name: mobile_sim}]` を足して起動します。

### パッケージを作る

CI の Release ワークフローが、5 ターゲットでプラグインをビルドして `.juizapp` にまとめ、mobile_sim の `.juizapp` と一緒に `juiz run` で動かしてロボットが動くことを確かめます。タグ `v<版>`(`app/juizapp.yaml` の `version` と同じ)を push するか、GitHub の画面でそのタグの Release を作ると、Releases に `.juizapp` が載ります。手元では次のとおりです。

```sh
cargo build --release
mkdir -p /tmp/plugins/x86_64-unknown-linux-gnu && cp target/release/libteleop_twist.so /tmp/plugins/x86_64-unknown-linux-gnu/
scripts/pack.sh /tmp/plugins dist     # dist/teleop_twist-<版>.juizapp
python3 scripts/integration_test.py --juizapp dist/teleop_twist-<版>.juizapp --mobile-sim mobile_sim-<版>.juizapp
```

juiz の新しい版に合わせるときは、`Cargo.toml` の `juiz_sdk`・`juiz_std_types` と `app/juizapp.yaml` の `juiz`(`>=<版>`)を上げます。

## ライセンス

MIT か Apache-2.0 のどちらか(`LICENSE-MIT`、`LICENSE-APACHE`)を選んで使えます。

Copyright (c) 2026 ysuga
