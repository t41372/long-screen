//! Host of the render pass (the page's `src/pipeline/render.ts` with `src/core/compositor.ts`): the one-frame
//! lookahead decode loop around the engine's `RenderSession`, answering what it asks for (plans, voting records,
//! canvas rows, tiles, temporal rows), storing what it produces, and formatting its diagnostics.

use crate::context::{pad, t, Ctx};
use crate::solve::kind_str;
use crate::source::{Frame, FrameSource};
use crate::value::{detail, read_rect, rect, to_locale, Js, Obj};
use long_screen_core::geometry::Rect;
use long_screen_core::temporal::TemporalRecord;
use long_screen_engine::attachments::Attachment;
use long_screen_engine::catalog::{Locale, Param};
use long_screen_engine::compositor::{Compositor, TemporalPolicy};
use long_screen_engine::diagnostic::Diagnostic as EngineDiagnostic;
use long_screen_engine::pose_graph::{EdgeKind, PoseEdge, PoseGraph, PoseNode};
use long_screen_engine::render::{
    CanvasMeta, ConsistencyRecord, ConsistencyVote, FrameInput, FramePlan, PlanPlacement,
    RegionKind, RenderConfig, RenderIo, RenderRegion, RenderSession, RenderStep,
};
use long_screen_engine::tiles::TileKey;
use std::collections::{HashMap, HashSet};
use std::time::Instant;

/// The tile-flush period of the page's render pass.
const FLUSH_MS: f64 = 1200.0;

fn plan_of(row: &Obj) -> FramePlan {
    let placements = row
        .get("placements")
        .and_then(Js::as_arr)
        .unwrap_or(&[])
        .iter()
        .filter_map(Js::as_obj)
        .map(|p| PlanPlacement {
            layer: p.str("layer").unwrap_or_default().to_string(),
            canvas_id: p.str("canvasId").unwrap_or_default().to_string(),
            node: p.str("node").unwrap_or_default().to_string(),
            x: p.num("x"),
            y: p.num("y"),
            confidence: p.num("confidence"),
            uncertain: p.bool("uncertain"),
            time: p.num("time"),
            skip: match p.get("skip") {
                Some(Js::Bool(b)) => Some(*b),
                _ => None,
            },
            occlusions: p
                .get("occlusions")
                .and_then(Js::as_arr)
                .map(|a| a.iter().filter_map(read_rect).collect()),
        })
        .collect();
    FramePlan {
        placements,
        duplicate: row.bool("duplicate"),
    }
}

fn placement_js(p: &PlanPlacement) -> Js {
    let mut o = Obj::new()
        .with("layer", p.layer.as_str())
        .with("canvasId", p.canvas_id.as_str())
        .with("node", p.node.as_str())
        .with("x", p.x)
        .with("y", p.y)
        .with("confidence", p.confidence)
        .with("uncertain", p.uncertain)
        .with("time", p.time);
    if let Some(skip) = p.skip {
        o.set("skip", skip);
    }
    if let Some(occ) = &p.occlusions {
        o.set(
            "occlusions",
            Js::Arr(occ.iter().map(|r| rect(*r)).collect()),
        );
    }
    Js::Obj(o)
}

fn record_of(row: &Obj) -> ConsistencyRecord {
    row.0
        .iter()
        .filter_map(|(id, v)| {
            let v = v.as_obj()?;
            let bytes = |k: &str| {
                v.get(k)
                    .and_then(Js::bytes)
                    .map(|b| b.to_vec())
                    .unwrap_or_default()
            };
            Some((
                id.clone(),
                ConsistencyVote {
                    x0: v.num("x0") as i32,
                    y0: v.num("y0") as i32,
                    w: v.num("w") as i32,
                    h: v.num("h") as i32,
                    bits: bytes("bits"),
                    clean: bytes("clean"),
                },
            ))
        })
        .collect()
}

fn meta_of(row: &Obj) -> CanvasMeta {
    CanvasMeta {
        bounds: row.get("bounds").and_then(read_rect).unwrap_or(Rect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        }),
        tile_count: row.num("tileCount"),
        observed_pixels: row.num("observedPixels"),
        uncertain_pixels: row.num("uncertainPixels"),
        conflict_pixels: row.num("conflictPixels"),
        provisional_pixels: row.num("provisionalPixels"),
        last_time: row.num("lastTime"),
    }
}

fn write_meta(row: &mut Obj, m: &CanvasMeta) {
    row.set("bounds", rect(m.bounds));
    row.set("tileCount", m.tile_count);
    row.set("observedPixels", m.observed_pixels);
    row.set("uncertainPixels", m.uncertain_pixels);
    row.set("conflictPixels", m.conflict_pixels);
    row.set("provisionalPixels", m.provisional_pixels);
    row.set("lastTime", m.last_time);
}

/// The pose graph as the render pass reads it back from the store: every `node/` row, then every `edge/` row.
pub fn hydrate_graph(ctx: &Ctx) -> PoseGraph {
    let mut graph = PoseGraph::new();
    for key in ctx.keys("node/") {
        if let Some(Js::Obj(n)) = ctx.get(&key) {
            graph.hydrate_node(PoseNode {
                id: n.str("id").unwrap_or_default().to_string(),
                canvas_id: n.str("canvasId").unwrap_or_default().to_string(),
                frame: n.num("frame") as u32,
                x: n.num("x"),
                y: n.num("y"),
                original_x: n.num("originalX"),
                original_y: n.num("originalY"),
                pinned: n.bool("pinned"),
                next: n.str("next").map(String::from),
            });
        }
    }
    for key in ctx.keys("edge/") {
        if let Some(Js::Obj(e)) = ctx.get(&key) {
            graph.hydrate_edge(
                &key,
                PoseEdge {
                    other: e.str("other").unwrap_or_default().to_string(),
                    dx: e.num("dx"),
                    dy: e.num("dy"),
                    weight: e.num("weight"),
                    kind: if e.str("kind") == Some("loop") {
                        EdgeKind::Loop
                    } else {
                        EdgeKind::Odometry
                    },
                },
            );
        }
    }
    graph
}

fn temporal_js(canvas: &str, record: &TemporalRecord, blocks: &[(i32, i32)]) -> Js {
    Js::Obj(
        Obj::new()
            .with("id", record.id.as_str())
            .with("canvasId", canvas)
            .with("rect", rect(record.rect))
            .with("chosenFrame", record.chosen_frame)
            .with("chosenTime", record.chosen_time)
            .with("complete", record.complete)
            .with("revisions", record.revisions)
            .with(
                "blocks",
                Js::Arr(
                    blocks
                        .iter()
                        .map(|(x, y)| Js::Arr(vec![Js::Num(*x as f64), Js::Num(*y as f64)]))
                        .collect(),
                ),
            ),
    )
}

fn temporal_of(row: &Obj) -> TemporalRecord {
    let blocks: HashSet<(i32, i32)> = row
        .get("blocks")
        .and_then(Js::as_arr)
        .unwrap_or(&[])
        .iter()
        .filter_map(|b| {
            let b = b.as_arr()?;
            Some((b.first()?.num() as i32, b.get(1)?.num() as i32))
        })
        .collect();
    TemporalRecord {
        id: row.str("id").unwrap_or_default().to_string(),
        rect: row.get("rect").and_then(read_rect).unwrap_or(Rect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        }),
        keys: blocks,
        chosen_frame: row.num("chosenFrame") as u32,
        chosen_time: row.num("chosenTime"),
        complete: row.bool("complete"),
        revisions: row.num("revisions") as u32,
    }
}

/// One of the render session's diagnostics as the journal row (render.ts `report`, `Compositor.report`).
fn render_diagnostic(d: &EngineDiagnostic, stable: bool, l: Locale) -> Obj {
    let time = d.time.map_or(Js::Undefined, Js::Num);
    let frame = d.frame.map_or(Js::Undefined, |f| Js::Num(f as f64));
    let canvas = d.canvas.clone().map_or(Js::Undefined, Js::Str);
    let region = d.region.map_or(Js::Undefined, rect);
    match d.code {
        "NONFINITE_POSE" => Obj::new()
            .with("code", "NONFINITE_POSE")
            .with("severity", "error")
            .with("time", time)
            .with("frame", frame)
            .with("canvasId", canvas)
            .with("message", t(l, "diag.NONFINITE_POSE.message", &[])),
        "INCOMPLETE_TEMPORAL_PATCH" => Obj::new()
            .with("code", "INCOMPLETE_TEMPORAL_PATCH")
            .with("severity", "warning")
            .with("canvasId", canvas)
            .with("frame", frame)
            .with("time", time)
            .with("region", region)
            .with(
                "message",
                t(l, "diag.INCOMPLETE_TEMPORAL_PATCH.message", &[]),
            )
            .with("action", t(l, "diag.INCOMPLETE_TEMPORAL_PATCH.action", &[])),
        _ => {
            let det = d.detail.as_ref().map_or(Js::Undefined, detail);
            let count = det
                .as_obj()
                .and_then(|o| o.get("regions"))
                .and_then(Js::as_arr)
                .map_or(0, |r| r.len());
            let conflicts = d
                .params
                .iter()
                .find(|(k, _)| *k == "conflicts")
                .map_or(0.0, |(_, v)| *v);
            Obj::new()
                .with("code", "TEMPORAL_OR_ALIGNMENT_CONFLICT")
                .with("severity", "warning")
                .with("time", time)
                .with("frame", frame)
                .with("canvasId", canvas)
                .with("region", region)
                .with("confidence", d.confidence.map_or(Js::Undefined, Js::Num))
                .with("count", count)
                .with("detail", det)
                .with(
                    "message",
                    t(
                        l,
                        "diag.TEMPORAL_OR_ALIGNMENT_CONFLICT.message",
                        &[("conflicts", Param::Str(&to_locale(conflicts)))],
                    ),
                )
                .with(
                    "action",
                    t(
                        l,
                        if stable {
                            "diag.TEMPORAL_OR_ALIGNMENT_CONFLICT.actionStable"
                        } else {
                            "diag.TEMPORAL_OR_ALIGNMENT_CONFLICT.actionRolling"
                        },
                        &[],
                    ),
                )
        }
    }
}

struct Pass {
    session: RenderSession,
    compositor: Compositor,
    graph: Option<PoseGraph>,
    labels: Vec<u8>,
    metas: HashMap<String, Obj>,
    base: (u64, f64, f64),
    last_flush: f64,
    started: Instant,
    stable: bool,
    missing_plan: bool,
    stop: bool,
}

impl Pass {
    fn now(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }

    fn report(&mut self, ctx: &mut Ctx, d: &EngineDiagnostic) {
        let stable = self.stable;
        ctx.emit(&|l| render_diagnostic(d, stable, l));
    }

    fn live_meta(&mut self, canvas: &str, values: Option<CanvasMeta>) -> Option<Obj> {
        let values = values.or_else(|| self.session.meta(canvas));
        let meta = self.metas.get_mut(canvas)?;
        if let Some(v) = values {
            write_meta(meta, &v);
        }
        Some(meta.clone())
    }

    fn flush_metas(&mut self, ctx: &mut Ctx) {
        for (canvas, meta) in self.session.take_dirty_metas() {
            if let Some(row) = self.live_meta(&canvas, Some(meta)) {
                ctx.put(&format!("canvas/{canvas}"), row);
            }
        }
    }

    fn flush_temporal(&mut self, ctx: &mut Ctx) {
        for f in self.compositor.flush() {
            for id in &f.deleted {
                ctx.delete(&format!("temporal/{}/{id}", f.canvas));
            }
            for (record, blocks) in &f.dirty {
                ctx.put(
                    &format!("temporal/{}/{}", f.canvas, record.id),
                    temporal_js(&f.canvas, record, blocks),
                );
            }
        }
    }

    fn checkpoint_flush(&mut self, ctx: &mut Ctx) -> Result<(), String> {
        let now = self.now();
        if now - self.last_flush >= FLUSH_MS {
            let settled_before = self.last_flush;
            self.last_flush = self.now();
            let run = ctx.key("");
            ctx.tiles
                .flush(&mut ctx.store, &run, Some(settled_before))?;
            self.flush_temporal(ctx);
            self.flush_metas(ctx);
        }
        Ok(())
    }

    /// Runs one frame through the session until it hands back the frame's observation row.
    fn composite(
        &mut self,
        ctx: &mut Ctx,
        frame: &Frame,
        plan: FramePlan,
        prev: Option<&[u8]>,
        next: Option<&[u8]>,
    ) -> Result<(Js, Option<String>), String> {
        let index = frame.index;
        let plan_at = |ctx: &Ctx, i: u32| match ctx.get(&format!("plan/{}", pad(i))) {
            Some(Js::Obj(o)) => Some(plan_of(&o)),
            _ => None,
        };
        let prev_plan = if prev.is_some() && index > 0 {
            plan_at(ctx, index - 1)
        } else {
            None
        };
        let next_plan = if next.is_some() {
            plan_at(ctx, index + 1)
        } else {
            None
        };
        let votes = self
            .session
            .wanted_votes(index, prev.is_some(), next.is_some())
            .into_iter()
            .map(|i| {
                let record = if i >= 0 {
                    match ctx.get(&format!("consistency/{}", pad(i as u32))) {
                        Some(Js::Obj(o)) => Some(record_of(&o)),
                        _ => None,
                    }
                } else {
                    None
                };
                (i, record)
            })
            .collect();
        self.session
            .begin(
                FrameInput {
                    index,
                    time: frame.time,
                    plan,
                    has_prev: prev.is_some(),
                    prev_plan,
                    has_next: next.is_some(),
                    next_plan,
                },
                votes,
            )
            .map_err(|e| e.to_string())?;
        if self.graph.is_none() {
            self.graph = Some(hydrate_graph(ctx));
        }
        loop {
            let now = self.now();
            let step = {
                let mut io = RenderIo {
                    cache: &mut ctx.tiles.cache,
                    compositor: &mut self.compositor,
                    graph: self.graph.as_ref().unwrap(),
                    labels: &self.labels,
                    now,
                };
                self.session.step(&mut io)
            };
            let events = self.session.take_events();
            let counters = self.session.counters();
            ctx.skipped_paints = self.base.0 + counters.skipped_paints;
            ctx.tile_total = self.base.1 + counters.tiles;
            ctx.observed_pixels = self.base.2 + counters.observed_pixels;
            for e in &events {
                self.report(ctx, e);
            }
            match step.map_err(|e| e.to_string())? {
                RenderStep::Done(outcome) => {
                    let o = outcome.observation;
                    let decisions = o
                        .decisions
                        .iter()
                        .map(|d| {
                            let mut row = Obj::new()
                                .with("canvasId", d.canvas_id.as_str())
                                .with("placement", placement_js(&d.placement))
                                .with("addedPixels", d.added_pixels)
                                .with("conflictPixels", d.conflict_pixels)
                                .with("uncertainPixels", d.uncertain_pixels);
                            if d.skipped {
                                row.set("skipped", true);
                            }
                            if d.reused_exact_observation {
                                row.set("reusedExactObservation", true);
                            }
                            Js::Obj(row)
                        })
                        .collect();
                    let row = Obj::new()
                        .with("frame", o.frame)
                        .with("time", o.time)
                        .with("decisions", Js::Arr(decisions));
                    return Ok((Js::Obj(row), outcome.latest));
                }
                RenderStep::NeedMeta(canvas) => {
                    let meta = match ctx.get(&format!("canvas/{canvas}")) {
                        Some(Js::Obj(o)) => Some(o),
                        _ => None,
                    };
                    let values = meta.as_ref().map(meta_of);
                    if let Some(m) = meta {
                        self.metas.insert(canvas.clone(), m);
                    }
                    self.session.provide_meta(&canvas, values);
                }
                RenderStep::NeedFrame(i) => {
                    let image = if i == index {
                        &frame.rgba[..]
                    } else if i < index {
                        prev.ok_or("CORE_BAD_ARGUMENT: no previous frame")?
                    } else {
                        next.ok_or("CORE_BAD_ARGUMENT: no next frame")?
                    };
                    let slot = self.session.frame_slot(i);
                    if slot.len() != image.len() {
                        return Err(format!(
                            "CORE_BAD_ARGUMENT: frame does not fit a {}×{} ring.",
                            ctx.info.width, ctx.info.height
                        ));
                    }
                    slot.copy_from_slice(image);
                }
                RenderStep::NeedTile(key) => {
                    let run = ctx.key("");
                    ctx.tiles.load(
                        &mut ctx.store,
                        &run,
                        TileKey::new(&key.canvas, 0, key.x, key.y),
                    )?;
                }
                RenderStep::NeedTemporal(canvas) => {
                    let records = ctx
                        .keys(&format!("temporal/{canvas}/"))
                        .into_iter()
                        .filter_map(|k| match ctx.get(&k) {
                            Some(Js::Obj(o)) => Some(temporal_of(&o)),
                            _ => None,
                        })
                        .collect();
                    self.compositor
                        .load_temporal(&canvas, records)
                        .map_err(|e| format!("{e:?}"))?;
                }
            }
        }
    }

    /// One decoded frame: composite its plan, store the ledger row, report progress.
    fn process(
        &mut self,
        ctx: &mut Ctx,
        frame: &Frame,
        prev: Option<&[u8]>,
        next: Option<&[u8]>,
    ) -> Result<(), String> {
        let index = frame.index;
        let plan = match ctx.get(&format!("plan/{}", pad(index))) {
            Some(Js::Obj(o)) => plan_of(&o),
            _ => {
                ctx.partial = true;
                self.missing_plan = true;
                ctx.emit(&|l| {
                    Obj::new()
                        .with("code", "MISSING_PLAN")
                        .with("severity", "error")
                        .with("frame", index)
                        .with(
                            "message",
                            t(
                                l,
                                "diag.MISSING_PLAN.message",
                                &[("index", Param::Str(&pad(index)))],
                            ),
                        )
                        .with("action", t(l, "diag.MISSING_PLAN.action", &[]))
                        .with(
                            "detail",
                            Obj::new().with("pass", "render").with("frame", index),
                        )
                });
                self.stop = true;
                return Ok(());
            }
        };
        let result =
            self.composite(ctx, frame, plan, prev, next)
                .and_then(|(observation, latest)| {
                    ctx.put(&format!("observation/{}", pad(index)), observation);
                    ctx.rendered_frames = index + 1;
                    self.checkpoint_flush(ctx)?;
                    let latest = latest.and_then(|c| self.live_meta(&c, None).map(|_| c));
                    let message = ctx.tr("progress.render", &[]);
                    let fraction = (index + 1) as f64 / ctx.processed.max(1) as f64;
                    ctx.report(
                        index + 1,
                        frame.time,
                        &message,
                        Some(fraction),
                        latest.as_deref(),
                    );
                    Ok(())
                });
        match result {
            Ok(()) => {
                if ctx.stop_requested {
                    ctx.honour_stop();
                    self.stop = true;
                } else if index + 1 >= ctx.processed {
                    self.stop = true;
                }
                Ok(())
            }
            Err(e) => {
                self.session.cancel(&mut self.compositor);
                if ctx.rendered_frames == 0 {
                    return Err(e);
                }
                ctx.partial = true;
                let rendered = ctx.rendered_frames;
                ctx.prefix_only("ANALYSIS_PREFIX_ONLY", "render", rendered, &e);
                self.stop = true;
                Ok(())
            }
        }
    }
}

/// Runs the render pass.
pub fn render(ctx: &mut Ctx, source: &mut dyn FrameSource) -> Result<(), String> {
    ctx.phase = "rendering";
    ctx.status = "rendering";
    ctx.persist();
    let (labels, counts) = ctx.atlas.clone().ok_or("no region atlas")?;
    let attachments = ctx
        .keys("attach/")
        .into_iter()
        .filter_map(|k| match ctx.get(&k) {
            Some(Js::Obj(a)) => Some(Attachment {
                id: a.str("id").unwrap_or_default().to_string(),
                target: a.str("target").unwrap_or_default().to_string(),
                dx: a.num("dx"),
                dy: a.num("dy"),
                frame: a.num("frame") as u32,
                confidence: a.num("confidence"),
                node: a.str("node").unwrap_or_default().to_string(),
            }),
            _ => None,
        })
        .collect();
    let regions = ctx
        .regions
        .iter()
        .enumerate()
        .map(|(i, r)| RenderRegion {
            id: r.id.clone(),
            kind: match kind_str(r) {
                "moving" => RegionKind::Moving,
                "fixed" => RegionKind::Fixed,
                _ => RegionKind::Ignore,
            },
            rect: r.rect,
            code: (i + 1) as u8,
            owned_pixels: counts.get(i + 1).copied().unwrap_or(0) as f64,
        })
        .collect();
    let session = RenderSession::new(RenderConfig {
        width: ctx.info.width,
        height: ctx.info.height,
        factor: ctx.factor as i32,
        noise: ctx.noise,
        regions,
        attachments,
    });
    let stable = ctx.settings.stable();
    let compositor = Compositor::new(
        if stable {
            TemporalPolicy::Stable
        } else {
            TemporalPolicy::Latest
        },
        ctx.info.width,
        ctx.info.height,
    );
    let mut pass = Pass {
        session,
        compositor,
        graph: None,
        labels,
        metas: HashMap::new(),
        base: (ctx.skipped_paints, ctx.tile_total, ctx.observed_pixels),
        last_flush: 0.0,
        started: Instant::now(),
        stable,
        missing_plan: false,
        stop: false,
    };
    pass.last_flush = pass.now();
    if let Some(raised) = pass
        .session
        .configure_tiles(&mut ctx.tiles.cache, ctx.settings.memory_mb)
    {
        let param = |n: &str| {
            raised
                .params
                .iter()
                .find(|(k, _)| *k == n)
                .map_or(0.0, |(_, v)| *v)
        };
        let (from, to, mb) = (param("from"), param("to"), param("mb"));
        let det = raised.detail.as_ref().map_or(Js::Undefined, detail);
        ctx.emit(&|l| {
            Obj::new()
                .with("code", "MEMORY_BUDGET_RAISED")
                .with("severity", "info")
                .with(
                    "message",
                    t(
                        l,
                        "diag.MEMORY_BUDGET_RAISED.message",
                        &[
                            ("from", Param::Num(from)),
                            ("to", Param::Num(to)),
                            ("mb", Param::Num(mb)),
                        ],
                    ),
                )
                .with("action", t(l, "diag.MEMORY_BUDGET_RAISED.action", &[]))
                .with("detail", det.clone())
        });
    }
    let mut ended_naturally = false;
    let outcome = (|| -> Result<(), String> {
        let mut frames = source.frames().map_err(|e| e.to_string())?;
        let mut pending: Option<Frame> = None;
        let mut pending_prev: Option<Vec<u8>> = None;
        loop {
            ctx.checkpoint();
            match frames.next() {
                Some(Err(e)) => {
                    if let Some(p) = pending.take() {
                        pass.process(ctx, &p, pending_prev.as_deref(), None)?;
                    }
                    if ctx.rendered_frames == 0 {
                        return Err(e.to_string());
                    }
                    ctx.partial = true;
                    let rendered = ctx.rendered_frames;
                    ctx.prefix_only("DECODE_PREFIX_ONLY", "render", rendered, &e.to_string());
                    return Ok(());
                }
                None => {
                    ended_naturally = true;
                    if let Some(p) = pending.take() {
                        pass.process(ctx, &p, pending_prev.as_deref(), None)?;
                    }
                    return Ok(());
                }
                Some(Ok(frame)) => {
                    if let Some(p) = pending.take() {
                        pass.process(ctx, &p, pending_prev.as_deref(), Some(&frame.rgba))?;
                        pending_prev = Some(p.rgba);
                    }
                    pending = Some(frame);
                    if pass.stop {
                        return Ok(());
                    }
                }
            }
        }
    })();
    // The page's `finally`: release the temporal indexes, then store what is still owed.
    pass.compositor.dispose();
    pass.flush_temporal(ctx);
    pass.flush_metas(ctx);
    outcome?;
    if (ended_naturally || pass.missing_plan) && ctx.rendered_frames != ctx.processed {
        let (processed, rendered) = (ctx.processed, ctx.rendered_frames);
        ctx.pass_mismatch("render", processed, rendered);
    }
    let run = ctx.key("");
    ctx.tiles.flush(&mut ctx.store, &run, None)?;
    let stats = ctx.tiles.cache.stats();
    let max_tiles = ctx.tiles.cache.max_tiles();
    let budget = ctx.settings.memory_mb;
    ctx.put(
        "memory-stats",
        Obj::new()
            .with("peakResidentTiles", stats.peak_resident)
            .with("tileCacheLimit", max_tiles)
            .with("budgetMB", budget)
            .with(
                "note",
                "Codec/browser/GPU allocations are additional, not a hard process-RSS bound. The render pass also holds one extra decoded native RGBA frame: a one-frame lookahead the world-consistency mask compares against (docs/ARCHITECTURE.md §七).",
            ),
    );
    ctx.persist();
    Ok(())
}
