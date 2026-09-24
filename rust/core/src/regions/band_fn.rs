//! `band()`: which stationary edge band (if any) an analysis cell falls in. Shared by `cells` (union-find join
//! rule), `construct` (region membership / band expansion) and `crops` (per-region side lookup).

#[inline]
#[allow(clippy::too_many_arguments)]
pub fn band(
    i: i64,
    cols: i64,
    cell: i64,
    width: i64,
    height: i64,
    top: i64,
    bottom: i64,
    left: i64,
    right: i64,
) -> u8 {
    let y = ((i / cols) as f64 + 0.5) * cell as f64;
    let y = y.min((height - 1) as f64);
    let x = ((i % cols) as f64 + 0.5) * cell as f64;
    let x = x.min((width - 1) as f64);
    if y < top as f64 {
        1
    } else if y >= bottom as f64 {
        2
    } else if x < left as f64 {
        3
    } else if x >= right as f64 {
        4
    } else {
        0
    }
}
