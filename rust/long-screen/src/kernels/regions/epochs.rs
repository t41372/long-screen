//! Ownership that changes during a recording without the region moving ([`RegionEpoch`]). A region keeps one screen
//! rect for the whole run, so every rect-relative coordinate (keyframe patches, voting boxes, reveal cells,
//! screen-fixed cells) means the same thing in every frame; what changes from one epoch to the next is which of its
//! pixels it owns, expressed as extra exclusions. A browser's address bar that collapses mid-recording (issue #1) is
//! two epochs: the page owns the bar's lower rows only after the collapse.

use crate::kernels::geometry::Rect;

/// Extra exclusions a region carries from frame `from` on, until the next epoch of the same region starts
/// (`Region.epochs` in the regions row). Before a region's first epoch it has no extra exclusions.
#[derive(Clone, Debug, PartialEq)]
pub struct RegionEpoch {
    pub from: u32,
    pub exclusions: Vec<Rect>,
}

/// The extra exclusions in effect at `frame`: those of the last epoch starting at or before it.
pub fn extra_exclusions(epochs: &[RegionEpoch], frame: u32) -> &[Rect] {
    epochs
        .iter()
        .rev()
        .find(|e| e.from <= frame)
        .map_or(&[], |e| e.exclusions.as_slice())
}

/// A region's exclusions at `frame`: its own, then the extra ones of the epoch in effect.
pub fn exclusions_at(base: &[Rect], epochs: &[RegionEpoch], frame: u32) -> Vec<Rect> {
    base.iter()
        .chain(extra_exclusions(epochs, frame))
        .copied()
        .collect()
}

/// The frames at which any of the regions' ownership may change, ascending and unique, always starting with 0: one
/// atlas per start. Regions without epochs give exactly `[0]`.
pub fn epoch_starts<'a>(epochs: impl IntoIterator<Item = &'a [RegionEpoch]>) -> Vec<u32> {
    let mut starts: Vec<u32> = std::iter::once(0)
        .chain(epochs.into_iter().flatten().map(|e| e.from))
        .collect();
    starts.sort_unstable();
    starts.dedup();
    starts
}

/// The index into [`epoch_starts`] of the epoch `frame` falls in.
pub fn epoch_index(starts: &[u32], frame: u32) -> usize {
    starts.partition_point(|&s| s <= frame).saturating_sub(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(y: f64, height: f64) -> Rect {
        Rect {
            x: 0.0,
            y,
            width: 100.0,
            height,
        }
    }

    // Failure cases: a frame before the first epoch picking up its exclusions; a frame exactly at an epoch's start
    // keeping the previous one; a later epoch not replacing an earlier one; an epoch with no exclusions failing to
    // clear them; the region's own exclusions dropped or reordered; starts out of order, duplicated or missing 0;
    // a frame past the last start mapped past the end.
    #[test]
    fn exclusions_follow_the_epoch_in_effect() {
        let own = [rect(0.0, 5.0)];
        let epochs = [
            RegionEpoch {
                from: 10,
                exclusions: vec![rect(20.0, 4.0)],
            },
            RegionEpoch {
                from: 30,
                exclusions: Vec::new(),
            },
        ];
        assert_eq!(exclusions_at(&own, &epochs, 0), vec![own[0]]);
        assert_eq!(exclusions_at(&own, &epochs, 9), vec![own[0]]);
        assert_eq!(
            exclusions_at(&own, &epochs, 10),
            vec![own[0], rect(20.0, 4.0)]
        );
        assert_eq!(
            exclusions_at(&own, &epochs, 29),
            vec![own[0], rect(20.0, 4.0)]
        );
        assert_eq!(exclusions_at(&own, &epochs, 30), vec![own[0]]);
        assert_eq!(exclusions_at(&own, &[], 1_000), vec![own[0]]);
    }

    #[test]
    fn starts_are_sorted_unique_and_begin_at_zero() {
        let a = [
            RegionEpoch {
                from: 30,
                exclusions: Vec::new(),
            },
            RegionEpoch {
                from: 0,
                exclusions: Vec::new(),
            },
        ];
        let b = [RegionEpoch {
            from: 30,
            exclusions: Vec::new(),
        }];
        let starts = epoch_starts([&a[..], &b[..], &[][..]]);
        assert_eq!(starts, vec![0, 30]);
        assert_eq!(epoch_starts([&[][..]]), vec![0]);
        assert_eq!(epoch_index(&starts, 0), 0);
        assert_eq!(epoch_index(&starts, 29), 0);
        assert_eq!(epoch_index(&starts, 30), 1);
        assert_eq!(epoch_index(&starts, u32::MAX), 1);
        assert_eq!(epoch_index(&[0], 7), 0);
    }
}
