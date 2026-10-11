//! The presentation stages (the page's `src/pipeline/presentation.ts`, `src/core/framing.ts` and
//! `TileStore.buildPyramid`): the framed canvas around each reconstructed canvas, and the preview pyramid. Both are
//! presentation only: a failure downgrades to a warning and never changes the run's status.

use crate::context::{error_text, t, Ctx};
use crate::engine::framing::{
    intersect, FramingSession, Outcome, Reference, SaveTile, SourceCanvas, Step as FramingStep,
    DEFAULT_MAX_TILES,
};
use crate::engine::pyramid::{PyramidSession, Step as PyramidStep};
use crate::engine::tiles::TileKey;
use crate::solve::{kind_str, shape};
use crate::tiles::{decode_png, encode_png};
use crate::value::{read_rect, rect, Js, Obj};
use std::time::Instant;

fn canvas_rows(ctx: &Ctx) -> Vec<(String, Obj)> {
    ctx.keys("canvas/")
        .into_iter()
        .filter_map(|k| match ctx.get(&k) {
            Some(Js::Obj(o)) => Some((k, o)),
            _ => None,
        })
        .collect()
}

/// Builds one framed canvas; `Ok(Some(tile count))` when one was stored.
fn build_framed(ctx: &mut Ctx, source: &Obj, started: Instant) -> Result<Option<f64>, String> {
    let id = source.str("id").unwrap_or_default().to_string();
    let layer = source.str("layer").unwrap_or_default();
    let region = ctx.regions.iter().find(|r| r.id == layer).ok_or_else(|| {
        "TypeError: Cannot read properties of undefined (reading 'crop')".to_string()
    })?;
    let pane = region
        .crop
        .map_or(region.rect, |crop| intersect(region.rect, crop));
    let ignore = ctx
        .regions
        .iter()
        .filter(|r| kind_str(r) == "ignore")
        .map(shape)
        .collect();
    let bounds = source
        .get("bounds")
        .and_then(read_rect)
        .ok_or("canvas without bounds")?;
    let tile_count = source.num("tileCount");
    let mut session = FramingSession::new(
        SourceCanvas {
            id: id.clone(),
            bounds,
            tile_count: if tile_count > 0.0 {
                tile_count as u64
            } else {
                0
            },
            attached: source
                .get("attachedTo")
                .is_some_and(|a| !matches!(a, Js::Undefined | Js::Null)),
        },
        pane,
        ignore,
        ctx.tiles.size,
        DEFAULT_MAX_TILES,
    );
    let run = ctx.key("");
    loop {
        let now = started.elapsed().as_secs_f64() * 1000.0;
        let step = session
            .step(&mut ctx.tiles.cache, now)
            .map_err(|e| format!("{e:?}"))?;
        match step {
            FramingStep::NeedReference => {
                let reference = match ctx.get("frame-reference") {
                    Some(Js::Obj(r)) => {
                        let image = r
                            .get("image")
                            .and_then(Js::bytes)
                            .ok_or("reference without an image")?;
                        let (w, h, rgba) = decode_png(image)?;
                        Some(Reference {
                            frame: r.num("frame") as u32,
                            width: w as usize,
                            height: h as usize,
                            rgba,
                        })
                    }
                    _ => None,
                };
                session.reference(reference).map_err(|e| format!("{e:?}"))?;
            }
            FramingStep::NeedIndex => {
                for k in ctx.keys(&format!("tile-index/{id}/0/")) {
                    if let Some(Js::Obj(row)) = ctx.get(&k) {
                        session
                            .index(
                                row.num("x") as i32,
                                row.num("y") as i32,
                                row.num("observed") as u64,
                            )
                            .map_err(|e| format!("{e:?}"))?;
                    }
                }
            }
            FramingStep::Next => ctx.checkpoint(),
            FramingStep::NeedTile(key) => {
                ctx.tiles.load(&mut ctx.store, &run, key)?;
            }
            FramingStep::Save(SaveTile::Resident(tile)) => {
                ctx.tiles.save_resident(&mut ctx.store, &run, tile)?;
            }
            FramingStep::Save(SaveTile::Detached(tile)) => {
                ctx.tiles.save(&mut ctx.store, &run, &tile)?;
            }
            FramingStep::Done(Outcome::Unframed) => return Ok(None),
            FramingStep::Done(Outcome::Skipped(d)) => {
                let max = d
                    .params
                    .iter()
                    .find(|(k, _)| *k == "maxTiles")
                    .map_or(0.0, |(_, v)| *v);
                let message = format!(
                    "Framed canvas exceeded the {} tile limit; skipped before allocating output tiles.",
                    crate::engine::catalog::js_number(max)
                );
                ctx.emit(&|l| {
                    Obj::new()
                        .with("code", "PRESENTATION_TOO_SPARSE")
                        .with("severity", "warning")
                        .with("message", message.as_str())
                        .with("action", t(l, "diag.PRESENTATION_TOO_SPARSE.action", &[]))
                });
                return Ok(None);
            }
            FramingStep::Done(Outcome::Framed(framed)) => {
                let mut meta = source.clone();
                let name = format!("{} · 保留外框", source.str("name").unwrap_or_default());
                meta.set("id", framed.id.as_str());
                meta.set("name", name);
                meta.set("kind", "presentation");
                meta.set(
                    "bounds",
                    Obj::new()
                        .with("x", 0u32)
                        .with("y", 0u32)
                        .with("width", framed.width)
                        .with("height", framed.height),
                );
                meta.set("tileCount", framed.tile_count);
                meta.set("maxLevel", 0u32);
                meta.set("observedPixels", framed.observed_pixels);
                meta.set("provisionalPixels", framed.provisional_pixels);
                meta.set(
                    "uncertainPixels",
                    source
                        .get("uncertainPixels")
                        .cloned()
                        .unwrap_or(Js::Undefined),
                );
                meta.set(
                    "conflictPixels",
                    source
                        .get("conflictPixels")
                        .cloned()
                        .unwrap_or(Js::Undefined),
                );
                meta.set(
                    "presentation",
                    Obj::new()
                        .with("sourceCanvas", id.as_str())
                        .with("sourceRegion", rect(framed.source_region))
                        .with("referenceFrame", framed.reference_frame)
                        .with("offset", Obj::new().with("x", framed.offset_x).with("y", framed.offset_y))
                        .with(
                            "extension",
                            "Native-scale reference chrome shown once; flat background-only extensions are presentation, NOT observed world content. Other panes in the frame are reference snapshots, NOT merged trajectories. Coverage bits mark copied evidence; opaque extension pixels are deliberately not covered.",
                        ),
                );
                ctx.put(&format!("canvas/{}", framed.id), meta);
                return Ok(Some(framed.tile_count as f64));
            }
        }
    }
}

/// The framing stage.
pub fn framing(ctx: &mut Ctx) {
    if !ctx.settings.framing_context() || ctx.stopped {
        return;
    }
    let started = Instant::now();
    let result = (|| -> Result<(), String> {
        ctx.phase = "framing";
        let originals: Vec<Obj> = canvas_rows(ctx)
            .into_iter()
            .map(|(_, o)| o)
            .filter(|o| {
                o.str("kind") == Some("moving")
                    && o.num("tileCount") > 0.0
                    && o.get("attachedTo")
                        .is_none_or(|a| matches!(a, Js::Undefined | Js::Null))
            })
            .collect();
        let message = ctx.tr("progress.framingStart", &[]);
        let rendered = ctx.rendered_frames;
        ctx.event("framing", 0.0, rendered, 0.0, message);
        for meta in &originals {
            if let Some(tiles) = build_framed(ctx, meta, started)? {
                ctx.canvas_count += 1;
                ctx.tile_total += tiles;
            }
            if ctx.stop_requested {
                ctx.stopped = true;
                break;
            }
        }
        if !originals.is_empty() {
            ctx.emit(&|l| {
                Obj::new()
                    .with("code", "PRESENTATION_FRAME")
                    .with("severity", "info")
                    .with("message", t(l, "diag.PRESENTATION_FRAME.message", &[]))
            });
        }
        Ok(())
    })();
    if let Err(e) = result {
        let message = error_text(&e);
        ctx.emit(&|l| {
            Obj::new()
                .with("code", "PRESENTATION_STAGE_FAILED")
                .with("severity", "warning")
                .with("message", message.as_str())
                .with("action", t(l, "diag.PRESENTATION_STAGE_FAILED.action", &[]))
        });
    }
}

fn build_pyramid(ctx: &mut Ctx, key: &str, mut meta: Obj, built: u32) -> Result<(), String> {
    let run = ctx.key("");
    ctx.tiles.clear(&mut ctx.store, &run)?;
    let id = meta.str("id").unwrap_or_default().to_string();
    let size = ctx.tiles.size;
    let bounds = meta
        .get("bounds")
        .and_then(read_rect)
        .ok_or("canvas without bounds")?;
    let mut session = PyramidSession::new(&id, bounds.width, bounds.height, size)
        .map_err(|e| format!("{e:?}"))?;
    loop {
        match session.step() {
            PyramidStep::Done => return Ok(()),
            PyramidStep::NeedIndex { level } => {
                for k in ctx.keys(&format!("tile-index/{id}/{}/", level - 1)) {
                    if let Some(Js::Obj(row)) = ctx.get(&k) {
                        session
                            .queue(row.num("x") as i32, row.num("y") as i32)
                            .map_err(|e| format!("{e:?}"))?;
                    }
                }
            }
            PyramidStep::NeedChildren { children, .. } => {
                let mut provided: [Option<Vec<u8>>; 4] = [None, None, None, None];
                for (slot, c) in provided.iter_mut().zip(children.iter()) {
                    if let Some(Js::Obj(row)) = ctx.get(&format!("tile/{}", c.path())) {
                        let blob = row
                            .get("blob")
                            .and_then(Js::bytes)
                            .ok_or("tile without pixels")?;
                        let (w, h, rgba) = decode_png(blob)?;
                        if w as usize != size || h as usize != size {
                            return Err(format!("Stored tile is {w}×{h}; expected {size}×{size}."));
                        }
                        *slot = Some(rgba);
                    }
                }
                session.provide(provided).map_err(|e| format!("{e:?}"))?;
            }
            PyramidStep::Parent {
                level,
                x,
                y,
                pixels,
            } => {
                if let Some(pixels) = pixels {
                    let blob = encode_png(&pixels, size as u32, size as u32)?;
                    let path = TileKey::new(&id, level, x, y).path();
                    ctx.put(
                        &format!("tile/{path}"),
                        Obj::new()
                            .with("blob", Js::png(blob))
                            .with("x", x)
                            .with("y", y)
                            .with("level", level)
                            .with("owner", Js::u32s(&[]))
                            .with("score", Js::f32s(&[])),
                    );
                    ctx.put(
                        &format!("tile-index/{path}"),
                        Obj::new()
                            .with("canvasId", id.as_str())
                            .with("level", level)
                            .with("x", x)
                            .with("y", y)
                            .with("observed", 0u32),
                    );
                }
                ctx.checkpoint();
                let message = ctx.tr("progress.pyramidBuild", &[]);
                let (rendered, count) = (ctx.rendered_frames, ctx.canvas_count);
                ctx.report(
                    rendered,
                    meta.num("lastTime"),
                    &message,
                    Some(built as f64 / count.max(1) as f64),
                    Some(&id),
                );
            }
            PyramidStep::LevelDone { level } => {
                meta.set("maxLevel", level);
                ctx.put(key, meta.clone());
            }
        }
    }
}

/// The pyramid stage.
pub fn pyramid(ctx: &mut Ctx) {
    if ctx.stopped {
        return;
    }
    let result = (|| -> Result<(), String> {
        let mut built = 0;
        for key in ctx.keys("canvas/") {
            let Some(Js::Obj(meta)) = ctx.get(&key) else {
                continue;
            };
            if meta.num("tileCount") > 0.0 {
                build_pyramid(ctx, &key, meta, built)?;
            }
            built += 1;
            if ctx.stop_requested {
                ctx.stopped = true;
                break;
            }
        }
        Ok(())
    })();
    if let Err(e) = result {
        let message = error_text(&e);
        ctx.emit(&|l| {
            Obj::new()
                .with("code", "PYRAMID_FAILED")
                .with("severity", "warning")
                .with("message", message.as_str())
                .with("action", t(l, "diag.PYRAMID_FAILED.action", &[]))
        });
    }
}
