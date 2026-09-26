use super::objects::*;
fn frame(pose: i32, cursor: Option<(i32, i32)>, widget: bool, index: u32) -> Vec<u8> {
    let mut rgba = vec![0; 160 * 144 * 4];
    for y in 0..144 {
        for x in 0..160 {
            let mut h = (x as u32).wrapping_mul(2246822519) ^ (y as i32 + pose) as u32;
            h = (h ^ (h >> 16)).wrapping_mul(3266489917);
            let v = 40 + (h % 130) as u8;
            rgba[(y * 160 + x) * 4..(y * 160 + x) * 4 + 4].copy_from_slice(&[v, v, v, 255]);
        }
    }
    if widget {
        for y in (80 - pose).max(0)..(112 - pose).min(144) {
            for x in 48..96 {
                let i = (y as usize * 160 + x) * 4;
                rgba[i..i + 4].copy_from_slice(&[10 + index as u8 * 30, 2, 250, 255]);
            }
        }
    }
    if let Some((cx, cy)) = cursor {
        for y in 0..18 {
            for x in 0..(y / 2 + 1).min(10) {
                let px = cx + x;
                let py = cy + y;
                if px >= 0 && py >= 0 && px < 160 && py < 144 {
                    let i = (py as usize * 160 + px as usize) * 4;
                    let v = if y % 3 == 0 { 255 } else { 0 };
                    rgba[i..i + 4].copy_from_slice(&[v, v, v, 255]);
                }
            }
        }
    }
    rgba
}
#[test]
fn clean_page_motion_never_creates_screen_objects() {
    let mut tracker = ObjectTracker::default();
    let labels = vec![1; 160 * 144];
    let mut visibility = vec![0; 160 * 144];
    for i in 1..5 {
        let a = frame((i - 1) * 6, None, false, i as u32 - 1);
        let b = frame(i * 6, None, false, i as u32);
        let view = |data| View {
            rgba: data,
            labels: &labels,
            width: 160,
            height: 144,
            code: 1,
            pose: (0, i * 6),
        };
        let mut prev = view(&a);
        prev.pose = (0, (i - 1) * 6);
        let result = tracker.observe(i as u32, view(&b), Some(prev), 0, &mut visibility);
        assert!(result.objects.is_empty());
        assert!(!visibility.contains(&2));
    }
}
#[test]
fn independently_moving_cursor_is_tracked_in_native_coordinates() {
    let mut tracker = ObjectTracker::default();
    let labels = vec![1; 160 * 144];
    let mut visibility = vec![0; 160 * 144];
    let mut found = false;
    for i in 1..6 {
        let a = frame(
            (i - 1) * 6,
            Some((30 + (i - 1) * 10, 60)),
            false,
            i as u32 - 1,
        );
        let b = frame(i * 6, Some((30 + i * 10, 60)), false, i as u32);
        let result = tracker.observe(
            i as u32,
            View {
                rgba: &b,
                labels: &labels,
                width: 160,
                height: 144,
                code: 1,
                pose: (0, i * 6),
            },
            Some(View {
                rgba: &a,
                labels: &labels,
                width: 160,
                height: 144,
                code: 1,
                pose: (0, (i - 1) * 6),
            }),
            0,
            &mut visibility,
        );
        found |= result
            .objects
            .iter()
            .any(|o| o.role == MotionRole::Local && !o.core.is_empty());
    }
    assert!(
        found,
        "a native local-motion witness must distinguish the cursor from the page translation"
    );
}
#[test]
fn changing_page_widget_remains_page_dynamic_not_an_overlay() {
    let mut tracker = ObjectTracker::default();
    let labels = vec![1; 160 * 144];
    let mut visibility = vec![0; 160 * 144];
    let mut found = false;
    for i in 1..6 {
        let a = frame((i - 1) * 6, None, true, i as u32 - 1);
        let b = frame(i * 6, None, true, i as u32);
        let result = tracker.observe(
            i as u32,
            View {
                rgba: &b,
                labels: &labels,
                width: 160,
                height: 144,
                code: 1,
                pose: (0, i * 6),
            },
            Some(View {
                rgba: &a,
                labels: &labels,
                width: 160,
                height: 144,
                code: 1,
                pose: (0, (i - 1) * 6),
            }),
            0,
            &mut visibility,
        );
        assert!(!result
            .objects
            .iter()
            .any(|o| matches!(o.role, MotionRole::Screen | MotionRole::Local)));
        found |= result
            .objects
            .iter()
            .any(|o| o.role == MotionRole::PageDynamic);
    }
    assert!(found);
}

#[test]
fn slow_page_motion_does_not_turn_a_stationary_panel_into_page_content() {
    let mut tracker = ObjectTracker::default();
    let labels = vec![1; 160 * 144];
    let mut visibility = vec![0; 160 * 144];
    let panel = |pose, index| {
        let mut data = frame(pose, None, false, index);
        for y in 48..96 {
            for x in 24..136 {
                let v = if y % 9 < 3 && x % 17 < 11 { 210 } else { 30 };
                let i = (y * 160 + x) * 4;
                data[i..i + 4].copy_from_slice(&[v, v, v, 255]);
            }
        }
        data
    };
    for i in 1..12 {
        let a = panel((i - 1) * 4, i as u32 - 1);
        let b = panel(i * 4, i as u32);
        let result = tracker.observe(
            i as u32,
            View {
                rgba: &b,
                labels: &labels,
                width: 160,
                height: 144,
                code: 1,
                pose: (0, i * 4),
            },
            Some(View {
                rgba: &a,
                labels: &labels,
                width: 160,
                height: 144,
                code: 1,
                pose: (0, (i - 1) * 4),
            }),
            0,
            &mut visibility,
        );
        assert!(
            !result
                .objects
                .iter()
                .any(|o| o.role == MotionRole::PageDynamic),
            "screen-stable bounds are not a page-anchoring witness at slow scroll speeds"
        );
        if i >= 2 {
            assert_eq!(
                visibility[70 * 160 + 80],
                2,
                "the confirmed panel's flat interior is also an occluding surface"
            );
        }
    }
}

#[test]
fn a_confirmed_overlay_can_unpin_and_become_page_anchored() {
    let mut tracker = ObjectTracker::default();
    let labels = vec![1; 160 * 144];
    let mut visibility = vec![0; 160 * 144];
    let image = |index: i32| {
        let mut data = frame(index * 6, None, false, index as u32);
        let top = if index < 5 { 54 } else { 54 - (index - 4) * 6 };
        for y in top..top + 24 {
            for x in 32..104 {
                let i = (y as usize * 160 + x) * 4;
                let v = if (x / 5 + y as usize - top as usize) % 3 == 0 {
                    230
                } else {
                    20
                };
                data[i..i + 4].copy_from_slice(&[v, v, v, 255]);
            }
        }
        data
    };
    let mut seen_screen = false;
    let mut seen_page = false;
    let mut roles = Vec::new();
    for i in 1..10 {
        let a = image(i - 1);
        let b = image(i);
        let update = tracker.observe(
            i as u32,
            View {
                rgba: &b,
                labels: &labels,
                width: 160,
                height: 144,
                code: 1,
                pose: (0, i * 6),
            },
            Some(View {
                rgba: &a,
                labels: &labels,
                width: 160,
                height: 144,
                code: 1,
                pose: (0, (i - 1) * 6),
            }),
            0,
            &mut visibility,
        );
        roles.push((i, update.states.clone()));
        seen_screen |= update.states.iter().any(|s| s.role == MotionRole::Screen);
        if i >= 7 {
            seen_page |= update
                .states
                .iter()
                .any(|s| s.role == MotionRole::PageDynamic);
        }
    }
    assert!(
        seen_screen && seen_page,
        "temporal motion roles must follow a real unpin transition: {roles:?}"
    );
}

#[test]
fn lossless_low_contrast_header_text_still_supplies_screen_motion_evidence() {
    let mut tracker = ObjectTracker::default();
    let labels = vec![1; 160 * 144];
    let mut visibility = vec![0; 160 * 144];
    let header = |pose, index| {
        let mut rgba = frame(pose, None, false, index);
        for y in 0..32 {
            for x in 0..160 {
                let v = if y > 8 && y < 22 && x % 13 < 7 {
                    250
                } else {
                    246
                };
                rgba[(y * 160 + x) * 4..(y * 160 + x) * 4 + 4].copy_from_slice(&[v, v, v, 255]);
            }
        }
        rgba
    };
    let mut found = false;
    for i in 1..6 {
        let a = header((i - 1) * 4, i as u32 - 1);
        let b = header(i * 4, i as u32);
        let update = tracker.observe(
            i as u32,
            View {
                rgba: &b,
                labels: &labels,
                width: 160,
                height: 144,
                code: 1,
                pose: (0, i * 4),
            },
            Some(View {
                rgba: &a,
                labels: &labels,
                width: 160,
                height: 144,
                code: 1,
                pose: (0, (i - 1) * 4),
            }),
            0,
            &mut visibility,
        );
        found |= update
            .objects
            .iter()
            .any(|o| o.role == MotionRole::Screen && !o.core.is_empty());
    }
    assert!(
        found,
        "native exact evidence must not inherit a fixed 12-level texture floor"
    );
}

#[test]
fn internal_motion_in_a_page_anchored_panel_keeps_an_observed_page_version() {
    let mut tracker = ObjectTracker::default();
    let labels = vec![1; 160 * 144];
    let mut visibility = vec![0; 160 * 144];
    let image = |index: i32| {
        let pose = index * 6;
        let mut rgba = frame(pose, None, false, index as u32);
        for y in 80 - pose..128 - pose {
            for x in 24..144 {
                let i = (y as usize * 160 + x) * 4;
                rgba[i..i + 4].copy_from_slice(&[30, 50, 70, 255]);
            }
        }
        for y in 92 - pose..116 - pose {
            for x in 40 + index * 5..64 + index * 5 {
                let i = (y as usize * 160 + x as usize) * 4;
                rgba[i..i + 4].copy_from_slice(&[220, 170, 90, 255]);
            }
        }
        rgba
    };
    let mut seen = false;
    for i in 1..10 {
        let a = image(i - 1);
        let b = image(i);
        let update = tracker.observe(
            i as u32,
            View {
                rgba: &b,
                labels: &labels,
                width: 160,
                height: 144,
                code: 1,
                pose: (0, i * 6),
            },
            Some(View {
                rgba: &a,
                labels: &labels,
                width: 160,
                height: 144,
                code: 1,
                pose: (0, (i - 1) * 6),
            }),
            0,
            &mut visibility,
        );
        seen |= update
            .states
            .iter()
            .any(|s| s.role == MotionRole::PageDynamic);
    }
    assert!(
        seen,
        "moving pixels inside a page-following container are page dynamics"
    );
}

#[test]
fn a_flat_screen_stripe_cannot_borrow_page_texture_from_its_neighbour() {
    let mut tracker = ObjectTracker::default();
    let labels = vec![1; 160 * 144];
    let mut a = frame(0, None, false, 0);
    let mut b = frame(6, None, false, 1);
    for image in [&mut a, &mut b] {
        for y in 0..144 {
            image[(y * 160 + 159) * 4..(y * 160 + 160) * 4].copy_from_slice(&[255; 4]);
        }
    }
    let view = |rgba, pose| View {
        rgba,
        labels: &labels,
        width: 160,
        height: 144,
        code: 1,
        pose: (0, pose),
    };
    let mut visibility = vec![0; 160 * 144];
    tracker.observe(1, view(&b, 6), Some(view(&a, 0)), 0, &mut visibility);
    assert_ne!(visibility[50 * 160 + 159], 1);
    assert!(
        visibility.contains(&1),
        "the textured page must still supply clean motion evidence"
    );
}

#[test]
fn a_screen_stripe_keeps_its_identity_when_page_text_changes_two_translucent_samples() {
    let mut tracker = ObjectTracker::default();
    let labels = vec![1; 160 * 144];
    let mut a = frame(0, None, false, 0);
    let mut b = frame(6, None, false, 1);
    for image in [&mut a, &mut b] {
        for y in 0..144 {
            image[(y * 160 + 159) * 4..(y * 160 + 160) * 4].copy_from_slice(&[180, 180, 180, 255]);
        }
    }
    // Underlying letters show through two of the five native vertical witnesses.
    for y in [34, 66] {
        a[(y * 160 + 159) * 4..(y * 160 + 160) * 4].copy_from_slice(&[230, 230, 230, 255]);
    }
    let view = |rgba, pose| View {
        rgba,
        labels: &labels,
        width: 160,
        height: 144,
        code: 1,
        pose: (0, pose),
    };
    let mut visibility = vec![0; 160 * 144];
    tracker.observe(1, view(&b, 6), Some(view(&a, 0)), 0, &mut visibility);
    assert_ne!(visibility[50 * 160 + 159], 1);
    assert!(visibility.contains(&1));
}

#[test]
fn inset_translucent_thumb_endcaps_do_not_become_page_motion_witnesses() {
    for x in [142, 159] {
        let mut tracker = ObjectTracker::default();
        let labels = vec![1; 160 * 144];
        let mut a = frame(0, None, false, 0);
        let mut b = frame(6, None, false, 1);
        for image in [&mut a, &mut b] {
            for y in 0..144 {
                image[(y * 160 + x) * 4..(y * 160 + x) * 4 + 4]
                    .copy_from_slice(&[180, 180, 180, 255]);
            }
        }
        for y in [50, 58, 66] {
            a[(y * 160 + x) * 4..(y * 160 + x) * 4 + 4].copy_from_slice(&[230, 230, 230, 255]);
        }
        b[(58 * 160 + x) * 4..(58 * 160 + x) * 4 + 4].copy_from_slice(&[30, 30, 30, 255]);
        b[(66 * 160 + x) * 4..(66 * 160 + x) * 4 + 4].copy_from_slice(&[30, 30, 30, 255]);
        let view = |rgba, pose| View {
            rgba,
            labels: &labels,
            width: 160,
            height: 144,
            code: 1,
            pose: (0, pose),
        };
        let mut mask = vec![0; 160 * 144];
        tracker.observe(1, view(&b, 6), Some(view(&a, 0)), 0, &mut mask);
        assert_ne!(
            mask[50 * 160 + x],
            1,
            "the inset/endcap still has a coherent screen-stripe hypothesis"
        );
    }
}

#[test]
fn an_edge_surface_keeps_its_motion_uncertainty_across_text_showing_through_it() {
    let mut tracker = ObjectTracker::default();
    let labels = vec![1; 160 * 144];
    let mut a = frame(0, None, false, 0);
    let mut b = frame(48, None, false, 1);
    for image in [&mut a, &mut b] {
        for y in 0..144 {
            image[(y * 160 + 159) * 4..(y * 160 + 160) * 4].copy_from_slice(&[180, 180, 180, 255]);
        }
    }
    for y in 42..83 {
        a[(y * 160 + 159) * 4..(y * 160 + 160) * 4].copy_from_slice(&[230, 230, 230, 255]);
    }
    let view = |rgba, pose| View {
        rgba,
        labels: &labels,
        width: 160,
        height: 144,
        code: 1,
        pose: (0, pose),
    };
    let mut mask = vec![0; 160 * 144];
    tracker.observe(1, view(&b, 48), Some(view(&a, 0)), 0, &mut mask);
    assert_ne!(
        mask[50 * 160 + 159],
        1,
        "a visible page glyph underneath cannot turn the contiguous thumb into a clean page source"
    );
}
