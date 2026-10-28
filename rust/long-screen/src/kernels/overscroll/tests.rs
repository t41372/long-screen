use super::*;

/// A trajectory along one axis, one frame per value; the other axis stays at 0.
fn along_y(ys: &[i64]) -> Vec<Pose> {
    ys.iter()
        .enumerate()
        .map(|(i, &y)| Pose {
            frame: i as u32,
            x: 0,
            y,
        })
        .collect()
}

fn along_x(xs: &[i64]) -> Vec<Pose> {
    xs.iter()
        .enumerate()
        .map(|(i, &x)| Pose {
            frame: i as u32,
            x,
            y: 0,
        })
        .collect()
}

fn rest(value: i64, frames: usize) -> Vec<i64> {
    vec![value; frames]
}

fn cat(parts: &[&[i64]]) -> Vec<i64> {
    parts.iter().flat_map(|p| p.iter().copied()).collect()
}

const W: i64 = 640;
const H: i64 = 400;

#[test]
fn a_fling_into_the_bottom_springs_back_to_the_edge() {
    let ys = cat(&[
        &rest(0, 4),
        &[
            60, 150, 270, 420, 590, 760, 920, 1060, 1180, 1280, 1350, 1400,
        ],
        &[
            1430, 1445, 1448, 1444, 1437, 1429, 1422, 1416, 1411, 1407, 1404, 1402, 1401,
        ],
        &rest(1400, 6),
    ]);
    let edges = page_edges(&along_y(&ys), W, H);
    assert_eq!(edges.bottom, Some(1400));
    assert_eq!(
        edges.top, None,
        "the page only rested at the top, it never ran past it"
    );
    assert_eq!(edges.overshoot(0, 1448), [0, 48, 0, 0]);
    assert_eq!(edges.overshoot(0, 1400), [0; 4]);
    assert_eq!(edges.overshoot(0, 700), [0; 4]);
}

#[test]
fn a_drag_held_past_the_top_is_not_the_edge() {
    let ys = cat(&[
        &[600, 450, 300, 170, 70, 10, 0, -12, -22, -30, -36],
        &rest(-40, 6),
        &[-27, -17, -10, -6, -3, -1],
        &rest(0, 8),
        &[40, 120, 260],
    ]);
    let edges = page_edges(&along_y(&ys), W, H);
    assert_eq!(
        edges.top,
        Some(0),
        "the held position is where the finger was, not where the page ends"
    );
    assert_eq!(edges.overshoot(0, -40), [40, 0, 0, 0]);
}

#[test]
fn leaving_before_the_spring_settles_keeps_the_edge_where_the_page_rested() {
    let xs = cat(&[
        &rest(0, 20),
        &[
            40, 100, 160, 200, 140, 80, 30, 0, -14, -22, -26, -24, -19, -14, -10, -7,
        ],
        &rest(-5, 2),
        &[8, 40, 90, 140],
    ]);
    let edges = page_edges(&along_x(&xs), W, H);
    assert_eq!(edges.left, Some(0));
    assert_eq!(edges.overshoot(-26, 0), [0, 0, 26, 0]);
    assert_eq!(edges.overshoot(-5, 0), [0, 0, 5, 0]);
}

#[test]
fn an_ordinary_reversal_is_not_an_edge() {
    // Even steps down, back up, down again: no spring anywhere.
    let mut ys: Vec<i64> = (0..=30).map(|i| i * 30).collect();
    ys.extend((1..=7).map(|i| 900 - i * 30));
    ys.extend((1..=40).map(|i| 690 + i * 30));
    assert_eq!(page_edges(&along_y(&ys), W, H), Edges::default());
}

#[test]
fn a_reversal_that_eases_to_a_stop_inside_the_page_is_not_an_edge() {
    // Up past 700, back down easing into 700 like a spring, a rest, then on down the page. The page was seen far
    // above 700 earlier, so 700 is not where it ends. (At the far end of what the recording saw, the motion alone
    // cannot tell such a reversal from a spring; there `background_lines` keeps the page content.)
    let ys = cat(&[
        &rest(300, 10),
        &[400, 600, 800, 1000, 900, 800, 720, 680, 660, 652],
        &[660, 672, 684, 692, 697, 699],
        &rest(700, 10),
        &[760, 900, 1100, 1300, 1500, 1700, 1900],
    ]);
    let edges = page_edges(&along_y(&ys), W, H);
    assert_eq!(edges.top, None);
}

#[test]
fn the_edge_is_where_the_page_rests_most() {
    // macOS stops the spring a couple of pixels short and snaps to the edge later.
    let ys = cat(&[
        &rest(0, 30),
        &[
            40, 20, 6, -30, -60, -75, -70, -55, -40, -28, -18, -11, -7, -4, -3,
        ],
        &rest(-2, 5),
        &rest(0, 20),
        &[30, 90],
    ]);
    let edges = page_edges(&along_y(&ys), W, H);
    assert_eq!(edges.top, Some(0));
}

#[test]
fn a_pause_on_the_way_back_is_not_the_edge() {
    let ys = cat(&[
        &[900, 1000, 1100, 1180, 1240, 1290, 1320],
        &[1330, 1336, 1340, 1337],
        &rest(1336, 5),
        &[1333, 1330, 1328, 1326, 1324, 1323, 1322, 1321],
        &rest(1320, 20),
    ]);
    let edges = page_edges(&along_y(&ys), W, H);
    assert_eq!(edges.bottom, Some(1320));
}

#[test]
fn a_single_stray_frame_past_the_edge_is_not_a_bounce() {
    let ys = cat(&[&rest(0, 20), &[-5], &rest(0, 20)]);
    assert_eq!(page_edges(&along_y(&ys), W, H).top, None);
}

#[test]
fn an_excursion_never_returned_from_marks_nothing() {
    let ys = cat(&[&rest(0, 20), &[-6, -14, -22, -28], &rest(-30, 20)]);
    assert_eq!(page_edges(&along_y(&ys), W, H).top, None);
}

#[test]
fn a_bounce_deeper_than_a_spring_can_go_is_not_one() {
    // 300 px past a 400-px region: no rubber band goes that far.
    let ys = cat(&[
        &rest(0, 10),
        &[-150, -300, -280, -200, -120, -60, -30, -14, -7, -4, -2, -1],
        &rest(0, 10),
    ]);
    assert_eq!(page_edges(&along_y(&ys), W, H).top, None);
}

#[test]
fn frames_far_past_the_edge_withdraw_it() {
    // A spring that settles at 0, then the page scrolls well beyond it (the page above 0 loaded later).
    let ys = cat(&[
        &rest(0, 10),
        &[-20, -32, -28, -20, -13, -8, -5, -3, -1],
        &rest(0, 10),
        &[-100, -300, -500, -700],
    ]);
    assert_eq!(page_edges(&along_y(&ys), W, H).top, None);
}

#[test]
fn frames_on_another_fragment_do_not_chain() {
    // The same values split by a gap in the frames are two runs; a run cannot enter the excursion of another.
    let mut track = along_y(&cat(&[
        &rest(0, 10),
        &[-20, -32, -28, -20, -13, -8, -5, -3, -1],
        &rest(0, 10),
    ]));
    let later = along_y(&[-40, -38, -30, -22, -15, -10, -6, -3, -1, 0, 0, 0]);
    track.extend(later.into_iter().map(|p| Pose {
        frame: p.frame + 100,
        ..p
    }));
    let edges = page_edges(&track, W, H);
    assert_eq!(edges.top, Some(0));
    assert_eq!(edges.overshoot(0, -40), [40, 0, 0, 0]);
}
#[test]
fn an_even_pan_back_from_far_out_is_not_a_spring() {
    // The `fixture` scenario's path on its 320-px region: out 100 px in even steps, back in even 3–4-px steps to a
    // rest, and later 120 px out again. No rubber band runs a third of the viewport past the edge.
    let mut xs = rest(0, 11);
    xs.extend((1..=8).map(|i| i * 25 / 2));
    xs.extend([
        92, 84, 76, 68, 60, 52, 44, 36, 28, 20, 17, 13, 10, 7, 3, 0, 0, 0, 1, 0, 0, 0, 0, 120,
    ]);
    assert_eq!(page_edges(&along_x(&xs), 320, 208), Edges::default());
}

/// A frame filled with `page`, then a `gap`-coloured band of `lines` lines on `side` of a `w × h` region at (0, 0).
fn frame(w: usize, h: usize, side: Side, lines: usize, gap: [u8; 3]) -> Vec<u8> {
    let mut rgba = vec![0u8; w * h * 4];
    // The page moves with the band: page pixel (px, py) is at screen (px + dx, py + dy).
    let (dx, dy) = match side {
        Side::Top => (0, lines as i64),
        Side::Bottom => (0, -(lines as i64)),
        Side::Left => (lines as i64, 0),
        Side::Right => (-(lines as i64), 0),
    };
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            // Page content: a fine pattern, so a page line is never one colour.
            let (px, py) = (x as i64 - dx + 1000, y as i64 - dy + 1000);
            let v = ((px * 7 + py * 13) % 5 * 40) as u8;
            let beyond = match side {
                Side::Top => y < lines,
                Side::Bottom => y >= h - lines,
                Side::Left => x < lines,
                Side::Right => x >= w - lines,
            };
            let c = if beyond { gap } else { [v, 255 - v, 128] };
            rgba[i..i + 3].copy_from_slice(&c);
            rgba[i + 3] = 255;
        }
    }
    rgba
}

fn paint(rgba: &mut [u8], w: usize, x0: usize, y0: usize, x1: usize, y1: usize, c: [u8; 3]) {
    for y in y0..y1 {
        for x in x0..x1 {
            rgba[(y * w + x) * 4..(y * w + x) * 4 + 3].copy_from_slice(&c);
        }
    }
}

fn lines(rgba: &[u8], w: usize, h: usize) -> Lines<'_> {
    Lines {
        rgba,
        width: w,
        height: h,
        labels: None,
        region: (0, 0, w as i64, h as i64),
        neighbours: [None, None],
        noise: 0.0,
    }
}

const GAP: [u8; 3] = [226, 229, 234];

#[test]
fn counts_the_background_lines_on_every_side() {
    for side in SIDES {
        let rgba = frame(120, 90, side, 17, GAP);
        assert_eq!(
            background_lines(&lines(&rgba, 120, 90), side, 40),
            17,
            "{side:?}"
        );
        assert_eq!(
            background_lines(&lines(&rgba, 120, 90), side, 10),
            10,
            "{side:?}: at most max"
        );
    }
}

#[test]
fn a_band_may_change_colour_from_line_to_line() {
    // 12 grey lines then 5 white ones (Chrome's overscroll band over a white page margin).
    let mut rgba = frame(120, 90, Side::Top, 17, GAP);
    paint(&mut rgba, 120, 0, 12, 120, 17, [255, 255, 255]);
    assert_eq!(background_lines(&lines(&rgba, 120, 90), Side::Top, 40), 17);
}

#[test]
fn page_content_stops_the_count() {
    let mut rgba = frame(120, 90, Side::Top, 17, GAP);
    // A word of text inside the band.
    paint(&mut rgba, 120, 30, 9, 50, 11, [40, 40, 40]);
    assert_eq!(background_lines(&lines(&rgba, 120, 90), Side::Top, 40), 9);
}

#[test]
fn a_line_split_between_two_colours_is_not_background() {
    let mut rgba = frame(120, 90, Side::Left, 20, GAP);
    paint(&mut rgba, 120, 0, 0, 20, 45, [10, 10, 10]);
    assert_eq!(background_lines(&lines(&rgba, 120, 90), Side::Left, 40), 0);
}

#[test]
fn a_scrollbar_along_the_edge_is_counted_with_the_band() {
    // A thumb pinned along the viewport's right edge, over the band, in this frame and in a neighbour whose page
    // moved (its band is 4 columns narrower).
    let mut rgba = frame(120, 90, Side::Right, 30, GAP);
    paint(&mut rgba, 120, 112, 20, 118, 60, [120, 120, 120]);
    let mut moved = frame(120, 90, Side::Right, 26, GAP);
    paint(&mut moved, 120, 112, 20, 118, 60, [120, 120, 120]);
    let mut input = lines(&rgba, 120, 90);
    assert_eq!(
        background_lines(&input, Side::Right, 40),
        2,
        "without a neighbour the thumb is content"
    );
    input.neighbours = [Some(&moved), None];
    assert_eq!(background_lines(&input, Side::Right, 40), 30);
}

#[test]
fn a_pinned_panel_over_the_band_stops_the_count() {
    // A sign-in button 40 lines tall pinned over a 60-line band is not told apart from page content: what sits in
    // the moving layer is left to the region learning and the consistency mask.
    let mut rgba = frame(120, 120, Side::Top, 60, GAP);
    paint(&mut rgba, 120, 70, 4, 110, 44, [250, 250, 250]);
    let mut moved = frame(120, 120, Side::Top, 56, GAP);
    paint(&mut moved, 120, 70, 4, 110, 44, [250, 250, 250]);
    let mut input = lines(&rgba, 120, 120);
    input.neighbours = [None, Some(&moved)];
    assert_eq!(background_lines(&input, Side::Top, 80), 4);
}

#[test]
fn a_band_that_ends_in_something_pinned_is_counted_up_to_it() {
    let mut rgba = frame(120, 90, Side::Bottom, 20, GAP);
    paint(&mut rgba, 120, 10, 70, 60, 80, [250, 250, 250]);
    let mut moved = frame(120, 90, Side::Bottom, 16, GAP);
    paint(&mut moved, 120, 10, 70, 60, 80, [250, 250, 250]);
    let mut input = lines(&rgba, 120, 90);
    input.neighbours = [Some(&moved), None];
    assert_eq!(background_lines(&input, Side::Bottom, 20), 10);
}

#[test]
fn page_content_in_the_band_is_not_pinned() {
    // A word inside the band moves with the page: the neighbour shows it 4 lines higher.
    let mut rgba = frame(120, 90, Side::Top, 30, GAP);
    paint(&mut rgba, 120, 30, 9, 50, 11, [40, 40, 40]);
    let mut moved = frame(120, 90, Side::Top, 26, GAP);
    paint(&mut moved, 120, 30, 5, 50, 7, [40, 40, 40]);
    let mut input = lines(&rgba, 120, 90);
    input.neighbours = [Some(&moved), None];
    assert_eq!(background_lines(&input, Side::Top, 40), 9);
}

#[test]
fn a_few_stray_pixels_do_not_stop_the_count() {
    let mut rgba = frame(200, 90, Side::Bottom, 12, GAP);
    // A 3-pixel pointer tip in each band line: under 5 % of the line.
    paint(&mut rgba, 200, 100, 78, 103, 90, [0, 0, 0]);
    assert_eq!(
        background_lines(&lines(&rgba, 200, 90), Side::Bottom, 40),
        12
    );
}

#[test]
fn decode_noise_is_tolerated_up_to_the_source_noise() {
    let mut rgba = frame(120, 90, Side::Right, 15, GAP);
    for y in 0..90 {
        for x in 105..120 {
            let i = (y * 120 + x) * 4;
            rgba[i] = (GAP[0] as i32 + if (x + y) % 2 == 0 { 6 } else { -6 }) as u8;
        }
    }
    let mut input = lines(&rgba, 120, 90);
    assert_eq!(
        background_lines(&input, Side::Right, 40),
        0,
        "exact for a lossless source"
    );
    input.noise = 10.0;
    assert_eq!(background_lines(&input, Side::Right, 40), 15);
}

#[test]
fn only_the_region_s_own_pixels_count() {
    let mut rgba = frame(120, 90, Side::Top, 20, GAP);
    // Another region's pixels (a fixed sidebar) cross the band; the label plane gives them away.
    paint(&mut rgba, 120, 0, 0, 30, 90, [20, 90, 20]);
    let mut labels = vec![1u8; 120 * 90];
    for y in 0..90 {
        for x in 0..30 {
            labels[y * 120 + x] = 2;
        }
    }
    let mut input = lines(&rgba, 120, 90);
    assert_eq!(background_lines(&input, Side::Top, 40), 0);
    input.labels = Some((&labels, 1));
    assert_eq!(background_lines(&input, Side::Top, 40), 20);
}

#[test]
fn the_count_stays_inside_the_region() {
    let rgba = frame(120, 90, Side::Top, 90, GAP);
    let mut input = lines(&rgba, 120, 90);
    input.region = (10, 20, 100, 30);
    assert_eq!(background_lines(&input, Side::Top, 200), 30);
}

#[test]
fn a_curved_pan_turning_at_the_recorded_extreme_is_not_a_spring() {
    // static/demo/sample.mp4's first 145 placements (960×600 region, page 2400×1500): a pan along the top bowed
    // 30 and 20 px down, then down the right side bowed 36 and 24 px in. Along y the second pan runs 20 → 0 → 20
    // and holds 20 for seven frames, along x the right-side one 1404 → 1440 → 1416 and holds 1416 for five, both
    // easing in like a spring; read as springs they put the top edge at 20 and the right one at 1416, and the
    // whiteboard's margin, one colour like an overscroll band, came out transparent there. The page never once
    // came to a stop at 20 or at 1416 (the other axis kept moving), but it stood still past both: 9 frames at
    // y = 0 where the recording starts and 13 at x = 1440 in the bottom-right corner.
    let xs = [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 6, 10, 16, 22, 30, 40, 50, 62, 76, 90, 106, 122, 140, 160,
        180, 202, 224, 250, 274, 302, 330, 358, 390, 422, 454, 488, 524, 560, 598, 638, 678, 720,
        762, 802, 842, 880, 916, 952, 986, 1018, 1050, 1082, 1110, 1138, 1166, 1190, 1216, 1238,
        1260, 1280, 1300, 1318, 1334, 1350, 1364, 1378, 1390, 1400, 1410, 1418, 1424, 1430, 1434,
        1438, 1440, 1440, 1436, 1432, 1428, 1424, 1420, 1418, 1414, 1412, 1410, 1408, 1406, 1404,
        1404, 1404, 1404, 1404, 1406, 1408, 1410, 1412, 1414, 1418, 1420, 1424, 1428, 1432, 1436,
        1440, 1438, 1434, 1432, 1430, 1428, 1426, 1424, 1422, 1420, 1418, 1418, 1416, 1416, 1416,
        1416, 1416, 1418, 1418, 1420, 1422, 1424, 1426, 1428, 1430, 1432, 1434, 1438, 1440, 1440,
        1440, 1440, 1440, 1440, 1440, 1440, 1440, 1440, 1440, 1440, 1440,
    ];
    let ys = [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 6, 8, 10, 14, 16, 18, 20, 22, 24, 26, 26, 28, 28, 30, 30, 30,
        30, 30, 28, 28, 26, 26, 24, 22, 20, 18, 16, 14, 10, 8, 6, 2, 0, 2, 4, 6, 8, 8, 10, 12, 14,
        14, 16, 18, 18, 18, 20, 20, 20, 20, 20, 20, 20, 18, 18, 18, 16, 14, 14, 12, 10, 8, 8, 6, 4,
        2, 0, 2, 6, 12, 22, 34, 48, 64, 82, 102, 124, 148, 172, 196, 220, 244, 268, 292, 316, 338,
        358, 376, 392, 406, 418, 428, 434, 438, 440, 442, 446, 452, 462, 476, 490, 508, 526, 548,
        570, 594, 618, 644, 670, 696, 722, 746, 770, 792, 814, 832, 850, 864, 878, 888, 894, 898,
        900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900,
    ];
    assert_eq!(xs.len(), ys.len());
    let track: Vec<Pose> = xs
        .iter()
        .zip(ys.iter())
        .enumerate()
        .map(|(i, (&x, &y))| Pose {
            frame: i as u32,
            x,
            y,
        })
        .collect();
    let edges = page_edges(&track, 960, 600);
    assert_eq!(
        edges.top, None,
        "the page top is where the recording started"
    );
    assert_eq!(
        edges.right, None,
        "the pan never ran past the page's right side"
    );
}

/// Poses of one pub recording, `(frame, x, y)`, as the render pass reads them.
fn poses(list: &[(u32, i64, i64)]) -> Vec<Pose> {
    list.iter()
        .map(|&(frame, x, y)| Pose { frame, x, y })
        .collect()
}

#[test]
fn a_bounce_while_the_page_pans_sideways_keeps_its_edge() {
    // test_1 (a page wider than the window): a fling into the bottom springs back from 4427 while the hand already
    // scrolls sideways, 18-120 px a frame, and the spring settles with the page still moving; then the page scrolls
    // away. The page never comes to a complete stop near the edge, and never past it.
    let fling = poses(&[
        (400, 1536, 4022),
        (401, 1536, 4064),
        (402, 1536, 4126),
        (403, 1536, 4238),
        (404, 1536, 4350),
        (405, 1536, 4388),
        (406, 1536, 4410),
        (407, 1536, 4423),
        (408, 1536, 4427),
        (409, 1536, 4424),
        (410, 1536, 4418),
        (411, 1536, 4412),
        (412, 1536, 4404),
        (413, 1536, 4395),
        (414, 1536, 4388),
        (415, 1536, 4380),
        (416, 1536, 4373),
        (417, 1536, 4366),
        (418, 1536, 4360),
        (419, 1536, 4356),
        (420, 1536, 4351),
        (421, 1536, 4347),
        (422, 1536, 4342),
        (423, 1536, 4339),
        (424, 1536, 4336),
        (425, 1534, 4335),
        (426, 1516, 4335),
        (427, 1486, 4335),
        (428, 1454, 4335),
        (429, 1380, 4335),
        (430, 1336, 4335),
        (431, 1276, 4333),
        (432, 1186, 4332),
        (433, 1084, 4329),
        (434, 980, 4327),
        (435, 870, 4326),
        (436, 768, 4326),
        (437, 674, 4324),
        (438, 586, 4324),
        (439, 466, 4323),
        (440, 392, 4323),
        (441, 324, 4323),
        (442, 264, 4323),
        (443, 208, 4323),
        (444, 156, 4321),
        (445, 108, 4321),
        (446, 64, 4321),
        (447, 24, 4321),
        (448, 24, 4317),
        (449, 24, 4293),
        (450, 24, 4185),
        (451, 24, 3921),
        (452, 24, 3443),
        (453, 24, 3079),
        (454, 24, 2589),
        (455, 24, 2299),
    ]);
    assert_eq!(page_edges(&fling, 2976, 2074).bottom, Some(4335));
    // test_4 (an image in Chrome): pulled 81 px past the top, the spring brings it back to -9 and the last 9 px
    // creep in while the page pans sideways 12-18 px a frame.
    let pull = poses(&[
        (110, 16, 178),
        (111, 16, 160),
        (112, 16, 150),
        (113, 16, 126),
        (114, 16, 98),
        (115, 16, 66),
        (116, 16, 38),
        (117, 16, 0),
        (118, 16, -42),
        (119, 16, -63),
        (120, 16, -75),
        (121, 16, -81),
        (122, 16, -78),
        (123, 16, -72),
        (124, 16, -66),
        (125, 16, -60),
        (126, 16, -54),
        (127, 16, -48),
        (128, 16, -42),
        (129, 16, -36),
        (130, 16, -33),
        (131, 16, -27),
        (132, 16, -24),
        (133, 16, -21),
        (134, 16, -18),
        (135, 16, -15),
        (136, 16, -12),
        (137, 16, -9),
        (138, 26, -9),
        (139, 42, -9),
        (140, 58, -9),
        (141, 70, -9),
        (142, 86, -9),
        (143, 98, -9),
        (144, 116, -9),
        (145, 134, -9),
        (146, 150, -6),
        (147, 168, -6),
        (148, 186, -3),
        (149, 202, -3),
        (150, 218, -3),
        (151, 234, -3),
        (152, 246, -3),
        (153, 258, 0),
        (154, 270, 0),
        (155, 282, 0),
        (156, 300, 0),
        (157, 308, 0),
        (158, 316, 0),
        (159, 314, 0),
        (160, 302, 0),
        (161, 292, 0),
        (162, 280, 0),
        (163, 272, 0),
        (164, 260, 0),
        (165, 252, -3),
        (166, 244, -3),
        (167, 238, -6),
        (168, 234, -6),
        (169, 230, -6),
        (170, 224, -2),
        (171, 216, 12),
        (172, 208, 24),
        (173, 200, 36),
        (174, 192, 50),
        (175, 180, 74),
    ]);
    assert_eq!(page_edges(&pull, 2976, 2074).top, Some(-9));
}
