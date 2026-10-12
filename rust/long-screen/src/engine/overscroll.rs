//! The render pass's side of elastic overscroll (docs/ARCHITECTURE.md §十 "合成与瞬态像素"): the page edges of every
//! moving canvas, worked out once from all stored plans before the first frame is painted, and per placement the
//! lines past those edges that the compositor must leave out.
//!
//! A frame whose pose runs past an edge shows the window's background in the strip beyond it. That strip becomes
//! extra occlusion rectangles on the placement: the compositor, the temporal records and reveal already leave
//! occluded pixels out, and the observation row carries them to reveal. The canvas bounds leave the strip out too.

use crate::engine::render::{FramePlan, PlanPlacement};
use crate::kernels::geometry::{js_round, Rect};
use crate::kernels::overscroll::{background_lines, page_edges, Edges, Lines, Pose, SIDES};
use std::collections::HashMap;

/// Lines next to the edge a strip may still show something other than background in: an edge read from the motion
/// can sit a pixel or two outside where the background really ends (the spring stopped short).
const SLACK: i64 = 3;

/// A placement resolved to its canvas and pose.
pub struct Resolved<'a> {
    pub canvas: &'a str,
    pub x: f64,
    pub y: f64,
}

#[derive(Default)]
pub struct Overscroll {
    /// Painted moving-region placements of every stored plan, kept until the edges are worked out.
    plans: Vec<(u32, PlanPlacement)>,
    /// Page edges by canvas.
    edges: Option<HashMap<String, Edges>>,
    /// The lines last left out per layer, with the canvas and pose they were measured at.
    last: HashMap<String, (String, f64, f64, [i64; 4])>,
}

impl Overscroll {
    /// Keeps a stored plan's placements of moving regions (`moving` says which layers are).
    pub fn add_plan(&mut self, index: u32, plan: &FramePlan, moving: impl Fn(&str) -> bool) {
        if self.edges.is_some() {
            return;
        }
        for p in &plan.placements {
            if p.skip != Some(true) && moving(&p.layer) {
                self.plans.push((index, p.clone()));
            }
        }
    }

    /// Works the edges out on first use. `resolve` gives a placement's final canvas and pose (`None` when it cannot
    /// be placed), `extent` its layer's region size.
    pub fn prepare<E>(
        &mut self,
        mut resolve: impl FnMut(&PlanPlacement, u32) -> Result<Option<(String, f64, f64)>, E>,
        extent: impl Fn(&str) -> Option<(i64, i64)>,
    ) -> Result<(), E> {
        if self.edges.is_some() {
            return Ok(());
        }
        let mut tracks: HashMap<(String, String), Vec<Pose>> = HashMap::new();
        for (frame, p) in &self.plans {
            if let Some((canvas, x, y)) = resolve(p, *frame)? {
                tracks
                    .entry((canvas, p.layer.clone()))
                    .or_default()
                    .push(Pose {
                        frame: *frame,
                        x: js_round(x) as i64,
                        y: js_round(y) as i64,
                    });
            }
        }
        let mut edges = HashMap::new();
        for ((canvas, layer), mut track) in tracks {
            let Some((w, h)) = extent(&layer) else {
                continue;
            };
            track.sort_by_key(|p| p.frame);
            let found = page_edges(&track, w, h);
            if !found.is_empty() {
                edges.insert(canvas, found);
            }
        }
        self.plans = Vec::new();
        self.edges = Some(edges);
        Ok(())
    }

    /// The lines of each side ([`SIDES`] order) a placement leaves out: on a side whose pose runs past the page's
    /// edge, the background lines counted from the region's outer side, at most as many as the pose runs past it,
    /// and only when they reach to within [`SLACK`] lines of the edge. A strip with something else in it further
    /// out is left whole: leaving out only its outer part made test_8's bounce frames paint the input bar pinned in
    /// the moving layer at shifted places, and the page end came out torn.
    /// `lines` holds the frame; its `region` is the placement's region.
    pub fn measure(&mut self, layer: &str, at: Resolved, lines: &Lines) -> [i64; 4] {
        let mut out = [0; 4];
        let edges = self.edges.as_ref().and_then(|e| e.get(at.canvas));
        if let Some(edges) = edges {
            let over = edges.overshoot(js_round(at.x) as i64, js_round(at.y) as i64);
            for (side, (&over, out)) in SIDES.iter().zip(over.iter().zip(out.iter_mut())) {
                if over <= 0 {
                    continue;
                }
                let counted = background_lines(lines, *side, over as usize) as i64;
                if counted + SLACK >= over {
                    *out = counted;
                }
            }
        }
        self.last
            .insert(layer.to_string(), (at.canvas.to_string(), at.x, at.y, out));
        out
    }

    /// What the last measured placement of `layer` left out, when it was at this canvas and pose (a frame the
    /// duplicate shortcut does not paint).
    pub fn reuse(&self, layer: &str, at: Resolved) -> [i64; 4] {
        match self.last.get(layer) {
            Some((canvas, x, y, out)) if canvas == at.canvas && *x == at.x && *y == at.y => *out,
            _ => [0; 4],
        }
    }
}

/// The region's rect in whole screen pixels: x, y, width, height.
pub fn pixel_rect(region: Rect) -> (i64, i64, i64, i64) {
    let (x0, y0) = (region.x.floor() as i64, region.y.floor() as i64);
    let (x1, y1) = (
        (region.x + region.width).ceil() as i64,
        (region.y + region.height).ceil() as i64,
    );
    (x0, y0, x1 - x0, y1 - y0)
}

/// The screen rectangles the left-out lines cover.
pub fn strips(region: Rect, out: [i64; 4]) -> Vec<Rect> {
    let (x, y, w, h) = pixel_rect(region);
    let [top, bottom, left, right] = out;
    let rect = |x: i64, y: i64, w: i64, h: i64| Rect {
        x: x as f64,
        y: y as f64,
        width: w as f64,
        height: h as f64,
    };
    let mut rects = Vec::new();
    if top > 0 {
        rects.push(rect(x, y, w, top));
    }
    if bottom > 0 {
        rects.push(rect(x, y + h - bottom, w, bottom));
    }
    if left > 0 {
        rects.push(rect(x, y, left, h));
    }
    if right > 0 {
        rects.push(rect(x + w - right, y, right, h));
    }
    rects
}

/// A placed rect on the canvas without the left-out lines; empty when nothing is left.
pub fn trim(bounds: Rect, out: [i64; 4]) -> Rect {
    let [top, bottom, left, right] = out.map(|v| v as f64);
    let width = bounds.width - left - right;
    let height = bounds.height - top - bottom;
    if width <= 0.0 || height <= 0.0 {
        return Rect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        };
    }
    Rect {
        x: bounds.x + left,
        y: bounds.y + top,
        width,
        height,
    }
}
