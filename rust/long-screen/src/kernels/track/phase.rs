//! A low-contrast phase rescue needs independent, spatially distributed feature support.
//! The caller still attempts anchor/relocalization first. Only an actually used rescue enables
//! an interior registration window; that window never changes the output region or its origin.
use crate::kernels::features::Feature;
use crate::kernels::geometry::Rect;
use crate::kernels::motion::{Audit, MatchPoints, Motion};

pub(super) fn supports_translation(
    error: f64,
    rival: f64,
    motion: &Motion,
    audit: &Audit,
    matches: &[MatchPoints],
    roi: Rect,
) -> bool {
    if !error.is_finite()
        || !rival.is_finite()
        || error >= 8.0
        || rival <= error * 2.0
        || rival < error + 4.0
        || motion.unique < 24
        || motion.ambiguous
        || audit.overlap < 0.5
        || audit.agreement < 0.8
        || audit.agreeing < 12
        || roi.width <= 0.0
        || roi.height <= 0.0
    {
        return false;
    }
    let mut occupied = 0u16;
    let mut count = 0;
    let (mut x0, mut y0, mut x1, mut y1) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for p in matches {
        if !p.unique
            || (p.ax - p.bx - motion.x).abs() > 2.0
            || (p.ay - p.by - motion.y).abs() > 2.0
            || !roi.contains(p.bx, p.by)
        {
            continue;
        }
        count += 1;
        x0 = x0.min(p.bx);
        y0 = y0.min(p.by);
        x1 = x1.max(p.bx);
        y1 = y1.max(p.by);
        let x = (((p.bx - roi.x) * 4.0 / roi.width) as usize).min(3);
        let y = (((p.by - roi.y) * 4.0 / roi.height) as usize).min(3);
        occupied |= 1 << (y * 4 + x);
    }
    count >= 24
        && occupied.count_ones() >= 6
        && x1 - x0 >= roi.width * 0.4
        && y1 - y0 >= roi.height * 0.4
}

/// Ignore empty capture padding, then reserve an interior with substantial texture.
pub fn registration_support(rect: Rect, features: &[Feature], f: f64) -> Option<Rect> {
    if features.len() < 64 {
        return None;
    }
    let (mut x0, mut y0, mut x1, mut y1) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for p in features {
        let (x, y) = (p.x as f64 * f, p.y as f64 * f);
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
    }
    if x1 - x0 < rect.width * 0.4 || y1 - y0 < rect.height * 0.4 {
        return None;
    }
    x0 = (x0 - 2.0 * f).max(rect.x);
    y0 = (y0 - 2.0 * f).max(rect.y);
    x1 = (x1 + 2.0 * f).min(rect.x + rect.width);
    y1 = (y1 + 2.0 * f).min(rect.y + rect.height);
    let inset = (x1 - x0).min(y1 - y0) * 0.1;
    let (x, y, right, bottom) = (
        (x0 + inset).ceil(),
        (y0 + inset).ceil(),
        (x1 - inset).floor(),
        (y1 - inset).floor(),
    );
    Some(Rect {
        x,
        y,
        width: right - x,
        height: bottom - y,
    })
}

/// A sparse interior falls back to the complete registration region, without changing ownership.
pub fn registration_features(
    rect: Rect,
    support: Option<Rect>,
    own: Vec<Feature>,
    f: f64,
) -> (Rect, Vec<Feature>) {
    let Some(support) = support else {
        return (rect, own);
    };
    let kept: Vec<Feature> = own
        .iter()
        .filter(|p| support.contains(p.x as f64 * f, p.y as f64 * f))
        .cloned()
        .collect();
    if kept.len() >= 64 && kept.len() * 5 >= own.len() * 2 {
        (support, kept)
    } else {
        (rect, own)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernels::motion::{Audit, Motion};

    fn evidence() -> (Rect, Motion, Audit, Vec<MatchPoints>) {
        let roi = Rect {
            x: 0.0,
            y: 0.0,
            width: 400.0,
            height: 400.0,
        };
        let motion = Motion {
            x: 3.0,
            y: -5.0,
            support: 48,
            unique: 48,
            confidence: 1.0,
            error: 0.0,
            ambiguous: false,
        };
        let audit = Audit {
            error: 3.0,
            mismatch: 0.02,
            overlap: 0.9,
            samples: 1000,
            blocks: 40,
            agreeing: 38,
            agreement: 0.95,
            agreeing_error: 2.0,
        };
        let points = (0..48)
            .map(|k| {
                let bx = 35.0 + (k % 8) as f64 * 45.0;
                let by = 40.0 + (k / 8) as f64 * 60.0;
                MatchPoints {
                    ax: bx + 3.0,
                    ay: by - 5.0,
                    bx,
                    by,
                    unique: true,
                }
            })
            .collect();
        (roi, motion, audit, points)
    }

    #[test]
    fn support_keeps_the_output_origin_and_falls_back_for_sparse_interiors() {
        let rect = Rect {
            x: 100.0,
            y: 200.0,
            width: 600.0,
            height: 400.0,
        };
        let features: Vec<Feature> = (0..128)
            .map(|i| Feature {
                x: 60 + (i % 16) * 16,
                y: 110 + (i / 16) * 20,
                score: 1.0,
                descriptor: [0; 8],
            })
            .collect();
        let support = registration_support(rect, &features, 2.0).unwrap();
        assert!(support.x > rect.x && support.y > rect.y);
        assert!(support.x + support.width < rect.x + rect.width);
        let (selected, kept) = registration_features(rect, Some(support), features, 2.0);
        assert_eq!(selected, support);
        assert!(kept.len() >= 64);
        let sparse = vec![Feature {
            x: 50,
            y: 100,
            score: 1.0,
            descriptor: [0; 8],
        }];
        let (selected, kept) = registration_features(rect, Some(support), sparse.clone(), 2.0);
        assert_eq!(selected, rect);
        assert_eq!(kept, sparse);
        assert!(registration_support(rect, &kept, 2.0).is_none());
    }

    #[test]
    fn phase_support_rejects_ambiguous_and_local_evidence() {
        let (roi, motion, audit, mut points) = evidence();
        assert!(supports_translation(
            3.2, 10.0, &motion, &audit, &points, roi
        ));
        for (winner, rival) in [
            (f64::INFINITY, 10.0),
            (3.0, f64::INFINITY),
            (8.0, 20.0),
            (3.0, 6.5),
            (0.0, 2.0),
        ] {
            assert!(!supports_translation(
                winner, rival, &motion, &audit, &points, roi
            ));
        }
        for p in &mut points {
            p.unique = false;
        }
        assert!(!supports_translation(
            3.2, 10.0, &motion, &audit, &points, roi
        ));
        for p in &mut points {
            p.unique = true;
            p.bx = 20.0;
            p.ax = 23.0;
        }
        assert!(!supports_translation(
            3.2, 10.0, &motion, &audit, &points, roi
        ));
        let (_, _, _, mut points) = evidence();
        for p in &mut points {
            p.ax += 8.0;
        }
        assert!(!supports_translation(
            3.2, 10.0, &motion, &audit, &points, roi
        ));
    }
}
