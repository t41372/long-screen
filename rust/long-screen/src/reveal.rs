//! Host of the reveal stage (the page's `src/pipeline/reveal.ts`): drives the engine's `RevealSession`, answering what
//! it asks for (the memory check, the observation rows, tiles), decoding the recording once per pass, and storing
//! what it hands back.

use crate::context::{t, Ctx};
use crate::engine::catalog::Param;
use crate::engine::reveal::{
    ObservedDecision, Outcome, Pass, RevealCanvas, RevealLayer, RevealSession, Step, PASSES,
};
use crate::solve::kind_str;
use crate::source::FrameSource;
use crate::value::{detail, read_rect, Js, Obj, Typed};
use std::time::Instant;

fn pass_name(pass: Pass) -> &'static str {
    match PASSES.iter().position(|p| *p == pass) {
        Some(0) => "learn",
        Some(1) => "agree",
        Some(2) => "relearn",
        _ => "write",
    }
}

fn decisions_of(row: &Obj) -> Vec<ObservedDecision> {
    row.get("decisions")
        .and_then(Js::as_arr)
        .unwrap_or(&[])
        .iter()
        .filter_map(Js::as_obj)
        .map(|d| {
            let p = d.get("placement").and_then(Js::as_obj);
            let num = |k: &str| p.map_or(f64::NAN, |p| p.num(k));
            ObservedDecision {
                canvas: d.str("canvasId").unwrap_or_default().to_string(),
                layer: p
                    .and_then(|p| p.str("layer"))
                    .unwrap_or_default()
                    .to_string(),
                x: num("x"),
                y: num("y"),
                skip: p.is_some_and(|p| p.bool("skip")),
                skipped: d.bool("skipped"),
                occlusions: p
                    .and_then(|p| p.get("occlusions"))
                    .and_then(Js::as_arr)
                    .map(|a| a.iter().filter_map(read_rect).collect())
                    .unwrap_or_default(),
            }
        })
        .collect()
}

/// Steps the session, bringing in the tiles it asks for, until `done` accepts a step.
fn until(
    ctx: &mut Ctx,
    session: &mut RevealSession,
    clock: Instant,
    done: impl Fn(&Step) -> bool,
) -> Result<(), String> {
    loop {
        let now = clock.elapsed().as_secs_f64() * 1000.0;
        let step = session
            .step(&mut ctx.tiles.cache, now)
            .map_err(|e| format!("{e:?}"))?;
        if done(&step) {
            return Ok(());
        }
        match step {
            Step::NeedTile(key) => {
                let run = ctx.key("");
                ctx.tiles.load(&mut ctx.store, &run, key)?;
            }
            other => {
                return Err(format!(
                    "CORE_BAD_ARGUMENT: reveal step {other:?} out of turn."
                ))
            }
        }
    }
}

/// One decode of the solved frames through `pass`; false when the run stopped.
fn sweep(
    ctx: &mut Ctx,
    source: &mut dyn FrameSource,
    session: &mut RevealSession,
    clock: Instant,
    pass: Pass,
    wanted: &[bool],
) -> Result<bool, String> {
    let name = pass_name(pass);
    let message = ctx.tr(&format!("progress.reveal.{name}"), &[]);
    let offset = PASSES.iter().position(|p| *p == pass).unwrap_or(0) as f64;
    let labels = ctx.atlas.as_ref().ok_or("no region atlas")?.0.clone();
    let (width, height) = (ctx.info.width, ctx.info.height);
    let started = Instant::now();
    let (mut core_ms, mut write_ms, mut wait_ms, mut upload_ms, mut converted) =
        (0.0, 0.0, 0.0, 0.0, 0u32);
    let ms = |since: Instant| since.elapsed().as_secs_f64() * 1000.0;
    {
        let mut frames = source.sparse_frames(wanted).map_err(|e| e.to_string())?;
        let mut waited = Instant::now();
        for frame in frames.by_ref() {
            let frame = frame.map_err(|e| e.to_string())?;
            wait_ms += ms(waited);
            if frame.index >= ctx.processed {
                break;
            }
            let mark = Instant::now();
            if wanted.get(frame.index as usize).copied().unwrap_or(false) {
                if frame.width != width
                    || frame.height != height
                    || frame.rgba.len() != width * height * 4
                {
                    return Err(format!(
                        "CORE_BAD_ARGUMENT: frame {}×{} does not fit a {width}×{height} reveal.",
                        frame.width, frame.height
                    ));
                }
                session
                    .frame_buffer()
                    .map_err(|e| format!("{e:?}"))?
                    .copy_from_slice(&frame.rgba);
                converted += 1;
            }
            upload_ms += ms(mark);
            let mark = Instant::now();
            session
                .push_frame(frame.index, Some(&labels))
                .map_err(|e| format!("{e:?}"))?;
            core_ms += ms(mark);
            let mark = Instant::now();
            until(ctx, session, clock, |s| matches!(s, Step::NextFrame))?;
            write_ms += ms(mark);
            let fraction = (offset + (frame.index + 1) as f64 / ctx.processed.max(1) as f64)
                / PASSES.len() as f64;
            ctx.report(frame.index + 1, frame.time, &message, Some(fraction), None);
            waited = Instant::now();
            if ctx.stop_requested {
                ctx.honour_stop();
                return Ok(false);
            }
        }
    }
    session
        .end_pass(Some(&labels))
        .map_err(|e| format!("{e:?}"))?;
    until(ctx, session, clock, |s| matches!(s, Step::PassDone(_)))?;
    ctx.timing(&format!("reveal.{name}MS"), ms(started));
    ctx.timing(&format!("reveal.{name}.coreMS"), core_ms);
    ctx.timing(&format!("reveal.{name}.writeMS"), write_ms);
    ctx.timing(&format!("reveal.{name}.waitMS"), wait_ms);
    ctx.timing(&format!("reveal.{name}.uploadMS"), upload_ms);
    ctx.timing(&format!("reveal.{name}.frames"), converted as f64);
    Ok(!ctx.stopped && !ctx.partial)
}

/// Runs the reveal stage.
pub fn reveal(ctx: &mut Ctx, source: &mut dyn FrameSource) -> Result<(), String> {
    if ctx.stopped || ctx.partial || ctx.atlas.is_none() || ctx.processed < 2 {
        return Ok(());
    }
    let canvases: Vec<RevealCanvas> = ctx
        .keys("canvas/")
        .into_iter()
        .filter_map(|k| match ctx.get(&k) {
            Some(Js::Obj(m)) if m.str("kind") == Some("moving") => Some(RevealCanvas {
                id: m.str("id").unwrap_or_default().to_string(),
                bounds: m.get("bounds").and_then(read_rect)?,
            }),
            _ => None,
        })
        .collect();
    let layers = ctx
        .regions
        .iter()
        .enumerate()
        .filter(|(_, r)| kind_str(r) == "moving")
        .map(|(i, r)| RevealLayer {
            id: r.id.clone(),
            rect: r.rect,
            code: (i + 1) as u32,
        })
        .collect();
    let mut session = RevealSession::new(
        ctx.info.width,
        ctx.info.height,
        ctx.noise,
        ctx.tiles.size,
        ctx.processed,
        layers,
        canvases,
    )
    .map_err(|e| format!("{e:?}"))?;
    let clock = Instant::now();
    let mut started: Option<Instant> = None;
    loop {
        let now = clock.elapsed().as_secs_f64() * 1000.0;
        let step = session
            .step(&mut ctx.tiles.cache, now)
            .map_err(|e| format!("{e:?}"))?;
        match step {
            Step::NeedMemory { .. } => {
                if started.is_none() {
                    started = Some(Instant::now());
                    ctx.phase = "revealing";
                }
                // Natively there is no WebAssembly memory ceiling: the stage always has room.
                session.memory(true, 0.0).map_err(|e| format!("{e:?}"))?;
            }
            Step::NeedObservations => {
                for key in ctx.keys("observation/") {
                    if let Some(Js::Obj(row)) = ctx.get(&key) {
                        session
                            .observation(row.num("frame") as u32, &decisions_of(&row))
                            .map_err(|e| format!("{e:?}"))?;
                    }
                }
            }
            Step::NeedTile(key) => {
                let run = ctx.key("");
                ctx.tiles.load(&mut ctx.store, &run, key)?;
            }
            Step::Checkpoint => ctx.checkpoint(),
            Step::Decode { pass, wanted } => {
                if !sweep(ctx, source, &mut session, clock, pass, &wanted)? {
                    return Ok(());
                }
            }
            Step::Provenance(p) => {
                let source: Vec<u8> = p.source.iter().flat_map(|v| v.to_le_bytes()).collect();
                ctx.put(
                    &format!("reveal/{}", p.canvas),
                    Obj::new()
                        .with("version", 1u32)
                        .with("gx", p.gx as f64)
                        .with("gy", p.gy as f64)
                        .with("bw", p.bw)
                        .with("bh", p.bh)
                        .with("source", Js::typed(Typed::Int32, source)),
                );
            }
            Step::Done(Outcome::Nothing) => return Ok(()),
            Step::Done(Outcome::Skipped(d)) => {
                let need = d
                    .params
                    .iter()
                    .find(|(k, _)| *k == "need")
                    .map_or(0.0, |(_, v)| *v);
                let det = d.detail.as_ref().map_or(Js::Undefined, detail);
                ctx.emit(&|l| {
                    Obj::new()
                        .with("code", d.code)
                        .with("severity", d.severity.as_str())
                        .with(
                            "message",
                            t(
                                l,
                                "diag.REVEAL_SKIPPED.message",
                                &[("need", Param::Num(need))],
                            ),
                        )
                        .with("action", t(l, "diag.REVEAL_SKIPPED.action", &[]))
                        .with("detail", det.clone())
                });
                return Ok(());
            }
            Step::Done(Outcome::Revealed(s)) => {
                let run = ctx.key("");
                ctx.tiles.flush(&mut ctx.store, &run, None)?;
                let ms = started.map_or(0.0, |s| s.elapsed().as_secs_f64() * 1000.0);
                ctx.timing("revealMS", ms);
                ctx.put(
                    "reveal-summary",
                    Obj::new()
                        .with("objects", s.objects)
                        .with("components", s.components)
                        .with("coherentBlocks", s.coherent_blocks)
                        .with("componentBlocks", s.component_blocks)
                        .with("provisionalBlocks", s.provisional_blocks)
                        .with("fallbackBlocks", s.fallback_blocks)
                        .with("seconds", ms / 1000.0),
                );
                return Ok(());
            }
            other => {
                return Err(format!(
                    "CORE_BAD_ARGUMENT: reveal step {other:?} out of turn."
                ))
            }
        }
    }
}
