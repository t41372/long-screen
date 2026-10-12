//! Screen-fixed regions (docs/ARCHITECTURE.md §十 "合成与瞬态像素"): a band that stays put on screen while a pointer
//! crosses it, fades in or is not a whole number of 16-px blocks high. Each test is one way the band's canvas could end
//! up showing something other than its settled, pointer-free state.

use super::*;
use crate::engine::compositor::TemporalPolicy;
use crate::engine::pose_graph::PoseNode;
use crate::engine::tiles::StoredTile;

const W: usize = 48;
const H: usize = 32;
const TILE: usize = 16;
/// What lies under the band's region outside it (another region's pixels).
const BELOW: u8 = 50;

fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}

/// A fixed band `band` rows high across the top; the rows under it belong to another region.
fn band(height: usize) -> (Vec<RenderRegion>, Vec<u8>) {
    let regions = vec![
        RenderRegion {
            id: "f".into(),
            kind: RegionKind::Fixed,
            rect: rect(0.0, 0.0, W as f64, height as f64),
            code: 1,
            owned_pixels: (W * height) as f64,
        },
        RenderRegion {
            id: "m".into(),
            kind: RegionKind::Moving,
            rect: rect(0.0, height as f64, W as f64, (H - height) as f64),
            code: 2,
            owned_pixels: (W * (H - height)) as f64,
        },
    ];
    let labels = (0..W * H)
        .map(|i| if i / W < height { 1 } else { 2 })
        .collect();
    (regions, labels)
}

/// A frame whose band rows hold `value` and whose other rows hold [`BELOW`].
fn frame(height: usize, value: u8) -> Vec<u8> {
    (0..W * H)
        .flat_map(|i| {
            let v = if i / W < height { value } else { BELOW };
            [v, v, v, 255]
        })
        .collect()
}

/// Paints `pixels` (x, y, value) into a frame.
fn draw(mut f: Vec<u8>, pixels: impl IntoIterator<Item = (usize, usize, u8)>) -> Vec<u8> {
    for (x, y, v) in pixels {
        let i = (y * W + x) * 4;
        f[i..i + 3].copy_from_slice(&[v, v, v]);
    }
    f
}

/// A `w × h` pointer of `value` with its top-left corner at (x, y), clipped to the band.
fn pointer(x: usize, y: usize, w: usize, h: usize, value: u8) -> Vec<(usize, usize, u8)> {
    (y..y + h)
        .flat_map(|py| (x..x + w).map(move |px| (px, py, value)))
        .filter(|&(px, _, _)| px < W)
        .collect()
}

/// A 4×8 pointer tip inside one block (12.5 % of it: not a conflict), with edges sharper than the flat band around it.
fn tip() -> Vec<(usize, usize, u8)> {
    (4..12)
        .flat_map(|y| [(20, y, 250), (21, y, 250), (22, y, 0), (23, y, 0)])
        .collect()
}

struct Host {
    cache: TileCache,
    compositor: Compositor,
    graph: PoseGraph,
    labels: Vec<u8>,
    frames: Vec<Vec<u8>>,
    tiles: HashMap<TileKey, StoredTile>,
}

impl Host {
    fn new(labels: Vec<u8>, frames: Vec<Vec<u8>>) -> Self {
        let mut graph = PoseGraph::new();
        graph.hydrate_node(PoseNode {
            id: "n".into(),
            canvas_id: "c".into(),
            frame: 0,
            x: 0.0,
            y: 0.0,
            original_x: 0.0,
            original_y: 0.0,
            pinned: false,
            next: None,
        });
        Self {
            cache: TileCache::new(TILE, 128.0).unwrap(),
            compositor: Compositor::new(TemporalPolicy::Stable, W, H),
            graph,
            labels,
            frames,
            tiles: HashMap::new(),
        }
    }

    /// Renders every frame in order, each with both neighbours in hand, the band placed at the origin.
    fn render(&mut self, s: &mut RenderSession) -> Vec<Diagnostic> {
        let plan = || FramePlan {
            placements: vec![PlanPlacement {
                layer: "f".into(),
                canvas_id: "c".into(),
                node: "n".into(),
                x: 0.0,
                y: 0.0,
                confidence: 1.0,
                uncertain: false,
                time: 0.0,
                skip: None,
                occlusions: None,
            }],
            duplicate: false,
        };
        let n = self.frames.len() as u32;
        let mut events = Vec::new();
        for index in 0..n {
            let input = FrameInput {
                index,
                time: index as f64 / 30.0,
                plan: plan(),
                has_prev: index > 0,
                prev_plan: (index > 0).then(plan),
                has_next: index + 1 < n,
                next_plan: (index + 1 < n).then(plan),
            };
            let wanted = s.wanted_votes(index, input.has_prev, input.has_next);
            s.begin(input, wanted.into_iter().map(|i| (i, None)).collect())
                .unwrap();
            self.drive(s);
            events.extend(s.take_events());
        }
        if s.begin_finish().unwrap() {
            self.drive(s);
        }
        events.extend(s.take_events());
        events
    }

    /// Answers the session's needs until the frame (or the finish) is done.
    fn drive(&mut self, s: &mut RenderSession) {
        {
            loop {
                let mut io = RenderIo {
                    cache: &mut self.cache,
                    compositor: &mut self.compositor,
                    graph: &self.graph,
                    labels: &self.labels,
                    now: 1.0,
                };
                match s.step(&mut io).unwrap() {
                    RenderStep::NeedMeta(c) => s.provide_meta(
                        &c,
                        Some(CanvasMeta {
                            bounds: rect(0.0, 0.0, 0.0, 0.0),
                            tile_count: 0.0,
                            observed_pixels: 0.0,
                            uncertain_pixels: 0.0,
                            conflict_pixels: 0.0,
                            provisional_pixels: 0.0,
                            last_time: 0.0,
                        }),
                    ),
                    RenderStep::NeedFrame(i) => {
                        s.frame_slot(i).copy_from_slice(&self.frames[i as usize])
                    }
                    RenderStep::NeedTile(key) => {
                        while let Some(id) = self.cache.victim() {
                            let t = self.cache.evict(id).unwrap();
                            self.tiles.insert(
                                t.key.clone(),
                                StoredTile {
                                    pixels: t.pixels,
                                    coverage: Some(t.coverage),
                                    provisional: Some(t.provisional),
                                    quality: Some(t.quality),
                                    conflicts: Some(t.conflicts),
                                    owner: Some(t.owner),
                                    score: Some(t.score),
                                    frozen: Some(t.frozen),
                                },
                            );
                        }
                        let stored = self.tiles.get(&key).cloned();
                        self.cache.insert(key, stored).unwrap();
                    }
                    RenderStep::NeedTemporal(c) => {
                        self.compositor.load_temporal(&c, Vec::new()).unwrap()
                    }
                    RenderStep::Done(_) => break,
                }
            }
        }
    }

    /// The band canvas's pixel at (x, y): its grey value, `None` where nothing was written, and whether it is provisional.
    fn pixel(&mut self, x: usize, y: usize) -> Option<(u8, bool)> {
        let key = TileKey::new("c", 0, (x / TILE) as i32, (y / TILE) as i32);
        let id = self.cache.touch(&key)?;
        let t = self.cache.get(id).unwrap();
        let p = (y % TILE) * TILE + x % TILE;
        let bit = |bits: &[u8]| bits[p >> 3] & (1 << (p & 7)) != 0;
        bit(&t.coverage).then(|| (t.pixels[p * 4], bit(&t.provisional)))
    }

    /// Every band pixel that is not `want`, as (x, y, value).
    fn wrong(&mut self, height: usize, want: u8) -> Vec<(usize, usize, Option<u8>)> {
        let mut out = Vec::new();
        for y in 0..height {
            for x in 0..W {
                let got = self.pixel(x, y).map(|(v, _)| v);
                if got != Some(want) {
                    out.push((x, y, got));
                }
            }
        }
        out
    }
}

fn session(regions: Vec<RenderRegion>) -> RenderSession {
    RenderSession::new(RenderConfig {
        width: W,
        height: H,
        factor: 1,
        noise: 0.0,
        regions,
        attachments: Vec::new(),
    })
}

#[test]
fn a_pointer_sweeping_a_fixed_band_leaves_no_trail() {
    // An 8×8 pointer (a quarter of a block: a conflict wherever it lands) crosses the band 20 px a frame, then leaves.
    let (regions, labels) = band(16);
    let mut frames: Vec<Vec<u8>> = (0..3)
        .map(|k| draw(frame(16, 100), pointer(4 + 20 * k, 4, 8, 8, 250)))
        .collect();
    frames.extend((0..3).map(|_| frame(16, 100)));
    let mut host = Host::new(labels, frames);
    host.render(&mut session(regions));
    assert_eq!(host.wrong(16, 100), Vec::new(), "the pointer left a trail");
}

#[test]
fn a_small_pointer_cannot_win_a_fixed_block_on_sharpness() {
    // 4×8 pixels of one block (12.5 %: not a conflict) whose edges are sharper than the flat band.
    let (regions, labels) = band(16);
    let frames = vec![
        frame(16, 100),
        draw(frame(16, 100), tip()),
        frame(16, 100),
        frame(16, 100),
    ];
    let mut host = Host::new(labels, frames);
    host.render(&mut session(regions));
    assert_eq!(
        host.wrong(16, 100),
        Vec::new(),
        "a sharper transient replaced the block"
    );
}

#[test]
fn a_pointer_in_the_first_frame_is_provisional_and_heals() {
    let (regions, labels) = band(16);
    let frames = vec![draw(frame(16, 100), tip()), frame(16, 100), frame(16, 100)];
    let mut host = Host::new(labels, frames);
    host.render(&mut session(regions));
    assert_eq!(host.wrong(16, 100), Vec::new());
    assert_eq!(host.pixel(20, 4), Some((100, false)));
}

#[test]
fn a_fading_band_settles_on_its_final_state() {
    // Hidden (black) for two frames, four frames of fade, then settled.
    let (regions, labels) = band(16);
    let frames = [0, 0, 40, 80, 120, 160, 200, 200, 200, 200]
        .into_iter()
        .map(|v| frame(16, v))
        .collect();
    let mut host = Host::new(labels, frames);
    host.render(&mut session(regions));
    assert_eq!(host.wrong(16, 200), Vec::new(), "the band froze mid-fade");
}

#[test]
fn a_band_whose_height_is_not_a_multiple_of_16_takes_its_settled_state() {
    // 24 rows: its second block row reaches row 32, eight rows into the region below.
    let (regions, labels) = band(24);
    let frames = [0, 200, 200, 200]
        .into_iter()
        .map(|v| frame(24, v))
        .collect();
    let mut host = Host::new(labels, frames);
    host.render(&mut session(regions));
    assert_eq!(host.wrong(24, 200), Vec::new(), "the band never updated");
    for y in 24..H {
        for x in 0..W {
            assert_eq!(
                host.pixel(x, y),
                None,
                "({x}, {y}) belongs to the region below"
            );
        }
    }
}

#[test]
fn a_pointer_resting_at_the_end_is_kept() {
    // The band's last stable state is what it shows: a pointer parked for the final frames is part of it.
    let (regions, labels) = band(16);
    let parked = || draw(frame(16, 100), pointer(20, 4, 8, 8, 250));
    let frames = vec![frame(16, 100), frame(16, 100), parked(), parked(), parked()];
    let mut host = Host::new(labels, frames);
    host.render(&mut session(regions));
    assert_eq!(host.pixel(24, 8), Some((250, false)));
    assert_eq!(host.pixel(4, 8), Some((100, false)));
}

#[test]
fn content_that_changes_every_frame_keeps_its_first_frame_as_provisional() {
    // A spinner: no frame agrees with either neighbour, so nothing certifies any of them.
    let (regions, labels) = band(16);
    let frames = (0..5).map(|k| frame(16, 40 + 30 * k as u8)).collect();
    let mut host = Host::new(labels, frames);
    host.render(&mut session(regions));
    assert_eq!(host.pixel(0, 0), Some((40, true)));
}

#[test]
fn a_region_whose_state_keeps_changing_keeps_its_first_frame() {
    // Content under a translucent bar: a new settled state every other frame. No state is the bar's; the first
    // frame (without transients) is what it showed before anything moved under it.
    let (regions, labels) = band(16);
    let frames = (0..60)
        .map(|k| frame(16, if (k / 2) % 2 == 0 { 60 } else { 160 }))
        .collect();
    let mut host = Host::new(labels, frames);
    host.render(&mut session(regions));
    assert_eq!(
        host.wrong(16, 60),
        Vec::new(),
        "the band kept a later state"
    );
}

#[test]
fn the_reference_frame_loses_a_pointer_parked_in_it() {
    // The pointer sits still for the first three frames, so no mask flags it; the bar then shows clean for longer.
    let (regions, labels) = band(16);
    let parked = || draw(frame(16, 100), pointer(20, 4, 8, 8, 250));
    let mut frames = vec![parked(), parked(), parked()];
    frames.extend((0..8).map(|_| frame(16, 100)));
    let reference = frames[0].clone();
    let mut host = Host::new(labels, frames);
    let mut s = session(regions);
    host.render(&mut s);
    let mut patched = reference.clone();
    assert!(s.patch_reference(&mut patched, W, H, 0));
    assert_eq!(
        patched,
        frame(16, 100),
        "the reference still shows the pointer"
    );
    assert!(
        !s.patch_reference(&mut patched, W, H, 1),
        "another frame is not patched"
    );
}
