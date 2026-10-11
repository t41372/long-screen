//! Host of the solve pass (the page's `src/pipeline/solve/solve.ts`): drives the engine's `SolveSession` frame by
//! frame, stores the rows it hands back, formats its diagnostics (`solve/diagnostics.ts`), relaxes the pose graph
//! and drops the pass's scratch.

use crate::context::{pad, t, Ctx};
use crate::engine::catalog::{Locale, Param};
use crate::engine::diagnostic::Diagnostic as EngineDiagnostic;
use crate::engine::pose_graph::{PoseEdge, PoseNode, PoseRow, Write};
use crate::engine::solve::{
    Begin, Effect, Keyframe, Placement, Poll, ScanFields, SolveConfig, SolveRegion, SolveSession,
    VotingRecord, VOTING_RING_BYTES,
};
use crate::kernels::features::{Feature, DESCRIPTOR_WORDS};
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
    let put = |ctx: &mut Ctx, row: &PoseRow| {
        let value = match row {
            PoseRow::Node(n) => node_js(n),
            PoseRow::Edge { edge, .. } => edge_js(edge),
        };
        ctx.put(&row.key(), value);
    };
    for w in writes {
        match w {
            Write::Put(row) => put(ctx, row),
            Write::PutMany(rows) => rows.iter().for_each(|r| put(ctx, r)),
        }
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
}

impl Run<'_> {
    fn apply(&mut self, ctx: &mut Ctx) {
        for effect in self.session.take_effects() {
            match effect {
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
                    ctx.put(&format!("canvas/{}", meta.id), o);
                    if created {
                        ctx.canvas_count += 1;
                    }
                }
                Effect::Attachment(a) => ctx.put(
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
                Effect::Graph(w) => store_writes(ctx, std::slice::from_ref(&w)),
                Effect::Diagnostic(d) => ctx.emit(&|l| solve_diagnostic(&d, l)),
            }
        }
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
            ctx.put(&format!("consistency/{}", pad(record.index)), row);
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
                ctx.put(&format!("plan/{}", pad(index)), plan);
                self.solved = index + 1;
                let message = ctx.tr("progress.duplicateReuse", &[]);
                let frames = ctx.frames;
                ctx.report(
                    self.solved,
                    time,
                    &message,
                    Some(self.solved as f64 / frames as f64),
                    None,
                );
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
        let labels = &ctx.atlas.as_ref().ok_or("no region atlas")?.0.clone();
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
                    ctx.put(&format!("plan/{}", pad(index)), plan);
                    self.solved = index + 1;
                    let message = ctx.tr("progress.solveFrame", &[]);
                    let frames = ctx.frames;
                    ctx.report(
                        self.solved,
                        time,
                        &message,
                        Some(self.solved as f64 / frames as f64),
                        None,
                    );
                    return Ok(());
                }
            }
        }
    }
}

/// Runs the solve pass.
pub fn solve(
    ctx: &mut Ctx,
    source: &mut dyn FrameSource,
    features: Features,
) -> Result<(), String> {
    ctx.phase = "solving";
    ctx.status = "solving";
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
        })
        .collect();
    let session = SolveSession::new(SolveConfig {
        width: ctx.info.width,
        height: ctx.info.height,
        factor: ctx.factor as u32,
        radius: ctx.refine_radius,
        noise: ctx.noise,
        voting_budget: VOTING_RING_BYTES,
        regions,
    });
    let mut run = Run {
        session,
        keyframes: HashMap::new(),
        features: &features,
        solved: 0,
    };
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
        }
    }
    if ended_naturally || missing_scan {
        let (frames, solved) = (ctx.frames, run.solved);
        ctx.pass_mismatch("solve", frames, solved);
    }
    // Finalise every frame still in the voting ring, then relax the pose graph.
    let drained = run.session.drain_voting();
    run.queue_voting(ctx, drained);
    let mut graph = run.session.take_graph();
    let solved = run.solved;
    drop(run);
    ctx.processed = solved;
    let message = ctx.tr("progress.optimizing", &[]);
    ctx.event("optimizing", 0.0, solved, 0.0, message);
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
                store_writes(ctx, &writes);
                (outcome.residual, outcome.iterations)
            }
        }
    };
    if residual > 1.0 {
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
    ctx.put(
        "graph-summary",
        Obj::new()
            .with("loops", graph.loops())
            .with("residual", residual)
            .with("iterations", iterations),
    );
    ctx.persist();
    Ok(())
}
