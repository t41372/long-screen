//! Region construction (`src/core/layers.ts::LayerLearner.finish` and `RegionAtlas`'s pixel-labelling
//! constructor), ported stage by stage from the frozen TS oracle in tests/support/reference/layers.ts. Per-frame
//! accumulation (rust/core/src/layers.rs) already runs here; this module turns the accumulators the adapter reads
//! back into `Region`s, once per run, and then labels every native pixel by first-containing-region-wins.
//!
//! f64 throughout (JS numbers are f64); `js_round`/`js_floor`/`js_ceil` (geometry.rs) reproduce `Math.round` /
//! `Math.floor` / `Math.ceil` exactly, including negative and half-integer inputs. Group/label construction walks
//! cells in the same order a JS `Map`/`Array` insertion order would (see `cells::group_and_label`), because
//! later stages in the TS compare region *identity*; this port replaces that with a stable index into `regions`.
//!
//! One file per construction stage (mirroring the frozen oracle's stage comments): `bands` (stationary edges +
//! texture test), `cells` (union-find + grouping), `construct` (per-region mask painting, pane divider, band
//! expansion, cell granularity), `crops` (native-precision edges and crop/solid), `merge` (sliver/sticky-header
//! cleanup and the final filter), `atlas` (`RegionAtlas` pixel labelling). `finish()`, the top-level orchestrator,
//! and the shared types/helpers stay here.

use crate::geometry::Rect;

mod atlas;
mod band_fn;
mod bands;
mod cells;
mod construct;
mod crops;
mod merge;
#[cfg(test)]
mod tests;

pub use atlas::{label_atlas, AtlasMask, AtlasRegion};
use band_fn::band;
use bands::{detect_bands, strongest_cut, Bands};
use cells::{group_and_label, union_find_cells};
use construct::{apply_cell_granularity, apply_pane_divider, build_regions, expand_bands};
use crops::{
    assign_native_crops, compute_native_edges, recompute_bounding_boxes, refine_vertical_cut_crops,
};
use merge::{cleanup_sticky_headers, finalize, merge_small_regions};

/// Borrowed RGBA8 image (`RGBA` in types.ts), used only for texture/appearance evidence.
pub struct Rgba<'a> {
    pub width: usize,
    pub height: usize,
    pub data: &'a [u8],
}

/// The accumulator arrays `LearnerHandle.read()` returns, plus the sizes and retained native frame `finish()`
/// needs. Mirrors `tests/support/reference/layers.ts::FinishAccumulators`.
pub struct FinishInput<'a> {
    pub width: usize,
    pub height: usize,
    pub cell: usize,
    pub informative_frames: f64,
    pub native_frames: f64,
    pub row_change: &'a [f64],
    pub col_change: &'a [f64],
    pub col_mean: &'a [f64],
    pub col_gain: &'a [f64],
    pub horizontal_gain: &'a [f64],
    pub split: &'a [f64],
    pub evidence: &'a [f64],
    pub activity: &'a [f64],
    pub observations: &'a [f64],
    pub native_row_change: Option<&'a [f64]>,
    pub native_col_change: Option<&'a [f64]>,
    pub reference: Option<Rgba<'a>>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Moving,
    Fixed,
    Ignore,
}

/// Constructed region, the Rust analogue of `Region` (types.ts). `mask` is always analysis-resolution
/// (`mask_width × mask_height`); `RegionAtlas.labels` (`src/core/layers.ts`) is built by
/// `regions::atlas::label_atlas` over `region::Region<&[u8]>` (region.rs's generic `Region`, instantiated with a
/// borrowed mask — see `regions/atlas.rs`'s `AtlasRegion`), constructed directly from the wire request in
/// `abi::regions::ls_regions_label_atlas`. It never goes through this type.
pub struct RegionOut {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub rect: Rect,
    pub cells: Option<Vec<i64>>,
    pub mask: Option<Vec<u8>>,
    pub mask_width: usize,
    pub mask_height: usize,
    pub manual: bool,
    pub unassigned: bool,
    pub exclusions: Vec<Rect>,
    pub crop: Option<Rect>,
    pub solid: bool,
    pub factor: u32,
    /// Construction-only annotation (`Region & { bandSide?: number }` in the TS `finish()`): which stationary
    /// edge band (1=top, 2=bottom, 3=left, 4=right) `expand_bands` last assigned this region to. A region whose
    /// cells touch more than one band keeps only the LAST band `expand_bands` visits (1, 2, 3, then 4) —
    /// reproduced here, not "fixed", because `native_crops` reads it the same way.
    pub band_side: Option<u8>,
}

#[inline]
fn intersect(a: Rect, b: Rect) -> Rect {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    Rect {
        x,
        y,
        width: ((a.x + a.width).min(b.x + b.width) - x).max(0.0),
        height: ((a.y + a.height).min(b.y + b.height) - y).max(0.0),
    }
}

/// A read past the end of a JS `Float64Array` returns `undefined`, which poisons downstream arithmetic to `NaN`
/// and makes every comparison below false; this reproduces that without ever indexing out of range.
#[inline]
fn stat_at(stats: &[f64], index: i64) -> f64 {
    if index < 0 || index as usize >= stats.len() {
        f64::NAN
    } else {
        stats[index as usize]
    }
}

/// Orchestrates every stage above, mirroring `tests/support/reference/layers.ts::referenceFinish` /
/// `src/core/layers.ts::LayerLearner.finish()` exactly (same stage order, same accumulator reads). The manual-
/// region branch of `finish()` (`LayerLearner.finish`'s `manual` parameter) is NOT ported here: it is cheap TS
/// object construction over data the caller already holds (spreading the input `Region`s, no per-pixel work
/// except the one native-pixel coverage scan, which IS in Rust — `ls_regions_manual_uncovered`,
/// abi/regions.rs). Porting it would mean Rust re-deriving id/name/exclusions only for TS to reconstruct the
/// same values back; this function therefore only ever builds the algorithmic-path regions.
pub fn finish(
    input: &FinishInput<'_>,
    native_width: f64,
    native_height: f64,
    factor: u32,
) -> Vec<RegionOut> {
    let width = input.width as i64;
    let height = input.height as i64;
    let cell = input.cell as i64;
    let cols = (width + cell - 1) / cell.max(1);
    let rows = (height + cell - 1) / cell.max(1);
    let reference = input.reference.as_ref();
    let bands = detect_bands(
        width,
        height,
        input.informative_frames,
        input.row_change,
        input.col_change,
        input.col_mean,
        reference,
        native_width,
        native_height,
        factor as f64,
    );
    let vertical_cut = strongest_cut(input.col_gain, input.informative_frames);
    let horizontal_cut = strongest_cut(input.horizontal_gain, input.informative_frames);
    let mut ds = union_find_cells(
        cols,
        rows,
        cell,
        width,
        height,
        bands.top,
        bands.bottom,
        bands.left,
        bands.right,
        vertical_cut,
        horizontal_cut,
        input.evidence,
        input.split,
        input.informative_frames,
    );
    let n = cols * rows;
    let (large, labels) = group_and_label(&mut ds, n, cols);
    let mut regions = build_regions(
        &large,
        &labels,
        cols,
        cell,
        width,
        height,
        bands.top,
        bands.bottom,
        bands.left,
        bands.right,
        input.activity,
        input.observations,
        input.informative_frames,
        factor,
    );
    let (divider_start, divider_end) = apply_pane_divider(
        &mut regions,
        &labels,
        cols,
        rows,
        cell,
        width,
        height,
        bands.top,
        bands.bottom,
        vertical_cut,
        input.col_change,
        input.informative_frames,
        factor,
    );
    expand_bands(
        &mut regions,
        width,
        height,
        bands.top,
        bands.bottom,
        bands.left,
        bands.right,
        native_width,
        native_height,
        cols,
        cell,
        factor,
    );
    apply_cell_granularity(
        &mut regions,
        width,
        height,
        cell,
        bands.top,
        bands.bottom,
        bands.left,
        bands.right,
    );
    let edges = compute_native_edges(
        &bands,
        input.native_row_change,
        input.native_col_change,
        input.native_frames,
        height,
        width,
        factor as f64,
        native_width,
        native_height,
    );
    assign_native_crops(
        &mut regions,
        &edges,
        native_width,
        native_height,
        cols,
        cell,
        width,
        height,
        bands.top,
        bands.bottom,
        bands.left,
        bands.right,
    );
    refine_vertical_cut_crops(
        &mut regions,
        &edges,
        vertical_cut,
        cell,
        cols,
        divider_start,
        divider_end,
        input.native_col_change,
        input.native_frames,
        native_width,
        factor as f64,
    );
    recompute_bounding_boxes(
        &mut regions,
        width,
        height,
        native_width,
        native_height,
        factor as f64,
    );
    let valid: Vec<usize> = (0..regions.len())
        .filter(|&i| regions[i].rect.width > 0.0 && regions[i].rect.height > 0.0)
        .collect();
    merge_small_regions(&mut regions, &valid, factor as f64);
    cleanup_sticky_headers(
        &mut regions,
        &valid,
        edges.content,
        cell,
        factor as f64,
        reference,
    );
    finalize(regions, &valid, edges.content)
}
