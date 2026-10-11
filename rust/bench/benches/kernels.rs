//! Core kernels on the public test recordings, one benchmark per kernel and case (see cases.json).
//!
//! Every case is prepared once, outside the measurements: its three fixture frames are converted to RGBA and analysis
//! gray, and the scan pass's features, matches and motion field between the first two frames are computed the way
//! src/pipeline/scan.ts asks the core for them. Each benchmark then times one kernel call on those
//! inputs, at the analysis size the app uses by default (`analysisSize` 640).
//!
//! These are native builds of the core: they run its scalar code, not the WebAssembly SIMD128 paths, and say
//! nothing about decoding, GPU conversion or storage in a browser (scripts/benchmark-pipeline.ts covers those).
//!
//! `benches/pipeline.rs` runs the whole native pipeline over a longer window of two of the cases.

use long_screen::kernels::compositor::{composite_tile, Observation, TileBuffers, QUALITY_BLOCK};
use long_screen::kernels::consistency::{consistency_mask, MaskInput, Neighbour};
use long_screen::kernels::features::{extract_features, match_features, Feature};
use long_screen::kernels::geometry::Rect;
use long_screen::kernels::layers::{informative, Field, FieldMotion, Learner};
use long_screen::kernels::motion::{
    estimate_motion, refine_native, Gray, MatchPoints, MotionField, Point,
};
use long_screen::kernels::pyramid::assemble_parent;
use long_screen::kernels::raster::{downscale_gray, downscaled_size, grayscale};
use long_screen::kernels::region::Region;
use long_screen::kernels::voting::Ring;
use long_screen::kernels::yuv::{self, Format, Plane, Signal};
use long_screen_bench::{load_fixture, manifest};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// The app's default `analysisSize`, and the feature cap scan.ts passes to `extractFeatures`.
const ANALYSIS_SIZE: usize = 640;
const MAX_FEATURES: usize = 480;
/// The tile size the store and viewer use.
const TILE: usize = 512;
/// `DECODED_VIDEO_NOISE` in src/media/source.ts.
const NOISE: f64 = 10.0;

fn main() {
    // The pipeline benchmark's native driver turns on the core's rayon pool for this crate's whole build; one thread
    // keeps every kernel on the single-threaded path these benchmarks have always measured.
    std::env::set_var("RAYON_NUM_THREADS", "1");
    divan::main();
}

struct Prepared {
    width: usize,
    height: usize,
    signal: u32,
    planes: Vec<Plane>,
    yuv: Vec<Vec<u8>>,
    rgba: Vec<Vec<u8>>,
    factor: usize,
    aw: usize,
    ah: usize,
    gray: Vec<Vec<u8>>,
    features: Vec<Vec<Feature>>,
    matches: Vec<MatchPoints>,
    /// The dominant analysis motion between frames 0 and 1, in native pixels.
    guess: Point,
}

impl Prepared {
    fn new(id: &str) -> Prepared {
        let m = manifest();
        let case = m.cases.iter().find(|c| c.id == id).expect("case id");
        let fixture = load_fixture(&m, case);
        let (width, height) = (case.width, case.height);
        let (cw, ch) = (width.div_ceil(2), height.div_ceil(2));
        let planes = vec![
            Plane {
                offset: 0,
                stride: width,
            },
            Plane {
                offset: width * height,
                stride: cw,
            },
            Plane {
                offset: width * height + cw * ch,
                stride: cw,
            },
        ];
        let signal = case.signal_code();
        let rgba: Vec<Vec<u8>> = fixture
            .frames
            .iter()
            .map(|f| {
                let mut out = vec![0u8; width * height * 4];
                convert(f, &planes, width, height, signal, &mut out);
                out
            })
            .collect();
        let factor = width.max(height).div_ceil(ANALYSIS_SIZE).max(1);
        let (aw, ah) = downscaled_size(width, height, factor);
        let gray: Vec<Vec<u8>> = rgba
            .iter()
            .map(|f| {
                let mut out = vec![0u8; aw * ah];
                downscale_gray(f, width, height, factor, &mut out);
                out
            })
            .collect();
        let features: Vec<Vec<Feature>> = gray
            .iter()
            .map(|g| extract_features(g, aw, ah, MAX_FEATURES, None))
            .collect();
        let matches = points(&features[0], &features[1]);
        let field = estimate_motion(
            Gray {
                width: aw,
                height: ah,
                data: &gray[0],
            },
            Gray {
                width: aw,
                height: ah,
                data: &gray[1],
            },
            &matches,
            features[1].len() as u32,
        );
        let dominant = field.motions.first();
        let guess = Point {
            x: dominant.map_or(0.0, |d| d.x * factor as f64),
            y: dominant.map_or(0.0, |d| d.y * factor as f64),
        };
        Prepared {
            width,
            height,
            signal,
            planes,
            yuv: fixture.frames,
            rgba,
            factor,
            aw,
            ah,
            gray,
            features,
            matches,
            guess,
        }
    }

    fn gray(&self, i: usize) -> Gray<'_> {
        Gray {
            width: self.aw,
            height: self.ah,
            data: &self.gray[i],
        }
    }

    fn frame_rect(&self) -> Rect {
        Rect {
            x: 0.0,
            y: 0.0,
            width: self.width as f64,
            height: self.height as f64,
        }
    }

    /// A `TILE`² crop of frame 1 at tile (tx, ty), zero beyond the frame.
    fn tile_crop(&self, tx: usize, ty: usize) -> Vec<u8> {
        let mut out = vec![0u8; TILE * TILE * 4];
        for r in 0..TILE {
            let (y, x0) = (ty * TILE + r, tx * TILE);
            if y >= self.height || x0 >= self.width {
                continue;
            }
            let n = TILE.min(self.width - x0) * 4;
            let src = (y * self.width + x0) * 4;
            out[r * TILE * 4..r * TILE * 4 + n].copy_from_slice(&self.rgba[1][src..src + n]);
        }
        out
    }
}

fn convert(src: &[u8], planes: &[Plane], w: usize, h: usize, signal: u32, out: &mut [u8]) -> usize {
    let signal = Signal::from_code(signal).expect("signal code");
    yuv::convert(src, Format::I420, planes, w, h, signal, out)
}

/// Matches of `current` against `previous` as point pairs, as src/core/wasm/motion.ts writes them.
fn points(previous: &[Feature], current: &[Feature]) -> Vec<MatchPoints> {
    match_features(previous, current, true)
        .iter()
        .map(|m| {
            let (a, b) = (&previous[m.a as usize], &current[m.b as usize]);
            MatchPoints {
                ax: a.x as f64,
                ay: a.y as f64,
                bx: b.x as f64,
                by: b.y as f64,
                unique: m.unique,
            }
        })
        .collect()
}

/// Each case's prepared inputs, built on first use and kept for the whole run (benchmarks iterate over cases once
/// per kernel, so rebuilding would redo the conversions eight times).
fn prepared(id: &str) -> &'static Prepared {
    static CACHE: OnceLock<Mutex<HashMap<String, &'static Prepared>>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(Default::default).lock().unwrap();
    cache
        .entry(id.to_string())
        .or_insert_with(|| Box::leak(Box::new(Prepared::new(id))))
}

fn cases() -> Vec<&'static str> {
    manifest()
        .cases
        .into_iter()
        .map(|c| &*Box::leak(c.id.into_boxed_str()))
        .collect()
}

#[divan::bench(args = cases())]
fn yuv_to_rgba(bencher: divan::Bencher, case: &str) {
    let p = prepared(case);
    bencher
        .with_inputs(|| vec![0u8; p.width * p.height * 4])
        .bench_local_refs(|out| convert(&p.yuv[1], &p.planes, p.width, p.height, p.signal, out));
}

#[divan::bench(args = cases())]
fn native_luma(bencher: divan::Bencher, case: &str) {
    let p = prepared(case);
    bencher
        .with_inputs(|| vec![0u8; p.width * p.height])
        .bench_local_refs(|out| grayscale(&p.rgba[1], out));
}

#[divan::bench(args = cases())]
fn analysis_gray(bencher: divan::Bencher, case: &str) {
    let p = prepared(case);
    bencher
        .with_inputs(|| vec![0u8; p.aw * p.ah])
        .bench_local_refs(|out| downscale_gray(&p.rgba[1], p.width, p.height, p.factor, out));
}

#[divan::bench(args = cases())]
fn features_extract(bencher: divan::Bencher, case: &str) {
    let p = prepared(case);
    bencher.bench_local(|| extract_features(&p.gray[1], p.aw, p.ah, MAX_FEATURES, None));
}

#[divan::bench(args = cases())]
fn features_match(bencher: divan::Bencher, case: &str) {
    let p = prepared(case);
    bencher.bench_local(|| match_features(&p.features[0], &p.features[1], true));
}

#[divan::bench(args = cases())]
fn motion_estimate(bencher: divan::Bencher, case: &str) {
    let p = prepared(case);
    bencher.bench_local(|| {
        estimate_motion(p.gray(0), p.gray(1), &p.matches, p.features[1].len() as u32)
    });
}

#[divan::bench(args = cases())]
fn motion_refine_native(bencher: divan::Bencher, case: &str) {
    let p = prepared(case);
    let radius = 3.max(p.factor.div_ceil(2) as i32 + 1);
    bencher.bench_local(|| {
        refine_native(
            &p.rgba[0],
            &p.rgba[1],
            p.width,
            p.height,
            p.guess,
            p.frame_rect(),
            None,
            radius,
        )
    });
}

/// The first frame pair of the window whose motion field `Learner::add` accepts (a pair that barely moves is not
/// informative and adds nothing), with that field.
fn informative_pair(p: &Prepared) -> Option<(usize, usize, MotionField)> {
    [(0, 1), (1, 2), (0, 2)].into_iter().find_map(|(a, b)| {
        let field = estimate_motion(
            p.gray(a),
            p.gray(b),
            &points(&p.features[a], &p.features[b]),
            p.features[b].len() as u32,
        );
        informative(&layer_field(&field, &field_motions(&field))).then_some((a, b, field))
    })
}

fn field_motions(field: &MotionField) -> Vec<FieldMotion> {
    field
        .motions
        .iter()
        .map(|m| FieldMotion {
            x: m.x,
            y: m.y,
            support: m.support,
            confidence: m.confidence,
        })
        .collect()
}

fn layer_field<'a>(field: &'a MotionField, motions: &'a [FieldMotion]) -> Field<'a> {
    Field {
        motions,
        labels: &field.labels,
        confidence: &field.confidence,
        dynamic: &field.dynamic,
        cols: field.cols,
        rows: field.rows,
        difference: field.difference,
        unknown: field.unknown,
    }
}

#[divan::bench(args = cases())]
fn layers_learn(bencher: divan::Bencher, case: &str) {
    let p = prepared(case);
    let Some((a, b, field)) = informative_pair(p) else {
        panic!(
            "{case}: no informative frame pair in the window; pick another window in cases.json"
        );
    };
    let motions = field_motions(&field);
    let field = layer_field(&field, &motions);
    bencher
        .with_inputs(|| Learner::new(p.aw, p.ah))
        .bench_local_refs(|learner| {
            learner.add(
                &field,
                &p.gray[a],
                &p.gray[b],
                Some((&p.rgba[a], &p.rgba[b], p.width, p.height)),
            )
        });
}

#[divan::bench(args = cases())]
fn consistency(bencher: divan::Bencher, case: &str) {
    let p = prepared(case);
    let labels = vec![1u8; p.width * p.height];
    let neighbour = |i: usize, sign: f64| Neighbour {
        rgba: &p.rgba[i],
        pose_x: sign * p.guess.x,
        pose_y: sign * p.guess.y,
        occlusions: &[],
        vote: None,
    };
    bencher
        .with_inputs(|| vec![0u8; p.width * p.height])
        .bench_local_refs(|out| {
            let input = MaskInput {
                rgba: &p.rgba[1],
                labels: &labels,
                width: p.width,
                height: p.height,
                region: p.frame_rect(),
                code: 1,
                pose_x: 0.0,
                pose_y: 0.0,
                prev: Some(neighbour(0, -1.0)),
                next: Some(neighbour(2, 1.0)),
                vote: None,
                factor: p.factor as i32,
                noise: NOISE,
            };
            consistency_mask(&input, out)
        });
}

#[divan::bench(args = cases())]
fn voting_observe(bencher: divan::Bencher, case: &str) {
    let p = prepared(case);
    let region = Region {
        rect: p.frame_rect(),
        exclusions: vec![],
        crop: None,
        solid: true,
        mask: None,
    };
    let mut ring = Ring::new(
        p.factor as i32,
        NOISE,
        p.width,
        p.height,
        p.aw,
        p.ah,
        24 << 20,
        vec![region],
    );
    // Six partners past `dmin`, as scripts/benchmark-kernels.ts seeds them, so every observation compares in full.
    for i in 0..6u32 {
        ring.observe(0, 0, 0.0, 100.0 * (i + 1) as f64, &p.gray[i as usize % 3]);
        ring.push_frame(i);
    }
    let mut index = 100u32;
    bencher.bench_local(|| {
        ring.observe(
            0,
            0,
            0.0,
            700.0 + (index % 3) as f64,
            &p.gray[index as usize % 3],
        );
        index += 1;
        ring.push_frame(index)
    });
}

/// One tile's buffers, as src/storage/tiles.ts allocates them.
struct Tile {
    pixels: Vec<u8>,
    coverage: Vec<u8>,
    provisional: Vec<u8>,
    quality: Vec<u8>,
    conflicts: Vec<u8>,
    owner: Vec<u32>,
    score: Vec<f32>,
    frozen: Vec<u8>,
}

impl Tile {
    fn new() -> Tile {
        let (n, blocks) = (TILE * TILE, (TILE / QUALITY_BLOCK).pow(2));
        Tile {
            pixels: vec![0; n * 4],
            coverage: vec![0; n / 8],
            provisional: vec![0; n / 8],
            quality: vec![0; blocks],
            conflicts: vec![0; blocks],
            owner: vec![0; blocks],
            score: vec![0.0; blocks],
            frozen: vec![0; blocks],
        }
    }
}

#[divan::bench(args = cases())]
fn composite_frame(bencher: divan::Bencher, case: &str) {
    let p = prepared(case);
    let (cols, rows) = (p.width.div_ceil(TILE), p.height.div_ceil(TILE));
    let obs = Observation {
        rgba: &p.rgba[1],
        width: p.width,
        height: p.height,
        labels: None,
        occlusions: &[],
        consistent: None,
        confidence: 0.8,
        uncertain: false,
        frame: 1,
    };
    // Every tile frame 1 covers, on empty tiles: the first paint of a frame onto the canvas.
    bencher
        .with_inputs(|| (0..cols * rows).map(|_| Tile::new()).collect::<Vec<_>>())
        .bench_local_refs(|tiles| {
            let mut added = 0;
            for (k, t) in tiles.iter_mut().enumerate() {
                let mut buffers = TileBuffers {
                    size: TILE,
                    pixels: &mut t.pixels,
                    coverage: &mut t.coverage,
                    provisional: &mut t.provisional,
                    quality: &mut t.quality,
                    conflicts: &mut t.conflicts,
                    owner: &mut t.owner,
                    score: &mut t.score,
                    frozen: &t.frozen,
                };
                let (tx, ty) = ((k % cols) as i64, (k / cols) as i64);
                added += composite_tile(&mut buffers, &obs, p.frame_rect(), 0, 0, tx, ty).added;
            }
            added
        });
}

#[divan::bench(args = cases())]
fn pyramid_parent(bencher: divan::Bencher, case: &str) {
    let p = prepared(case);
    let children: Vec<Vec<u8>> = (0..4).map(|i| p.tile_crop(i % 2, i / 2)).collect();
    bencher
        .with_inputs(|| vec![0u8; TILE * TILE * 4])
        .bench_local_refs(|out| {
            assemble_parent(
                [
                    Some(&children[0]),
                    Some(&children[1]),
                    Some(&children[2]),
                    Some(&children[3]),
                ],
                TILE,
                out,
            )
        });
}

#[divan::bench(args = cases())]
fn png_encode_tile(bencher: divan::Bencher, case: &str) {
    let p = prepared(case);
    let tile = p.tile_crop(0, 0);
    // The settings of `ls_png_encode` (rust/wasm/src/png.rs).
    bencher.bench_local(|| {
        let mut out = Vec::new();
        let mut enc = png::Encoder::new(&mut out, TILE as u32, TILE as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().unwrap();
        writer.write_image_data(&tile).unwrap();
        writer.finish().unwrap();
        out
    });
}
