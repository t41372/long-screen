//! Corner detection and binary descriptors on analysis-resolution grey images.
//!
//! The scoring is the minimum eigenvalue of the 3×3 structure tensor computed from exact integer
//! prefix sums; ties and ordering follow the historical implementation so keyframe words, matches
//! and downstream motion hypotheses are reproducible across releases.

use crate::geometry::{js_round, Rect, Rng};
use std::sync::OnceLock;

pub const DESCRIPTOR_WORDS: usize = 8;
pub const MAX_FEATURES_DEFAULT: usize = 480;

#[derive(Clone, Debug, PartialEq)]
pub struct Feature {
    pub x: i32,
    pub y: i32,
    pub score: f64,
    pub descriptor: [u32; DESCRIPTOR_WORDS],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Match {
    pub a: u32,
    pub b: u32,
    pub distance: u16,
    pub unique: bool,
}

/// Deterministic BRIEF sampling pairs: 256 × (ax, ay, bx, by), each coordinate in −9..=9.
fn pairs() -> &'static [[i32; 4]; 256] {
    static PAIRS: OnceLock<[[i32; 4]; 256]> = OnceLock::new();
    PAIRS.get_or_init(|| {
        let mut rng = Rng::new(0x0abc_7361);
        let mut table = [[0i32; 4]; 256];
        for pair in table.iter_mut() {
            for coord in pair.iter_mut() {
                let sum = rng.next_f64() + rng.next_f64() + rng.next_f64() - 1.5;
                *coord = js_round(sum * 6.0);
            }
        }
        table
    })
}

/// 3×3 binomial blur; the one-pixel border is copied unchanged.
pub fn smooth(gray: &[u8], width: usize, height: usize, out: &mut [u8]) {
    out[..width * height].copy_from_slice(&gray[..width * height]);
    if width < 3 || height < 3 {
        return;
    }
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let i = y * width + x;
            let a = &gray;
            let sum = a[i - width - 1] as u32
                + 2 * a[i - width] as u32
                + a[i - width + 1] as u32
                + 2 * a[i - 1] as u32
                + 4 * a[i] as u32
                + 2 * a[i + 1] as u32
                + a[i + width - 1] as u32
                + 2 * a[i + width] as u32
                + a[i + width + 1] as u32;
            out[i] = (sum >> 4) as u8;
        }
    }
}

struct Candidate {
    x: i32,
    y: i32,
    score: f64,
}

/// Spatially balanced minimum-eigenvalue corners with 256-bit BRIEF descriptors, strongest first.
pub fn extract_features(
    gray: &[u8],
    width: usize,
    height: usize,
    max_features: usize,
    roi: Option<Rect>,
) -> Vec<Feature> {
    let mut d = vec![0u8; width * height];
    smooth(gray, width, height, &mut d);
    let (w, h) = (width, height);
    if w < 23 || h < 23 {
        return Vec::new();
    }
    // Summed-area tensors over the interior gradients; i64 is exact for any frame the analysis path produces.
    let stride = w + 1;
    let length = stride * (h + 1);
    let mut tx = vec![0i64; length];
    let mut ty = vec![0i64; length];
    let mut txy = vec![0i64; length];
    for y in 1..h - 1 {
        let (mut xx, mut yy, mut xy) = (0i64, 0i64, 0i64);
        for x in 1..w - 1 {
            let i = y * w + x;
            let gx = d[i + 1] as i64 - d[i - 1] as i64;
            let gy = d[i + w] as i64 - d[i - w] as i64;
            xx += gx * gx;
            yy += gy * gy;
            xy += gx * gy;
            let j = (y + 1) * stride + x + 1;
            tx[j] = tx[j - stride] + xx;
            ty[j] = ty[j - stride] + yy;
            txy[j] = txy[j - stride] + xy;
        }
    }
    const CELL: usize = 28;
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut local: Vec<(i32, i32, f64)> = Vec::with_capacity(CELL * CELL);
    let mut by = 11;
    while by < h - 11 {
        let mut bx = 11;
        while bx < w - 11 {
            local.clear();
            for y in by..(h - 11).min(by + CELL) {
                for x in bx..(w - 11).min(bx + CELL) {
                    if let Some(r) = roi {
                        if !r.contains(x as f64, y as f64) {
                            continue;
                        }
                    }
                    let a = (y - 1) * stride + x - 1;
                    let b = a + 3;
                    let c = a + 3 * stride;
                    let e = c + 3;
                    let xx = (tx[e] - tx[b] - tx[c] + tx[a]) as f64;
                    let yy = (ty[e] - ty[b] - ty[c] + ty[a]) as f64;
                    let xy = (txy[e] - txy[b] - txy[c] + txy[a]) as f64;
                    let score = (xx + yy - ((xx - yy) * (xx - yy) + 4.0 * xy * xy).sqrt()) / 2.0;
                    if score > 100.0 {
                        local.push((x as i32, y as i32, score));
                    }
                }
            }
            // Three stable argmax passes with a 6px suppression radius, first maximum wins ties.
            for _ in 0..3 {
                let mut best: Option<usize> = None;
                let mut score = 100.0;
                for (i, c) in local.iter().enumerate() {
                    if c.2 > score {
                        best = Some(i);
                        score = c.2;
                    }
                }
                let Some(best) = best else { break };
                let (x, y) = (local[best].0, local[best].1);
                candidates.push(Candidate { x, y, score });
                for c in local.iter_mut() {
                    if (c.0 - x).pow(2) + (c.1 - y).pow(2) <= 36 {
                        c.2 = 0.0;
                    }
                }
            }
            bx += CELL;
        }
        by += CELL;
    }
    candidates.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    candidates.truncate(max_features);
    let table = pairs();
    candidates
        .into_iter()
        .map(|c| {
            let mut descriptor = [0u32; DESCRIPTOR_WORDS];
            for (bit, [ax, ay, bx, by]) in table.iter().enumerate() {
                let p = ((c.y + ay) as usize) * w + (c.x + ax) as usize;
                let q = ((c.y + by) as usize) * w + (c.x + bx) as usize;
                if d[p] < d[q] {
                    descriptor[bit >> 5] |= 1 << (bit & 31);
                }
            }
            Feature {
                x: c.x,
                y: c.y,
                score: c.score,
                descriptor,
            }
        })
        .collect()
}

#[inline]
pub fn hamming(a: &[u32; DESCRIPTOR_WORDS], b: &[u32; DESCRIPTOR_WORDS]) -> u32 {
    a.iter().zip(b).map(|(x, y)| (x ^ y).count_ones()).sum()
}

/// Mutual-nearest distinct matches plus explicitly flagged ambiguous alternatives, in `a` order.
pub fn match_features(a: &[Feature], b: &[Feature], include_ambiguous: bool) -> Vec<Match> {
    if a.is_empty() || b.is_empty() {
        return Vec::new();
    }
    let mut best_a = vec![-1i32; a.len()];
    let mut best_dist = vec![257u32; a.len()];
    let mut second = vec![257u32; a.len()];
    let mut alt = vec![-1i32; a.len()];
    let mut best_b = vec![-1i32; b.len()];
    let mut dist_b = vec![257u32; b.len()];
    for (i, fa) in a.iter().enumerate() {
        for (j, fb) in b.iter().enumerate() {
            let d = hamming(&fa.descriptor, &fb.descriptor);
            if d < best_dist[i] {
                second[i] = best_dist[i];
                alt[i] = best_a[i];
                best_dist[i] = d;
                best_a[i] = j as i32;
            } else if d < second[i] {
                second[i] = d;
                alt[i] = j as i32;
            }
            if d < dist_b[j] {
                dist_b[j] = d;
                best_b[j] = i as i32;
            }
        }
    }
    let mut out = Vec::new();
    for i in 0..a.len() {
        let j = best_a[i];
        if j < 0 || best_dist[i] > 72 {
            continue;
        }
        let unique = best_b[j as usize] == i as i32
            && (best_dist[i] as f64) < second[i] as f64 * 0.82
            && second[i] - best_dist[i] >= 4;
        if unique {
            out.push(Match {
                a: i as u32,
                b: j as u32,
                distance: best_dist[i] as u16,
                unique: true,
            });
        } else if include_ambiguous && best_dist[i] < 45 {
            out.push(Match {
                a: i as u32,
                b: j as u32,
                distance: best_dist[i] as u16,
                unique: false,
            });
            let k = alt[i];
            if k >= 0 && second[i] < best_dist[i] + 8 {
                out.push(Match {
                    a: i as u32,
                    b: k as u32,
                    distance: second[i] as u16,
                    unique: false,
                });
            }
        }
    }
    out
}

/// Four independent 12-bit vocabulary bands per descriptor; deduplicated in first-seen order.
pub fn feature_words(descriptors: &[[u32; DESCRIPTOR_WORDS]]) -> Vec<u32> {
    let mut words = Vec::new();
    let mut seen = [0u64; 256]; // 4 bands × 4096 words
    for d in descriptors {
        for k in 0..4 {
            let word = ((k as u32) << 12) | ((d[k * 2] ^ (d[k * 2 + 1] >> 8)) & 4095);
            let (slot, bit) = ((word >> 6) as usize, 1u64 << (word & 63));
            if seen[slot] & bit == 0 {
                seen[slot] |= bit;
                words.push(word);
            }
        }
    }
    words
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_table_is_bounded_and_stable() {
        let table = pairs();
        assert!(table.iter().flatten().all(|c| (-9..=9).contains(c)));
        assert_eq!(table[0], pairs()[0]);
    }

    #[test]
    fn textured_image_yields_ordered_features() {
        let (w, h) = (200usize, 160usize);
        let mut rng = Rng::new(97);
        let gray: Vec<u8> = (0..w * h).map(|_| (rng.next_f64() * 256.0) as u8).collect();
        let features = extract_features(&gray, w, h, 480, None);
        assert!(features.len() > 50);
        assert!(features.windows(2).all(|p| p[0].score >= p[1].score));
        let matches = match_features(&features, &features, true);
        assert!(matches.iter().filter(|m| m.unique).count() >= features.len() / 2);
    }
}
