use super::opacity::{PixelModel, Sample};
fn sample(i: i32, b: u8, alpha: f64) -> Sample {
    Sample {
        observed_frame: 0,
        background_frame: 0,
        world_x: 0,
        world_y: i * 32,
        background: [b, b, b],
        observed: [((b as f64) * (1. - alpha)).round() as u8; 3],
    }
}
#[test]
fn a_translucent_field_requires_distinct_backgrounds_and_never_produces_output_pixels() {
    let mut model = PixelModel::default();
    for _ in 0..20 {
        model.observe(sample(0, 200, 0.25), 0);
    }
    assert!(model.fit(0).is_none(), "a long pause is only one witness");
    for (i, b) in [40, 80, 120, 200, 240].into_iter().enumerate() {
        model.observe(sample(i as i32 + 1, b, 0.25), 0);
    }
    let fit = model
        .fit(0)
        .expect("one stable alpha explains independent background changes");
    assert!((fit.transmission - 0.75).abs() < 0.01);
    assert!(fit.matches([180, 180, 180], [240, 240, 240], 0));
    assert!(!fit.matches([240, 240, 240], [240, 240, 240], 0));
}
#[test]
fn identical_page_pixels_and_ambiguous_opacity_changes_do_not_become_occlusion_models() {
    let mut page = PixelModel::default();
    let mut changed = PixelModel::default();
    for (i, b) in [40, 80, 120, 200, 240].into_iter().enumerate() {
        page.observe(sample(i as i32, b, 0.), 0);
        changed.observe(sample(i as i32, b, 0.25), 0);
    }
    assert!(page.fit(0).is_none());
    changed.observe(sample(0, 40, 0.75), 0);
    assert!(
        changed.fit(0).is_none(),
        "same-footprint appearance changes cannot be averaged into a fictitious alpha"
    );
}
#[test]
fn faint_native_shadows_are_tested_at_native_precision() {
    let mut model = PixelModel::default();
    for (i, b) in [30, 70, 120, 170, 220, 250].into_iter().enumerate() {
        model.observe(sample(i as i32, b, 0.0325), 0);
    }
    assert!(model.fit(0).is_some());
}

#[test]
fn an_unknown_background_does_not_allow_colours_the_overlay_cannot_produce() {
    let mut opaque = PixelModel::default();
    for (i, b) in [30, 80, 160, 230].into_iter().enumerate() {
        opaque.observe(
            Sample {
                observed_frame: 0,
                background_frame: 0,
                world_x: 0,
                world_y: i as i32 * 32,
                background: [b; 3],
                observed: [246; 3],
            },
            0,
        );
    }
    let fit = opaque.fit(0).unwrap();
    assert!(fit.explains([246; 3], 0));
    assert!(!fit.explains([50; 3], 0));
    let mut shadow = PixelModel::default();
    for (i, b) in [30, 80, 160, 230].into_iter().enumerate() {
        shadow.observe(sample(i as i32, b, 0.5), 0);
    }
    assert!(!shadow.fit(0).unwrap().explains([240; 3], 0));
}

#[test]
fn a_nonconvex_colour_transform_is_not_an_alpha_occluder() {
    let mut model = PixelModel::default();
    for (i, b) in [10, 30, 60, 100].into_iter().enumerate() {
        model.observe(
            Sample {
                observed_frame: 0,
                background_frame: 0,
                world_x: 0,
                world_y: i as i32 * 32,
                background: [b; 3],
                observed: [(b as f64 * 0.8 + 80.).round() as u8; 3],
            },
            0,
        );
    }
    assert!(
        model.fit(0).is_none(),
        "the implied foreground would exceed the 8-bit colour range"
    );
}

#[test]
fn later_blank_observations_do_not_evict_the_only_contrasting_witnesses() {
    let mut model = PixelModel::default();
    for (i, b) in [246, 246, 57, 57, 246].into_iter().enumerate() {
        model.observe(
            Sample {
                world_y: i as i32 * 4,
                background: [b; 3],
                observed: [246; 3],
                ..Sample::default()
            },
            0,
        );
    }
    assert!(model.fit(0).is_some());
    for i in 10..100 {
        model.observe(
            Sample {
                world_y: i * 4,
                background: [246; 3],
                observed: [246; 3],
                ..Sample::default()
            },
            0,
        );
    }
    assert!(model.fit(0).is_some());
    model.observe(
        Sample {
            world_y: 1000,
            background: [40; 3],
            observed: [40; 3],
            ..Sample::default()
        },
        0,
    );
    assert!(
        model.fit(0).is_none(),
        "later contradictory visibility must still invalidate a frozen witness set"
    );
}
#[test]
fn earlier_clear_counterevidence_cannot_expire_into_a_fictitious_constant_overlay() {
    let mut model = PixelModel::default();
    for (i, b) in [20, 100, 240].into_iter().enumerate() {
        model.observe(sample(i as i32, b, 0.), 0);
    }
    for i in 10..60 {
        model.observe(sample(i, 100 + (i % 8) as u8 * 10, 0.5), 0);
    }
    assert!(model.fit(0).is_none());
}

#[test]
fn repeated_or_frozen_evidence_does_not_dirty_a_persisted_model() {
    let mut model = PixelModel::default();
    assert!(model.observe(sample(0, 40, 0.25), 0));
    assert!(!model.observe(sample(0, 40, 0.25), 0));
    for (i, b) in [80, 120, 200].into_iter().enumerate() {
        model.observe(sample(i as i32 + 1, b, 0.25), 0);
    }
    assert!(model.fit(0).is_some());
    assert!(!model.observe(sample(99, 200, 0.25), 0));
    assert!(model.observe(sample(100, 200, 0.75), 0));
    assert!(model.fit(0).is_none());
    assert!(!model.observe(sample(101, 200, 0.25), 0));
}
