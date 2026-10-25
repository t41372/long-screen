//! Host of the scan pass (the page's `src/pipeline/scan.ts`): the decode loop around the engine's `ScanSession`,
//! the `scan/` rows, the first frame's facts, the region rows and the diagnostics' text.

use crate::context::{error_text, pad, t, Ctx};
use crate::engine::catalog::{Locale, Param};
use crate::engine::diagnostic::Diagnostic as EngineDiagnostic;
use crate::engine::scan::{CompactFeatures, FieldLayout, FrameMeta, ScanRecord, ScanSession};
use crate::kernels::motion::MotionField;
use crate::kernels::regions::{Kind, RegionOut};
use crate::source::FrameSource;
use crate::tiles::encode_png;
use crate::value::{rect, Js, Obj};
use std::collections::HashMap;

/// The scan rows solve reads back natively (features are scratch the page deletes after solve; they never reach
/// the store here).
pub type Features = HashMap<u32, CompactFeatures>;

/// Diagnostics whose catalogue entry has an `action` the pass has always attached.
const WITH_ACTION: [&str; 2] = ["LOW_TEXTURE_UNOBSERVABLE", "AUTOMATIC_LAYER_MASK"];

fn params(d: &EngineDiagnostic) -> Vec<(&str, Param<'static>)> {
    d.params.iter().map(|(k, v)| (*k, Param::Num(*v))).collect()
}

/// One of the scan session's diagnostics as the journal row the page writes (`hostDiagnostic`).
pub fn host_diagnostic(d: &EngineDiagnostic, l: Locale) -> Obj {
    let mut row = Obj::new()
        .with("code", d.code)
        .with("severity", d.severity.as_str());
    if let Some(time) = d.time {
        row.set("time", time);
    }
    if let Some(frame) = d.frame {
        row.set("frame", frame);
    }
    row.set(
        "message",
        t(l, &format!("diag.{}.message", d.code), &params(d)),
    );
    if WITH_ACTION.contains(&d.code) {
        row.set("action", t(l, &format!("diag.{}.action", d.code), &[]));
    }
    if d.code == "UNRESOLVED_MOTION" {
        row.set("confidence", 0u32);
    }
    row
}

/// A motion field in the key order of the branch that laid it out (`readField`).
pub fn field_js(f: &MotionField, layout: FieldLayout) -> Js {
    let motions = Js::Arr(
        f.motions
            .iter()
            .map(|m| {
                Js::Obj(
                    Obj::new()
                        .with("x", m.x)
                        .with("y", m.y)
                        .with("support", m.support)
                        .with("unique", m.unique)
                        .with("confidence", m.confidence)
                        .with("error", m.error)
                        .with("ambiguous", m.ambiguous),
                )
            })
            .collect(),
    );
    let labels = Js::u8s(f.labels.clone());
    let confidence = Js::u8s(f.confidence.clone());
    let dynamic = Js::u8s(f.dynamic.clone());
    let o = match layout {
        FieldLayout::Initial => Obj::new()
            .with("motions", motions)
            .with("labels", labels)
            .with("confidence", confidence)
            .with("dynamic", dynamic)
            .with("cols", f.cols)
            .with("rows", f.rows)
            .with("cell", f.cell)
            .with("difference", f.difference)
            .with("featureCount", f.feature_count)
            .with("unknown", f.unknown)
            .with("zoom", f.zoom),
        FieldLayout::Estimated => Obj::new()
            .with("cols", f.cols)
            .with("rows", f.rows)
            .with("cell", f.cell)
            .with("motions", motions)
            .with("difference", f.difference)
            .with("featureCount", f.feature_count)
            .with("unknown", f.unknown)
            .with("zoom", f.zoom)
            .with("labels", labels)
            .with("confidence", confidence)
            .with("dynamic", dynamic),
    };
    Js::Obj(o)
}

fn record_js(r: &ScanRecord) -> Js {
    Js::Obj(
        Obj::new()
            .with("index", r.index)
            .with("time", r.time)
            .with("duration", r.duration)
            .with("field", field_js(&r.field, r.layout))
            .with("duplicate", r.duplicate),
    )
}

/// A finished region as the `regions` row holds it (`readRegions` in src/core/wasm/regions.ts), with or without its
/// mask. Automatic layouts only: a hand-placed one keeps the settings' own objects, which a native run has none of.
pub fn region_js(r: &RegionOut, mask: bool) -> Js {
    let id_index: u32 =
        r.id.strip_prefix("layer-")
            .and_then(|n| n.parse().ok())
            .unwrap_or(0);
    let mask_js = || {
        Js::u8s(
            r.mask
                .clone()
                .unwrap_or_else(|| vec![0; r.mask_width * r.mask_height]),
        )
    };
    let mut o = Obj::new().with("id", format!("layer-{id_index}"));
    let has_cells = r.cells.is_some();
    let cells = r.cells.clone().unwrap_or_default();
    if !has_cells {
        o.set("name", "固定分隔界面");
        o.set("kind", "fixed");
        o.set("rect", rect(r.rect));
        if mask {
            o.set("mask", mask_js());
        }
        o.set("maskWidth", r.mask_width);
        o.set("maskHeight", r.mask_height);
        o.set("factor", r.factor);
    } else if cells.is_empty() {
        o.set("name", "固定界面");
        o.set("kind", "fixed");
        o.set("rect", rect(r.rect));
        if mask {
            o.set("mask", mask_js());
        }
        o.set("maskWidth", r.mask_width);
        o.set("maskHeight", r.mask_height);
        o.set("cells", Js::Arr(Vec::new()));
        o.set("factor", r.factor);
    } else {
        let fixed = r.kind == Kind::Fixed;
        o.set(
            "name",
            if fixed {
                "固定界面".to_string()
            } else {
                format!("内容画布 {}", id_index + 1)
            },
        );
        o.set("kind", if fixed { "fixed" } else { "moving" });
        o.set(
            "cells",
            Js::Arr(cells.iter().map(|&c| Js::Num(c as u32 as f64)).collect()),
        );
        o.set("rect", rect(r.rect));
        if mask {
            o.set("mask", mask_js());
        }
        o.set("maskWidth", r.mask_width);
        o.set("maskHeight", r.mask_height);
        o.set("factor", r.factor);
    }
    if let Some(side) = r.band_side.filter(|s| *s > 0) {
        o.set("bandSide", side as u32);
    }
    o.set("crop", rect(r.crop.unwrap_or(r.rect)));
    o.set("solid", r.solid);
    if !r.epochs.is_empty() {
        let epochs = r.epochs.iter().map(|e| {
            Js::Obj(Obj::new().with("from", e.from).with(
                "exclusions",
                Js::Arr(e.exclusions.iter().map(|x| rect(*x)).collect()),
            ))
        });
        o.set("epochs", Js::Arr(epochs.collect()));
    }
    if !r.sticky.is_empty() {
        o.set(
            "sticky",
            Js::Arr(r.sticky.iter().map(|&s| rect(s)).collect()),
        );
    }
    Js::Obj(o)
}

/// What the page knows only once a frame was analysed: the compute backend, and the frame-reference image.
fn first_frame_facts(ctx: &mut Ctx, index: u32, rgba: &[u8]) {
    let threads = ctx.threads;
    ctx.emit(&|l| {
        Obj::new()
            .with("code", "COMPUTE_BACKEND")
            .with("severity", "info")
            .with(
                "message",
                t(
                    l,
                    "diag.COMPUTE_BACKEND.message",
                    &[
                        ("backend", Param::Str("CPU")),
                        ("reason", Param::Str("native")),
                        ("variant", Param::Str("native")),
                        ("threads", Param::Int(threads as i64)),
                        ("coreReason", Param::Str("rayon")),
                    ],
                ),
            )
            .with(
                "detail",
                Obj::new().with("backend", "cpu").with(
                    "core",
                    Obj::new()
                        .with("variant", "native")
                        .with("threads", threads),
                ),
            )
    });
    if ctx.settings.framing_context() {
        match encode_png(rgba, ctx.info.width as u32, ctx.info.height as u32) {
            Ok(png) => ctx.put(
                "frame-reference",
                Obj::new().with("frame", index).with("image", Js::png(png)),
            ),
            Err(e) => {
                let message = error_text(&e);
                ctx.emit(&|l| {
                    Obj::new()
                        .with("code", "PRESENTATION_REFERENCE_FAILED")
                        .with("severity", "warning")
                        .with("message", message.as_str())
                        .with(
                            "action",
                            t(l, "diag.PRESENTATION_REFERENCE_FAILED.action", &[]),
                        )
                });
            }
        }
    }
}

/// Runs the scan pass; returns the features solve reads back. Errors only when no frame could be analysed.
pub fn scan(ctx: &mut Ctx, source: &mut dyn FrameSource) -> Result<Features, String> {
    ctx.phase = "scanning";
    let mut features = Features::new();
    let (width, height) = (ctx.info.width, ctx.info.height);
    let mut session: Option<ScanSession> = None;
    let mut ended_naturally = false;
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
                    drop(frames);
                    if ctx.frames == 0 {
                        return Err(e.to_string());
                    }
                    ctx.partial = true;
                    let frames_done = ctx.frames;
                    ctx.prefix_only("DECODE_PREFIX_ONLY", "scan", frames_done, &e.to_string());
                    return finish(ctx, session, features, false);
                }
                Some(Ok(f)) => f,
            };
            let index = frame.index;
            if index == 0 {
                session = Some(ScanSession::new(width, height, ctx.factor));
            }
            if frame.width != width || frame.height != height {
                let message = format!(
                    "FRAME_GEOMETRY_CHANGED: observation is {}×{}; the run is {width}×{height}.",
                    frame.width, frame.height
                );
                drop(frames);
                if ctx.frames == 0 {
                    return Err(message);
                }
                ctx.partial = true;
                let done = ctx.frames;
                ctx.prefix_only("DECODE_PREFIX_ONLY", "scan", done, &message);
                return finish(ctx, session, features, false);
            }
            let Some(s) = session.as_mut() else {
                return Err("CORE_BAD_ARGUMENT: the first frame is not frame 0.".into());
            };
            s.frame_buffer().copy_from_slice(&frame.rgba);
            let step = match s.push(
                FrameMeta {
                    index,
                    time: frame.time,
                    duration: frame.duration,
                },
                None,
            ) {
                Ok(step) => step,
                Err(e) => {
                    drop(frames);
                    if ctx.frames == 0 {
                        return Err(e.to_string());
                    }
                    ctx.partial = true;
                    let done = ctx.frames;
                    ctx.prefix_only("ANALYSIS_PREFIX_ONLY", "scan", done, &e.to_string());
                    return finish(ctx, session, features, false);
                }
            };
            if step.record.duplicate {
                ctx.duplicates += 1;
            }
            if step.first {
                first_frame_facts(ctx, index, &frame.rgba);
            }
            ctx.put(&format!("scan/{}", pad(index)), record_js(&step.record));
            if let Some(f) = step.features {
                features.insert(index, f);
            }
            ctx.frames = index + 1;
            for d in &step.diagnostics {
                ctx.emit(&|l| host_diagnostic(d, l));
            }
            let message = ctx.tr("progress.scanFrame", &[]);
            ctx.report(index + 1, frame.time, &message, None, None);
            if ctx.stop_requested {
                ctx.honour_stop();
                break;
            }
        }
    }
    finish(ctx, session, features, ended_naturally)
}

/// The frame-count check, the source's notices, and the regions.
fn finish(
    ctx: &mut Ctx,
    session: Option<ScanSession>,
    features: Features,
    ended_naturally: bool,
) -> Result<Features, String> {
    if ended_naturally {
        if let Some(count) = ctx.info.frame_count {
            let preroll = ctx
                .info
                .notices
                .iter()
                .find(|n| n.code == "NEGATIVE_TIMESTAMP_SKIPPED")
                .map_or(0, |n| n.count);
            let frames = ctx.frames;
            ctx.pass_mismatch("scan", count.saturating_sub(preroll) as u32, frames);
        }
    }
    for notice in ctx.info.notices.clone() {
        ctx.emit(&|_| {
            Obj::new()
                .with("code", notice.code.as_str())
                .with("severity", "warning")
                .with("message", notice.message.as_str())
                .with("count", notice.count)
                .with("detail", Obj::new().with("count", notice.count))
        });
    }
    // Region finalisation: a run that analysed no frame still reports the layout diagnostics.
    let (width, height) = (ctx.info.width, ctx.info.height);
    let session = session.unwrap_or_else(|| ScanSession::new(width, height, ctx.factor));
    let done = session.finish(&[]);
    drop(session);
    let atlas = crate::engine::layers::label_atlas_epochs(&done.regions, width, height)
        .ok_or("Too many regions for the pixel atlas.")?;
    ctx.atlas = Some(atlas);
    ctx.project_regions = Js::Arr(done.regions.iter().map(|r| region_js(r, false)).collect());
    let rows = Js::Arr(done.regions.iter().map(|r| region_js(r, true)).collect());
    ctx.put("regions", rows);
    ctx.regions = done.regions;
    for d in &done.diagnostics {
        ctx.emit(&|l| host_diagnostic(d, l));
    }
    ctx.persist();
    Ok(features)
}
