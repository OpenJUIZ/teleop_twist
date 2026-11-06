//! teleop_twist の juiz コンポーネント。
//!
//! ブラウザの画面(`app/web/`)がキーボードとゲームパッドの入力を HTTP でコンテナ `teleop_twist` に書き込み、
//! main_loop_ec が周期ごとに `teleop_twist_output` を呼んで `juiz_std.geometry.Twist2D` をトピック `cmd_vel` に出す。
//! 入力が `timeout` 秒途切れると 0 を出す。中身は [`teleop::Teleop`] にある。
//!
//! | ContainerProcess | 引数 | 戻り値 |
//! | --- | --- | --- |
//! | `teleop_twist_output` | なし | `Twist2D`(EC が呼び、トピック `cmd_vel` に出す) |
//! | `teleop_twist_set_command` | `vx`・`vy`・`omega`(各 -1〜1) | 状態 |
//! | `teleop_twist_set_scale` | `scale`(0.1〜1) | 状態 |
//! | `teleop_twist_stop` | なし | 状態 |
//! | `teleop_twist_get_state` | なし | 状態(readonly) |

pub mod teleop;

use std::time::Instant;

use juiz_sdk::anyhow::anyhow;
use juiz_sdk::prelude::*;
use juiz_sdk::serde_json::json;
use juiz_std_types::geometry::{Twist2D, Vector2};

pub use teleop::{Teleop, Velocity};

fn err(e: String) -> JuizError {
    JuizError::InvalidValueError { message: e }
}

fn velocity_json(v: Velocity) -> Value {
    json!({ "vx": v.vx, "vy": v.vy, "omega": v.omega })
}

/// `{vx, vy, omega}` を読む。書いていない軸は `default` の値
fn read_velocity(v: &Value, default: Velocity) -> Result<Velocity, String> {
    if v.is_null() {
        return Ok(default);
    }
    let obj = v
        .as_object()
        .ok_or_else(|| format!("max_velocity must be {{vx, vy, omega}} (got {v})"))?;
    for k in obj.keys() {
        if !["vx", "vy", "omega"].contains(&k.as_str()) {
            return Err(format!(
                "unknown key '{k}' in max_velocity. Use vx, vy and omega"
            ));
        }
    }
    let get = |k: &str, d: f64| -> Result<f64, String> {
        match obj.get(k) {
            None | Some(Value::Null) => Ok(d),
            Some(x) => x
                .as_f64()
                .ok_or_else(|| format!("max_velocity.{k} must be a number (got {x})")),
        }
    };
    Ok(Velocity {
        vx: get("vx", default.vx)?,
        vy: get("vy", default.vy)?,
        omega: get("omega", default.omega)?,
    })
}

/// 既定の最大速度(mobile_sim の robot0 の上限 vx 1.0・omega 1.5 より小さめ)
pub const DEFAULT_MAX_VELOCITY: Velocity = Velocity {
    vx: 0.5,
    vy: 0.5,
    omega: 1.0,
};

/// 画面に返す状態
pub fn state(t: &Teleop, now: Instant) -> Value {
    json!({
        "active": t.is_active(now),
        "age": t.age(now),
        "command": velocity_json(t.command(now)),
        "twist": velocity_json(t.twist(now)),
        "scale": t.scale(),
        "max_velocity": velocity_json(t.max_velocity),
        "timeout": t.timeout().as_secs_f64(),
    })
}

#[juiz_component_container(
    description = "Teleoperation: turns keyboard / gamepad input from the browser into Twist2D"
    arguments = {
        default = {
            max_velocity = { vx = 0.5, vy = 0.5, omega = 1.0 }
            scale = 0.5
            timeout = 0.5
        }
        description = {
            max_velocity = "Velocity at full input and scale 1: {vx [m/s], vy [m/s], omega [rad/s]}. vy is used only by omnidirectional robots"
            scale = "Initial speed scale (0.1 to 1). The browser can change it"
            timeout = "Output zero when no input comes for this time [s]"
        }
    }
)]
fn teleop_twist(
    _name: String,
    max_velocity: Value,
    scale: f64,
    timeout: f64,
) -> JuizResult<Box<Teleop>> {
    let max = read_velocity(&max_velocity, DEFAULT_MAX_VELOCITY).map_err(|e| anyhow!(err(e)))?;
    let t = Teleop::new(max, scale, timeout).map_err(|e| anyhow!(err(e)))?;
    Ok(Box::new(t))
}

#[juiz_component_container_process(
    container_type = "teleop_twist"
    description = "Velocity to send now (zero when the input has stopped). Bind to main_loop_ec and publish to cmd_vel"
)]
fn teleop_twist_output(container: &mut ContainerImpl<Teleop>) -> JuizResult<Twist2D> {
    let v = container.twist(Instant::now());
    Ok(Twist2D {
        linear: Vector2 { x: v.vx, y: v.vy },
        angular: v.omega,
    })
}

#[juiz_component_container_process(
    container_type = "teleop_twist"
    description = "Write the current input. Each axis is -1 to 1 (vx forward, vy left, omega counterclockwise)"
    arguments = {
        default = {
            vx = 0.0
            vy = 0.0
            omega = 0.0
        }
    }
)]
fn teleop_twist_set_command(
    container: &mut ContainerImpl<Teleop>,
    vx: f64,
    vy: f64,
    omega: f64,
) -> JuizResult<Value> {
    let now = Instant::now();
    container.set_command(Velocity { vx, vy, omega }, now);
    Ok(state(container, now))
}

#[juiz_component_container_process(
    container_type = "teleop_twist"
    description = "Change the speed scale (0.1 to 1)"
    arguments = { default = { scale = 0.5 } }
)]
fn teleop_twist_set_scale(container: &mut ContainerImpl<Teleop>, scale: f64) -> JuizResult<Value> {
    container.set_scale(scale);
    Ok(state(container, Instant::now()))
}

#[juiz_component_container_process(
    container_type = "teleop_twist"
    description = "Stop now (output zero until the next input)"
)]
fn teleop_twist_stop(container: &mut ContainerImpl<Teleop>) -> JuizResult<Value> {
    container.stop();
    Ok(state(container, Instant::now()))
}

#[juiz_component_container_process(
    container_type = "teleop_twist"
    description = "Current input, output velocity, scale and settings"
)]
fn teleop_twist_get_state(container: &ContainerImpl<Teleop>) -> JuizResult<Value> {
    Ok(state(container, Instant::now()))
}

juiz_component_manifest!(
    component_name = "teleop_twist"
    containers = {
        teleop_twist = [
            teleop_twist_output,
            teleop_twist_set_command,
            teleop_twist_set_scale,
            teleop_twist_stop,
            teleop_twist_get_state
        ]
    }
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_max_velocity() {
        let v = read_velocity(&json!({"vx": 0.3}), DEFAULT_MAX_VELOCITY).unwrap();
        assert_eq!(v.vx, 0.3);
        assert_eq!(v.omega, DEFAULT_MAX_VELOCITY.omega);
        assert_eq!(
            read_velocity(&Value::Null, DEFAULT_MAX_VELOCITY).unwrap(),
            DEFAULT_MAX_VELOCITY
        );
        assert!(read_velocity(&json!({"x": 1.0}), DEFAULT_MAX_VELOCITY).is_err());
        assert!(read_velocity(&json!({"vx": "fast"}), DEFAULT_MAX_VELOCITY).is_err());
        assert!(read_velocity(&json!(1.0), DEFAULT_MAX_VELOCITY).is_err());
    }

    #[test]
    fn state_has_twist() {
        let mut t = Teleop::new(DEFAULT_MAX_VELOCITY, 1.0, 0.5).unwrap();
        let now = Instant::now();
        t.set_command(
            Velocity {
                vx: 1.0,
                vy: 0.0,
                omega: -1.0,
            },
            now,
        );
        let s = state(&t, now);
        assert_eq!(s["active"], true);
        assert_eq!(s["twist"]["vx"], 0.5);
        assert_eq!(s["twist"]["omega"], -1.0);
    }
}
