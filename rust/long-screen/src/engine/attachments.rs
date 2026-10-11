//! Fragment attachments: a fragment canvas that later evidence tied rigidly onto another canvas. The solve pass
//! records them (`attach/<id>` rows) and follows the chains to compare a keyframe's raw canvas and pose with the
//! canvas it is observed at today; the render pass walks the same chains.

use crate::engine::pose_graph::{PoseGraph, PoseGraphError};
use std::collections::{HashMap, HashSet};

/// One `attach/<id>` row: every placement on `id` maps onto `target`, shifted by `(dx, dy)`.
#[derive(Clone, Debug, PartialEq)]
pub struct Attachment {
    pub id: String,
    pub target: String,
    pub dx: f64,
    pub dy: f64,
    pub frame: u32,
    pub confidence: f64,
    /// The matched target keyframe's pose-graph node.
    pub node: String,
}

/// Fragment id → its attachment.
pub type Attachments = HashMap<String, Attachment>;

/// The canvas `id` finally resolves to through its attachment chain (a cycle stops at the first repeat).
pub fn resolve_target<'a>(attachments: &'a Attachments, mut id: &'a str) -> &'a str {
    let mut seen = HashSet::new();
    while let Some(a) = attachments.get(id) {
        if !seen.insert(id) {
            break;
        }
        id = &a.target;
    }
    id
}

/// The total rigid shift from `id` through its attachment chain to the canvas it resolves to.
pub fn attachment_shift<'a>(attachments: &'a Attachments, mut id: &'a str) -> (f64, f64) {
    let (mut x, mut y) = (0.0, 0.0);
    let mut seen = HashSet::new();
    while let Some(a) = attachments.get(id) {
        if !seen.insert(id) {
            break;
        }
        x += a.dx;
        y += a.dy;
        id = &a.target;
    }
    (x, y)
}

/// The render-time shift from `id` through its chain: each link's measured offset plus how far its anchor node has
/// since moved under graph relaxation (as of the attach frame), so an attached fragment follows a target that a
/// later loop closure moved. Summed link by link as `shift += dx + correction`.
pub fn render_shift<'a>(
    attachments: &'a Attachments,
    mut id: &'a str,
    graph: &PoseGraph,
) -> Result<(f64, f64), PoseGraphError> {
    let (mut x, mut y) = (0.0, 0.0);
    let mut seen = HashSet::new();
    while let Some(a) = attachments.get(id) {
        if !seen.insert(id) {
            break;
        }
        let (cx, cy) = graph.correction(&a.node, a.frame as f64)?;
        x += a.dx + cx;
        y += a.dy + cy;
        id = &a.target;
    }
    Ok((x, y))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attach(id: &str, target: &str, dx: f64, dy: f64) -> (String, Attachment) {
        (
            id.to_string(),
            Attachment {
                id: id.to_string(),
                target: target.to_string(),
                dx,
                dy,
                frame: 0,
                confidence: 1.0,
                node: String::new(),
            },
        )
    }

    #[test]
    fn an_unattached_canvas_resolves_to_itself_unshifted() {
        let map = Attachments::new();
        assert_eq!(resolve_target(&map, "a"), "a");
        assert_eq!(attachment_shift(&map, "a"), (0.0, 0.0));
    }

    #[test]
    fn a_chain_resolves_to_its_end_and_sums_its_shifts() {
        let map: Attachments = [attach("a", "b", 1.0, 2.0), attach("b", "c", 10.0, 20.0)]
            .into_iter()
            .collect();
        assert_eq!(resolve_target(&map, "a"), "c");
        assert_eq!(attachment_shift(&map, "a"), (11.0, 22.0));
        assert_eq!(resolve_target(&map, "b"), "c");
    }

    #[test]
    fn the_render_shift_adds_how_far_each_anchor_node_moved() {
        use crate::engine::pose_graph::PoseNode;
        let node = |id: &str, moved: f64| PoseNode {
            id: id.into(),
            canvas_id: "t".into(),
            frame: 0,
            x: moved,
            y: 0.0,
            original_x: 0.0,
            original_y: 0.0,
            pinned: false,
            next: None,
        };
        let mut map: Attachments = [attach("a", "b", 1.0, 2.0), attach("b", "c", 10.0, 20.0)]
            .into_iter()
            .collect();
        map.get_mut("a").unwrap().node = "na".into();
        map.get_mut("b").unwrap().node = "nb".into();
        let mut g = PoseGraph::new();
        g.hydrate_node(node("na", 3.0));
        g.hydrate_node(node("nb", 0.5));
        assert_eq!(
            render_shift(&map, "a", &g),
            Ok((1.0 + 3.0 + (10.0 + 0.5), 22.0))
        );
        assert_eq!(render_shift(&map, "c", &g), Ok((0.0, 0.0)));
        g = PoseGraph::new();
        assert_eq!(
            render_shift(&map, "a", &g),
            Err(PoseGraphError::MissingPose)
        );
    }

    #[test]
    fn a_cycle_stops_at_the_first_repeat() {
        let map: Attachments = [attach("a", "b", 1.0, 0.0), attach("b", "a", 2.0, 0.0)]
            .into_iter()
            .collect();
        assert_eq!(resolve_target(&map, "a"), "a");
        assert_eq!(attachment_shift(&map, "a"), (3.0, 0.0));
    }
}
