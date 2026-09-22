//! Integer/float conventions shared with the adapter. JavaScript's `Math.round` rounds halves toward
//! +∞ and `Math.floor(x + .5)` does not (it fails just below a half), so the exact form is spelled out.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    #[inline]
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }
}

/// `Math.round`: nearest integer, halves toward +∞.
#[inline]
pub fn js_round(value: f64) -> i32 {
    let floor = value.floor();
    let rounded = if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    };
    rounded as i32
}

#[inline]
pub fn js_floor(value: f64) -> i32 {
    value.floor() as i32
}

#[inline]
pub fn js_ceil(value: f64) -> i32 {
    value.ceil() as i32
}

/// `Math.hypot(x, y)` as V8 and JavaScriptCore compute it: scale by the larger magnitude, Kahan-sum the
/// squares, multiply back. Not the correctly rounded libm `hypot`; poses compared against `dmin` and sorted
/// by distance must round exactly as the historical adapter did.
#[inline]
pub fn js_hypot(x: f64, y: f64) -> f64 {
    let (ax, ay) = (x.abs(), y.abs());
    if ax.is_infinite() || ay.is_infinite() {
        return f64::INFINITY;
    }
    if ax.is_nan() || ay.is_nan() {
        return f64::NAN;
    }
    let max = ax.max(ay);
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0f64;
    let mut compensation = 0.0f64;
    for v in [ax, ay] {
        let n = v / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// Xorshift32 with the exact `| 0` / `>>> 0` semantics of `src/core/math.ts::rng`.
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng(seed)
    }
    pub fn next_f64(&mut self) -> f64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x as f64 / 4294967296.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_matches_javascript() {
        assert_eq!(js_round(0.5), 1);
        assert_eq!(js_round(-0.5), 0);
        assert_eq!(js_round(-1.5), -1);
        assert_eq!(js_round(0.49999999999999994), 0);
        assert_eq!(js_round(-0.5000000000000001), -1);
        assert_eq!(js_round(2.5), 3);
    }

    #[test]
    fn rng_sequence_is_deterministic() {
        let mut a = Rng::new(0x9e3779b9);
        let mut b = Rng::new(0x9e3779b9);
        for _ in 0..1000 {
            assert_eq!(a.next_f64(), b.next_f64());
        }
    }

    #[test]
    fn hypot_handles_exact_and_degenerate_inputs() {
        assert_eq!(js_hypot(3.0, 4.0), 5.0);
        assert_eq!(js_hypot(0.0, 0.0), 0.0);
        assert_eq!(js_hypot(-7.0, 0.0), 7.0);
        assert_eq!(js_hypot(f64::INFINITY, f64::NAN), f64::INFINITY);
        assert!(js_hypot(1.0, f64::NAN).is_nan());
    }
}
