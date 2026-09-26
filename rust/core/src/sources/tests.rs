use super::*;

fn observation(frame: u32, value: u8, visibility: Visibility) -> Candidate {
    Candidate::new(
        frame,
        frame as f64 / 30.0,
        frame as i32 * 32,
        0,
        vec![value, value, value, 255].repeat(PIXELS),
        vec![visibility; PIXELS],
        100,
    )
}

// Failure cases are the contract: dwell cannot outvote a clean witness; partially visible sources may
// jointly cover a static block; different dynamic blocks must share an observed epoch; overflow and
// eviction must preserve rare sources; archives must survive reload without losing provenance.
#[test]
fn one_visible_observation_beats_arbitrarily_many_occluded_copies() {
    let mut history = History::default();
    for frame in 0..90 {
        history.observe(observation(frame, 20, Visibility::Occluded), 0);
    }
    history.observe(observation(90, 200, Visibility::Visible), 0);
    let candidates = history.all_candidates();
    let result = resolve_block(&candidates, 0);
    assert_eq!(result.kind, ContentKind::Static);
    assert!(result
        .rgba
        .chunks_exact(4)
        .all(|p| p == [200, 200, 200, 255]));
    assert!(result.sources.iter().all(|s| *s == 90));
    assert!(result.reasons.iter().all(|r| *r == Reason::VisibleWitness));
}

#[test]
fn static_pixels_can_be_recovered_without_any_wholly_clean_frame() {
    let mut a = observation(0, 50, Visibility::Visible);
    let mut b = observation(1, 50, Visibility::Visible);
    for i in 0..PIXELS / 2 {
        a.visibility[i] = Visibility::Occluded;
        a.rgba[i * 4] = 250;
    }
    for i in PIXELS / 2..PIXELS {
        b.visibility[i] = Visibility::Occluded;
        b.rgba[i * 4] = 250;
    }
    let result = resolve_block(&[a, b], 0);
    assert_eq!(result.kind, ContentKind::Static);
    assert!(result.rgba.chunks_exact(4).all(|p| p == [50, 50, 50, 255]));
    assert_eq!(result.sources[0], 1);
    assert_eq!(result.sources[PIXELS - 1], 0);
}

#[test]
fn spill_and_reload_never_lose_the_only_clean_source() {
    let mut history = History::default();
    history.observe(observation(0, 77, Visibility::Visible), 0);
    for frame in 1..30 {
        history.observe(observation(frame, frame as u8, Visibility::Unknown), 0);
    }
    assert!(history.resident.len() <= RESIDENT_CANDIDATES);
    assert!(!history.spilled.is_empty());
    let bytes = history.encode().unwrap();
    let loaded = History::decode(&bytes).unwrap();
    let result = resolve_block(&loaded.all_candidates(), 0);
    assert_eq!(result.rgba[0], 77);
    assert_eq!(result.sources[0], 0);
}

#[test]
fn paused_duplicates_have_one_exposure_but_disappearance_is_a_new_state() {
    let mut history = History::default();
    for frame in 0..90 {
        let mut c = observation(frame, 20, Visibility::Occluded);
        c.pose_x = 0;
        c.source_state = 0; // exact whole-frame equality, established by the replay's frame-ring comparison
        history.observe(c, 0);
    }
    assert_eq!(history.all_candidates().len(), 1);
    assert_eq!(history.resident[0].exposures.len(), 1);
    let mut clean = observation(90, 80, Visibility::Visible);
    clean.pose_x = 0;
    history.observe(clean, 0);
    assert_eq!(resolve_block(&history.all_candidates(), 0).rgba[0], 80);
}

#[test]
fn component_selection_never_invents_the_majority_state_111() {
    let states = [[1, 1, 0], [1, 0, 1], [0, 1, 1]];
    let blocks: Vec<_> = (0..3)
        .map(|b| {
            let candidates: Vec<_> = (0..3)
                .map(|f| observation(f as u32, states[f][b] * 200, Visibility::Visible))
                .collect();
            assert_eq!(resolve_block(&candidates, 0).kind, ContentKind::Dynamic);
            candidates
        })
        .collect();
    let chosen = choose_component_epoch(&blocks, TemporalPolicy::Stable);
    assert_eq!(chosen.frame, Some(0));
    let selected: Vec<_> = blocks
        .iter()
        .map(|cs| at_epoch(cs, chosen.frame.unwrap()).unwrap().rgba[0])
        .collect();
    assert_eq!(selected, vec![200, 200, 0]);
    assert_eq!(
        choose_component_epoch(&blocks, TemporalPolicy::Latest).frame,
        Some(2)
    );
}

#[test]
fn a_component_with_no_complete_epoch_stays_partial() {
    let a = vec![observation(0, 10, Visibility::Visible)];
    let b = vec![observation(1, 20, Visibility::Visible)];
    let chosen = choose_component_epoch(&[a, b], TemporalPolicy::Stable);
    assert!(!chosen.complete);
    assert_eq!(chosen.frame, Some(0));
    assert_eq!(chosen.missing_blocks, vec![1]);
}

#[test]
fn unknown_is_not_clean_and_unobserved_pixels_are_not_filled() {
    let mut a = observation(0, 42, Visibility::Unknown);
    a.visibility[0] = Visibility::Outside;
    let result = resolve_block(&[a], 0);
    assert_eq!(result.reasons[0], Reason::Unobserved);
    assert_eq!(result.rgba[3], 0);
    assert_eq!(result.reasons[1], Reason::SingleObservation);
    assert_eq!(result.sources[1], 0);
}

#[test]
fn a_narrow_pane_is_complete_when_all_previously_observed_pixels_are_visible() {
    let mut a = observation(0, 30, Visibility::Visible);
    for y in 0..SIDE {
        for x in 8..SIDE {
            a.visibility[y * SIDE + x] = Visibility::Outside;
        }
    }
    assert!(choose_component_epoch(&[vec![a]], TemporalPolicy::Stable).complete);
}

#[test]
fn late_motion_confirmation_labels_pause_aliases_without_rewriting_native_pixels() {
    use super::annotation::Evidence;
    use super::objects::{Bounds, MaskRun, MotionRole, ObjectObservation, ObjectState};
    let pixels = vec![80; PIXELS * 4];
    let mut c = Candidate::new(
        0,
        0.,
        0,
        0,
        pixels.clone(),
        vec![Visibility::Unknown; PIXELS],
        1,
    );
    c.frames[0].last = 90;
    let evidence = Evidence::new(
        vec![ObjectObservation {
            region: 1,
            id: 4,
            frame: 90,
            bounds: Bounds {
                x: 0,
                y: 0,
                width: 16,
                height: 16,
            },
            role: MotionRole::Unknown,
            core: vec![MaskRun {
                x: 0,
                y: 4,
                length: 16,
            }],
            pose_x: 0,
            pose_y: 0,
        }],
        vec![ObjectState {
            region: 1,
            id: 4,
            first: 89,
            last: 93,
            role: MotionRole::Screen,
            observations: 4,
        }],
    );
    evidence.apply(&mut c, 0, 0);
    assert!(c.visibility[64..80]
        .iter()
        .all(|v| *v == Visibility::Occluded));
    assert_eq!(c.visibility[63], Visibility::Unknown);
    assert_eq!(c.rgba, pixels);
}

#[test]
fn unknown_noise_sized_reveals_survive_until_visibility_is_known() {
    let mut h = History::default();
    h.observe(
        Candidate::new(
            0,
            0.,
            0,
            0,
            vec![80; PIXELS * 4],
            vec![Visibility::Unknown; PIXELS],
            1,
        ),
        10,
    );
    h.observe(
        Candidate::new(
            1,
            1.,
            0,
            0,
            vec![81; PIXELS * 4],
            vec![Visibility::Unknown; PIXELS],
            1,
        ),
        10,
    );
    assert_eq!(h.resident.len(), 2);
}

#[test]
fn exported_patch_sheet_preserves_actual_pixels_and_source_poses() {
    use super::tile::SpillEntry;
    let c = Candidate::new(
        7,
        0.25,
        -16,
        32,
        vec![94; PIXELS * 4],
        vec![Visibility::Visible; PIXELS],
        80,
    );
    let (sheet, rgba) = super::export::sheet(vec![SpillEntry {
        block: 3,
        candidate: c.clone(),
    }]);
    assert_eq!(sheet.patches[0].frame, 7);
    assert_eq!(sheet.patches[0].pose_x, -16);
    assert_eq!(sheet.patches[0].visibility, vec![(0, PIXELS, 1)]);
    for y in 0..SIDE {
        assert_eq!(
            &rgba[y * sheet.width * 4..(y * sheet.width + SIDE) * 4],
            &c.rgba[y * SIDE * 4..(y + 1) * SIDE * 4]
        );
    }
    assert!(super::export::encode_png(&sheet, &rgba)
        .unwrap()
        .starts_with(&[137, 80, 78, 71]));
}

#[test]
fn ambiguity_preserves_an_existing_source_only_when_an_eligible_native_candidate_matches_it() {
    use super::analysis::BlockAnalysis;
    let source = |frame, colour, visibility| {
        Candidate::new(
            frame,
            frame as f64,
            0,
            0,
            vec![colour; PIXELS * 4],
            vec![visibility; PIXELS],
            1,
        )
    };
    let mut b = BlockAnalysis::default();
    b.set_baseline(&vec![80; PIXELS * 4], &vec![true; PIXELS]);
    b.feed(&source(0, 40, Visibility::Unknown), 0, 0, 0);
    b.feed(&source(1, 80, Visibility::Unknown), 0, 0, 1);
    assert_eq!(b.resolution().rgba[0], 80);
    assert_eq!(b.resolution().sources[0], 1);
    assert_eq!(b.resolution().reasons[0], Reason::Ambiguous);
    let mut disproved = BlockAnalysis::default();
    disproved.set_baseline(&vec![80; PIXELS * 4], &vec![true; PIXELS]);
    disproved.feed(&source(0, 80, Visibility::Occluded), 0, 0, 0);
    disproved.feed(&source(1, 40, Visibility::Unknown), 0, 0, 1);
    assert_eq!(disproved.resolution().rgba[0], 40);
    b.feed(&source(2, 120, Visibility::Visible), 0, 0, 2);
    assert_eq!(
        b.resolution().rgba[0],
        120,
        "a clean witness still replaces prior ownership"
    );
}

#[test]
fn no_confirmed_clean_source_keeps_a_traceable_prior_without_claiming_a_clean_witness() {
    use super::analysis::BlockAnalysis;
    let mut b = BlockAnalysis::default();
    b.set_baseline(&vec![80; PIXELS * 4], &vec![true; PIXELS]);
    b.feed(
        &Candidate::new(
            0,
            0.,
            0,
            0,
            vec![40; PIXELS * 4],
            vec![Visibility::Occluded; PIXELS],
            1,
        ),
        0,
        0,
        0,
    );
    b.feed(
        &Candidate::new(
            1,
            1.,
            0,
            0,
            vec![80; PIXELS * 4],
            vec![Visibility::Occluded; PIXELS],
            1,
        ),
        0,
        0,
        1,
    );
    let resolved = b.resolution();
    assert_eq!(resolved.rgba[0], 80);
    assert_eq!(resolved.sources[0], 1);
    assert_eq!(resolved.reasons[0], Reason::NoCleanSource);
}

#[test]
fn unknown_aliases_keep_distinct_screen_footprints_and_whole_frame_appearance_states() {
    let source = |frame, pose, state| {
        let mut c = Candidate::new(
            frame,
            frame as f64,
            0,
            pose,
            vec![80; PIXELS * 4],
            vec![Visibility::Unknown; PIXELS],
            1,
        );
        c.source_state = state;
        c
    };
    let mut h = History::default();
    h.observe(source(0, 0, 0), 0);
    h.observe(source(1, 0, 0), 0);
    assert_eq!(
        h.resident.len(),
        1,
        "a byte-identical paused frame can share its visibility evidence"
    );
    h.observe(source(2, 32, 2), 0);
    h.observe(source(3, 0, 3), 0);
    assert_eq!(
        h.resident.len(),
        3,
        "matching patch colours do not prove the same overlay footprint or appearance state"
    );
}

#[test]
fn raster_phase_is_ambiguous_not_a_new_content_version() {
    use super::analysis::BlockAnalysis;
    let mut sharp = vec![255; PIXELS * 4];
    for y in 0..SIDE {
        for x in 0..SIDE {
            if (x / 3 + y / 4) % 2 == 0 {
                sharp[(y * SIDE + x) * 4..(y * SIDE + x) * 4 + 3].fill(30);
            }
        }
    }
    let mut soft = sharp.clone();
    for y in 0..SIDE - 1 {
        for x in 0..SIDE {
            for c in 0..3 {
                let i = (y * SIDE + x) * 4 + c;
                soft[i] = ((sharp[i] as u16 + sharp[i + SIDE * 4] as u16).div_ceil(2)) as u8;
            }
        }
    }
    let mut b = BlockAnalysis::default();
    b.feed(
        &Candidate::new(
            0,
            0.,
            0,
            0,
            sharp.clone(),
            vec![Visibility::Visible; PIXELS],
            1,
        ),
        0,
        0,
        0,
    );
    b.feed(
        &Candidate::new(1, 1., 0, 0, soft, vec![Visibility::Visible; PIXELS], 1),
        0,
        0,
        1,
    );
    assert_eq!(b.kind(), ContentKind::Ambiguous);
    assert_eq!(
        b.resolution().rgba,
        sharp,
        "a weak phase model never writes interpolated output"
    );
}
#[test]
fn a_real_thin_stroke_disappearance_is_not_a_raster_shift() {
    use super::analysis::BlockAnalysis;
    let mut on = vec![255; PIXELS * 4];
    for y in 2..14 {
        on[(y * SIDE + 8) * 4..(y * SIDE + 8) * 4 + 3].fill(0);
    }
    let mut b = BlockAnalysis::default();
    b.feed(
        &Candidate::new(0, 0., 0, 0, on, vec![Visibility::Visible; PIXELS], 1),
        0,
        0,
        0,
    );
    b.feed(
        &Candidate::new(
            1,
            1.,
            0,
            0,
            vec![255; PIXELS * 4],
            vec![Visibility::Visible; PIXELS],
            1,
        ),
        0,
        0,
        1,
    );
    assert_eq!(b.kind(), ContentKind::Dynamic);
}

#[test]
fn an_overlay_matching_page_velocity_is_not_automatically_clean_page_content() {
    use super::{
        annotation::Evidence,
        objects::{Bounds, MaskRun, MotionRole, ObjectObservation, ObjectState},
    };
    let object = ObjectObservation {
        region: 1,
        id: 7,
        frame: 8,
        bounds: Bounds {
            x: 0,
            y: 0,
            width: 16,
            height: 16,
        },
        role: MotionRole::PageDynamic,
        core: vec![MaskRun {
            x: 0,
            y: 4,
            length: 16,
        }],
        pose_x: 0,
        pose_y: 0,
    };
    let state = |first, last, role| ObjectState {
        region: 1,
        id: 7,
        first,
        last,
        role,
        observations: 10,
    };
    let mut c = observation(8, 40, Visibility::Visible);
    c.pose_x = 0;
    c.frames[0].pose_x = 0;
    let evidence = Evidence::new(
        vec![object.clone()],
        vec![
            state(0, 4, MotionRole::Screen),
            state(5, 10, MotionRole::PageDynamic),
        ],
    );
    evidence.apply(&mut c, 0, 0);
    assert!(c.visibility[64..80]
        .iter()
        .all(|v| *v == Visibility::Occluded));
    assert_eq!(
        c.visibility[63],
        Visibility::Unknown,
        "the unmatched surface stays uncertain, while only the appearance-confirmed core is excluded"
    );
    // A retrospectively confirmed page container covers the identity from birth and can correct
    // its preliminary local-motion hypothesis, unlike velocity agreement after a real pinned period.
    let proven_page = Evidence::new(vec![object], vec![state(0, 10, MotionRole::PageDynamic)]);
    proven_page.apply(&mut c, 0, 0);
    assert!(c.visibility.iter().all(|v| *v == Visibility::Visible));
}

#[test]
fn placement_occlusions_survive_retrospective_page_motion_reclassification() {
    use super::{
        annotation::Evidence,
        objects::{Bounds, MotionRole, ObjectObservation},
        tile::{Capture, TileHistory},
    };
    let capture: Capture = serde_json::from_value(serde_json::json!({
        "width":16,"height":16,"frame":1,"time":0.0,"poseX":0.0,"poseY":0.0,"code":1,"quality":100,
        "occlusions":[{"x":0.0,"y":0.0,"width":16.0,"height":16.0}]
    }))
    .unwrap();
    let mut tile = TileHistory::new(16, 0, 0, 0, &[1]);
    tile.capture(&capture, &[255; PIXELS * 4], &[1; PIXELS], &[1; PIXELS]);
    let c = &mut tile.blocks.get_mut(&0).unwrap().resident[0];
    let evidence = Evidence::new(
        vec![ObjectObservation {
            region: 1,
            id: 1,
            frame: 1,
            bounds: Bounds {
                x: 0,
                y: 0,
                width: 16,
                height: 16,
            },
            role: MotionRole::PageDynamic,
            core: vec![],
            pose_x: 0,
            pose_y: 0,
        }],
        vec![],
    );
    evidence.apply(c, 0, 0);
    assert!(resolve_block(&[c.clone()], 0)
        .reasons
        .iter()
        .all(|r| *r == Reason::NoCleanSource));
}

#[test]
fn page_motion_alone_does_not_overwrite_an_unrefuted_native_baseline() {
    use super::analysis::BlockAnalysis;
    for visibility in [Visibility::Unknown, Visibility::Occluded] {
        let prior = observation(0, 255, visibility);
        let new = observation(1, 40, Visibility::Visible);
        let mut block = BlockAnalysis::default();
        block.set_baseline(&prior.rgba, &[true; PIXELS]);
        block.feed(&prior, 0, 0, 0);
        block.feed(&new, 0, 1, 0);
        assert_eq!(
            block.resolution().rgba[0],
            40,
            "without contradictory occlusion evidence the clean source wins"
        );
        block.refute(&observation(2, 40, Visibility::Occluded), 0);
        let result = block.resolution();
        if visibility == Visibility::Unknown {
            assert_eq!(
                result.rgba, prior.rgba,
                "a page-following overlay is not an independent clean witness"
            );
            assert!(result.reasons.iter().all(|r| *r == Reason::Ambiguous));
        } else {
            assert_eq!(
                result.rgba, new.rgba,
                "a rejected baseline must still be repaired"
            );
            assert!(result.reasons.iter().all(|r| *r == Reason::VisibleWitness));
        }
    }
}

#[test]
fn contradictory_occluded_runs_only_weaken_matching_native_pixels() {
    use super::analysis::BlockAnalysis;
    let prior = observation(0, 255, Visibility::Unknown);
    let selected = observation(1, 40, Visibility::Visible);
    let mut negative = observation(2, 190, Visibility::Occluded);
    negative.rgba[12 * SIDE * 4..13 * SIDE * 4]
        .copy_from_slice(&selected.rgba[12 * SIDE * 4..13 * SIDE * 4]);
    let mut block = BlockAnalysis::default();
    block.set_baseline(&prior.rgba, &[true; PIXELS]);
    block.feed(&prior, 0, 0, 0);
    block.feed(&selected, 0, 1, 0);
    assert_eq!(block.refute(&negative, 0), 16);
    let out = block.resolution();
    for i in 0..PIXELS {
        assert_eq!(out.rgba[i * 4], if i / SIDE == 12 { 255 } else { 40 });
    }
}

#[test]
fn equally_visible_sources_preserve_the_existing_native_quality_choice() {
    use super::analysis::BlockAnalysis;
    // Quality breaks ties between equally supported sources. An Unknown baseline versus a
    // Visible reveal is covered separately: that is new evidence, not a quality tie.
    let old = observation(0, 80, Visibility::Visible);
    let new = observation(1, 85, Visibility::Visible);
    let mut block = BlockAnalysis::default();
    block.set_baseline(&old.rgba, &[true; PIXELS]);
    block.feed(&old, 10, 0, 0);
    block.feed(&new, 10, 1, 0);
    let result = block.resolution();
    assert_eq!(result.rgba,old.rgba,"registration confidence must not replace compatible compositor pixels with codec variation");
    assert!(result.sources.iter().all(|s| *s == 0));
}

#[test]
fn an_occluded_appearance_can_refute_an_earlier_small_translation_without_repainting() {
    use super::analysis::BlockAnalysis;
    let prior = observation(0, 255, Visibility::Unknown);
    let mut selected = observation(1, 255, Visibility::Visible);
    let mut negative = observation(2, 255, Visibility::Occluded);
    for y in 8..10 {
        for x in 0..SIDE {
            selected.rgba[(y * SIDE + x) * 4..(y * SIDE + x) * 4 + 3].fill(40);
        }
    }
    for y in 4..6 {
        for x in 0..SIDE {
            negative.rgba[(y * SIDE + x) * 4..(y * SIDE + x) * 4 + 3].fill(40);
        }
    }
    let mut b = BlockAnalysis::default();
    b.set_baseline(&prior.rgba, &[true; PIXELS]);
    b.feed(&prior, 0, 0, 0);
    b.feed(&selected, 0, 1, 0);
    assert_eq!(b.refute(&negative, 0), 32);
    assert_eq!(b.resolution().rgba, prior.rgba);
}

#[test]
fn uncertain_parent_candidates_can_repair_rejected_pixels_but_do_not_outrank_primary_sources() {
    let rejected = observation(0, 20, Visibility::Occluded);
    let context = observation(1, 200, Visibility::Context);
    let result = resolve_block(&[rejected.clone(), context.clone()], 0);
    assert_eq!(result.rgba[0], 200);
    assert!(result.reasons.iter().all(|r| *r == Reason::ContextSource));
    let primary = observation(2, 80, Visibility::Unknown);
    let result = resolve_block(&[rejected, context, primary], 0);
    assert_eq!(result.rgba[0], 80);
}

#[test]
fn page_affiliation_is_pane_local_while_independent_overlays_can_cross_panes() {
    use super::{
        annotation::{Evidence, Roles},
        objects::{Bounds, MaskRun, MotionRole, ObjectObservation},
    };
    use std::rc::Rc;
    let object = |role| ObjectObservation {
        region: 2,
        id: 1,
        frame: 0,
        bounds: Bounds {
            x: 0,
            y: 0,
            width: 16,
            height: 16,
        },
        role,
        core: vec![MaskRun {
            x: 0,
            y: 0,
            length: 16,
        }],
        pose_x: 0,
        pose_y: 0,
    };
    let roles = Rc::new(Roles::new(vec![]).in_region(1));
    let mut c = observation(0, 50, Visibility::Unknown);
    Evidence::with_roles(vec![object(MotionRole::PageDynamic)], roles.clone()).apply(&mut c, 0, 0);
    assert!(c.visibility.iter().all(|v| *v == Visibility::Unknown));
    Evidence::with_roles(vec![object(MotionRole::Local)], roles).apply(&mut c, 0, 0);
    assert!(c.visibility[..16]
        .iter()
        .all(|v| *v == Visibility::Occluded));
}

#[test]
fn uncertain_context_does_not_create_unobserved_parent_pixels_or_false_provenance() {
    use super::analysis::BlockAnalysis;
    let mut b = BlockAnalysis::default();
    b.set_baseline(&[0; PIXELS * 4], &[false; PIXELS]);
    b.feed(&observation(1, 200, Visibility::Context), 0, 0, 0);
    let r = b.resolution();
    assert!(r.reasons.iter().all(|r| *r == Reason::Unobserved));
    assert!(r.sources.iter().all(|f| *f == u32::MAX));
    assert!(r.rgba.iter().all(|v| *v == 0));
}

#[test]
fn auxiliary_object_masks_cannot_change_primary_ownership_or_excluded_hypotheses() {
    use super::{
        annotation::{Evidence, Roles},
        objects::{Bounds, MaskRun, MotionRole, ObjectObservation},
    };
    use std::rc::Rc;
    let object = ObjectObservation {
        region: 257,
        id: 1,
        frame: 0,
        bounds: Bounds {
            x: 0,
            y: 0,
            width: 16,
            height: 16,
        },
        role: MotionRole::Local,
        core: vec![MaskRun {
            x: 0,
            y: 0,
            length: 16,
        }],
        pose_x: 0,
        pose_y: 0,
    };
    let evidence = Evidence::with_roles(vec![object], Rc::new(Roles::new(vec![]).in_region(1)));
    for initial in [
        Visibility::Unknown,
        Visibility::Context,
        Visibility::ContextExcluded,
    ] {
        let mut c = observation(0, 50, initial);
        evidence.apply(&mut c, 0, 0);
        let expected = if initial == Visibility::Context {
            Visibility::ContextOccluded
        } else {
            initial
        };
        assert!(c.visibility[..16].iter().all(|v| *v == expected));
    }
}

#[test]
fn an_identified_overlay_bounds_can_refute_clean_motion_without_erasing_unmatched_pixels() {
    use super::{
        annotation::Evidence,
        objects::{Bounds, MotionRole, ObjectObservation},
    };
    let mut c = observation(0, 40, Visibility::Visible);
    let evidence = Evidence::new(
        vec![ObjectObservation {
            region: 1,
            id: 1,
            frame: 0,
            bounds: Bounds {
                x: 4,
                y: 4,
                width: 8,
                height: 8,
            },
            role: MotionRole::Local,
            core: vec![],
            pose_x: 0,
            pose_y: 0,
        }],
        vec![],
    );
    evidence.apply(&mut c, 0, 0);
    assert_eq!(c.visibility[4 * SIDE + 4], Visibility::Unknown);
    assert_eq!(c.visibility[0], Visibility::Visible);
    assert_eq!(c.rgba, observation(0, 40, Visibility::Visible).rgba);
}

#[test]
fn equivalent_unknown_colours_prefer_pose_corroboration_over_a_rare_quality_winner() {
    use super::analysis::BlockAnalysis;
    let mut b = BlockAnalysis::default();
    let mut prior = observation(0, 21, Visibility::Unknown);
    prior.exposures.push(Exposure {
        x: 0,
        y: 0,
        visibility: 0,
    });
    b.set_baseline(&prior.rgba, &[true; PIXELS]);
    // The stored darker glyph is within the codec tolerance but only occurs once.
    for frame in 1..9 {
        let mut c = observation(frame, 28, Visibility::Unknown);
        c.exposures.push(Exposure {
            x: frame as i32 * 2,
            y: 0,
            visibility: 0,
        });
        b.feed(&c, 10, 0, frame);
    }
    b.feed(&prior, 10, 0, 0);
    assert_eq!(b.resolution().rgba[0], 28);
    assert_eq!(b.resolution().reasons[0], Reason::SingleObservation);
    // A single good observation still outranks arbitrarily many uncertain ones.
    b.feed(&observation(20, 21, Visibility::Visible), 10, 0, 20);
    assert_eq!(b.resolution().rgba[0], 21);
}

#[test]
fn a_paused_colour_does_not_gain_pose_support_when_other_visibility_bits_change() {
    use super::analysis::BlockAnalysis;
    let mut b = BlockAnalysis::default();
    let mut prior = observation(0, 21, Visibility::Unknown);
    prior.exposures.push(Exposure {
        x: 0,
        y: 0,
        visibility: 0,
    });
    b.set_baseline(&prior.rgba, &[true; PIXELS]);
    for frame in 1..9 {
        let mut c = observation(frame, 28, Visibility::Unknown);
        c.exposures.push(Exposure {
            x: 1,
            y: 0,
            visibility: frame,
        });
        b.feed(&c, 10, 0, frame);
    }
    b.feed(&prior, 10, 0, 0);
    assert_eq!(b.resolution().rgba[0], 21);
}

#[test]
fn a_clean_noise_sized_reveal_is_not_replaced_by_an_uncorroborated_baseline() {
    use super::analysis::BlockAnalysis;
    let mut b = BlockAnalysis::default();
    let prior = observation(0, 21, Visibility::Unknown);
    b.set_baseline(&prior.rgba, &[true; PIXELS]);
    b.feed(&prior, 10, 0, 0);
    b.feed(&observation(1, 28, Visibility::Visible), 10, 0, 1);
    assert_eq!(b.resolution().rgba[0], 28);
    assert_eq!(b.resolution().reasons[0], Reason::VisibleWitness);
}

#[test]
fn the_first_confirmed_object_withdraws_a_page_speed_claim_one_frame_before_detection() {
    use super::{
        annotation::{Evidence, Roles},
        objects::{Bounds, MotionRole, ObjectObservation, ObjectState},
    };
    use std::rc::Rc;
    let object = ObjectObservation {
        region: 1,
        id: 1,
        frame: 1,
        bounds: Bounds {
            x: 4,
            y: 4,
            width: 8,
            height: 8,
        },
        role: MotionRole::Unknown,
        core: vec![],
        pose_x: 0,
        pose_y: 0,
    };
    let states = vec![ObjectState {
        region: 1,
        id: 1,
        first: 1,
        last: 5,
        role: MotionRole::Screen,
        observations: 5,
    }];
    let evidence = Evidence::with_roles(
        vec![object.clone()],
        Rc::new(Roles::new(states.clone()).in_region(1)),
    );
    let mut c = observation(0, 40, Visibility::Visible);
    evidence.apply(&mut c, 0, 0);
    assert_eq!(c.visibility[4 * SIDE + 4], Visibility::Unknown);
    assert_eq!(c.visibility[0], Visibility::Visible);
    let mut other = observation(0, 40, Visibility::Visible);
    Evidence::with_roles(vec![object], Rc::new(Roles::new(states).in_region(2)))
        .apply(&mut other, 0, 0);
    assert!(
        other.visibility.iter().all(|v| *v == Visibility::Visible),
        "world coordinates from another pane are not transferable"
    );
}

#[test]
fn later_independent_motion_makes_the_initial_page_role_uncertain_without_erasing_it() {
    use super::{
        annotation::Evidence,
        objects::{Bounds, MaskRun, MotionRole, ObjectObservation, ObjectState},
    };
    let mut c = observation(0, 40, Visibility::Visible);
    let object = ObjectObservation {
        region: 1,
        id: 1,
        frame: 0,
        bounds: Bounds {
            x: 0,
            y: 0,
            width: 16,
            height: 16,
        },
        role: MotionRole::PageDynamic,
        core: vec![MaskRun {
            x: 0,
            y: 0,
            length: 16,
        }],
        pose_x: 0,
        pose_y: 0,
    };
    let state = |first, last, role| ObjectState {
        region: 1,
        id: 1,
        first,
        last,
        role,
        observations: 3,
    };
    Evidence::new(
        vec![object],
        vec![
            state(0, 2, MotionRole::PageDynamic),
            state(3, 8, MotionRole::Screen),
        ],
    )
    .apply(&mut c, 0, 0);
    assert!(c.visibility.iter().all(|v| *v == Visibility::Unknown));
    assert_eq!(c.rgba, observation(0, 40, Visibility::Visible).rgba);
}

#[test]
fn a_later_occluded_colour_cannot_refute_multiple_independent_clean_page_witnesses() {
    use super::analysis::BlockAnalysis;
    let mut b = BlockAnalysis::default();
    let prior = observation(0, 255, Visibility::Unknown);
    b.set_baseline(&prior.rgba, &[true; PIXELS]);
    b.feed(&prior, 0, 0, 0);
    for frame in 1..5 {
        let mut c = observation(frame, 80, Visibility::Visible);
        c.exposures.push(Exposure {
            x: frame as i32 * 2,
            y: 0,
            visibility: 0,
        });
        b.feed(&c, 0, 0, frame);
    }
    assert_eq!(b.refute(&observation(6, 80, Visibility::Occluded), 0), 0);
    assert_eq!(
        b.resolution().rgba[0],
        80,
        "a later dark overlay may share the real page icon's colour"
    );
}

#[test]
fn changing_masks_at_one_pose_do_not_make_a_motion_cue_immune_to_refutation() {
    use super::analysis::BlockAnalysis;
    let mut b = BlockAnalysis::default();
    let prior = observation(0, 255, Visibility::Unknown);
    b.set_baseline(&prior.rgba, &[true; PIXELS]);
    b.feed(&prior, 0, 0, 0);
    for frame in 1..9 {
        let mut c = observation(frame, 80, Visibility::Visible);
        c.pose_x = 0;
        c.pose_y = 0;
        c.frames[0].pose_x = 0;
        c.frames[0].pose_y = 0;
        c.exposures.push(Exposure {
            x: 0,
            y: 0,
            visibility: frame,
        });
        b.feed(&c, 0, 0, frame);
    }
    assert_eq!(
        b.refute(&observation(10, 80, Visibility::Occluded), 0),
        PIXELS
    );
    assert_eq!(b.resolution().rgba[0], 255);
}

#[test]
fn a_component_prefers_a_whole_observed_epoch_to_a_cleaner_but_clipped_epoch() {
    let a0 = observation(0, 40, Visibility::Visible);
    let mut b0 = observation(0, 50, Visibility::Visible);
    for i in PIXELS / 2..PIXELS {
        b0.visibility[i] = Visibility::Outside;
    }
    let mut a1 = observation(1, 60, Visibility::Visible);
    let mut b1 = observation(1, 70, Visibility::Visible);
    a1.visibility[0] = Visibility::Unknown;
    b1.visibility[0] = Visibility::Unknown;
    let choice = choose_component_epoch(&[vec![a0, a1], vec![b0, b1]], TemporalPolicy::Stable);
    assert_eq!(
        choice.frame,
        Some(1),
        "uncertain observed pixels must not be replaced by avoidable holes"
    );
    assert!(
        !choice.complete,
        "full presence is not proof that every pixel is clean"
    );
    assert!(choice.missing_blocks.is_empty());
}

#[test]
fn connected_background_breaks_an_unknown_tie_without_claiming_visibility() {
    let prior = observation(0, 150, Visibility::Unknown);
    let clean = observation(2, 250, Visibility::Background);
    let mut a = analysis::BlockAnalysis::default();
    a.set_baseline(&prior.rgba, &[true; PIXELS]);
    a.feed(&prior, 0, 0, 0);
    a.feed(&clean, 0, 0, 1);
    let out = a.resolution();
    assert_eq!(out.rgba, clean.rgba);
    assert!(out.reasons.iter().all(|r| *r != Reason::VisibleWitness));
    let visible = observation(3, 100, Visibility::Visible);
    a.feed(&visible, 0, 0, 2);
    assert_eq!(a.resolution().rgba, visible.rgba);
}

#[test]
fn independent_poses_protect_observed_ink_from_an_affiliation_only_background() {
    let prior = observation(0, 90, Visibility::Unknown);
    let mut a = analysis::BlockAnalysis::default();
    a.set_baseline(&prior.rgba, &[true; PIXELS]);
    for frame in 0..3 {
        let mut c = observation(frame, 90, Visibility::Unknown);
        c.quality = 80;
        c.exposures.push(Exposure {
            x: frame as i32 * 2,
            y: 0,
            visibility: 0,
        });
        a.feed(&c, 10, 0, frame);
    }
    // One high-quality background observation is affiliation evidence, not evidence that the
    // repeatedly observed glyph disappeared. This is the c.mov Star-button failure contract.
    a.feed(&observation(10, 245, Visibility::Background), 10, 0, 3);
    assert_eq!(a.resolution().rgba, prior.rgba);
}

#[test]
fn independent_ink_support_uses_the_recordings_noise_envelope() {
    let prior = observation(0, 90, Visibility::Unknown);
    let mut a = analysis::BlockAnalysis::default();
    a.set_baseline(&prior.rgba, &[true; PIXELS]);
    for frame in 0..4 {
        let mut c = observation(frame, 90 + frame as u8, Visibility::Unknown);
        c.quality = 80;
        c.exposures.push(Exposure {
            x: frame as i32 * 2,
            y: 0,
            visibility: 0,
        });
        a.feed(&c, 10, 0, frame);
    }
    a.feed(&observation(10, 245, Visibility::Background), 10, 0, 4);
    assert_eq!(a.resolution().rgba, prior.rgba);
}

#[test]
fn independently_supported_background_can_repair_a_repeated_unknown_occluder() {
    let prior = observation(0, 150, Visibility::Unknown);
    let mut a = analysis::BlockAnalysis::default();
    a.set_baseline(&prior.rgba, &[true; PIXELS]);
    for frame in 0..4 {
        let mut c = observation(frame, 150, Visibility::Unknown);
        c.exposures.push(Exposure {
            x: frame as i32 * 2,
            y: 0,
            visibility: 0,
        });
        a.feed(&c, 10, 0, frame);
    }
    for frame in 10..14 {
        let mut c = observation(frame, 245, Visibility::Background);
        c.exposures.push(Exposure {
            x: frame as i32 * 2,
            y: 0,
            visibility: 0,
        });
        a.feed(&c, 10, 0, frame);
    }
    assert_eq!(
        a.resolution().rgba,
        observation(10, 245, Visibility::Background).rgba
    );
}

#[test]
fn distinct_native_page_witnesses_are_not_erased_by_one_later_surface_overlap() {
    let prior = observation(0, 246, Visibility::Unknown);
    let mut a = analysis::BlockAnalysis::default();
    a.set_baseline(&prior.rgba, &[true; PIXELS]);
    a.feed(&prior, 0, 0, 0);
    for frame in 1..4 {
        let mut c = observation(frame, 60, Visibility::Visible);
        c.frames[0].pose_x = 0;
        c.frames[0].pose_y = frame as i32 * 4;
        c.pose_x = 0;
        c.pose_y = frame as i32 * 4;
        // All three physical positions fall inside one coarse exposure bucket.
        c.exposures.push(Exposure {
            x: 0,
            y: 0,
            visibility: 0,
        });
        a.feed(&c, 0, 0, frame);
    }
    a.refute(&observation(10, 60, Visibility::Occluded), 0);
    assert_eq!(
        a.resolution().rgba,
        observation(1, 60, Visibility::Visible).rgba
    );
}

#[test]
fn one_background_affiliation_cannot_override_a_later_native_occluder_match() {
    let prior = observation(0, 90, Visibility::Unknown);
    let mut a = analysis::BlockAnalysis::default();
    a.set_baseline(&prior.rgba, &[true; PIXELS]);
    a.feed(&prior, 0, 0, 0);
    a.feed(&observation(1, 246, Visibility::Background), 0, 0, 1);
    a.refute(&observation(2, 246, Visibility::Occluded), 0);
    assert_eq!(a.resolution().rgba, prior.rgba);
}

#[test]
fn a_coherent_occluder_can_refute_one_wrong_pixel_at_a_block_edge() {
    let mut prior = observation(0, 246, Visibility::Unknown);
    prior.rgba[..4].copy_from_slice(&[60, 60, 60, 255]);
    let mut a = analysis::BlockAnalysis::default();
    a.set_baseline(&prior.rgba, &[true; PIXELS]);
    a.feed(&prior, 0, 0, 0);
    a.feed(&observation(1, 246, Visibility::Background), 0, 0, 1);
    assert_eq!(a.refute(&observation(2, 246, Visibility::Occluded), 0), 1);
    assert_eq!(a.resolution().rgba, prior.rgba);
}

#[test]
fn matching_affiliated_detail_can_corroborate_an_existing_native_page_witness() {
    let prior = observation(0, 246, Visibility::Unknown);
    let mut a = analysis::BlockAnalysis::default();
    a.set_baseline(&prior.rgba, &[true; PIXELS]);
    a.feed(&prior, 0, 0, 0);
    for frame in 1..4 {
        let mut c = observation(
            frame,
            60,
            if frame == 3 {
                Visibility::Background
            } else {
                Visibility::Visible
            },
        );
        c.pose_x = 0;
        c.pose_y = frame as i32 * 4;
        c.frames[0].pose_x = 0;
        c.frames[0].pose_y = c.pose_y;
        c.exposures.push(Exposure {
            x: 0,
            y: 0,
            visibility: 0,
        });
        a.feed(&c, 0, 0, frame);
    }
    a.refute(&observation(10, 60, Visibility::Occluded), 0);
    assert_eq!(
        a.resolution().rgba,
        observation(1, 60, Visibility::Visible).rgba
    );
}

#[test]
fn corroboration_is_independent_of_archive_page_order() {
    let prior = observation(0, 246, Visibility::Unknown);
    let mut early = observation(3, 60, Visibility::Background);
    early.pose_x = 0;
    early.pose_y = 12;
    early.frames[0].pose_x = 0;
    early.frames[0].pose_y = 12;
    let mut a = analysis::BlockAnalysis::default();
    a.set_baseline(&prior.rgba, &[true; PIXELS]);
    a.feed(&prior, 0, 0, 0);
    a.feed(&early, 0, 0, 3);
    for frame in 1..3 {
        let mut c = observation(frame, 60, Visibility::Visible);
        c.frames[0].pose_x = 0;
        c.frames[0].pose_y = frame as i32 * 4;
        c.exposures.push(Exposure {
            x: 0,
            y: 0,
            visibility: 0,
        });
        a.feed(&c, 0, -1, frame);
    }
    a.corroborate(&early, 0);
    a.refute(&observation(10, 60, Visibility::Occluded), 0);
    assert_eq!(
        a.resolution().rgba,
        observation(1, 60, Visibility::Visible).rgba
    );
}

#[test]
fn refuted_affiliation_stays_uncertain_rather_than_becoming_an_observed_occlusion() {
    let prior = observation(0, 100, Visibility::Occluded);
    let candidate = observation(1, 200, Visibility::Background);
    let mut first = analysis::BlockAnalysis::default();
    first.set_baseline(&prior.rgba, &[true; PIXELS]);
    first.feed(&prior, 0, 0, 0);
    first.feed(&candidate, 0, 0, 1);
    first.refute(&observation(2, 200, Visibility::Occluded), 0);
    let mut replay = analysis::BlockAnalysis::default();
    replay.set_baseline(&prior.rgba, &[true; PIXELS]);
    replay.refutations = first.refutations.clone();
    replay.feed(&prior, 0, 0, 0);
    replay.feed(&candidate, 0, 0, 1);
    assert_eq!(replay.resolution().rgba, candidate.rgba);
    assert_eq!(replay.resolution().reasons[0], Reason::Ambiguous);
}

#[test]
fn repeating_a_background_hypothesis_does_not_make_it_immune_to_object_evidence() {
    let prior = observation(0, 60, Visibility::Unknown);
    let mut a = analysis::BlockAnalysis::default();
    a.set_baseline(&prior.rgba, &[true; PIXELS]);
    a.feed(&prior, 0, 0, 0);
    for frame in 1..5 {
        let mut c = observation(frame, 246, Visibility::Background);
        c.exposures.push(Exposure {
            x: frame as i32 * 2,
            y: 0,
            visibility: 0,
        });
        a.feed(&c, 0, 0, frame);
    }
    // Counter-evidence must itself cover independent positions; one same-colour overlap can
    // be a genuinely clean background that happens to match the object's material.
    for frame in 10..18 {
        let mut negative = observation(frame, 246, Visibility::Occluded);
        negative.exposures.push(Exposure {
            x: frame as i32 * 2,
            y: 0,
            visibility: 0,
        });
        a.corroborate(&negative, 0);
    }
    a.refute(&observation(18, 246, Visibility::Occluded), 0);
    assert_eq!(a.resolution().rgba, prior.rgba);
}

#[test]
fn a_more_supported_affiliated_alternative_is_not_replaced_by_a_weaker_baseline() {
    let mut prior = observation(0, 246, Visibility::Background);
    prior.quality = 60;
    prior.exposures.push(Exposure {
        x: 0,
        y: 0,
        visibility: 0,
    });
    let mut a = analysis::BlockAnalysis::default();
    a.set_baseline(&prior.rgba, &[true; PIXELS]);
    a.feed(&prior, 0, 0, 0);
    for frame in 1..3 {
        let mut c = observation(frame, 60, Visibility::Background);
        c.exposures.push(Exposure {
            x: frame as i32 * 2,
            y: 0,
            visibility: 0,
        });
        a.feed(&c, 0, 0, frame);
    }
    assert_eq!(
        a.resolution().rgba,
        observation(1, 60, Visibility::Background).rgba
    );
}

#[test]
fn repeated_page_background_is_not_rejected_for_a_few_same_coloured_occlusions() {
    let prior = observation(0, 22, Visibility::Unknown);
    let mut a = analysis::BlockAnalysis::default();
    a.set_baseline(&prior.rgba, &[true; PIXELS]);
    a.feed(&prior, 0, 0, 0);
    for frame in 1..7 {
        let mut c = observation(frame, 30, Visibility::Background);
        c.exposures.push(Exposure {
            x: frame as i32 * 2,
            y: 0,
            visibility: 0,
        });
        a.feed(&c, 0, 0, frame);
    }
    let mut negative = observation(10, 30, Visibility::Occluded);
    negative.exposures.push(Exposure {
        x: 20,
        y: 0,
        visibility: 0,
    });
    a.corroborate(&negative, 0);
    a.refute(&negative, 0);
    assert_eq!(
        a.resolution().rgba,
        observation(1, 30, Visibility::Background).rgba
    );
}

#[test]
fn equally_independent_object_evidence_can_refute_an_unverified_background() {
    let prior = observation(0, 60, Visibility::Unknown);
    let mut a = analysis::BlockAnalysis::default();
    a.set_baseline(&prior.rgba, &[true; PIXELS]);
    a.feed(&prior, 0, 0, 0);
    for frame in 1..4 {
        let mut c = observation(frame, 246, Visibility::Background);
        c.exposures.push(Exposure {
            x: frame as i32 * 2,
            y: 0,
            visibility: 0,
        });
        a.feed(&c, 0, 0, frame);
    }
    for frame in 10..13 {
        let mut c = observation(frame, 246, Visibility::Occluded);
        c.exposures.push(Exposure {
            x: frame as i32 * 2,
            y: 0,
            visibility: 0,
        });
        a.corroborate(&c, 0);
    }
    a.refute(&observation(13, 246, Visibility::Occluded), 0);
    assert_eq!(a.resolution().rgba, prior.rgba);
}
