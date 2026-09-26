//! Retrospective motion evidence applied to preserved native alternatives. A later confirmation can
//! label an early observation, including a pause alias, without decoding a GOP again.
use super::objects::{MotionRole, ObjectObservation, ObjectState};
use super::*;
use std::{collections::BTreeMap, rc::Rc};
// A short detection lead covers page-speed arrival before an independent residual becomes visible.
// It only withholds confidence and cannot attach an object to arbitrary older page content.
const TRANSITION_FRAMES: u32 = 4;
#[derive(Default)]
pub struct Roles {
    by_object: BTreeMap<(u16, u32), Vec<ObjectState>>,
    region: u16,
}
impl Roles {
    pub fn new(states: Vec<ObjectState>) -> Self {
        let mut index: BTreeMap<_, Vec<_>> = BTreeMap::new();
        for state in states {
            index
                .entry((state.region, state.id))
                .or_default()
                .push(state);
        }
        Self {
            by_object: index,
            region: 0,
        }
    }
    pub fn in_region(mut self, region: u16) -> Self {
        self.region = region;
        self
    }
    fn scoped(&self, role: MotionRole, region: u16) -> MotionRole {
        if matches!(
            role,
            MotionRole::PageDynamic
                | MotionRole::Transition
                | MotionRole::Background
                | MotionRole::PageSurface
        ) && self.region != 0
            && self.region != (region & 255)
        {
            MotionRole::Unknown
        } else {
            role
        }
    }
    fn at(&self, object: &ObjectObservation) -> MotionRole {
        let Some(states) = self.by_object.get(&(object.region, object.id)) else {
            return self.scoped(object.role, object.region);
        };
        let Some(current) = states
            .iter()
            .filter(|s| object.frame >= s.first && object.frame <= s.last)
            .max_by_key(|s| s.observations)
        else {
            return self.scoped(object.role, object.region);
        };
        // A formerly independent object can momentarily travel at page speed (a sticky bar's
        // release animation). Motion agreement does not turn its appearance into clean page RGB.
        // A confirmed page container can reinterpret the identity from birth, replacing that
        // earlier overlay interval; otherwise retain negative evidence from the tracked surface.
        if current.role == MotionRole::PageDynamic
            && states.iter().any(|s| {
                s.first < current.first && matches!(s.role, MotionRole::Screen | MotionRole::Local)
            })
        {
            MotionRole::Local
        } else if current.role == MotionRole::PageDynamic
            && states.iter().any(|s| {
                s.first > current.first && matches!(s.role, MotionRole::Screen | MotionRole::Local)
            })
        {
            // An initial page-speed segment is not proof of page ownership once this same tracked
            // identity moves independently. Keep its pixels available, with uncertain affiliation.
            self.scoped(MotionRole::Transition, object.region)
        } else {
            self.scoped(current.role, object.region)
        }
    }
}
#[derive(Default)]
pub struct Evidence {
    pub objects: Vec<ObjectObservation>,
    roles: Rc<Roles>,
    pub(super) index: std::cell::OnceCell<BTreeMap<u32, Vec<(usize, MotionRole)>>>,
}
impl Evidence {
    pub fn new(objects: Vec<ObjectObservation>, states: Vec<ObjectState>) -> Self {
        Self::with_roles(objects, Rc::new(Roles::new(states)))
    }
    pub fn with_roles(objects: Vec<ObjectObservation>, roles: Rc<Roles>) -> Self {
        Self {
            objects,
            roles,
            ..Self::default()
        }
    }
    pub fn each_object(
        &self,
        c: &Candidate,
        mut f: impl FnMut(&ObjectObservation, MotionRole, (i32, i32)),
    ) {
        let index = self.index.get_or_init(|| {
            let mut index = std::collections::BTreeMap::<u32, Vec<(usize, MotionRole)>>::new();
            for (id, object) in self.objects.iter().enumerate() {
                let role = self.roles.at(object);
                index.entry(object.frame).or_default().push((id, role));
            }
            index
        });
        for span in &c.frames {
            for objects in index
                .range(span.first..=span.last)
                .map(|(_, objects)| objects)
            {
                for &(id, role) in objects {
                    f(&self.objects[id], role, (span.pose_x, span.pose_y));
                }
            }
        }
    }

    pub fn apply(&self, c: &mut Candidate, wx: i32, wy: i32) {
        let mut visibility = c.visibility.clone();
        // Page-container inference may be confirmed after the frame was archived. Reclassify
        // its whole observed footprint, then apply independent overlays last (a cursor can cross a video).
        for overlays in [false, true] {
            self.each_object(c, |object, role, pose| {
                if overlays != matches!(role, MotionRole::Screen | MotionRole::Local) {
                    return;
                }
                if !matches!(
                    role,
                    MotionRole::Screen
                        | MotionRole::Local
                        | MotionRole::PageDynamic
                        | MotionRole::Transition
                        | MotionRole::Background
                        | MotionRole::PageSurface
                ) {
                    return;
                }
                let (sx, sy) = (wx - pose.0, wy - pose.1);
                if object.bounds.x >= sx + SIDE as i32
                    || object.bounds.y >= sy + SIDE as i32
                    || object.bounds.x + object.bounds.width <= sx
                    || object.bounds.y + object.bounds.height <= sy
                {
                    return;
                }
                if matches!(role, MotionRole::Background | MotionRole::PageSurface) {
                    if object.region >= 256 && !visibility.iter().any(|v| v.is_context()) {
                        return;
                    }
                    for run in &object.core {
                        let y = run.y - sy;
                        if y < 0 || y >= SIDE as i32 {
                            continue;
                        }
                        for x in
                            (run.x - sx).max(0)..(run.x + run.length as i32 - sx).min(SIDE as i32)
                        {
                            let at = y as usize * SIDE + x as usize;
                            if visibility[at] != Visibility::Outside
                                && !visibility[at].is_locked()
                                && visibility[at].is_context() == (object.region >= 256)
                            {
                                visibility[at] = if role == MotionRole::PageSurface {
                                    if visibility[at].is_occluded() {
                                        continue;
                                    }
                                    if visibility[at].is_context() {
                                        Visibility::ContextSurface
                                    } else {
                                        Visibility::Unknown
                                    }
                                } else if visibility[at].is_context() {
                                    Visibility::ContextBackground
                                } else {
                                    Visibility::Background
                                };
                            }
                        }
                    }
                    return;
                }
                if role == MotionRole::PageDynamic {
                    for y in (object.bounds.y - sy).max(0)
                        ..(object.bounds.y + object.bounds.height - sy).min(SIDE as i32)
                    {
                        for x in (object.bounds.x - sx).max(0)
                            ..(object.bounds.x + object.bounds.width - sx).min(SIDE as i32)
                        {
                            let at = y as usize * SIDE + x as usize;
                            if !matches!(
                                visibility[at],
                                Visibility::Outside | Visibility::ContextExcluded
                            ) && !visibility[at].is_locked()
                                && visibility[at].is_context() == (object.region >= 256)
                            {
                                visibility[at] = if visibility[at].is_context() {
                                    Visibility::Context
                                } else {
                                    Visibility::Visible
                                };
                            }
                        }
                    }
                } else {
                    // A confirmed object's transition can predate its first reliable native mask.
                    // Its bounds only withdraw a page-motion claim; unmatched pixels stay available
                    // as unknown sources. Only the observed core below establishes occlusion.
                    if object.region < 256 {
                        for y in (object.bounds.y - sy).max(0)
                            ..(object.bounds.y + object.bounds.height - sy).min(SIDE as i32)
                        {
                            for x in (object.bounds.x - sx).max(0)
                                ..(object.bounds.x + object.bounds.width - sx).min(SIDE as i32)
                            {
                                let at = y as usize * SIDE + x as usize;
                                if visibility[at] == Visibility::Visible {
                                    visibility[at] = Visibility::Unknown;
                                }
                            }
                        }
                    }
                    if role == MotionRole::Transition {
                        return;
                    }
                    for run in &object.core {
                        let y = run.y - sy;
                        if y < 0 || y >= SIDE as i32 {
                            continue;
                        }
                        for x in
                            (run.x - sx).max(0)..(run.x + run.length as i32 - sx).min(SIDE as i32)
                        {
                            let at = y as usize * SIDE + x as usize;
                            if !matches!(
                                visibility[at],
                                Visibility::Outside
                                    | Visibility::ContextExcluded
                                    | Visibility::Background
                                    | Visibility::ContextBackground
                            ) && !visibility[at].is_locked()
                                && (object.region < 256 || visibility[at].is_context())
                            {
                                visibility[at] = if visibility[at].is_context() {
                                    Visibility::ContextOccluded
                                } else {
                                    Visibility::Occluded
                                };
                            }
                        }
                    }
                }
            });
        }
        // Detection needs a residual, so a moving overlay can first travel at page speed and only
        // become identifiable a few frames later. The birth bounds offer a short world-aligned
        // uncertainty hypothesis, never an occlusion mask or a cross-pane correspondence.
        let index = self
            .index
            .get()
            .expect("the current-frame pass built the evidence index");
        for span in &c.frames {
            let Some(first) = span.last.checked_add(1) else {
                continue;
            };
            let last = span.last.saturating_add(TRANSITION_FRAMES);
            for &(id, role) in index.range(first..=last).flat_map(|(_, objects)| objects) {
                let object = &self.objects[id];
                if object.region >= 256
                    || self.roles.region != 0 && object.region != self.roles.region
                    || !matches!(role, MotionRole::Screen | MotionRole::Local)
                    || !self
                        .roles
                        .by_object
                        .get(&(object.region, object.id))
                        .is_some_and(|states| {
                            states.iter().map(|state| state.first).min() == Some(object.frame)
                        })
                {
                    continue;
                }
                let x0 = object.bounds.x + object.pose_x - wx;
                let y0 = object.bounds.y + object.pose_y - wy;
                for y in y0.max(0)..(y0 + object.bounds.height).min(SIDE as i32) {
                    for x in x0.max(0)..(x0 + object.bounds.width).min(SIDE as i32) {
                        let at = y as usize * SIDE + x as usize;
                        if visibility[at] == Visibility::Visible {
                            visibility[at] = Visibility::Unknown;
                        }
                    }
                }
            }
        }
        c.visibility = visibility;
    }
}
pub fn frames(candidates: impl Iterator<Item = Candidate>) -> Vec<u32> {
    let mut frames = std::collections::BTreeSet::new();
    for c in candidates {
        for span in c.frames {
            frames.insert(span.first);
            frames.insert(span.last);
            for lead in 1..=TRANSITION_FRAMES {
                if let Some(next) = span.last.checked_add(lead) {
                    frames.insert(next);
                }
            }
        }
    }
    frames.into_iter().collect()
}
