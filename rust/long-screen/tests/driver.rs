//! The native driver end to end on frames built here: a tall textured page scrolled under a fixed 640×400 window.
//! Failure cases first (nothing decodable, a stop, a frame of the wrong size), then the result itself: the print's
//! pixels against the page they came from, PNG output, and independence from the thread count.

use long_screen::source::{Frame, Frames, MediaInfo, SourceError};
use long_screen::value::{Js, Obj};
use long_screen::{run, Control, Error, FrameSource, Options};

const W: usize = 640;
const H: usize = 400;

/// A deterministic page with enough texture to track: hashed 4×4 cells over a few gradients.
fn page_pixel(x: usize, y: usize) -> [u8; 4] {
    let cell =
        ((x / 4) as u32).wrapping_mul(73_856_093) ^ ((y / 4) as u32).wrapping_mul(19_349_663);
    let h = cell.wrapping_mul(2_654_435_761);
    [
        (h >> 24) as u8,
        (h >> 16) as u8 ^ (y as u8),
        (h >> 8) as u8 ^ (x as u8),
        255,
    ]
}

struct Scroll {
    info: MediaInfo,
    offsets: Vec<usize>,
    /// Frames from this index on come in the wrong size.
    resize_at: Option<usize>,
    /// Stops the run when this frame of this pass (1 = scan, 2 = solve, …) is read.
    stop_at: Option<(usize, usize, Control)>,
    passes: usize,
}

impl Scroll {
    fn new(offsets: Vec<usize>) -> Scroll {
        let n = offsets.len();
        let js = Obj::new()
            .with("name", "scroll.test")
            .with("size", 0u32)
            .with("width", W)
            .with("height", H)
            .with("codedWidth", W)
            .with("codedHeight", H)
            .with("rotation", 0u32)
            .with("duration", n as f64 / 30.0)
            .with("frameCount", n)
            .with("codec", "test")
            .with("mode", "Deterministic test input")
            .with("noise", 0u32)
            .with("warnings", Js::Arr(vec![]))
            .with("notices", Js::Arr(vec![]));
        Scroll {
            info: MediaInfo::from_js(js),
            offsets,
            resize_at: None,
            stop_at: None,
            passes: 0,
        }
    }
}

impl FrameSource for Scroll {
    fn info(&self) -> &MediaInfo {
        &self.info
    }

    fn frames(&mut self) -> Result<Frames<'_>, SourceError> {
        let offsets = self.offsets.clone();
        let resize_at = self.resize_at;
        self.passes += 1;
        let stop = self
            .stop_at
            .clone()
            .filter(|(pass, _, _)| *pass == self.passes);
        Ok(Box::new(offsets.into_iter().enumerate().map(
            move |(i, dy)| {
                if let Some((_, frame, control)) = &stop {
                    if i == *frame {
                        control.stop();
                    }
                }
                let (w, h) = if resize_at.is_some_and(|r| i >= r) {
                    (W / 2, H)
                } else {
                    (W, H)
                };
                let mut rgba = vec![0u8; w * h * 4];
                for y in 0..h {
                    for x in 0..w {
                        rgba[(y * w + x) * 4..][..4].copy_from_slice(&page_pixel(x, y + dy));
                    }
                }
                Ok(Frame {
                    index: i as u32,
                    time: i as f64 / 30.0,
                    duration: 1.0 / 30.0,
                    width: w,
                    height: h,
                    rgba,
                })
            },
        )))
    }
}

struct Empty(MediaInfo);

impl FrameSource for Empty {
    fn info(&self) -> &MediaInfo {
        &self.0
    }
    fn frames(&mut self) -> Result<Frames<'_>, SourceError> {
        Ok(Box::new(std::iter::empty()))
    }
}

fn scroll_offsets() -> Vec<usize> {
    (0..24).map(|i| i * 23).collect()
}

fn codes(result: &long_screen::RunResult) -> Vec<String> {
    result
        .diagnostics()
        .iter()
        .map(|d| d.code.clone())
        .collect()
}

#[test]
fn a_source_without_frames_fails_and_says_why() {
    let mut source = Empty(Scroll::new(vec![]).info);
    match run(&mut source, &Options::default(), &mut (), &Control::new()) {
        Err(Error::Failed { message, result }) => {
            assert!(
                message.starts_with("No observations could be decoded"),
                "{message}"
            );
            assert_eq!(result.status(), "error");
            assert!(codes(&result).contains(&"PROCESSING_ERROR".to_string()));
        }
        other => panic!("expected a failed run, got {other:?}"),
    }
}

#[test]
fn a_bad_tile_size_is_refused_before_the_run() {
    let mut options = Options::default();
    options.settings.tile_size = 100;
    let mut source = Scroll::new(scroll_offsets());
    assert!(matches!(
        run(&mut source, &options, &mut (), &Control::new()),
        Err(Error::Settings(_))
    ));
}

#[test]
fn a_stop_keeps_the_committed_prefix_and_ends_partial() {
    // Stopped from the frame source, not from a progress event: progress is throttled by the wall clock, so a
    // fast solve pass can end before it reports.
    let control = Control::new();
    let mut source = Scroll::new(scroll_offsets());
    source.stop_at = Some((2, 5, control.clone()));
    let result =
        run(&mut source, &Options::default(), &mut (), &control).expect("a partial result");
    assert_eq!(result.status(), "partial");
    assert_eq!(result.frames(), 24, "the scan finished before the stop");
    assert!(result.rendered_frames() < 24);
    // A stop is honoured, not reported as a failure, and no presentation is built after it.
    assert!(!codes(&result).contains(&"PROCESSING_ERROR".to_string()));
    assert!(result.canvases().iter().all(|c| c.kind != "presentation"));
}

#[test]
fn a_frame_of_another_size_ends_the_scan_at_the_prefix() {
    let mut source = Scroll::new(scroll_offsets());
    source.resize_at = Some(10);
    let result =
        run(&mut source, &Options::default(), &mut (), &Control::new()).expect("a partial result");
    assert_eq!(result.frames(), 10);
    assert_eq!(result.status(), "partial");
    let decode = result
        .diagnostics()
        .iter()
        .find(|d| d.code == "DECODE_PREFIX_ONLY")
        .expect("the size change is reported as a decode-level stop");
    assert!(
        decode.message.contains("FRAME_GEOMETRY_CHANGED"),
        "{}",
        decode.message
    );
}

#[test]
fn the_print_is_the_page_that_scrolled_past() {
    let mut source = Scroll::new(scroll_offsets());
    let mut options = Options::default();
    options.settings.framing = long_screen::Framing::Region;
    let result = run(&mut source, &options, &mut (), &Control::new()).expect("a result");
    assert_eq!(result.status(), "complete", "{:?}", codes(&result));
    let print = result.print().expect("a print");
    assert_eq!(print.kind, "moving");
    let b = print.bounds;
    assert_eq!((b.width, b.height), (W as f64, (H + 23 * 23) as f64));
    assert!(result.fragments().is_empty());
    // Every pixel of the print is the page's, at the page position the canvas origin maps to.
    let mut png = Vec::new();
    let (w, h) = result.write_png(&print.id, &mut png).expect("PNG");
    assert_eq!((w as usize, h as usize), (W, H + 23 * 23));
    let decoder = png::Decoder::new(std::io::Cursor::new(png));
    let mut reader = decoder.read_info().unwrap();
    let mut pixels = vec![0u8; reader.output_buffer_size().unwrap()];
    reader.next_frame(&mut pixels).unwrap();
    let (ox, oy) = (b.x as i64, b.y as i64);
    let mut wrong = 0;
    for y in 0..h as usize {
        for x in 0..w as usize {
            let page_y = (y as i64 + oy) as usize;
            let page_x = (x as i64 + ox) as usize;
            if pixels[(y * w as usize + x) * 4..][..4] != page_pixel(page_x, page_y) {
                wrong += 1;
            }
        }
    }
    assert_eq!(wrong, 0, "pixels that are not the page's");
}

#[test]
fn results_do_not_depend_on_the_thread_count() {
    let fingerprint = |threads| {
        let mut source = Scroll::new(scroll_offsets());
        let options = Options {
            threads: Some(threads),
            ..Options::default()
        };
        let result = run(&mut source, &options, &mut (), &Control::new()).expect("a result");
        result.fingerprint()
    };
    let (one, _) = fingerprint(1);
    let (four, _) = fingerprint(4);
    let differing: Vec<_> = one
        .iter()
        .filter(|(k, v)| four.get(*k) != Some(v) && !k.ends_with("/performance"))
        .map(|(k, _)| k.clone())
        .collect();
    assert_eq!(one.len(), four.len());
    assert!(
        differing.is_empty(),
        "rows that changed with the thread count: {differing:?}"
    );
}

#[test]
fn spilled_tiles_read_back_as_the_same_rows() {
    let fingerprint = |options: Options| {
        let mut source = Scroll::new(scroll_offsets());
        let result = run(&mut source, &options, &mut (), &Control::new()).expect("a result");
        (result.fingerprint().0, result.store().spilled())
    };
    let (memory, none) = fingerprint(Options::default());
    let dir = std::env::temp_dir().join(format!("long-screen-spill-test-{}", std::process::id()));
    let (spilled, rows) = fingerprint(Options {
        store_budget: Some(1),
        spill_dir: Some(dir.clone()),
        ..Options::default()
    });
    assert_eq!(none, 0);
    assert!(rows > 0, "a one-byte budget spills every encoded tile");
    let differing: Vec<_> = memory
        .iter()
        .filter(|(k, v)| spilled.get(*k) != Some(v) && !k.ends_with("/performance"))
        .map(|(k, _)| k.clone())
        .collect();
    assert_eq!(memory.len(), spilled.len());
    assert!(
        differing.is_empty(),
        "rows that changed when tiles spilled: {differing:?}"
    );
    let _ = std::fs::remove_dir_all(dir);
}
