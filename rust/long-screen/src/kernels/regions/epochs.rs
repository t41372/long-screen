//! Ownership that changes during a recording without the region moving ([`RegionEpoch`]). A region keeps one screen
//! rect for the whole run, so every rect-relative coordinate (keyframe patches, voting boxes, reveal cells,
//! screen-fixed cells) means the same thing in every frame; what changes from one epoch to the next is which of its
//! pixels it owns, expressed as extra exclusions. A browser's address bar that collapses mid-recording (issue #1) is
//! two epochs: the page owns the bar's lower rows only after the collapse.

use crate::kernels::geometry::Rect;

/// Extra exclusions a region carries from frame `from` on, until the next epoch of the same region starts
/// (`Region.epochs` in the regions row). Before a region's first epoch it has no extra exclusions.
#[derive(Clone, Debug, PartialEq)]
pub struct RegionEpoch {
    pub from: u32,
    pub exclusions: Vec<Rect>,
}

/// The extra exclusions in effect at `frame`: those of the last epoch starting at or before it.
pub fn extra_exclusions(epochs: &[RegionEpoch], frame: u32) -> &[Rect] {
    epochs
        .iter()
        .rev()
        .find(|e| e.from <= frame)
        .map_or(&[], |e| e.exclusions.as_slice())
}

/// A region's exclusions at `frame`: its own, then the extra ones of the epoch in effect.
pub fn exclusions_at(base: &[Rect], epochs: &[RegionEpoch], frame: u32) -> Vec<Rect> {
    base.iter()
        .chain(extra_exclusions(epochs, frame))
        .copied()
        .collect()
}

/// The frames at which any of the regions' ownership may change, ascending and unique, always starting with 0: one
/// atlas per start. Regions without epochs give exactly `[0]`.
pub fn epoch_starts<'a>(epochs: impl IntoIterator<Item = &'a [RegionEpoch]>) -> Vec<u32> {
    let mut starts: Vec<u32> = std::iter::once(0)
        .chain(epochs.into_iter().flatten().map(|e| e.from))
        .collect();
    starts.sort_unstable();
    starts.dedup();
    starts
}

/// The index into [`epoch_starts`] of the epoch `frame` falls in.
pub fn epoch_index(starts: &[u32], frame: u32) -> usize {
    starts.partition_point(|&s| s <= frame).saturating_sub(1)
}

/// A top band that collapses once during the recording and stays collapsed: before frame `from` it reached down
/// to native row `tall`, from then on only to `short`, and the page shows in between.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Collapse {
    pub from: u32,
    pub tall: f64,
    pub short: f64,
}

/// Frames on each side of a collapse, at least: a band must hold its height for a while to be told from noise.
const COLLAPSE_SEGMENT: usize = 8;
/// The smallest collapse, in native pixels: about one line of text.
const COLLAPSE_STEP: f64 = 16.0;
/// Share of the frames after the collapse that must show the page above the band's old edge.
const COLLAPSE_OPEN: f64 = 0.6;

fn quantile(values: &mut [u32], q: f64) -> u32 {
    values.sort_unstable();
    values[((values.len() - 1) as f64 * q).floor() as usize]
}

/// Finds a top band that collapses once, from the first row where the moving page started in each frame (`series`:
/// consecutive informative frames and that row, in analysis rows; `Learner::last_top_moving`). While the band is
/// tall, nothing moves above its edge: the 5th percentile of the starting row over the frames before the split is
/// the band's edge (blank page rows only ever push the starting row further down, never up). After the collapse the
/// page shows above that edge in most frames, and the 10th percentile of the starting row afterwards is the new,
/// shorter edge. The split is the one after which the most frames show the page above the old edge, moved on to the
/// first frame that does; the step must be at least `COLLAPSE_STEP` native pixels, each side at least
/// `COLLAPSE_SEGMENT` frames and a tenth of the series, and at least `COLLAPSE_OPEN` of the frames after it must show
/// the page above the old edge.
///
/// A band that grows (a page header pinning under the status bar, new_ip_4 at its 70th informative frame, 37 → 75
/// analysis rows) is not a collapse, and neither is a series whose starting row keeps falling to the top of the
/// region in the frames before any split (the translucent bars and page headers of new_ip_1, new_ip_3 and pub_6,
/// where it ranges over 2–130 rows): their 5th percentile leaves no room for a step.
pub fn band_collapse(series: &[(u32, u32)], factor: u32) -> Option<Collapse> {
    let n = series.len();
    let segment = COLLAPSE_SEGMENT.max(n / 10);
    if n < 2 * segment {
        return None;
    }
    let f = factor.max(1) as f64;
    let step = (COLLAPSE_STEP / f).ceil() as u32;
    let mut best: Option<(f64, usize, u32, u32)> = None;
    for k in segment..=n - segment {
        let mut before: Vec<u32> = series[..k].iter().map(|s| s.1).collect();
        let mut after: Vec<u32> = series[k..].iter().map(|s| s.1).collect();
        let tall = quantile(&mut before, 0.05);
        let open = after.iter().filter(|&&m| m + 1 < tall).count() as f64 / after.len() as f64;
        let short = quantile(&mut after, 0.10);
        if tall < short + step || open < COLLAPSE_OPEN {
            continue;
        }
        if best.is_none_or(|b| open > b.0) {
            best = Some((open, k, tall, short));
        }
    }
    let (_, k, tall, short) = best?;
    // The collapse starts with the first frame that shows the page above the old edge, not a few frames before it.
    let k = k + series[k..].iter().position(|s| s.1 + 1 < tall)?;
    (n - k >= segment).then(|| Collapse {
        from: series[k].0,
        tall: tall as f64 * f,
        short: short as f64 * f,
    })
}

/// Gives a layout the collapse as epochs: the top band (the full-width fixed region along the top) reaches down to
/// the tall edge and, from the collapse on, no longer owns the rows between the two edges; the main moving region
/// (the largest) gives those rows up before the collapse and takes them from it on. Its rect is unchanged when it
/// already reaches up to the short edge; otherwise nothing is done, as the page would need a new rect.
pub fn apply_collapse(regions: &mut [super::RegionOut], c: Collapse, native_width: f64) {
    let area = |r: &super::RegionOut| r.rect.width * r.rect.height;
    let Some(main) = (0..regions.len())
        .filter(|&i| regions[i].kind == super::Kind::Moving)
        .max_by(|&a, &b| area(&regions[a]).total_cmp(&area(&regions[b])))
    else {
        return;
    };
    let Some(band) = (0..regions.len()).find(|&i| {
        let r = &regions[i];
        r.kind == super::Kind::Fixed && r.rect.y <= 0.0 && r.rect.width >= native_width
    }) else {
        return;
    };
    let page = regions[main].rect;
    if page.y > c.short || c.tall > page.y + page.height {
        return;
    }
    let rows = |top: f64, bottom: f64, x: f64, width: f64| Rect {
        x,
        y: top,
        width,
        height: bottom - top,
    };
    {
        let b = &mut regions[band];
        b.rect.height = b.rect.height.max(c.tall);
        if let Some(crop) = b.crop.as_mut() {
            crop.height = crop.height.max(c.tall);
        }
        b.epochs = vec![RegionEpoch {
            from: c.from,
            exclusions: vec![rows(c.short, c.tall, 0.0, native_width)],
        }];
    }
    let m = &mut regions[main];
    let before = rows(page.y, c.tall, page.x, page.width);
    let after = (c.short > page.y).then(|| rows(page.y, c.short, page.x, page.width));
    m.epochs = vec![
        RegionEpoch {
            from: 0,
            exclusions: vec![before],
        },
        RegionEpoch {
            from: c.from,
            exclusions: after.into_iter().collect(),
        },
    ];
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(y: f64, height: f64) -> Rect {
        Rect {
            x: 0.0,
            y,
            width: 100.0,
            height,
        }
    }

    // Failure cases: a frame before the first epoch picking up its exclusions; a frame exactly at an epoch's start
    // keeping the previous one; a later epoch not replacing an earlier one; an epoch with no exclusions failing to
    // clear them; the region's own exclusions dropped or reordered; starts out of order, duplicated or missing 0;
    // a frame past the last start mapped past the end.
    #[test]
    fn exclusions_follow_the_epoch_in_effect() {
        let own = [rect(0.0, 5.0)];
        let epochs = [
            RegionEpoch {
                from: 10,
                exclusions: vec![rect(20.0, 4.0)],
            },
            RegionEpoch {
                from: 30,
                exclusions: Vec::new(),
            },
        ];
        assert_eq!(exclusions_at(&own, &epochs, 0), vec![own[0]]);
        assert_eq!(exclusions_at(&own, &epochs, 9), vec![own[0]]);
        assert_eq!(
            exclusions_at(&own, &epochs, 10),
            vec![own[0], rect(20.0, 4.0)]
        );
        assert_eq!(
            exclusions_at(&own, &epochs, 29),
            vec![own[0], rect(20.0, 4.0)]
        );
        assert_eq!(exclusions_at(&own, &epochs, 30), vec![own[0]]);
        assert_eq!(exclusions_at(&own, &[], 1_000), vec![own[0]]);
    }

    #[test]
    fn starts_are_sorted_unique_and_begin_at_zero() {
        let a = [
            RegionEpoch {
                from: 30,
                exclusions: Vec::new(),
            },
            RegionEpoch {
                from: 0,
                exclusions: Vec::new(),
            },
        ];
        let b = [RegionEpoch {
            from: 30,
            exclusions: Vec::new(),
        }];
        let starts = epoch_starts([&a[..], &b[..], &[][..]]);
        assert_eq!(starts, vec![0, 30]);
        assert_eq!(epoch_starts([&[][..]]), vec![0]);
        assert_eq!(epoch_index(&starts, 0), 0);
        assert_eq!(epoch_index(&starts, 29), 0);
        assert_eq!(epoch_index(&starts, 30), 1);
        assert_eq!(epoch_index(&starts, u32::MAX), 1);
        assert_eq!(epoch_index(&[0], 7), 0);
    }

    fn frames(levels: &[(usize, u32)]) -> Vec<(u32, u32)> {
        let mut out = Vec::new();
        for &(n, level) in levels {
            for i in 0..n {
                // Blank page rows push the starting row down by a few rows now and then, never up.
                let gap = [0, 0, 3, 0, 9, 0, 1, 0, 0, 22][i % 10];
                out.push((out.len() as u32, level + gap));
            }
        }
        out
    }

    // Failure cases: a band that holds (new_ip_8: 58-59 rows throughout); one that grows (new_ip_4, 37 then 75);
    // a starting row that falls to the region's top now and then before any split (new_ip_1, pub_6, new_ip_3); a
    // step under one text line; a collapse too close to either end; a collapse after which the page rarely shows
    // above the old edge. And the case itself: toolbar-collapse's 96 → 48 at frame 30, at factor 1 and at 4.
    #[test]
    fn a_band_collapses_only_by_a_clear_lasting_step() {
        assert_eq!(band_collapse(&frames(&[(200, 58)]), 5), None);
        assert_eq!(band_collapse(&frames(&[(70, 37), (130, 75)]), 5), None);
        let mut noisy = frames(&[(30, 96), (20, 48)]);
        for (i, s) in noisy.iter_mut().enumerate() {
            if i % 7 == 3 {
                s.1 = 4;
            }
        }
        assert_eq!(band_collapse(&noisy, 1), None);
        assert_eq!(band_collapse(&frames(&[(30, 96), (20, 86)]), 1), None);
        assert_eq!(band_collapse(&frames(&[(5, 96), (45, 48)]), 1), None);
        assert_eq!(band_collapse(&frames(&[(45, 96), (5, 48)]), 1), None);
        let mut closed = frames(&[(30, 96), (20, 48)]);
        for s in closed.iter_mut().skip(30).step_by(2) {
            s.1 = 120;
        }
        assert_eq!(band_collapse(&closed, 1), None);
        assert_eq!(
            band_collapse(&frames(&[(30, 96), (20, 48)]), 1),
            Some(Collapse {
                from: 30,
                tall: 96.0,
                short: 48.0
            })
        );
        assert_eq!(
            band_collapse(&frames(&[(30, 24), (20, 12)]), 4),
            Some(Collapse {
                from: 30,
                tall: 96.0,
                short: 48.0
            })
        );
    }

    fn region(kind: super::super::Kind, rect: Rect) -> super::super::RegionOut {
        super::super::RegionOut {
            id: String::new(),
            name: String::new(),
            kind,
            rect,
            cells: None,
            mask: None,
            mask_width: 0,
            mask_height: 0,
            manual: false,
            unassigned: false,
            exclusions: Vec::new(),
            crop: Some(rect),
            solid: true,
            factor: 1,
            band_side: None,
            epochs: Vec::new(),
            sticky: Vec::new(),
        }
    }

    // Failure cases for giving a layout the collapse: no full-width band along the top to hand the rows to; a page
    // that starts below the short edge (it would need a new rect); a page that ends above the tall edge; the band
    // or the page left without the epochs, or the band not reaching the tall edge.
    #[test]
    fn a_collapse_moves_the_rows_between_the_band_and_the_page() {
        use super::super::Kind::{Fixed, Moving};
        let at = |x: f64, y: f64, width: f64, height: f64| Rect {
            x,
            y,
            width,
            height,
        };
        let c = Collapse {
            from: 30,
            tall: 96.0,
            short: 48.0,
        };
        let mut no_band = vec![
            region(Moving, at(0.0, 18.0, 640.0, 430.0)),
            region(Fixed, at(0.0, 0.0, 20.0, 18.0)),
        ];
        apply_collapse(&mut no_band, c, 640.0);
        assert!(no_band.iter().all(|r| r.epochs.is_empty()));
        let mut low_page = vec![
            region(Moving, at(0.0, 60.0, 640.0, 388.0)),
            region(Fixed, at(0.0, 0.0, 640.0, 18.0)),
        ];
        apply_collapse(&mut low_page, c, 640.0);
        assert!(low_page.iter().all(|r| r.epochs.is_empty()));
        let mut layout = vec![
            region(Moving, at(20.0, 18.0, 620.0, 430.0)),
            region(Fixed, at(0.0, 0.0, 640.0, 18.0)),
            region(Fixed, at(0.0, 18.0, 20.0, 430.0)),
        ];
        apply_collapse(&mut layout, c, 640.0);
        assert_eq!(layout[1].rect.height, 96.0);
        assert_eq!(layout[1].crop.unwrap().height, 96.0);
        assert_eq!(
            layout[1].epochs,
            vec![RegionEpoch {
                from: 30,
                exclusions: vec![at(0.0, 48.0, 640.0, 48.0)]
            }]
        );
        assert_eq!(
            layout[0].epochs,
            vec![
                RegionEpoch {
                    from: 0,
                    exclusions: vec![at(20.0, 18.0, 620.0, 78.0)]
                },
                RegionEpoch {
                    from: 30,
                    exclusions: vec![at(20.0, 18.0, 620.0, 30.0)]
                }
            ]
        );
        assert!(layout[2].epochs.is_empty());
    }
}
