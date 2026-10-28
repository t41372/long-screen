//! Host of the solve pass (the page's `src/pipeline/solve/solve.ts`): drives the engine's `SolveSession` frame by
//! frame, stores the rows it hands back, formats its diagnostics (`solve/diagnostics.ts`), relaxes the pose graph
//! and drops the pass's scratch.

use crate::context::{pad, t, Ctx, NestedRegion};
use crate::engine::catalog::{Locale, Param};
use crate::engine::diagnostic::Diagnostic as EngineDiagnostic;
use crate::engine::pose_graph::PoseGraph;
use crate::engine::pose_graph::{PoseEdge, PoseNode, PoseRow, Write};
use crate::engine::solve::{
    Begin, Effect, Keyframe, Nest, NestedFound, Placement, Poll, ScanFields, SolveConfig,
    SolveRegion, SolveSession, VotingRecord, VOTING_RING_BYTES,
};
use crate::kernels::features::{Feature, DESCRIPTOR_WORDS};
use crate::kernels::geometry::Rect;
use crate::kernels::region::{Mask, Region as Shape};
use crate::kernels::regions::{Kind, RegionOut};
use crate::scan::Features;
use crate::source::FrameSource;
use crate::value::{detail, rect, to_fixed, Js, Obj};
use std::collections::HashMap;
use std::sync::Arc;

/// `BUDGET_MESSAGE` (src/core/keyframes.ts): not in the catalogue, the English sentence the journal stores.
const BUDGET_MESSAGE: &str = "A highly repetitive visual-word posting exceeded the 96-candidate retrieval budget. Relocalization is approximate here; all image observations remain in the reconstruction journal.";

/// The region's name as its row carries it.
pub fn region_name(r: &RegionOut) -> String {
    let id_index: u32 =
        r.id.strip_prefix("layer-")
            .and_then(|n| n.parse().ok())
            .unwrap_or(0);
    match &r.cells {
        None => "固定分隔界面".into(),
        Some(c) if c.is_empty() => "固定界面".into(),
        Some(_) if r.kind == Kind::Fixed => "固定界面".into(),
        Some(_) => format!("内容画布 {}", id_index + 1),
    }
}

pub fn kind_str(r: &RegionOut) -> &'static str {
    match (&r.cells, r.kind) {
        (None, _) => "fixed",
        (Some(c), _) if c.is_empty() => "fixed",
        (_, Kind::Fixed) => "fixed",
        (_, Kind::Ignore) => "ignore",
        (_, Kind::Moving) => "moving",
    }
}

/// The region's shape as the page's region descriptor gives it (`writeRegionDescriptor`).
pub fn shape(r: &RegionOut) -> Shape {
    Shape {
        rect: r.rect,
        exclusions: r.exclusions.clone(),
        crop: Some(r.crop.unwrap_or(r.rect)),
        solid: r.solid,
        mask: r.mask.clone().filter(|_| !r.solid).map(|data| Mask {
            width: r.mask_width,
            height: r.mask_height,
            factor: r.factor,
            data,
        }),
    }
}

pub fn placement_js(p: &Placement) -> Js {
    let mut o = Obj::new()
        .with("layer", p.layer.as_str())
        .with("canvasId", p.canvas_id.as_str())
        .with("node", p.node.as_str())
        .with("x", p.x)
        .with("y", p.y)
        .with("confidence", p.confidence)
        .with("uncertain", p.uncertain)
        .with("time", p.time);
    if p.skip {
        o.set("skip", true);
    }
    if !p.occlusions.is_empty() {
        o.set(
            "occlusions",
            Js::Arr(p.occlusions.iter().map(|r| rect(*r)).collect()),
        );
    }
    Js::Obj(o)
}

pub fn node_js(n: &PoseNode) -> Js {
    let mut o = Obj::new()
        .with("id", n.id.as_str())
        .with("canvasId", n.canvas_id.as_str())
        .with("frame", n.frame)
        .with("x", n.x)
        .with("y", n.y)
        .with("originalX", n.original_x)
        .with("originalY", n.original_y)
        .with("pinned", n.pinned)
        .with("edges", Js::Arr(Vec::new()));
    if let Some(next) = &n.next {
        o.set("next", next.as_str());
    }
    Js::Obj(o)
}

pub fn edge_js(e: &PoseEdge) -> Js {
    Js::Obj(
        Obj::new()
            .with("other", e.other.as_str())
            .with("dx", e.dx)
            .with("dy", e.dy)
            .with("weight", e.weight)
            .with("kind", e.kind.as_str()),
    )
}

/// Stores pose-graph rows.
pub fn store_writes(ctx: &mut Ctx, writes: &[Write]) {
    pose_rows(writes, &mut |key, value| ctx.put(key, value));
}

/** Each pose graph row of `writes`, keyed, as its row is stored. */
fn pose_rows(writes: &[Write], put: &mut dyn FnMut(&str, Js)) {
    let mut one = |row: &PoseRow| {
        let value = match row {
            PoseRow::Node(n) => node_js(n),
            PoseRow::Edge { edge, .. } => edge_js(edge),
        };
        put(&row.key(), value);
    };
    for w in writes {
        match w {
            Write::Put(row) => one(row),
            Write::PutMany(rows) => rows.iter().for_each(&mut one),
        }
    }
}

/// A nested run's writes, held back until its containers are confirmed (`Effect::NestedRejected`; `solve.ts`'s
/// `HeldStore`): its rows (a later put of a key replaces the earlier in place), its diagnostics, its large residual
/// and the canvases it created, in order.
#[derive(Default)]
struct Held {
    rows: Vec<(String, Js)>,
    index: HashMap<String, usize>,
    diagnostics: Vec<EngineDiagnostic>,
    residual: Option<(f64, u32)>,
    canvases: u32,
}

impl Held {
    fn put(&mut self, key: &str, value: Js) {
        match self.index.get(key) {
            Some(&i) => self.rows[i].1 = value,
            None => {
                self.index.insert(key.to_string(), self.rows.len());
                self.rows.push((key.to_string(), value));
            }
        }
    }

    fn get(&self, key: &str) -> Option<Js> {
        self.index.get(key).map(|&i| self.rows[i].1.clone())
    }

    /// Drops a held row (a canvas the run created and then let go); false when the run never wrote `key`.
    fn remove(&mut self, key: &str) -> bool {
        let Some(i) = self.index.remove(key) else {
            return false;
        };
        self.rows.remove(i);
        for at in self.index.values_mut() {
            if *at > i {
                *at -= 1;
            }
        }
        true
    }
}

/// One of the solve session's diagnostics as the journal row the page writes (`solveDiagnostic`).
fn solve_diagnostic(d: &EngineDiagnostic, l: Locale) -> Obj {
    let code = d.code;
    let time = d.time.map_or(Js::Undefined, Js::Num);
    let frame = d.frame.map_or(Js::Undefined, |f| Js::Num(f as f64));
    let canvas = d.canvas.clone().map_or(Js::Undefined, Js::Str);
    let confidence = d.confidence.map_or(Js::Undefined, Js::Num);
    let region = d.region.map_or(Js::Undefined, rect);
    let det = d.detail.as_ref().map_or(Js::Undefined, detail);
    let param = |name: &str| {
        d.params
            .iter()
            .find(|(k, _)| *k == name)
            .map_or(f64::NAN, |(_, v)| *v)
    };
    let msg = |key: &str| t(l, &format!("diag.{code}.{key}"), &[]);
    let base = Obj::new().with("code", code);
    match code {
        "PARTIAL_CONTENT_CHANGE" => base
            .with("severity", "info")
            .with("time", time)
            .with("frame", frame)
            .with("canvasId", canvas)
            .with(
                "message",
                t(
                    l,
                    "diag.PARTIAL_CONTENT_CHANGE.message",
                    &[("percent", Param::Num(param("percent")))],
                ),
            ),
        "THIN_OVERLAP_STEP" => base
            .with("severity", "warning")
            .with("time", time)
            .with("frame", frame)
            .with("canvasId", canvas)
            .with("confidence", confidence)
            .with("message", msg("message"))
            .with("action", msg("action")),
        "LOW_CONFIDENCE_PLACEMENT" => {
            if d.region.is_some() {
                let ambiguous = param("ambiguous");
                base.with("severity", "warning")
                    .with("time", time)
                    .with("frame", frame)
                    .with("canvasId", canvas)
                    .with("confidence", confidence)
                    .with("region", region)
                    .with(
                        "message",
                        if ambiguous != 0.0 && !ambiguous.is_nan() {
                            msg("messageAmbiguous")
                        } else {
                            msg("messageLowConfidence")
                        },
                    )
                    .with("action", msg("action"))
                    .with("detail", det)
            } else {
                base.with("severity", "warning")
                    .with("time", time)
                    .with("frame", frame)
                    .with("canvasId", canvas)
                    .with("confidence", confidence)
                    .with("message", msg("messageStatic"))
            }
        }
        "UNOBSERVABLE_FRAME" => base
            .with("severity", "warning")
            .with("time", time)
            .with("frame", frame)
            .with(
                "canvasId",
                match &d.canvas {
                    Some(c) if !c.is_empty() => Js::Str(c.clone()),
                    _ => Js::Undefined,
                },
            )
            .with("message", msg("message"))
            .with("action", msg("action")),
        "RELOCALIZED" | "FRAGMENT_ATTACHED" => base
            .with("severity", "info")
            .with("canvasId", canvas)
            .with("time", time)
            .with("frame", frame)
            .with("confidence", confidence)
            .with("detail", det)
            .with("message", msg("message")),
        "SCALE_CHANGE_FRAGMENT" => base
            .with("severity", "warning")
            .with("canvasId", canvas)
            .with("time", time)
            .with("frame", frame)
            .with("confidence", confidence)
            .with("detail", det)
            .with(
                "message",
                t(
                    l,
                    "diag.SCALE_CHANGE_FRAGMENT.message",
                    &[("scale", Param::Str(&to_fixed(param("scale"), 2)))],
                ),
            )
            .with("action", msg("action")),
        "UNPLACED_FRAGMENT" => base
            .with("severity", "warning")
            .with("canvasId", canvas)
            .with("time", time)
            .with("frame", frame)
            .with("confidence", confidence)
            .with("detail", Js::Undefined)
            .with("message", msg("message"))
            .with("action", msg("action")),
        "NONFINITE_POSE" => base
            .with("severity", "error")
            .with("time", time)
            .with("frame", frame)
            .with("message", msg("message")),
        "STICKY_OCCLUSION" => base
            .with("severity", "info")
            .with("frame", frame)
            .with("time", time)
            .with("canvasId", canvas)
            .with("region", region)
            .with("message", msg("message")),
        "NESTED_LAYER_FOUND" => base
            .with("severity", "info")
            .with("canvasId", canvas)
            .with("region", region)
            .with("detail", det)
            .with(
                "message",
                t(
                    l,
                    "diag.NESTED_LAYER_FOUND.message",
                    &[("frames", Param::Int(param("frames") as i64))],
                ),
            ),
        "TRAJECTORY_CORRECTED" => base
            .with("severity", "warning")
            .with("time", time)
            .with("frame", frame)
            .with("canvasId", canvas)
            .with("confidence", confidence)
            .with("detail", det)
            .with(
                "message",
                t(
                    l,
                    "diag.TRAJECTORY_CORRECTED.message",
                    &[(
                        "discrepancy",
                        Param::Str(&to_fixed(param("discrepancy"), 1)),
                    )],
                ),
            )
            .with("action", msg("action")),
        "LOOP_CLOSURE" => base
            .with("severity", "info")
            .with("canvasId", canvas)
            .with("time", time)
            .with("frame", frame)
            .with("confidence", confidence)
            .with("message", msg("message")),
        "INCONSISTENT_LOOP_REJECTED" => base
            .with("severity", "warning")
            .with("time", time)
            .with("frame", frame)
            .with("canvasId", canvas)
            .with(
                "message",
                t(
                    l,
                    "diag.INCONSISTENT_LOOP_REJECTED.message",
                    &[(
                        "discrepancy",
                        Param::Str(&to_fixed(param("discrepancy"), 1)),
                    )],
                ),
            )
            .with("confidence", confidence),
        "AMBIGUOUS_LOOP" => base
            .with("severity", "warning")
            .with("time", time)
            .with("frame", frame)
            .with("canvasId", canvas)
            .with("message", msg("message")),
        "RELOCALIZATION_BUDGET" => base
            .with("severity", "warning")
            .with("message", BUDGET_MESSAGE),
        _ => base.with("severity", d.severity.as_str()).with(
            "message",
            format!("CORE_BAD_ARGUMENT: unknown solve diagnostic {code}."),
        ),
    }
}

/// Stored compact features as the session takes them (`ls_solve_run`).
fn features(f: &crate::engine::scan::CompactFeatures) -> Vec<Feature> {
    (0..f.score.len())
        .map(|i| {
            let mut descriptor = [0u32; DESCRIPTOR_WORDS];
            descriptor
                .copy_from_slice(&f.descriptors[i * DESCRIPTOR_WORDS..(i + 1) * DESCRIPTOR_WORDS]);
            Feature {
                x: f.xy[i * 2] as i32,
                y: f.xy[i * 2 + 1] as i32,
                score: f.score[i] as f64,
                descriptor,
            }
        })
        .collect()
}

struct Run<'s> {
    session: SolveSession,
    keyframes: HashMap<String, Arc<Keyframe>>,
    features: &'s Features,
    solved: u32,
    /// Containers the pass found scrolling inside its regions (`track::nested`).
    found: Vec<NestedFound>,
    /// On a nested run: per container, the frames its parent's print shows it in.
    moments: Vec<(String, Vec<(u32, Rect)>)>,
    /// On a nested run: the containers their own run did not confirm.
    rejected: Vec<String>,
    /// On a nested run: where its rows and diagnostics wait until its containers are confirmed.
    held: Option<Held>,
    /// On the first run: the containers it would report so far (refreshed every 30 frames), for its progress.
    candidates: usize,
    /// On a nested run: the frames it solves (`SolveSession::nested_until`).
    until: Option<u32>,
    /// On the nested containers' run (`solve_nested`): each container's parent, whose stored plan rows this run's
    /// placements join.
    parents: Option<HashMap<String, String>>,
}

impl Run<'_> {
    fn put(&mut self, ctx: &mut Ctx, key: &str, value: impl Into<Js>) {
        match &mut self.held {
            Some(held) => held.put(key, value.into()),
            None => ctx.put(key, value),
        }
    }

    /// The solve pass's progress, both runs on one scale (`solve.ts`'s `SolveRun.progress`): each frame of a run costs
    /// a decode and a step per region it solves, so the first run takes `1 + moving regions` of the work and a second
    /// run `1 + containers`; until the first run has seen every frame its containers are an estimate. It never goes
    /// back.
    fn progress(&mut self, ctx: &mut Ctx) -> f64 {
        let done = self.solved as f64 / self.until.unwrap_or(ctx.frames).max(1) as f64;
        if self.parents.is_none() && self.solved.is_multiple_of(30) {
            self.candidates = self.session.nested_candidates();
        }
        let moving = ctx
            .regions
            .iter()
            .filter(|r| kind_str(r) == "moving")
            .count();
        let first = 1.0 + moving.max(1) as f64;
        let second = |containers: usize| {
            if containers > 0 {
                1.0 + containers as f64
            } else {
                0.0
            }
        };
        let value = match &self.parents {
            Some(parents) => {
                let s = second(parents.len());
                (first + s * done) / (first + s)
            }
            None => first * done / (first + second(self.candidates)),
        };
        ctx.solve_progress = ctx.solve_progress.max(value);
        ctx.solve_progress
    }

    fn get(&self, ctx: &Ctx, key: &str) -> Option<Js> {
        self.held
            .as_ref()
            .and_then(|h| h.get(key))
            .or_else(|| ctx.get(key))
    }

    fn apply(&mut self, ctx: &mut Ctx) {
        for effect in self.session.take_effects() {
            match effect {
                Effect::Nested(found) => self.found.push(found),
                Effect::NestedMoment { region, frames } => self.moments.push((region, frames)),
                Effect::NestedRejected { region } => self.rejected.push(region),
                Effect::Canvas { meta, created } => {
                    let mut o = Obj::new()
                        .with("id", meta.id.as_str())
                        .with("layer", meta.layer.as_str())
                        .with("name", meta.name.as_str())
                        .with("kind", meta.kind.as_str())
                        .with(
                            "bounds",
                            Obj::new()
                                .with("x", 0u32)
                                .with("y", 0u32)
                                .with("width", 0u32)
                                .with("height", 0u32),
                        )
                        .with("tileCount", 0u32)
                        .with("observedPixels", 0u32)
                        .with("uncertainPixels", 0u32)
                        .with("conflictPixels", 0u32)
                        .with("provisionalPixels", 0u32)
                        .with("maxLevel", 0u32)
                        .with("fragment", meta.fragment)
                        .with("firstTime", meta.first_time)
                        .with("lastTime", meta.last_time);
                    if let Some(a) = &meta.attached_to {
                        o.set("attachedTo", a.as_str());
                    }
                    self.put(ctx, &format!("canvas/{}", meta.id), o);
                    if created {
                        match &mut self.held {
                            Some(held) => held.canvases += 1,
                            None => ctx.canvas_count += 1,
                        }
                    }
                }
                Effect::CanvasDropped(id) => {
                    let key = format!("canvas/{id}");
                    let held = self.held.as_mut().is_some_and(|held| {
                        let kept = held.remove(&key);
                        if kept {
                            held.canvases = held.canvases.saturating_sub(1);
                        }
                        kept
                    });
                    if !held {
                        ctx.delete(&key);
                        ctx.canvas_count = ctx.canvas_count.saturating_sub(1);
                    }
                }
                Effect::Attachment(a) => self.put(
                    ctx,
                    &format!("attach/{}", a.id),
                    Obj::new()
                        .with("id", a.id.as_str())
                        .with("target", a.target.as_str())
                        .with("dx", a.dx)
                        .with("dy", a.dy)
                        .with("frame", a.frame)
                        .with("confidence", a.confidence)
                        .with("node", a.node.as_str()),
                ),
                Effect::Keyframe(k) => {
                    self.keyframes.insert(k.id.clone(), k);
                }
                Effect::Graph(w) => match &mut self.held {
                    Some(held) => pose_rows(std::slice::from_ref(&w), &mut |k, v| held.put(k, v)),
                    None => store_writes(ctx, std::slice::from_ref(&w)),
                },
                Effect::Diagnostic(d) => match &mut self.held {
                    Some(held) => held.diagnostics.push(d),
                    None => ctx.emit(&|l| solve_diagnostic(&d, l)),
                },
            }
        }
    }

    /// Stores frame `index`'s plan row: `row` on the first run; on a nested run the first run's row with the
    /// containers' `placements` added and each container's rectangle left out of its parent's placement
    /// (`solve.ts`'s `SolveRun.plan`).
    fn store_plan(&mut self, ctx: &mut Ctx, index: u32, row: Obj, placements: &[Placement]) {
        let key = format!("plan/{}", pad(index));
        let Some(parents) = self.parents.clone() else {
            self.put(ctx, &key, row);
            return;
        };
        let mut row = match self.get(ctx, &key) {
            Some(Js::Obj(stored)) => stored,
            _ => {
                let mut row = row;
                row.set("placements", Js::Arr(Vec::new()));
                row
            }
        };
        let mut list = match row.get("placements") {
            Some(Js::Arr(a)) => a.clone(),
            _ => Vec::new(),
        };
        for p in placements {
            if let Some(clip) = p.clip {
                let parent = parents.get(&p.layer).map(String::as_str);
                let at = list.iter().position(
                    |q| matches!(q, Js::Obj(q) if q.str("layer") == parent && !q.bool("skip")),
                );
                if let Some(Js::Obj(q)) = at.and_then(|at| list.get_mut(at)) {
                    let mut occlusions = match q.get("occlusions") {
                        Some(Js::Arr(a)) => a.clone(),
                        _ => Vec::new(),
                    };
                    occlusions.push(rect(clip));
                    q.set("occlusions", Js::Arr(occlusions));
                }
            }
            list.push(placement_js(p));
        }
        row.set("placements", Js::Arr(list));
        self.put(ctx, &key, row);
    }

    fn queue_voting(&mut self, ctx: &mut Ctx, records: Vec<VotingRecord>) {
        for record in records {
            ctx.voted_layers += record.voted_layers;
            ctx.thin_layers += record.thin_layers;
            if record.verdicts.is_empty() {
                continue;
            }
            let mut row = Obj::new();
            for v in &record.verdicts {
                row.set(
                    &v.region,
                    Obj::new()
                        .with("x0", v.x0)
                        .with("y0", v.y0)
                        .with("w", v.w)
                        .with("h", v.h)
                        .with("bits", Js::u8s(v.bits.clone()))
                        .with("clean", Js::u8s(v.clean.clone())),
                );
            }
            self.put(ctx, &format!("consistency/{}", pad(record.index)), row);
        }
    }

    /// One decoded frame.
    fn frame(
        &mut self,
        ctx: &mut Ctx,
        index: u32,
        time: f64,
        rgba: &[u8],
        scan: &Obj,
    ) -> Result<(), String> {
        let field = scan
            .get("field")
            .and_then(Js::as_obj)
            .ok_or("scan record without a field")?;
        let fields = ScanFields {
            duplicate: scan.bool("duplicate"),
            zoom: field.num("zoom"),
            difference: field.num("difference"),
        };
        // The page applies effects only after `run`/`provide`; whatever `begin` produced goes out with the next.
        match self
            .session
            .begin_frame(index, time, fields)
            .map_err(|e| e.to_string())?
        {
            Begin::Duplicate(placements) => {
                let plan = Obj::new()
                    .with("index", index)
                    .with("time", time)
                    .with("duplicate", true)
                    .with(
                        "placements",
                        Js::Arr(placements.iter().map(placement_js).collect()),
                    );
                self.store_plan(ctx, index, plan, &placements);
                self.solved = index + 1;
                let message = ctx.tr("progress.duplicateReuse", &[]);
                let fraction = self.progress(ctx);
                ctx.report(self.solved, time, &message, Some(fraction), None);
                return Ok(());
            }
            Begin::NeedFrame { .. } => {}
        }
        if rgba.len() != self.session.width() * self.session.height() * 4 {
            return Err(format!(
                "FRAME_GEOMETRY_CHANGED: observation does not match the run's {}×{}.",
                ctx.info.width, ctx.info.height
            ));
        }
        self.session.frame_mut().copy_from_slice(rgba);
        let stored = if fields.duplicate {
            None
        } else {
            self.features.get(&index).map(features)
        };
        let labels = &ctx
            .atlas
            .as_ref()
            .ok_or("no region atlas")?
            .at(index)
            .0
            .clone();
        let mut poll = self.session.run_frame(None, stored, labels);
        self.apply(ctx);
        loop {
            match poll.map_err(|e| e.to_string())? {
                Poll::NeedKeyframes(ids) => {
                    let rows = ids
                        .iter()
                        .map(|id| self.keyframes.get(id).map(|k| (**k).clone()))
                        .collect();
                    poll = self.session.provide_keyframes(rows, labels);
                    self.apply(ctx);
                }
                Poll::Done(done) => {
                    if done.joined_ring {
                        self.queue_voting(ctx, done.voting);
                    }
                    let plan = Obj::new()
                        .with("index", index)
                        .with("time", time)
                        .with(
                            "placements",
                            Js::Arr(done.placements.iter().map(placement_js).collect()),
                        )
                        .with("duplicate", fields.duplicate);
                    self.store_plan(ctx, index, plan, &done.placements);
                    self.solved = index + 1;
                    let message = ctx.tr("progress.solveFrame", &[]);
                    let fraction = self.progress(ctx);
                    ctx.report(self.solved, time, &message, Some(fraction), None);
                    return Ok(());
                }
            }
        }
    }
}

/// One decode of the frames through `run`, as far as the scan rows and the decoder go.
fn sweep(ctx: &mut Ctx, source: &mut dyn FrameSource, run: &mut Run) -> Result<(), String> {
    let until = run
        .parents
        .is_some()
        .then(|| run.session.nested_until())
        .flatten();
    run.until = until;
    let mut ended_naturally = false;
    let mut missing_scan = false;
    {
        let mut frames = source.frames().map_err(|e| e.to_string())?;
        loop {
            ctx.checkpoint();
            let frame = match frames.next() {
                None => {
                    ended_naturally = true;
                    break;
                }
                Some(Err(e)) => {
                    if run.solved == 0 {
                        return Err(e.to_string());
                    }
                    ctx.partial = true;
                    ctx.prefix_only("DECODE_PREFIX_ONLY", "solve", run.solved, &e.to_string());
                    break;
                }
                Some(Ok(f)) => f,
            };
            let Some(Js::Obj(scan)) = ctx.get(&format!("scan/{}", pad(frame.index))) else {
                missing_scan = true;
                ctx.partial = true;
                let index = frame.index;
                ctx.emit(&|l| {
                    Obj::new()
                        .with("code", "MISSING_SCAN_RECORD")
                        .with("severity", "error")
                        .with("frame", index)
                        .with(
                            "message",
                            t(
                                l,
                                "diag.MISSING_SCAN_RECORD.message",
                                &[("index", Param::Str(&pad(index)))],
                            ),
                        )
                        .with("action", t(l, "diag.MISSING_SCAN_RECORD.action", &[]))
                        .with(
                            "detail",
                            Obj::new().with("pass", "solve").with("frame", index),
                        )
                });
                break;
            };
            if let Err(e) = run.frame(ctx, frame.index, frame.time, &frame.rgba, &scan) {
                if run.solved == 0 {
                    return Err(e);
                }
                ctx.partial = true;
                let solved = run.solved;
                ctx.prefix_only("ANALYSIS_PREFIX_ONLY", "solve", solved, &e);
                break;
            }
            if ctx.stop_requested {
                ctx.honour_stop();
                break;
            }
            if run.solved >= ctx.frames {
                break;
            }
            // A nested run ends after the last frame in which a container is in sight.
            if until.is_some_and(|n| run.solved >= n) {
                break;
            }
        }
    }
    if ended_naturally || missing_scan {
        let (frames, solved) = (ctx.frames, run.solved);
        ctx.pass_mismatch("solve", frames, solved);
    }
    Ok(())
}

/// What a run left once its pose graph was relaxed.
struct Finished {
    graph: PoseGraph,
    residual: f64,
    iterations: u32,
    /// Containers the pass found scrolling inside its regions.
    found: Vec<NestedFound>,
    /// On a nested run: the frames each confirmed container's parent shows it in, and the containers not confirmed.
    moments: Vec<(String, Vec<(u32, Rect)>)>,
    rejected: Vec<String>,
    held: Option<Held>,
}

fn graph_residual(ctx: &mut Ctx, residual: f64, iterations: u32) {
    ctx.emit(&|l| {
        Obj::new()
            .with("code", "GRAPH_RESIDUAL")
            .with("severity", "warning")
            .with(
                "message",
                t(
                    l,
                    "diag.GRAPH_RESIDUAL.message",
                    &[("residual", Param::Str(&to_fixed(residual, 2)))],
                ),
            )
            .with(
                "detail",
                Obj::new()
                    .with("residual", residual)
                    .with("iterations", iterations),
            )
            .with("action", t(l, "diag.GRAPH_RESIDUAL.action", &[]))
    });
}

/// Finalises every frame still in the voting ring, relaxes the pose graph and reports a large residual (a held run
/// keeps the relaxed rows and the residual with the rest of what it holds).
fn finish(ctx: &mut Ctx, mut run: Run) -> Finished {
    let drained = run.session.drain_voting();
    // Draining also reports what the pass found once it had seen every frame (nested containers).
    run.apply(ctx);
    run.queue_voting(ctx, drained);
    let mut graph = run.session.take_graph();
    let solved = run.solved;
    let (found, moments, rejected) = (
        std::mem::take(&mut run.found),
        std::mem::take(&mut run.moments),
        std::mem::take(&mut run.rejected),
    );
    let mut held = run.held.take();
    let nested = run.parents.is_some();
    drop(run);
    if !nested {
        ctx.processed = solved;
    }
    // When a second run will follow, the solve progress has not ended yet: the optimizing phase comes after it.
    if nested || found.is_empty() {
        let message = ctx.tr("progress.optimizing", &[]);
        ctx.event("optimizing", 0.0, solved, 0.0, message);
    }
    let (residual, iterations) = match graph.begin_optimize() {
        None => (0.0, 0),
        Some(mut optimizer) => {
            let mut stopped = false;
            loop {
                let done = optimizer.step(1);
                ctx.checkpoint();
                if ctx.stop_requested {
                    stopped = true;
                    break;
                }
                if done {
                    break;
                }
            }
            if stopped {
                ctx.honour_stop();
                (0.0, 0)
            } else {
                let (outcome, writes) = graph.finish_optimize(optimizer);
                match &mut held {
                    Some(held) => pose_rows(&writes, &mut |k, v| held.put(k, v)),
                    None => store_writes(ctx, &writes),
                }
                (outcome.residual, outcome.iterations)
            }
        }
    };
    if residual > 1.0 {
        match &mut held {
            Some(held) => held.residual = Some((residual, iterations)),
            None => graph_residual(ctx, residual, iterations),
        }
    }
    Finished {
        graph,
        residual,
        iterations,
        found,
        moments,
        rejected,
        held,
    }
}

fn session(ctx: &Ctx, regions: Vec<SolveRegion>) -> SolveSession {
    SolveSession::new(SolveConfig {
        width: ctx.info.width,
        height: ctx.info.height,
        factor: ctx.factor as u32,
        radius: ctx.refine_radius,
        noise: ctx.noise,
        voting_budget: VOTING_RING_BYTES,
        regions,
    })
}

/// Runs the solve pass.
pub fn solve(
    ctx: &mut Ctx,
    source: &mut dyn FrameSource,
    features: Features,
) -> Result<(), String> {
    ctx.phase = "solving";
    ctx.status = "solving";
    ctx.solve_progress = 0.0;
    ctx.persist();
    let regions = ctx
        .regions
        .iter()
        .enumerate()
        .filter(|(_, r)| kind_str(r) != "ignore")
        .map(|(i, r)| SolveRegion {
            id: r.id.clone(),
            name: region_name(r),
            moving: kind_str(r) == "moving",
            kind: kind_str(r).to_string(),
            unassigned: r.unassigned,
            code: (i + 1) as u8,
            shape: shape(r),
            epochs: r.epochs.clone(),
            sticky: r.sticky.clone(),
            nest: None,
        })
        .collect();
    let mut run = Run {
        session: session(ctx, regions),
        keyframes: HashMap::new(),
        features: &features,
        solved: 0,
        found: Vec::new(),
        moments: Vec::new(),
        rejected: Vec::new(),
        held: None,
        candidates: 0,
        until: None,
        parents: None,
    };
    sweep(ctx, source, &mut run)?;
    let done = finish(ctx, run);
    ctx.put(
        "graph-summary",
        Obj::new()
            .with("loops", done.graph.loops())
            .with("residual", done.residual)
            .with("iterations", done.iterations),
    );
    if !done.found.is_empty() && !ctx.stop_requested && !ctx.partial {
        solve_nested(ctx, source, &features, done.found)?;
    }
    ctx.persist();
    Ok(())
}

/// The containers `found` as regions of their own (`solve.ts`'s `nestedRegions`): their solve regions, their rows
/// for `regions`, their parents and their entries in [`Ctx::nested`].
struct Children {
    regions: Vec<SolveRegion>,
    ids: Vec<String>,
    rows: Vec<Js>,
    parents: HashMap<String, String>,
    nested: Vec<NestedRegion>,
}

fn nested_children(ctx: &Ctx, found: &[&NestedFound], plans: &[Option<Obj>]) -> Children {
    let base = match ctx.get("regions") {
        Some(Js::Arr(a)) => a,
        _ => Vec::new(),
    };
    let mut c = Children {
        regions: Vec::new(),
        ids: Vec::new(),
        rows: Vec::new(),
        parents: HashMap::new(),
        nested: Vec::new(),
    };
    for f in found {
        let Some(parent) = ctx.regions.iter().position(|r| r.id == f.region) else {
            continue;
        };
        let Some(Js::Obj(mut row)) = base.get(parent).cloned() else {
            continue;
        };
        let r = &ctx.regions[parent];
        let id = format!("{}-nested-{}", r.id, c.regions.len());
        // The closed vocabulary's name for the region at this index (`src/i18n/names.ts`).
        let n = (base.len() + c.regions.len() + 1).to_string();
        let name = t(Locale::Zh, "names.contentCanvas", &[("n", Param::Str(&n))]);
        row.set("id", id.as_str());
        row.set("name", name.as_str());
        row.remove("epochs");
        row.remove("sticky");
        row.set("parent", r.id.as_str());
        row.set(
            "nest",
            Obj::new()
                .with("canvas", f.canvas.as_str())
                .with("footprint", rect(f.footprint))
                .with("open", f.open as u32),
        );
        c.rows.push(Js::Obj(row));
        let parent_poses = plans
            .iter()
            .map(
                |plan| match plan.as_ref().and_then(|p| p.get("placements")) {
                    Some(Js::Arr(list)) => list.iter().find_map(|q| match q {
                        Js::Obj(q)
                            if q.str("layer") == Some(r.id.as_str())
                                && q.str("canvasId") == Some(f.canvas.as_str())
                                && !q.bool("skip") =>
                        {
                            Some((q.num("x"), q.num("y")))
                        }
                        _ => None,
                    }),
                    _ => None,
                },
            )
            .collect();
        c.regions.push(SolveRegion {
            id: id.clone(),
            name,
            moving: true,
            kind: "moving".to_string(),
            unassigned: r.unassigned,
            code: (parent + 1) as u8,
            shape: shape(r),
            epochs: Vec::new(),
            sticky: Vec::new(),
            nest: Some(Nest {
                canvas: f.canvas.clone(),
                footprint: f.footprint,
                open: f.open,
                parent_poses,
            }),
        });
        c.parents.insert(id.clone(), r.id.clone());
        c.ids.push(id.clone());
        c.nested.push(NestedRegion { id, parent });
    }
    c
}

fn run_nested(
    ctx: &mut Ctx,
    source: &mut dyn FrameSource,
    features: &Features,
    children: &mut Children,
    held: bool,
) -> Result<Finished, String> {
    let mut run = Run {
        session: session(ctx, std::mem::take(&mut children.regions)),
        keyframes: HashMap::new(),
        features,
        solved: 0,
        found: Vec::new(),
        moments: Vec::new(),
        rejected: Vec::new(),
        held: held.then(Held::default),
        candidates: 0,
        until: None,
        parents: Some(children.parents.clone()),
    };
    sweep(ctx, source, &mut run)?;
    Ok(finish(ctx, run))
}

/// Adds the confirmed containers to the run and shows each in its parent's print at its moment.
fn keep_nested(ctx: &mut Ctx, children: Children, moments: Vec<(String, Vec<(u32, Rect)>)>) {
    let mut rows = match ctx.get("regions") {
        Some(Js::Arr(a)) => a,
        _ => Vec::new(),
    };
    rows.extend(children.rows);
    ctx.put("regions", Js::Arr(rows));
    ctx.nested.extend(children.nested);
    show_moments(ctx, &children.parents, moments);
}

/// Solves the containers the first run found scrolling inside its regions, each as a region of its own clipped to its
/// footprint (`engine::solve::Nest`), in a second run over the frames (`solve.ts`'s `solveNested`). The run's rows
/// are held back until it has confirmed its containers: when it confirms them all they are stored; when it confirms
/// some, those are solved again on their own; a container it does not confirm stays part of its parent.
fn solve_nested(
    ctx: &mut Ctx,
    source: &mut dyn FrameSource,
    features: &Features,
    found: Vec<NestedFound>,
) -> Result<(), String> {
    let plans: Vec<Option<Obj>> = (0..ctx.processed)
        .map(|i| match ctx.get(&format!("plan/{}", pad(i))) {
            Some(Js::Obj(o)) => Some(o),
            _ => None,
        })
        .collect();
    let usable: Vec<&NestedFound> = found
        .iter()
        .filter(|f| ctx.regions.iter().any(|r| r.id == f.region))
        .collect();
    let mut children = nested_children(ctx, &usable, &plans);
    if children.regions.is_empty() {
        return Ok(());
    }
    let probe = run_nested(ctx, source, features, &mut children, true)?;
    if ctx.stop_requested || ctx.partial {
        return Ok(());
    }
    if probe.rejected.is_empty() {
        let held = probe.held.unwrap_or_default();
        for (key, value) in held.rows {
            ctx.put(&key, value);
        }
        for d in &held.diagnostics {
            ctx.emit(&|l| solve_diagnostic(d, l));
        }
        if let Some((residual, iterations)) = held.residual {
            graph_residual(ctx, residual, iterations);
        }
        ctx.canvas_count += held.canvases;
        keep_nested(ctx, children, probe.moments);
        return Ok(());
    }
    let confirmed: Vec<&NestedFound> = usable
        .iter()
        .zip(&children.ids)
        .filter(|(_, id)| !probe.rejected.contains(id))
        .map(|(f, _)| *f)
        .collect();
    if confirmed.is_empty() {
        return Ok(());
    }
    let mut kept = nested_children(ctx, &confirmed, &plans);
    let run = run_nested(ctx, source, features, &mut kept, false)?;
    keep_nested(ctx, kept, run.moments);
    Ok(())
}

/// Takes each moment frame's clip back out of the parent placement's occlusions, so the parent's print holds the
/// container as it was in one state of its own scroll (`solve.ts`'s `showMoments`).
fn show_moments(
    ctx: &mut Ctx,
    parents: &HashMap<String, String>,
    moments: Vec<(String, Vec<(u32, Rect)>)>,
) {
    for (region, frames) in moments {
        let parent = parents.get(&region).map(String::as_str);
        for (frame, clip) in frames {
            let key = format!("plan/{}", pad(frame));
            let Some(Js::Obj(mut row)) = ctx.get(&key) else {
                continue;
            };
            let Some(Js::Arr(list)) = row.get_mut("placements") else {
                continue;
            };
            let Some(Js::Obj(q)) = list
                .iter_mut()
                .find(|q| matches!(q, Js::Obj(q) if q.str("layer") == parent && !q.bool("skip")))
            else {
                continue;
            };
            let Some(Js::Arr(occlusions)) = q.get_mut("occlusions") else {
                continue;
            };
            let target = rect(clip);
            let Some(k) = occlusions.iter().rposition(|o| *o == target) else {
                continue;
            };
            occlusions.remove(k);
            if occlusions.is_empty() {
                q.remove("occlusions");
            }
            ctx.put(&key, row);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::diagnostic::{Severity, Value};
    use crate::kernels::geometry::Rect;

    // Failure cases: a tracked placement's registration window lost from the native row (the page keeps it);
    // a static placement, which has no rectangle, gaining one.
    #[test]
    fn a_low_confidence_placement_keeps_its_detail_as_the_page_does() {
        let rect = Rect {
            x: 0.0,
            y: 0.0,
            width: 640.0,
            height: 480.0,
        };
        let detail = Value::Object(vec![
            ("registrationScreenRect", Value::rect(rect)),
            ("fullRegionFallback", Value::Bool(true)),
        ]);
        let tracked = EngineDiagnostic::new("LOW_CONFIDENCE_PLACEMENT", Severity::Warning)
            .at(3, 0.1)
            .canvas("canvas-1")
            .confidence(0.3)
            .region(rect)
            .param("ambiguous", 0.0)
            .detail(detail.clone());
        let row = solve_diagnostic(&tracked, Locale::Zh);
        let mut json = String::new();
        crate::value::write_json(row.get("detail").unwrap(), &mut json);
        assert_eq!(
            json,
            r#"{"registrationScreenRect":{"x":0,"y":0,"width":640,"height":480},"fullRegionFallback":true}"#
        );
        let mut still = tracked.clone();
        still.region = None;
        assert!(solve_diagnostic(&still, Locale::Zh).get("detail").is_none());
    }
}
