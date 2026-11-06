//! teleop の中身(juiz に依存しない)。
//!
//! ブラウザの画面が入力(各軸 -1〜1)を [`Teleop::set_command`] で書き込み、
//! EC が周期ごとに [`Teleop::twist`] で速度を読む。最後の書き込みから `timeout` 秒たつと 0 を返す。

use std::time::{Duration, Instant};

/// 速度の倍率の下限と上限
pub const SCALE_MIN: f64 = 0.1;
pub const SCALE_MAX: f64 = 1.0;

/// 各軸の速度(並進 vx・vy [m/s]、回転 omega [rad/s])
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Velocity {
    pub vx: f64,
    pub vy: f64,
    pub omega: f64,
}

impl Velocity {
    pub const ZERO: Velocity = Velocity {
        vx: 0.0,
        vy: 0.0,
        omega: 0.0,
    };
}

#[derive(Debug, Clone)]
pub struct Teleop {
    /// 倍率 1 のときの各軸の最大速度
    pub max_velocity: Velocity,
    /// 速度の倍率(SCALE_MIN〜SCALE_MAX)
    scale: f64,
    /// 入力が途切れたとみなすまでの時間
    timeout: Duration,
    /// 今の入力(各軸 -1〜1)
    command: Velocity,
    /// 最後に入力を受けた時刻。None なら止まっている
    last: Option<Instant>,
}

fn unit(v: f64) -> f64 {
    if v.is_finite() {
        v.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

impl Teleop {
    pub fn new(max_velocity: Velocity, scale: f64, timeout: f64) -> Result<Self, String> {
        for (name, v) in [
            ("vx", max_velocity.vx),
            ("vy", max_velocity.vy),
            ("omega", max_velocity.omega),
        ] {
            if !v.is_finite() || v < 0.0 {
                return Err(format!("max_velocity.{name} must be 0 or more (got {v})"));
            }
        }
        if !timeout.is_finite() || timeout <= 0.0 {
            return Err(format!("timeout must be more than 0 [s] (got {timeout})"));
        }
        let mut t = Self {
            max_velocity,
            scale: SCALE_MAX,
            timeout: Duration::from_secs_f64(timeout),
            command: Velocity::ZERO,
            last: None,
        };
        t.set_scale(scale);
        Ok(t)
    }

    pub fn scale(&self) -> f64 {
        self.scale
    }

    pub fn timeout(&self) -> Duration {
        self.timeout
    }

    /// 倍率を変える。範囲の外は端に丸める
    pub fn set_scale(&mut self, scale: f64) {
        self.scale = if scale.is_finite() {
            scale.clamp(SCALE_MIN, SCALE_MAX)
        } else {
            SCALE_MAX
        };
    }

    /// 入力を書き込む(各軸 -1〜1、範囲の外は端に丸める)
    pub fn set_command(&mut self, command: Velocity, now: Instant) {
        self.command = Velocity {
            vx: unit(command.vx),
            vy: unit(command.vy),
            omega: unit(command.omega),
        };
        self.last = Some(now);
    }

    /// すぐに止める
    pub fn stop(&mut self) {
        self.command = Velocity::ZERO;
        self.last = None;
    }

    /// 入力が生きているか(最後の入力から timeout 以内か)
    pub fn is_active(&self, now: Instant) -> bool {
        matches!(self.last, Some(t) if now.saturating_duration_since(t) <= self.timeout)
    }

    /// 最後の入力からの時間 [s]。入力が無ければ None
    pub fn age(&self, now: Instant) -> Option<f64> {
        self.last
            .map(|t| now.saturating_duration_since(t).as_secs_f64())
    }

    /// 今の入力(各軸 -1〜1)。途切れていれば 0
    pub fn command(&self, now: Instant) -> Velocity {
        if self.is_active(now) {
            self.command
        } else {
            Velocity::ZERO
        }
    }

    /// 出す速度。入力 × 最大速度 × 倍率、途切れていれば 0
    pub fn twist(&self, now: Instant) -> Velocity {
        let c = self.command(now);
        let k = self.scale;
        Velocity {
            vx: c.vx * self.max_velocity.vx * k,
            vy: c.vy * self.max_velocity.vy * k,
            omega: c.omega * self.max_velocity.omega * k,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn teleop() -> Teleop {
        Teleop::new(
            Velocity {
                vx: 0.5,
                vy: 0.2,
                omega: 1.0,
            },
            0.5,
            0.5,
        )
        .unwrap()
    }

    #[test]
    fn zero_before_any_input() {
        let t = teleop();
        assert_eq!(t.twist(Instant::now()), Velocity::ZERO);
        assert!(!t.is_active(Instant::now()));
    }

    #[test]
    fn scales_the_command() {
        let mut t = teleop();
        let now = Instant::now();
        t.set_command(
            Velocity {
                vx: 1.0,
                vy: -1.0,
                omega: 0.5,
            },
            now,
        );
        let v = t.twist(now);
        assert!((v.vx - 0.25).abs() < 1e-12);
        assert!((v.vy + 0.1).abs() < 1e-12);
        assert!((v.omega - 0.25).abs() < 1e-12);
    }

    #[test]
    fn clamps_the_command_and_scale() {
        let mut t = teleop();
        let now = Instant::now();
        t.set_command(
            Velocity {
                vx: 3.0,
                vy: f64::NAN,
                omega: -9.0,
            },
            now,
        );
        assert_eq!(
            t.command(now),
            Velocity {
                vx: 1.0,
                vy: 0.0,
                omega: -1.0
            }
        );
        t.set_scale(5.0);
        assert_eq!(t.scale(), SCALE_MAX);
        t.set_scale(0.0);
        assert_eq!(t.scale(), SCALE_MIN);
    }

    #[test]
    fn zero_after_timeout() {
        let mut t = teleop();
        let now = Instant::now();
        t.set_command(
            Velocity {
                vx: 1.0,
                vy: 0.0,
                omega: 0.0,
            },
            now,
        );
        assert!(t.twist(now + Duration::from_millis(400)).vx > 0.0);
        assert_eq!(t.twist(now + Duration::from_millis(600)), Velocity::ZERO);
        assert!(!t.is_active(now + Duration::from_millis(600)));
    }

    #[test]
    fn stop_is_immediate() {
        let mut t = teleop();
        let now = Instant::now();
        t.set_command(
            Velocity {
                vx: 1.0,
                vy: 0.0,
                omega: 1.0,
            },
            now,
        );
        t.stop();
        assert_eq!(t.twist(now), Velocity::ZERO);
        assert_eq!(t.age(now), None);
    }

    #[test]
    fn rejects_bad_settings() {
        assert!(Teleop::new(
            Velocity {
                vx: -1.0,
                vy: 0.0,
                omega: 1.0
            },
            1.0,
            0.5
        )
        .is_err());
        assert!(Teleop::new(Velocity::ZERO, 1.0, 0.0).is_err());
    }
}
