//! Region learning over a whole recording: the core's per-frame evidence accumulators
//! (`crate::kernels::layers::Learner`), the last informative native frame kept for appearance evidence, and the
//! one-shot region construction at the end — the automatic layout (`crate::kernels::regions::finish`) or a
//! hand-placed one (manual regions, plus the "unassigned" region when they leave pixels uncovered).
//!
//! The scan session owns one of these; the web page's `LayerLearner` (src/core/layers.ts) drives one directly
//! through rust/wasm/src/layers.rs for the layer-learning unit and parity tests.

use crate::kernels::geometry::Rect;
use crate::kernels::layers::{Field, Learner};
#[cfg(test)]
use crate::kernels::regions::RegionEpoch;
use crate::kernels::regions::{self, AtlasMask, AtlasRegion, FinishInput, Kind, RegionOut, Rgba};

/// Name of the region that owns whatever native pixels a hand-placed layout leaves uncovered. Region names are a
/// fixed zh vocabulary, translated only for display (src/i18n/names.ts).
pub const UNASSIGNED_NAME: &str = "未指定区域 · 屏幕坐标观察";

/// One hand-placed region from the run's settings.
#[derive(Clone, Debug, PartialEq)]
pub struct ManualRegion {
    pub name: String,
    pub kind: Kind,
    pub rect: Rect,
}

/// A native RGBA frame the learner keeps a copy of.
struct NativeFrame {
    data: Vec<u8>,
    width: usize,
    height: usize,
}

/// Layer-learning state for one run: accumulators plus the last informative native frame.
pub struct RegionLearner {
    learner: Learner,
    reference: Option<NativeFrame>,
    /// Per consecutive informative pair: the later frame and the analysis row where the moving page started at the
    /// top (`Learner::last_top_moving`), for `regions::band_collapse`.
    top_series: Vec<(u32, u32)>,
}

impl RegionLearner {
    /// A learner over a `width × height` analysis grid.
    pub fn new(width: usize, height: usize) -> RegionLearner {
        RegionLearner {
            learner: Learner::new(width, height),
            reference: None,
            top_series: Vec::new(),
        }
    }

    /// The accumulators, for hosts and tests that read them back.
    pub fn accumulators(&self) -> &Learner {
        &self.learner
    }

    /// Accumulates one field (the learner applies its own informative gate). `prev`/`current` are analysis grays;
    /// `native` is the pair of native RGBA frames with their shared size, when the host has both. When the field
    /// was accumulated and native frames were given, `current`'s native frame becomes the appearance reference
    /// `finish` samples. Returns whether the field was accumulated.
    pub fn add(
        &mut self,
        field: &Field<'_>,
        prev: &[u8],
        current: &[u8],
        native: Option<(&[u8], &[u8], usize, usize)>,
    ) -> bool {
        let informative = self.learner.add(field, prev, current, native);
        if let (true, Some((_, frame, width, height))) = (informative, native) {
            match &mut self.reference {
                Some(r) if r.width == width && r.height == height => r.data.copy_from_slice(frame),
                slot => {
                    *slot = Some(NativeFrame {
                        data: frame.to_vec(),
                        width,
                        height,
                    })
                }
            }
        }
        informative
    }

    /// [`RegionLearner::add`] for the pair of consecutive frames ending at `frame`, which also records where the
    /// moving page started at the top, so `finish` can tell a top band that collapses (issue #1).
    pub fn add_consecutive(
        &mut self,
        frame: u32,
        field: &Field<'_>,
        prev: &[u8],
        current: &[u8],
        native: Option<(&[u8], &[u8], usize, usize)>,
    ) -> bool {
        let informative = self.add(field, prev, current, native);
        if let (true, Some(row)) = (informative, self.learner.last_top_moving) {
            self.top_series.push((frame, row));
        }
        informative
    }

    /// Builds the run's regions. With `manual` regions, those (in order, each excluding every later one and every
    /// ignored one) plus an unassigned region when they leave native pixels uncovered; otherwise the automatic
    /// layout from the accumulators. `factor` is the integer analysis factor.
    pub fn finish(
        &self,
        native_width: f64,
        native_height: f64,
        manual: &[ManualRegion],
        factor: u32,
    ) -> Vec<RegionOut> {
        let l = &self.learner;
        if !manual.is_empty() {
            return manual_regions(
                manual,
                l.width,
                l.height,
                native_width,
                native_height,
                factor,
            );
        }
        fn optional(values: &[f64]) -> Option<&[f64]> {
            (!values.is_empty()).then_some(values)
        }
        let reference = self.reference.as_ref().map(|r| Rgba {
            width: r.width,
            height: r.height,
            data: &r.data,
        });
        let input = FinishInput {
            width: l.width,
            height: l.height,
            cell: l.cell,
            informative_frames: l.informative_frames as f64,
            native_frames: l.native_frames as f64,
            row_change: &l.row_change,
            col_change: &l.col_change,
            col_moving: &l.col_moving,
            col_mean: &l.col_mean,
            col_gain: &l.col_gain,
            horizontal_gain: &l.horizontal_gain,
            split: &l.split,
            evidence: &l.evidence,
            activity: &l.activity,
            observations: &l.observations,
            pixel_fixed: &l.pixel_fixed,
            pixel_moving: &l.pixel_moving,
            native_row_change: optional(&l.native_row_change),
            native_col_change: optional(&l.native_col_change),
            row_fixed: Some(&l.row_fixed),
            row_moving: Some(&l.row_moving),
            reference,
        };
        let mut out = regions::finish(&input, native_width, native_height, factor);
        if let Some(collapse) = regions::band_collapse(&self.top_series, factor) {
            regions::apply_collapse(&mut out, collapse, native_width);
        }
        out
    }
}

/// Whether some native pixel of a `native_width × native_height` frame lies in none of `rects`. An empty list
/// covers nothing.
pub fn manual_uncovered(rects: &[Rect], native_width: f64, native_height: f64) -> bool {
    if rects.is_empty() {
        return true;
    }
    let (nw, nh) = (native_width as i64, native_height as i64);
    (0..nh).any(|y| (0..nw).any(|x| !rects.iter().any(|r| r.contains(x as f64, y as f64))))
}

fn manual_regions(
    manual: &[ManualRegion],
    mask_width: usize,
    mask_height: usize,
    native_width: f64,
    native_height: f64,
    factor: u32,
) -> Vec<RegionOut> {
    let ignored: Vec<Rect> = manual
        .iter()
        .filter(|r| r.kind == Kind::Ignore)
        .map(|r| r.rect)
        .collect();
    let region =
        |id: usize, name: String, kind: Kind, rect: Rect, exclusions: Vec<Rect>| RegionOut {
            id: format!("layer-{id}"),
            name,
            kind,
            rect,
            cells: None,
            mask: None,
            mask_width,
            mask_height,
            manual: true,
            unassigned: false,
            exclusions,
            crop: None,
            solid: false,
            factor,
            band_side: None,
            epochs: Vec::new(),
            sticky: Vec::new(),
        };
    let mut out: Vec<RegionOut> = manual
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let exclusions = manual[i + 1..]
                .iter()
                .map(|later| later.rect)
                .chain(ignored.iter().copied())
                .collect();
            region(i, r.name.clone(), r.kind, r.rect, exclusions)
        })
        .collect();
    let rects: Vec<Rect> = manual.iter().map(|r| r.rect).collect();
    if manual_uncovered(&rects, native_width, native_height) {
        let full = Rect {
            x: 0.0,
            y: 0.0,
            width: native_width,
            height: native_height,
        };
        let mut unassigned = region(
            out.len(),
            UNASSIGNED_NAME.to_string(),
            Kind::Fixed,
            full,
            rects,
        );
        unassigned.unassigned = true;
        out.push(unassigned);
    }
    out
}

/// The native-resolution label plane for `regions` (0 = no region, otherwise index + 1; the first region that
/// contains a pixel owns it) and the per-code pixel counts, or `None` past 254 regions. Regions are described the
/// way the page's region rows carry them: an automatic region always has a crop (its own rect when it has none),
/// and a solid region's mask is not consulted. Each region's own exclusions apply, not its epochs'
/// ([`label_atlas_epochs`]).
pub fn label_atlas(
    regions: &[RegionOut],
    width: usize,
    height: usize,
) -> Option<(Vec<u8>, Vec<u32>)> {
    label_at(regions, width, height, None)
}

/// [`label_atlas`] with the exclusions in effect at `frame` (`None`: the regions' own only).
fn label_at(
    regions: &[RegionOut],
    width: usize,
    height: usize,
    frame: Option<u32>,
) -> Option<(Vec<u8>, Vec<u32>)> {
    let defs: Vec<AtlasRegion> = regions
        .iter()
        .map(|r| AtlasRegion {
            rect: r.rect,
            exclusions: match frame {
                Some(f) => regions::exclusions_at(&r.exclusions, &r.epochs, f),
                None => r.exclusions.clone(),
            },
            crop: if r.manual {
                r.crop
            } else {
                Some(r.crop.unwrap_or(r.rect))
            },
            solid: r.solid,
            mask: r
                .mask
                .as_deref()
                .filter(|_| !r.solid)
                .map(|data| AtlasMask {
                    width: r.mask_width,
                    height: r.mask_height,
                    factor: r.factor,
                    data,
                }),
        })
        .collect();
    let mut labels = vec![0u8; width * height];
    let counts = regions::label_atlas(&defs, width, height, &mut labels)?;
    Some((labels, counts))
}

/// The run's pixel ownership over time: one label plane (and its per-code counts) per epoch start
/// (`kernels::regions::RegionEpoch`). Codes are the same in every plane: region order never changes.
#[derive(Clone, Debug, PartialEq)]
pub struct Atlas {
    /// The first frame of each plane, ascending, starting at 0.
    pub starts: Vec<u32>,
    pub planes: Vec<(Vec<u8>, Vec<u32>)>,
}

impl Atlas {
    /// The label plane and counts in effect at `frame`.
    pub fn at(&self, frame: u32) -> &(Vec<u8>, Vec<u32>) {
        &self.planes[regions::epoch_index(&self.starts, frame)]
    }

    /// How many pixels the first plane gives `code`, then how many each later plane does from its first frame on.
    pub fn owned(&self, code: usize) -> (f64, Vec<(u32, f64)>) {
        let count = |p: &(Vec<u8>, Vec<u32>)| p.1.get(code).copied().unwrap_or(0) as f64;
        (
            count(&self.planes[0]),
            self.starts
                .iter()
                .zip(&self.planes)
                .skip(1)
                .map(|(s, p)| (*s, count(p)))
                .collect(),
        )
    }
}

/// One label plane per epoch start of `regions`; a run without epochs gets exactly [`label_atlas`]'s plane.
pub fn label_atlas_epochs(regions: &[RegionOut], width: usize, height: usize) -> Option<Atlas> {
    let starts = regions::epoch_starts(regions.iter().map(|r| r.epochs.as_slice()));
    let planes = starts
        .iter()
        .map(|&s| label_at(regions, width, height, Some(s)))
        .collect::<Option<Vec<_>>>()?;
    Some(Atlas { starts, planes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernels::layers::FieldMotion;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn manual(name: &str, kind: Kind, r: Rect) -> ManualRegion {
        ManualRegion {
            name: name.to_string(),
            kind,
            rect: r,
        }
    }

    // Failure cases first: a later region not excluded from an earlier one (overlaps owned twice); an ignored
    // region not excluded from every sibling; an unassigned region missing when pixels are uncovered, or added when
    // they are all covered; ids not following list order.
    #[test]
    fn manual_regions_exclude_later_and_ignored_regions() {
        let a = rect(0.0, 0.0, 25.0, 30.0);
        let b = rect(15.0, 0.0, 25.0, 30.0);
        let c = rect(0.0, 20.0, 40.0, 10.0);
        let learner = RegionLearner::new(10, 8);
        let out = learner.finish(
            40.0,
            30.0,
            &[
                manual("A", Kind::Moving, a),
                manual("B", Kind::Ignore, b),
                manual("C", Kind::Fixed, c),
            ],
            4,
        );
        assert_eq!(out.len(), 3, "a, b and c cover every pixel");
        assert_eq!(out[0].id, "layer-0");
        assert_eq!(out[0].exclusions, vec![b, c, b]);
        assert_eq!(out[1].exclusions, vec![c, b]);
        assert_eq!(out[2].exclusions, vec![b]);
        assert!(out.iter().all(|r| r.manual && !r.unassigned));
        assert_eq!(
            (out[2].mask_width, out[2].mask_height, out[2].factor),
            (10, 8, 4)
        );
    }

    #[test]
    fn a_gap_adds_the_unassigned_region_over_the_whole_frame() {
        let a = rect(0.0, 0.0, 10.0, 10.0);
        let out = RegionLearner::new(10, 10).finish(40.0, 30.0, &[manual("A", Kind::Moving, a)], 1);
        assert_eq!(out.len(), 2);
        let u = &out[1];
        assert!(u.unassigned && u.manual);
        assert_eq!(u.id, "layer-1");
        assert_eq!(u.name, UNASSIGNED_NAME);
        assert_eq!(u.kind, Kind::Fixed);
        assert_eq!(u.rect, rect(0.0, 0.0, 40.0, 30.0));
        assert_eq!(u.exclusions, vec![a]);
    }

    #[test]
    fn coverage_counts_every_native_pixel() {
        assert!(manual_uncovered(&[], 4.0, 4.0));
        assert!(!manual_uncovered(&[rect(0.0, 0.0, 4.0, 4.0)], 4.0, 4.0));
        // Column 3 is outside [0, 3): uncovered.
        assert!(manual_uncovered(&[rect(0.0, 0.0, 3.0, 4.0)], 4.0, 4.0));
        assert!(!manual_uncovered(
            &[rect(0.0, 0.0, 2.0, 4.0), rect(2.0, 0.0, 2.0, 4.0)],
            4.0,
            4.0
        ));
    }

    fn field<'a>(motions: &'a [FieldMotion], cells: &'a [u8], confidence: &'a [u8]) -> Field<'a> {
        Field {
            motions,
            labels: cells,
            confidence,
            dynamic: cells,
            cols: 1,
            rows: 1,
            difference: 5.0,
            unknown: false,
        }
    }

    // The reference must follow the last ACCUMULATED field, not the last field offered, and only when the host
    // gave native frames.
    #[test]
    fn the_reference_follows_the_last_accumulated_native_frame() {
        let moving = [FieldMotion {
            x: 0.0,
            y: 3.0,
            support: 20,
            confidence: 0.9,
        }];
        let still = [FieldMotion {
            x: 0.0,
            y: 0.0,
            support: 20,
            confidence: 0.9,
        }];
        let (cells, confidence) = ([0u8], [255u8]);
        let gray = vec![0u8; 24 * 24];
        let (a, b, c) = (vec![1u8; 8 * 4], vec![2u8; 8 * 4], vec![3u8; 8 * 4]);
        let mut learner = RegionLearner::new(24, 24);
        assert!(learner.add(&field(&moving, &cells, &confidence), &gray, &gray, None));
        assert!(
            learner.reference.is_none(),
            "no native frames, no reference"
        );
        assert!(learner.add(
            &field(&moving, &cells, &confidence),
            &gray,
            &gray,
            Some((&a, &b, 4, 2))
        ));
        assert_eq!(learner.reference.as_ref().unwrap().data, b);
        assert!(!learner.add(
            &field(&still, &cells, &confidence),
            &gray,
            &gray,
            Some((&b, &c, 4, 2))
        ));
        assert_eq!(
            learner.reference.as_ref().unwrap().data,
            b,
            "an ignored field keeps the reference"
        );
    }

    #[test]
    fn the_atlas_gives_each_pixel_to_the_first_region_that_holds_it() {
        let out = RegionLearner::new(4, 4).finish(
            8.0,
            4.0,
            &[
                manual("A", Kind::Moving, rect(0.0, 0.0, 6.0, 4.0)),
                manual("B", Kind::Fixed, rect(4.0, 0.0, 4.0, 4.0)),
            ],
            2,
        );
        let (labels, counts) = label_atlas(&out, 8, 4).unwrap();
        assert_eq!(
            &labels[..8],
            &[1, 1, 1, 1, 2, 2, 2, 2],
            "A excludes the later B"
        );
        assert_eq!(counts, vec![0, 16, 16]);
    }

    // Failure cases: a run without epochs getting anything but label_atlas's one plane; a plane built with the
    // epoch of the wrong frame; codes or region order changing between planes; owned counts not following the plane
    // in effect.
    #[test]
    fn the_atlas_has_one_plane_per_epoch_start() {
        let mut out = RegionLearner::new(4, 4).finish(
            8.0,
            4.0,
            &[
                manual("bar", Kind::Fixed, rect(0.0, 0.0, 8.0, 2.0)),
                manual("page", Kind::Moving, rect(0.0, 1.0, 8.0, 3.0)),
            ],
            2,
        );
        let plain = label_atlas_epochs(&out, 8, 4).unwrap();
        assert_eq!(plain.starts, vec![0]);
        assert_eq!(plain.planes, vec![label_atlas(&out, 8, 4).unwrap()]);
        // Row 1 is the bar's until frame 5, the page's from then on (the hand-placed bar no longer excludes the page).
        let row = rect(0.0, 1.0, 8.0, 1.0);
        out[0].exclusions.clear();
        out[0].epochs = vec![RegionEpoch {
            from: 5,
            exclusions: vec![row],
        }];
        out[1].epochs = vec![
            RegionEpoch {
                from: 0,
                exclusions: vec![row],
            },
            RegionEpoch {
                from: 5,
                exclusions: Vec::new(),
            },
        ];
        let atlas = label_atlas_epochs(&out, 8, 4).unwrap();
        assert_eq!(atlas.starts, vec![0, 5]);
        assert_eq!(&atlas.at(4).0[8..16], &[1; 8], "row 1 before the change");
        assert_eq!(&atlas.at(5).0[8..16], &[2; 8], "row 1 after the change");
        assert_eq!(&atlas.at(99).0[..8], &[1; 8]);
        assert_eq!(&atlas.at(0).0[16..], &[2; 16]);
        assert_eq!(atlas.owned(1), (16.0, vec![(5, 8.0)]));
        assert_eq!(atlas.owned(2), (16.0, vec![(5, 24.0)]));
    }
}
