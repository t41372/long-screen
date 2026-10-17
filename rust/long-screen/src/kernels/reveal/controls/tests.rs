use super::*;
use crate::kernels::reveal::model::Object;
use crate::kernels::reveal::TIER_CLEAN;

const CW: usize = 40;
const CH: usize = 120;

fn model() -> LayerModel {
    LayerModel {
        x: 0,
        y: 0,
        cw: CW,
        ch: CH,
        objects: vec![Object {
            kind: Kind::Opaque,
            bx: 34,
            by: 0,
            bw: 6,
            bh: CH,
            mask: vec![true; 6 * CH],
            tpl: vec![[180; 3]; 6 * CH],
            stable: Vec::new(),
            coarse: Vec::new(),
            textured: true,
            last: (0, 0),
            flat: None,
        }],
    }
}

fn cells(y: usize) -> Cells {
    let mut cells = Cells {
        cw: CW,
        ch: CH,
        rgb: vec![[240; 3]; CW * CH],
        luma: vec![240; CW * CH],
    };
    for yy in y..y + 20 {
        for x in 36..39 {
            cells.rgb[yy * CW + x] = [120; 3];
            cells.luma[yy * CW + x] = 120;
        }
    }
    cells
}

// Failure cases chosen before promotion: confusing page-locked content with a
// control; aliasing a repeated line when its original world position still agrees;
// treating offscreen/occluded evidence as disagreement; accepting only two views;
// retaining empty map entries after the byte budget is exhausted.
#[test]
fn three_independent_views_retroactively_locate_the_actual_thumb() {
    let model = model();
    let mask = vec![1; CW * CH * 4];
    let footprint = Footprint {
        x: 0,
        y: 0,
        width: CW * 2,
        height: CH * 2,
        mask: &mask,
    };
    let mut tracks = ControlTracks::new(CW * CH);
    for (index, y) in [20, 35, 50].into_iter().enumerate() {
        tracks.observe(
            &cells(y),
            &model,
            &footprint,
            24,
            View {
                index: index as u32,
                canvas: 0,
                pose: (0, index as i64 * 30),
            },
        );
        if index < 2 {
            assert!(
                tracks.records.is_empty(),
                "two observations are not a track"
            );
        }
    }
    for (index, y) in [20, 35, 50].into_iter().enumerate() {
        let mut tiers = vec![TIER_CLEAN; CW * CH];
        tracks.apply(index as u32, &model, &vec![true; CW * CH], &mut tiers);
        assert_eq!(tiers[y * CW + 37], TIER_OPAQUE);
        assert_eq!(
            tiers[2 * CW + 20],
            TIER_CLEAN,
            "the page outside the actual component stays clean"
        );
    }
}

#[test]
fn a_page_locked_component_never_becomes_a_control() {
    let model = model();
    let mask = vec![1; CW * CH * 4];
    let footprint = Footprint {
        x: 0,
        y: 0,
        width: CW * 2,
        height: CH * 2,
        mask: &mask,
    };
    let mut tracks = ControlTracks::new(CW * CH);
    for (index, y) in [50, 35, 20].into_iter().enumerate() {
        tracks.observe(
            &cells(y),
            &model,
            &footprint,
            24,
            View {
                index: index as u32,
                canvas: 0,
                pose: (0, index as i64 * 30),
            },
        );
    }
    assert!(tracks.records.is_empty());
}

#[test]
fn missing_evidence_and_a_matching_world_position_cannot_disprove_page_motion() {
    let model = model();
    let mut mask = vec![1; CW * CH * 4];
    fn footprint(mask: &[u8]) -> Footprint<'_> {
        Footprint {
            x: 0,
            y: 0,
            width: CW * 2,
            height: CH * 2,
            mask,
        }
    }
    let previous = detect(&cells(40), &model, &footprint(&mask), 24, 0).remove(0);
    assert!(!contradicts_page(
        &previous,
        &cells(25),
        &model,
        &footprint(&mask),
        (0, -30),
        24
    ));
    assert!(!contradicts_page(
        &previous,
        &cells(80),
        &model,
        &footprint(&mask),
        (0, -100),
        24
    ));
    assert!(contradicts_page(
        &previous,
        &cells(80),
        &model,
        &footprint(&mask),
        (0, -30),
        24
    ));
    // Hide part of that expected world position. Its absence is no longer evidence.
    mask[50 * CW * 2 + 72] = 0;
    assert!(!contradicts_page(
        &previous,
        &cells(80),
        &model,
        &footprint(&mask),
        (0, -30),
        24
    ));
}

#[test]
fn a_full_record_budget_does_not_accumulate_empty_frame_entries() {
    let mut tracks = ControlTracks::new(0);
    let mut stamp = Stamp {
        frame: 0,
        rect: CellRect {
            x: 2,
            y: 2,
            width: 2,
            height: 8,
        },
        colour: [120; 3],
        area: 16,
        mask: vec![255; 2].into_boxed_slice(),
    };
    for frame in 0..100 {
        stamp.frame = frame;
        tracks.remember(&stamp);
    }
    let retained = tracks.records.len();
    assert!(retained > 0 && retained < 100);
    // A 4 KiB recording budget has room for three masks with a fixed, conservative
    // 1 KiB metadata charge each. Pointer width must not change the retained prefix.
    assert_eq!(
        tracks.records.keys().copied().collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
    for frame in 100..10_000 {
        stamp.frame = frame;
        tracks.remember(&stamp);
    }
    assert_eq!(tracks.records.len(), retained);
    assert!(tracks.record_bytes <= tracks.record_limit);
}
