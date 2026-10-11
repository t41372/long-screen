//! The whole native pipeline (`long_screen::run`: scan, solve, render, reveal, framing, pyramid) over each case's
//! longer `pipeline` window (cases.json): 48 frames of test_3 (780×1404 HDR) and 30 of test_7 (1320×2868 HDR iPhone).
//!
//! The fixture frames are converted to RGBA once, outside the measurement, the way the native decoder hands them to
//! the driver (the core's YUV conversion, HDR through its PQ path); each benchmark then times one complete run on one
//! thread, so the figure does not depend on the machine's core count. Decoding is not included.

use long_screen::source::{Frame, FrameSource, Frames, MediaInfo, SourceError};
use long_screen::value::{Js, Obj};
use long_screen::{run, Control, Options};
use long_screen_bench::{load_span, manifest, Span};
use long_screen_core::yuv::{self, Format, Plane, Signal};
use std::sync::OnceLock;

fn main() {
    divan::main();
}

struct Prepared {
    width: usize,
    height: usize,
    frames: Vec<Vec<u8>>,
    name: String,
}

fn prepare(id: &str) -> Prepared {
    let m = manifest();
    let case = m.cases.iter().find(|c| c.id == id).expect("case");
    let fixture = load_span(&m, case, Span::Pipeline);
    let (w, h) = (case.width, case.height);
    let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
    let planes = [
        Plane {
            offset: 0,
            stride: w,
        },
        Plane {
            offset: w * h,
            stride: cw,
        },
        Plane {
            offset: w * h + cw * ch,
            stride: cw,
        },
    ];
    let signal = Signal::from_code(case.signal_code()).expect("signal");
    let frames = fixture
        .frames
        .iter()
        .map(|yuv| {
            let mut rgba = vec![0u8; w * h * 4];
            yuv::convert(yuv, Format::I420, &planes, w, h, signal, &mut rgba);
            rgba
        })
        .collect();
    Prepared {
        width: w,
        height: h,
        frames,
        name: case.file.clone(),
    }
}

fn prepared(id: &'static str) -> &'static Prepared {
    static TEST_3: OnceLock<Prepared> = OnceLock::new();
    static TEST_7: OnceLock<Prepared> = OnceLock::new();
    match id {
        "test_3" => TEST_3.get_or_init(|| prepare(id)),
        _ => TEST_7.get_or_init(|| prepare(id)),
    }
}

struct Window {
    p: &'static Prepared,
    info: MediaInfo,
}

impl Window {
    fn new(p: &'static Prepared) -> Window {
        let n = p.frames.len();
        let js = Obj::new()
            .with("name", p.name.as_str())
            .with("size", 0u32)
            .with("width", p.width)
            .with("height", p.height)
            .with("codedWidth", p.width)
            .with("codedHeight", p.height)
            .with("rotation", 0u32)
            .with("duration", n as f64 / 60.0)
            .with("frameCount", n)
            .with("codec", "hevc")
            .with("mode", "benchmark window")
            .with("noise", 10u32)
            .with("warnings", Js::Arr(vec![]))
            .with("notices", Js::Arr(vec![]));
        Window {
            p,
            info: MediaInfo::from_js(js),
        }
    }
}

impl FrameSource for Window {
    fn info(&self) -> &MediaInfo {
        &self.info
    }

    fn frames(&mut self) -> Result<Frames<'_>, SourceError> {
        let p = self.p;
        Ok(Box::new(p.frames.iter().enumerate().map(
            move |(i, rgba)| {
                Ok(Frame {
                    index: i as u32,
                    time: i as f64 / 60.0,
                    duration: 1.0 / 60.0,
                    width: p.width,
                    height: p.height,
                    rgba: rgba.clone(),
                })
            },
        )))
    }
}

#[divan::bench(args = ["test_3", "test_7"], sample_count = 3, sample_size = 1)]
fn pipeline(bencher: divan::Bencher, id: &'static str) {
    let p = prepared(id);
    let options = Options {
        threads: Some(1),
        ..Options::default()
    };
    bencher.bench_local(|| {
        let mut source = Window::new(p);
        let result = run(&mut source, &options, &mut (), &Control::new()).expect("a result");
        divan::black_box(result.rendered_frames())
    });
}
