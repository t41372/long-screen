//! Per-frame layer-learning evidence (`src/core/layers.ts::LayerLearner.add/addNative`): screen-space motion
//! discontinuities accumulated across the WHOLE recording. `finish()` — the one-shot region construction that
//! reads these accumulators — stays with the adapter for now; every per-frame pixel loop lives here.
//!
//! Accumulation order and arithmetic are those of the historical adapter (f64 sums in the same order, JS
//! `Math.hypot` for motion norms) so the accumulators match bit-for-bit.

use crate::geometry::js_hypot;
use crate::pool::SyncPtr;

pub struct FieldMotion {
    pub x: f64,
    pub y: f64,
    pub support: u32,
    pub confidence: f64,
}

/// One motion field over `cols × rows` analysis cells.
pub struct Field<'a> {
    pub motions: &'a [FieldMotion],
    pub labels: &'a [u8],
    pub confidence: &'a [u8],
    pub dynamic: &'a [u8],
    pub cols: usize,
    pub rows: usize,
    pub difference: f64,
    pub unknown: bool,
}

#[inline]
fn norm(m: &FieldMotion) -> f64 {
    js_hypot(m.x, m.y)
}

/// A field carries real evidence only once some model moved more than analysis jitter and is reasonably well
/// matched; per-frame and long-baseline evidence are both held to this bar.
pub fn informative(field: &Field<'_>) -> bool {
    !field.unknown
        && field.difference >= 0.2
        && field
            .motions
            .iter()
            .any(|m| norm(m) > 1.0 && m.confidence > 0.3)
}

pub struct Learner {
    pub width: usize,
    pub height: usize,
    pub cell: usize,
    pub cols: usize,
    pub rows: usize,
    pub split: Vec<f64>,
    pub evidence: Vec<f64>,
    pub activity: Vec<f64>,
    pub observations: Vec<f64>,
    pub row_fixed: Vec<f64>,
    pub row_moving: Vec<f64>,
    pub informative_frames: u32,
    pub row_change: Vec<f64>,
    pub col_change: Vec<f64>,
    pub col_mean: Vec<f64>,
    pub col_gain: Vec<f64>,
    pub horizontal_gain: Vec<f64>,
    /// Native-resolution statistics, allocated on the first native pair.
    pub native_row_change: Vec<f64>,
    pub native_col_change: Vec<f64>,
    pub native_col_mean: Vec<f64>,
    pub native_frames: u32,
    pub native_width: usize,
    pub native_height: usize,
}

impl Learner {
    pub fn new(width: usize, height: usize) -> Learner {
        let cell = 24;
        let cols = width.div_ceil(cell);
        let rows = height.div_ceil(cell);
        let n = cols * rows;
        Learner {
            width,
            height,
            cell,
            cols,
            rows,
            split: vec![0.0; n * 2],
            evidence: vec![0.0; n * 2],
            activity: vec![0.0; n],
            observations: vec![0.0; n],
            row_fixed: vec![0.0; height],
            row_moving: vec![0.0; height],
            informative_frames: 0,
            row_change: vec![0.0; height],
            col_change: vec![0.0; width],
            col_mean: vec![0.0; width],
            col_gain: vec![0.0; cols],
            horizontal_gain: vec![0.0; rows],
            native_row_change: Vec::new(),
            native_col_change: Vec::new(),
            native_col_mean: Vec::new(),
            native_frames: 0,
            native_width: 0,
            native_height: 0,
        }
    }

    /// Adds one informative field. `prev`/`current` are analysis grays (width × height); the native pair is
    /// optional and must share one size (a size change is ignored, as before). Returns false when the field was
    /// not informative and nothing was accumulated.
    pub fn add(
        &mut self,
        field: &Field<'_>,
        prev: &[u8],
        current: &[u8],
        native: Option<(&[u8], &[u8], usize, usize)>,
    ) -> bool {
        if !informative(field) {
            return false;
        }
        self.informative_frames += 1;
        if let Some((a, b, w, h)) = native {
            self.add_native(a, b, w, h);
        }
        let (width, height, cols, rows) = (self.width, self.height, self.cols, self.rows);
        for y in 0..height {
            let (mut sum, mut n) = (0.0f64, 0u32);
            let mut x = 0;
            while x < width {
                let i = y * width + x;
                sum += (prev[i] as i32 - current[i] as i32).abs() as f64;
                n += 1;
                x += 3;
            }
            self.row_change[y] += sum / (n.max(1) as f64);
        }
        // Column sums walk the sampled rows in order with one accumulator per column: each column still adds
        // its samples top to bottom, so every float sum is the historical one, without a strided column walk.
        let (mut change, mut mean) = (vec![0.0f64; width], vec![0.0f64; width]);
        let mut n = 0u32;
        let mut y = 0;
        while y < height {
            let (p, c) = (
                &prev[y * width..(y + 1) * width],
                &current[y * width..(y + 1) * width],
            );
            for x in 0..width {
                change[x] += (p[x] as i32 - c[x] as i32).abs() as f64;
                mean[x] += c[x] as f64;
            }
            n += 1;
            y += 3;
        }
        for x in 0..width {
            self.col_change[x] += change[x] / n as f64;
            self.col_mean[x] += mean[x] / n as f64;
        }
        let models = field.motions.len();
        let mut columns = vec![0.0f64; cols * models];
        let mut lines = vec![0.0f64; rows * models];
        let informative_frames = self.informative_frames as f64;
        for y in 0..rows {
            for x in 0..cols {
                let i = y * cols + x;
                let py = (height - 1).min(((y as f64 + 0.5) * self.cell as f64).floor() as usize);
                // A blank gutter assigned to the zero-motion model is not a second pane. Global cuts require
                // disagreement between independently MOVING populations; fixed chrome is learned separately.
                let label = field.labels[i] as usize;
                if field.confidence[i] <= 110
                    || field.dynamic[i] != 0
                    || norm(&field.motions[label]) <= 1.0
                    || self.row_change[py] / informative_frames < 0.9
                {
                    continue;
                }
                let w = field.confidence[i] as f64 / 255.0;
                columns[x * models + label] += w;
                lines[y * models + label] += w;
            }
        }
        gain(&columns, models, &mut self.col_gain);
        gain(&lines, models, &mut self.horizontal_gain);
        for y in 0..rows {
            for x in 0..cols {
                let i = y * cols + x;
                let m = &field.motions[field.labels[i] as usize];
                let c = field.confidence[i] as f64 / 255.0;
                if c > 0.25 && field.dynamic[i] == 0 {
                    self.activity[i] += norm(m) * c;
                    self.observations[i] += c;
                }
                let neighbours = [
                    if x + 1 < cols { Some(i + 1) } else { None },
                    if y + 1 < rows { Some(i + cols) } else { None },
                ];
                for (k, j) in neighbours.iter().enumerate() {
                    let Some(j) = *j else {
                        continue;
                    };
                    if field.dynamic[i] != 0 || field.dynamic[j] != 0 {
                        continue;
                    }
                    let weight = c.min(field.confidence[j] as f64 / 255.0);
                    if weight < 0.25 {
                        continue;
                    }
                    let other = &field.motions[field.labels[j] as usize];
                    let disagreement = js_hypot(m.x - other.x, m.y - other.y);
                    self.evidence[i * 2 + k] += weight;
                    if disagreement > 1.8 {
                        self.split[i * 2 + k] += weight;
                    }
                }
            }
        }
        // Sub-cell horizontal chrome boundaries: accumulate pixel evidence rather than cropping whole blocks.
        // The strongest-support moving model (Array#sort is stable, so ties keep motion order).
        let mut moving: Option<&FieldMotion> = None;
        for m in field.motions {
            if norm(m) > 1.0 && m.support >= 4 && moving.is_none_or(|best| m.support > best.support)
            {
                moving = Some(m);
            }
        }
        if let Some(moving) = moving {
            let dx = crate::geometry::js_round(moving.x) as i64;
            let dy = crate::geometry::js_round(moving.y) as i64;
            let (w, h) = (width as i64, height as i64);
            for y in 2..(h - 2).max(2) {
                let mut x = 2i64;
                while x < w - 2 {
                    if x + dx < 1 || x + dx >= w - 1 || y + dy < 1 || y + dy >= h - 1 {
                        x += 4;
                        continue;
                    }
                    let i = (y * w + x) as usize;
                    let stationary = (prev[i] as i32 - current[i] as i32).abs();
                    let motion =
                        (prev[((y + dy) * w + x + dx) as usize] as i32 - current[i] as i32).abs();
                    if stationary + 6 < motion {
                        self.row_fixed[y as usize] += 1.0;
                    }
                    if motion + 6 < stationary {
                        self.row_moving[y as usize] += 1.0;
                    }
                    x += 4;
                }
            }
        }
        true
    }

    fn add_native(&mut self, a: &[u8], b: &[u8], w: usize, h: usize) {
        if self.native_row_change.is_empty() {
            self.native_row_change = vec![0.0; h];
            self.native_col_change = vec![0.0; w];
            self.native_col_mean = vec![0.0; w];
            self.native_width = w;
            self.native_height = h;
        }
        if w != self.native_width || h != self.native_height {
            // The adapter only ever fed one native size per run; a mismatch here is a caller error.
            return;
        }
        self.native_frames += 1;
        let step = (w / 480).max(1);
        let vstep = (h / 300).max(1);
        // Rows and columns are independent accumulators, so both passes are split across the pool; within a row
        // or column the samples are added in the historical order, so every float sum is unchanged.
        let sample = |i: usize| {
            ((a[i] as i32 - b[i] as i32).abs()
                + (a[i + 1] as i32 - b[i + 1] as i32).abs()
                + (a[i + 2] as i32 - b[i + 2] as i32).abs()) as f64
                / 3.0
        };
        let rows_out = SyncPtr(self.native_row_change.as_mut_ptr());
        let chunks = crate::pool::chunks_for(h * w.div_ceil(step), 32 * 1024);
        crate::pool::par_for(chunks, |c| {
            for y in crate::pool::split(h, chunks, c)..crate::pool::split(h, chunks, c + 1) {
                let (mut sum, mut n) = (0.0f64, 0u32);
                let mut x = 0;
                while x < w {
                    sum += sample((y * w + x) * 4);
                    n += 1;
                    x += step;
                }
                // SAFETY: row `y` belongs to this chunk alone.
                unsafe { *rows_out.get().add(y) += sum / (n.max(1) as f64) };
            }
        });
        let samples = h.div_ceil(vstep);
        let (mut change, mut mean) = (vec![0.0f64; w], vec![0.0f64; w]);
        let (change_out, mean_out) = (SyncPtr(change.as_mut_ptr()), SyncPtr(mean.as_mut_ptr()));
        let chunks = crate::pool::chunks_for(w * samples, 32 * 1024);
        crate::pool::par_for(chunks, |c| {
            let (x0, x1) = (
                crate::pool::split(w, chunks, c),
                crate::pool::split(w, chunks, c + 1),
            );
            // SAFETY: columns `x0..x1` belong to this chunk alone.
            let (change, mean) = unsafe {
                (
                    std::slice::from_raw_parts_mut(change_out.get().add(x0), x1 - x0),
                    std::slice::from_raw_parts_mut(mean_out.get().add(x0), x1 - x0),
                )
            };
            let mut y = 0;
            while y < h {
                for x in x0..x1 {
                    let i = (y * w + x) * 4;
                    change[x - x0] += sample(i);
                    mean[x - x0] += (b[i] as f64 + b[i + 1] as f64 + b[i + 2] as f64) / 3.0;
                }
                y += vstep;
            }
        });
        let n = samples.max(1) as f64;
        for x in 0..w {
            self.native_col_change[x] += change[x] / n;
            self.native_col_mean[x] += mean[x] / n;
        }
    }
}

/// Split gain of a run of bins (`bins[k * models + m]`): for every cut position k, how much better the best
/// single model on each side explains its side than the best model explains everything, normalised by weight.
fn gain(bins: &[f64], models: usize, output: &mut [f64]) {
    let count = output.len();
    let mut total = vec![0.0f64; models];
    let mut left = vec![0.0f64; models];
    let mut weight = 0.0f64;
    for k in 0..count {
        for m in 0..models {
            total[m] += bins[k * models + m];
            weight += bins[k * models + m];
        }
    }
    if weight < 10.0 {
        return;
    }
    // Math.max(...total): NaN-free here, and -Infinity for zero models exactly like the spread call.
    let all = total.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    for k in 1..count {
        let (mut a, mut b) = (0.0f64, 0.0f64);
        for m in 0..models {
            left[m] += bins[(k - 1) * models + m];
            a = a.max(left[m]);
            b = b.max(total[m] - left[m]);
        }
        output[k] += (a + b - all) / weight;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uninformative_fields_leave_every_accumulator_untouched() {
        let mut learner = Learner::new(48, 24);
        let motions = [FieldMotion {
            x: 0.0,
            y: 0.0,
            support: 10,
            confidence: 1.0,
        }];
        let cells = learner.cols * learner.rows;
        let field = Field {
            motions: &motions,
            labels: &vec![0u8; cells],
            confidence: &vec![255u8; cells],
            dynamic: &vec![0u8; cells],
            cols: learner.cols,
            rows: learner.rows,
            difference: 1.0,
            unknown: false,
        };
        let gray = vec![7u8; 48 * 24];
        assert!(!learner.add(&field, &gray, &gray, None));
        assert_eq!(learner.informative_frames, 0);
        assert!(learner.row_change.iter().all(|&v| v == 0.0));
    }
}
