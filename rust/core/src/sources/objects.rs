//! Competing page/screen/local translation models. A residual is a proposal, never an occluder
//! by itself. Appearance tracking and motion relative to the page determine its temporal role.
use super::surface::Surface;
mod matching;
use matching::{fit, gradient, local_fit, pixel, rgb_distance, track_template, Fit, Point};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

const CELL: usize = 16;
const MAX_POINTS: usize = 48;
const MAX_TRACKS: usize = 64;
const MAX_SURFACE_BYTES: usize = 8 * 1024 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MotionRole {
    Unknown,
    PageDynamic,
    Screen,
    Local,
    /// Retrospective affiliation uncertainty; never a positive or negative pixel witness.
    Transition,
    /// Retrospective native background affiliation; never a clean motion witness.
    Background,
    /// Enclosed detail on a supported page surface; independent occlusion still wins.
    PageSurface,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
impl Bounds {
    fn distance(self, b: Self) -> i32 {
        (self.x + self.width / 2 - b.x - b.width / 2).abs()
            + (self.y + self.height / 2 - b.y - b.height / 2).abs()
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MaskRun {
    pub y: i32,
    pub x: i32,
    pub length: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectObservation {
    pub region: u16,
    pub id: u32,
    pub frame: u32,
    pub bounds: Bounds,
    pub role: MotionRole,
    pub core: Vec<MaskRun>,
    pub pose_x: i32,
    pub pose_y: i32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectState {
    pub region: u16,
    pub id: u32,
    pub first: u32,
    pub last: u32,
    pub role: MotionRole,
    pub observations: u32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectUpdate {
    pub objects: Vec<ObjectObservation>,
    pub states: Vec<ObjectState>,
    pub overflow: bool,
}
#[derive(Clone)]
struct Track {
    state: ObjectState,
    bounds: Bounds,
    world: Bounds,
    reference: Bounds,
    reference_world: Bounds,
    reference_pose: (i32, i32),
    independent: u32,
    anchored: u32,
    last_delta: (i32, i32),
    anchors: Vec<(Point, [u8; 3])>,
    surface: Option<Surface>,
    birth: u32,
    container: Option<Bounds>,
    container_support: u32,
    container_rejected: bool,
}
#[derive(Default)]
pub struct ObjectTracker {
    tracks: Vec<Track>,
    next_id: u32,
}
#[derive(Clone, Copy)]
pub struct View<'a> {
    pub rgba: &'a [u8],
    pub labels: &'a [u8],
    pub width: usize,
    pub height: usize,
    pub code: u8,
    pub pose: (i32, i32),
}
fn change_role(track: &mut Track, role: MotionRole, frame: u32, states: &mut Vec<ObjectState>) {
    if role != track.state.role && track.state.role != MotionRole::Unknown {
        let mut closed = track.state.clone();
        closed.last = frame.saturating_sub(2);
        if closed.last >= closed.first {
            states.push(closed);
        }
        track.state.first = frame.saturating_sub(1);
    }
    track.state.role = role;
}

/// A broad page margin must not supply a narrow-surface hypothesis.
fn narrow_edge_run(view: View<'_>, x: usize, y: usize, tolerance: u32) -> bool {
    let at = y * view.width + x;
    let (mut left, mut right) = (x, x + 1);
    while left > 0
        && x - left < CELL
        && rgb_distance(view.rgba, at, view.rgba, y * view.width + left - 1) <= tolerance
    {
        left -= 1;
    }
    while right < view.width
        && right - left <= CELL
        && rgb_distance(view.rgba, at, view.rgba, y * view.width + right) <= tolerance
    {
        right += 1;
    }
    right - left <= CELL && (!(left == 0 || right == view.width) || right - left <= 4)
}

/// A narrow native edge stripe that is unchanged in screen coordinates cannot inherit a clean
/// page witness from the text elsewhere in its 16px cell. This only withholds positive evidence;
/// it does not crop the edge or classify a page border as an occluder.
fn stationary_edge_stripe(
    current: View<'_>,
    previous: View<'_>,
    x: usize,
    y: usize,
    noise: u8,
) -> bool {
    let interior = if x < CELL * 2 && x + CELL < current.width {
        x + CELL
    } else if x + CELL * 2 >= current.width && x >= CELL {
        x - CELL
    } else {
        return false;
    };
    if y < CELL || y + CELL >= current.height {
        return false;
    }
    let center = y * current.width + x;
    let tolerance = noise as u32 * 3;
    let (mut flat, mut contrast, mut stationary) = (0, 0, 0);
    for yy in [y - CELL, y - CELL / 2, y, y + CELL / 2, y + CELL] {
        let at = yy * current.width + x;
        if rgb_distance(current.rgba, center, current.rgba, at) > tolerance {
            continue;
        }
        if !narrow_edge_run(current, x, yy, tolerance) {
            continue;
        }
        flat += 1;
        // A translucent thumb retains its surface while letters pass behind it. Requiring every
        // screen sample to remain identical incorrectly lends those pixels the page's motion.
        stationary += (rgb_distance(current.rgba, at, previous.rgba, at) <= tolerance) as usize;
        contrast += (rgb_distance(
            current.rgba,
            at,
            current.rgba,
            yy * current.width + interior,
        ) > tolerance + 12) as usize;
    }
    // Samples beyond an endpoint may have just left the thumb. Two separated screen witnesses suffice to
    // withdraw a clean claim; they are not enough to mark these pixels as occluded.
    flat >= 3 && contrast >= 3 && stationary >= 2
}

/// Transfer an uncertainty hypothesis only along the actual connected narrow surface. Text showing
/// through a translucent thumb may defeat the pointwise screen comparison in the middle of that
/// same surface. This withdraws positive page evidence; it neither creates an occlusion mask nor
/// changes pixels, and later independent object/container evidence remains available.
fn withhold_edge_motion(current: View<'_>, previous: View<'_>, noise: u8, visibility: &mut [u8]) {
    let band = (CELL * 2).min(current.width);
    let tolerance = noise as u32 * 3;
    for x in (0..band).chain(current.width.saturating_sub(band).max(band)..current.width) {
        let mut y = 0;
        while y < current.height {
            let at = y * current.width + x;
            if visibility[at] != 1
                || current.labels[at] != current.code
                || !narrow_edge_run(current, x, y, tolerance)
            {
                y += 1;
                continue;
            }
            let belongs = |yy: usize| {
                let i = yy * current.width + x;
                current.labels[i] == current.code
                    && rgb_distance(current.rgba, at, current.rgba, i) <= tolerance
                    && narrow_edge_run(current, x, yy, tolerance)
            };
            let (mut start, mut end) = (y, y + 1);
            while start > 0 && belongs(start - 1) {
                start -= 1;
            }
            while end < current.height && belongs(end) {
                end += 1;
            }
            if end - start >= CELL
                && (start..end).any(|yy| stationary_edge_stripe(current, previous, x, yy, noise))
            {
                for yy in start..end {
                    let i = yy * current.width + x;
                    if visibility[i] == 1 {
                        visibility[i] = 0;
                    }
                }
            }
            y = end;
        }
    }
}

impl ObjectTracker {
    pub fn previous_background(
        frame: u32,
        current: View<'_>,
        previous: View<'_>,
        noise: u8,
        visibility: &[u8],
        ownership: &[u8],
        objects: &[ObjectObservation],
    ) -> Vec<ObjectObservation> {
        super::background::previous_witness(
            frame, current, previous, noise, visibility, ownership, objects,
        )
    }
    pub fn observe(
        &mut self,
        frame: u32,
        current: View<'_>,
        previous: Option<View<'_>>,
        noise: u8,
        visibility: &mut [u8],
    ) -> ObjectUpdate {
        visibility.fill(0);
        let mut output = ObjectUpdate {
            objects: Vec::new(),
            states: Vec::new(),
            overflow: false,
        };
        let Some(previous) = previous else {
            return output;
        };
        let page = (
            current.pose.0 - previous.pose.0,
            current.pose.1 - previous.pose.1,
        );
        let texture_threshold = noise as u32 * 3 + 6;
        for track in self
            .tracks
            .iter_mut()
            .filter(|t| t.state.role != MotionRole::Unknown && t.anchors.len() >= 8)
        {
            if let Some((dx, dy)) = track_template(
                current,
                &track.anchors,
                (-track.last_delta.0, -track.last_delta.1),
                page,
                noise as u32,
            ) {
                let bounds = Bounds {
                    x: track.bounds.x + dx,
                    y: track.bounds.y + dy,
                    ..track.bounds
                };
                let follows_page = (dx + page.0).abs() + (dy + page.1).abs() <= 2;
                if page.0.abs() + page.1.abs() > 2 {
                    if follows_page {
                        track.anchored += 1;
                        track.independent = 0;
                    } else {
                        track.independent += 1;
                        track.anchored = 0;
                    }
                }
                let role = if track.anchored >= 2 {
                    MotionRole::PageDynamic
                } else if track.independent >= 2 {
                    if dx.abs() + dy.abs() <= 1 {
                        MotionRole::Screen
                    } else {
                        MotionRole::Local
                    }
                } else {
                    track.state.role
                };
                change_role(track, role, frame, &mut output.states);
                // A first page-following step is a transition, not more screen-occlusion support.
                let observed_role = if follows_page
                    && page.0.abs() + page.1.abs() > 2
                    && role != MotionRole::PageDynamic
                {
                    MotionRole::Unknown
                } else {
                    role
                };
                let mut core = Vec::new();
                for (point, value) in &mut track.anchors {
                    point.x += dx;
                    point.y += dy;
                    if let Some(i) = pixel(current, point.x, point.y) {
                        if (current.labels[i] == current.code
                            || matches!(observed_role, MotionRole::Screen | MotionRole::Local)
                                && current.labels[i] != 0)
                            && (0..3)
                                .map(|c| current.rgba[i * 4 + c].abs_diff(value[c]) as u32)
                                .sum::<u32>()
                                <= noise as u32 * 3
                        {
                            core.push(MaskRun {
                                x: point.x,
                                y: point.y,
                                length: 1,
                            });
                        }
                    }
                }
                if let Some(surface) = &mut track.surface {
                    surface.shift(dx, dy);
                    // Retain the actual surface through a page-speed transition too. The deferred
                    // role history decides eligibility; velocity alone cannot promote this overlay.
                    if observed_role != MotionRole::PageDynamic || track.state.first > track.birth {
                        core.extend(surface.matching(current, noise, visibility));
                    }
                }
                track.bounds = bounds;
                track.world = Bounds {
                    x: bounds.x + current.pose.0,
                    y: bounds.y + current.pose.1,
                    ..bounds
                };
                track.last_delta = (-dx, -dy);
                track.state.last = frame;
                track.state.observations += 1;
                output.objects.push(ObjectObservation {
                    region: current.code as u16,
                    id: track.state.id,
                    frame,
                    bounds,
                    role: observed_role,
                    core,
                    pose_x: current.pose.0,
                    pose_y: current.pose.1,
                });
                output.states.push(track.state.clone());
            }
        }
        let (cols, rows) = (current.width.div_ceil(CELL), current.height.div_ceil(CELL));
        let mut changed = vec![false; cols * rows];
        for cy in 0..rows {
            for cx in 0..cols {
                let (mut differences, mut samples, mut texture, mut screen_difference) =
                    (0, 0, 0, 0u64);
                for y in cy * CELL..((cy + 1) * CELL).min(current.height) {
                    for x in cx * CELL..((cx + 1) * CELL).min(current.width) {
                        let i = y * current.width + x;
                        if current.labels[i] != current.code {
                            continue;
                        }
                        let Some(j) = pixel(previous, x as i32 + page.0, y as i32 + page.1) else {
                            continue;
                        };
                        if previous.labels[j] != current.code {
                            continue;
                        }
                        let error = rgb_distance(current.rgba, i, previous.rgba, j);
                        samples += 1;
                        if error > noise as u32 * 3 {
                            differences += 1;
                        } else if gradient(current, x as i32, y as i32) >= texture_threshold {
                            texture += 1;
                        }
                        screen_difference += rgb_distance(current.rgba, i, previous.rgba, i) as u64;
                    }
                }
                changed[cy * cols + cx] = differences >= 4;
                // Blank agreement alone is not a clean witness. Texture must follow the page better
                // than screen coordinates; dynamic/occluding residuals are left unknown for tracking.
                if samples > 0
                    && texture >= 8
                    && differences * 10 <= samples
                    && screen_difference > samples as u64 * (noise as u64 * 3 + 12)
                {
                    for y in cy * CELL..((cy + 1) * CELL).min(current.height) {
                        for x in cx * CELL..((cx + 1) * CELL).min(current.width) {
                            let i = y * current.width + x;
                            if current.labels[i] != current.code {
                                continue;
                            }
                            if pixel(previous, x as i32 + page.0, y as i32 + page.1).is_some_and(
                                |j| {
                                    rgb_distance(current.rgba, i, previous.rgba, j)
                                        <= noise as u32 * 3
                                },
                            ) {
                                visibility[i] = 1;
                            }
                        }
                    }
                }
            }
        }
        let mut components = Vec::new();
        for seed in 0..changed.len() {
            if !changed[seed] {
                continue;
            }
            changed[seed] = false;
            let mut q = VecDeque::from([seed]);
            let (mut l, mut r, mut t, mut b) = (seed % cols, seed % cols, seed / cols, seed / cols);
            while let Some(i) = q.pop_front() {
                let (x, y) = (i % cols, i / cols);
                l = l.min(x);
                r = r.max(x);
                t = t.min(y);
                b = b.max(y);
                for yy in y.saturating_sub(1)..=(y + 1).min(rows - 1) {
                    for xx in x.saturating_sub(1)..=(x + 1).min(cols - 1) {
                        let at = yy * cols + xx;
                        if changed[at] {
                            changed[at] = false;
                            q.push_back(at);
                        }
                    }
                }
            }
            components.push(Bounds {
                x: (l * CELL) as i32,
                y: (t * CELL) as i32,
                width: ((r + 1) * CELL).min(current.width) as i32 - (l * CELL) as i32,
                height: ((b + 1) * CELL).min(current.height) as i32 - (t * CELL) as i32,
            });
        }
        components.sort_by_key(|b| std::cmp::Reverse(b.width * b.height));
        output.overflow = components.len() > MAX_TRACKS;
        for cell_bounds in components.into_iter().take(MAX_TRACKS) {
            let mut bounds = Bounds {
                x: current.width as i32,
                y: current.height as i32,
                width: 0,
                height: 0,
            };
            let (mut right, mut bottom) = (0, 0);
            for y in cell_bounds.y..cell_bounds.y + cell_bounds.height {
                for x in cell_bounds.x..cell_bounds.x + cell_bounds.width {
                    let i = y as usize * current.width + x as usize;
                    if current.labels[i] == current.code
                        && pixel(previous, x + page.0, y + page.1).is_some_and(|j| {
                            previous.labels[j] == current.code
                                && rgb_distance(current.rgba, i, previous.rgba, j)
                                    > noise as u32 * 3
                        })
                    {
                        bounds.x = bounds.x.min(x);
                        bounds.y = bounds.y.min(y);
                        right = right.max(x + 1);
                        bottom = bottom.max(y + 1);
                    }
                }
            }
            bounds.width = right - bounds.x;
            bounds.height = bottom - bounds.y;
            if bounds.width <= 0 || bounds.height <= 0 {
                continue;
            }
            if bounds.width as usize * bounds.height as usize > current.width * current.height / 2 {
                continue;
            }
            let mut points = Vec::new();
            for y in bounds.y..bounds.y + bounds.height {
                for x in bounds.x..bounds.x + bounds.width {
                    let i = y as usize * current.width + x as usize;
                    if current.labels[i] != current.code
                        || gradient(current, x, y) < texture_threshold
                    {
                        continue;
                    }
                    if pixel(previous, x + page.0, y + page.1).is_some_and(|j| {
                        rgb_distance(current.rgba, i, previous.rgba, j) > noise as u32 * 3
                    }) {
                        points.push(Point { x, y });
                    }
                }
            }
            let points: Vec<_> = if points.len() > MAX_POINTS {
                (0..MAX_POINTS)
                    .map(|k| points[k * points.len() / MAX_POINTS])
                    .collect()
            } else {
                points
            };
            let mut local = local_fit(
                current,
                previous,
                &points,
                bounds,
                &self.tracks,
                noise as u32,
            );
            // A residual component contains the object AND the newly revealed page behind it.
            // The matching object can be a minority; temporal confirmation supplies the second gate.
            let informative_fit = |fit: Fit| {
                let colours: Vec<_> = points
                    .iter()
                    .filter_map(|p| {
                        pixel(previous, p.x + fit.dx, p.y + fit.dy)
                            .filter(|&j| {
                                rgb_distance(
                                    current.rgba,
                                    p.y as usize * current.width + p.x as usize,
                                    previous.rgba,
                                    j,
                                ) <= noise as u32 * 3
                            })
                            .map(|_| {
                                let i = (p.y as usize * current.width + p.x as usize) * 4;
                                [current.rgba[i], current.rgba[i + 1], current.rgba[i + 2]]
                            })
                    })
                    .collect();
                colours.iter().any(|a| {
                    colours.iter().any(|b| {
                        (0..3).map(|c| a[c].abs_diff(b[c]) as u32).sum::<u32>()
                            > noise as u32 * 3 + 6
                    })
                })
            };
            let mut independent = informative_fit(local)
                && points.len() >= 8
                && local.inliers >= 8
                && local.inliers * 5 >= points.len() * 2
                && (local.dx - page.0).abs() + (local.dy - page.1).abs() > 2;
            let world = Bounds {
                x: bounds.x + current.pose.0,
                y: bounds.y + current.pose.1,
                ..bounds
            };
            let matched = if independent {
                Bounds {
                    x: bounds.x + local.dx,
                    y: bounds.y + local.dy,
                    ..bounds
                }
            } else {
                Bounds {
                    x: bounds.x + page.0,
                    y: bounds.y + page.1,
                    ..bounds
                }
            };
            let index = self
                .tracks
                .iter()
                .enumerate()
                .filter(|(_, t)| frame.saturating_sub(t.state.last) <= 2)
                .min_by_key(|(_, t)| t.bounds.distance(matched))
                .filter(|(_, t)| t.bounds.distance(matched) <= CELL as i32 * 3)
                .map(|(i, _)| i);
            let index = if let Some(i) = index {
                i
            } else {
                if self.tracks.len() >= MAX_TRACKS {
                    output.overflow = true;
                    continue;
                }
                self.next_id += 1;
                self.tracks.push(Track {
                    state: ObjectState {
                        region: current.code as u16,
                        id: self.next_id,
                        first: frame.saturating_sub(1),
                        last: frame.saturating_sub(1),
                        role: MotionRole::Unknown,
                        observations: 0,
                    },
                    bounds: matched,
                    world,
                    reference: bounds,
                    reference_world: world,
                    reference_pose: current.pose,
                    independent: 0,
                    anchored: 0,
                    last_delta: (0, 0),
                    anchors: Vec::new(),
                    surface: None,
                    birth: frame.saturating_sub(1),
                    container: super::container::enclosing_page_panel(
                        current, previous, bounds, noise,
                    ),
                    container_support: 0,
                    container_rejected: false,
                });
                self.tracks.len() - 1
            };
            let other_surface_bytes: usize = self
                .tracks
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != index)
                .map(|(_, t)| t.surface.as_ref().map_or(0, Surface::bytes))
                .sum();
            let track = &mut self.tracks[index];
            let template_seen = track.state.last == frame;
            if template_seen {
                local = fit(
                    current,
                    previous,
                    &points,
                    track.last_delta.0,
                    track.last_delta.1,
                    noise as u32,
                );
                independent = informative_fit(local)
                    && points.len() >= 8
                    && local.inliers >= 8
                    && local.inliers * 5 >= points.len() * 2
                    && (local.dx - page.0).abs() + (local.dy - page.1).abs() > 2;
            }
            let mut page_container = false;
            if let Some(container) = track.container.filter(|_| !track.container_rejected) {
                let contained = world.x >= container.x
                    && world.y >= container.y
                    && world.x + world.width <= container.x + container.width
                    && world.y + world.height <= container.y + container.height;
                if !contained {
                    track.container_rejected = true;
                    track.container_support = 0;
                    if track.state.role == MotionRole::PageDynamic {
                        track.state.first = track.birth;
                        track.state.role = MotionRole::Local;
                        track.anchored = 0;
                    }
                } else if page.0.abs() + page.1.abs() >= 2 {
                    track.container_support += 1;
                }
                page_container = contained && track.container_support >= 2;
            }
            // An independently changing video texture still belongs to a stationary world rectangle.
            if ((bounds.width - track.reference.width).abs() > 2
                || (bounds.height - track.reference.height).abs() > 2)
                && bounds.width * bounds.height > track.reference.width * track.reference.height
            {
                track.reference = bounds;
                track.reference_world = world;
                track.reference_pose = current.pose;
                track.anchored = 0;
            }
            let same_shape = (bounds.width - track.reference.width).abs() <= 2
                && (bounds.height - track.reference.height).abs() <= 2;
            let world_edges = (world.x - track.reference_world.x).abs()
                + (world.y - track.reference_world.y).abs()
                + (world.x + world.width - track.reference_world.x - track.reference_world.width)
                    .abs()
                + (world.y + world.height - track.reference_world.y - track.reference_world.height)
                    .abs();
            let travelled = (current.pose.0 - track.reference_pose.0).abs()
                + (current.pose.1 - track.reference_pose.1).abs();
            let bounded_page = same_shape && world_edges <= 4 && travelled >= CELL as i32;
            if bounded_page && !template_seen {
                track.anchored += 1;
            }
            if independent && track.state.last != frame {
                track.independent += 1;
                if !bounded_page {
                    track.anchored = 0;
                }
                track.last_delta = (local.dx, local.dy);
                if !same_shape
                    && bounds.width * bounds.height > track.reference.width * track.reference.height
                {
                    track.reference = bounds;
                    track.reference_world = world;
                    track.reference_pose = current.pose;
                }
            } else if !independent && track.state.last != frame {
                let travelled = (current.pose.0 - track.reference_pose.0).abs()
                    + (current.pose.1 - track.reference_pose.1).abs();
                let world_distance = track.reference_world.distance(world);
                let screen_distance = track.reference.distance(bounds);
                // Cell quantisation can hide a small screen displacement. Accumulate a baseline
                // before comparing the two models; a <=16px world drift alone is not page evidence.
                if travelled >= CELL as i32
                    && world_distance <= 4
                    && world_distance + 4 < screen_distance
                {
                    track.anchored += 1;
                }
            }
            if !template_seen {
                track.state.observations += 1;
            }
            track.state.last = frame;
            let mut role = track.state.role;
            if !template_seen && track.independent >= 2 {
                role = if local.dx.abs() + local.dy.abs() <= 1 {
                    MotionRole::Screen
                } else {
                    MotionRole::Local
                };
            }
            if page_container || (!template_seen && track.anchored >= 2) {
                role = MotionRole::PageDynamic;
                track.independent = 0;
            }
            change_role(track, role, frame, &mut output.states);
            if page_container {
                track.state.first = track.birth;
            }
            if independent && !template_seen {
                track.anchors = points
                    .iter()
                    .filter(|p| {
                        pixel(previous, p.x + local.dx, p.y + local.dy).is_some_and(|j| {
                            rgb_distance(
                                current.rgba,
                                p.y as usize * current.width + p.x as usize,
                                previous.rgba,
                                j,
                            ) <= noise as u32 * 3
                        })
                    })
                    .map(|p| {
                        let at = (p.y as usize * current.width + p.x as usize) * 4;
                        (*p, current.rgba[at..at + 3].try_into().unwrap())
                    })
                    .collect();
            }
            let mut core = Vec::new();
            if independent {
                // Motion is established by the textured seeds above. The object's stable surface
                // includes flat pixels too: requiring page disagreement AGAIN at every pixel would
                // leave a panel's solid interior unknown forever. This is a native appearance match
                // within the tracked residual footprint, not an unconditional bounding-box mask.
                for y in bounds.y..bounds.y + bounds.height {
                    let mut start = None;
                    for x in bounds.x..=bounds.x + bounds.width {
                        let on = x < bounds.x + bounds.width
                            && pixel(previous, x + local.dx, y + local.dy).is_some_and(|j| {
                                let i = y as usize * current.width + x as usize;
                                current.labels[i] == current.code
                                    && rgb_distance(current.rgba, i, previous.rgba, j)
                                        <= noise as u32 * 3
                            });
                        if on && start.is_none() {
                            start = Some(x);
                        }
                        if !on {
                            if let Some(s) = start.take() {
                                core.push(MaskRun {
                                    y,
                                    x: s,
                                    length: (x - s) as u32,
                                });
                            }
                        }
                    }
                }
            }
            super::background::exclude_margin(current, bounds, &mut core, noise);
            if independent && matches!(track.state.role, MotionRole::Screen | MotionRole::Local) {
                if !template_seen {
                    if let Some(surface) = &mut track.surface {
                        surface.shift(-local.dx, -local.dy);
                    }
                }
                if let Some(surface) = Surface::updated(
                    track.surface.as_ref(),
                    current,
                    &core,
                    MAX_SURFACE_BYTES.saturating_sub(other_surface_bytes),
                ) {
                    track.surface = Some(surface);
                } else {
                    output.overflow = true;
                }
            }
            if track.state.role == MotionRole::PageDynamic {
                let visible = if page_container {
                    let c = track.container.unwrap();
                    Bounds {
                        x: c.x - current.pose.0,
                        y: c.y - current.pose.1,
                        ..c
                    }
                } else {
                    bounds
                };
                for y in visible.y.max(0)..(visible.y + visible.height).min(current.height as i32) {
                    for x in visible.x.max(0)..(visible.x + visible.width).min(current.width as i32)
                    {
                        let i = y as usize * current.width + x as usize;
                        if current.labels[i] == current.code {
                            visibility[i] = 1;
                        }
                    }
                }
            }
            if track.state.observations == 1 {
                output.objects.push(ObjectObservation {
                    region: current.code as u16,
                    id: track.state.id,
                    frame: frame.saturating_sub(1),
                    bounds: matched,
                    role: track.state.role,
                    core: core
                        .iter()
                        .map(|r| MaskRun {
                            x: r.x + local.dx,
                            y: r.y + local.dy,
                            length: r.length,
                        })
                        .collect(),
                    pose_x: previous.pose.0,
                    pose_y: previous.pose.1,
                });
            }
            output.objects.push(ObjectObservation {
                region: current.code as u16,
                id: track.state.id,
                frame,
                bounds,
                role: track.state.role,
                core,
                pose_x: current.pose.0,
                pose_y: current.pose.1,
            });
            output.states.push(track.state.clone());
            if !template_seen {
                track.bounds = bounds;
                track.world = world;
            }
        }
        for object in &mut output.objects {
            let view = if object.frame == frame {
                current
            } else {
                previous
            };
            super::background::exclude_margin(view, object.bounds, &mut object.core, noise);
        }
        for object in output.objects.iter_mut().filter(|o| o.frame == frame) {
            if object.role != MotionRole::Unknown {
                if let Some(track) = self.tracks.iter().find(|t| t.state.id == object.id) {
                    object.role = track.state.role;
                }
            }
            if matches!(object.role, MotionRole::Screen | MotionRole::Local) {
                for run in &object.core {
                    for x in run.x..run.x + run.length as i32 {
                        visibility[run.y as usize * current.width + x as usize] = 2;
                    }
                }
            }
        }
        withhold_edge_motion(current, previous, noise, visibility);
        super::background::refine_objects(frame, current, visibility, noise, &mut output.objects);

        self.tracks
            .retain(|t| frame.saturating_sub(t.state.last) < 12);
        output
    }
}
