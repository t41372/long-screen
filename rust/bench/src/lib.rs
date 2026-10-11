//! The public test recordings (`cases.json`) and the decoded frame windows the benchmarks read.
//!
//! A case is a screen recording published as a GitHub Release asset; its manifest entry pins the file's SHA-256 and
//! a short window of consecutive frames with motion. The `cases` binary downloads and checks the recordings and
//! decodes each window once with ffmpeg into a fixture: the frames' planes exactly as decoded (no scaling, no pixel
//! format conversion), whose SHA-256 the manifest also pins. Benchmarks read only fixtures, so they never decode
//! video and measure the same bytes on every machine.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Release {
    pub repository: String,
    pub tag: String,
    /// Download URL with `{file}` standing for the case's file name.
    pub url: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct Window {
    /// Index of the first frame, counting every decoded frame (ffmpeg `-fps_mode passthrough`).
    pub start: u32,
    pub count: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Case {
    pub id: String,
    pub file: String,
    pub bytes: u64,
    pub sha256: String,
    pub codec: String,
    pub width: usize,
    pub height: usize,
    pub pix_fmt: String,
    pub range: String,
    pub matrix: String,
    pub transfer: String,
    pub primaries: String,
    /// Decoded frames with `-fps_mode passthrough` (the recordings are variable frame rate).
    pub frames: u32,
    pub note: String,
    pub window: Window,
    /// SHA-256 of the fixture this manifest's extractor version produces; `None` until recorded.
    pub fixture_sha256: Option<String>,
    /// A longer window the whole native pipeline runs over (`benches/pipeline.rs`), for the cases that have one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<Window>,
    /// SHA-256 of the pipeline window's fixture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipeline_sha256: Option<String>,
}

/// Which of a case's windows a fixture holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Span {
    /// `window`: the kernel benchmarks' three frames.
    Kernels,
    /// `pipeline`: the end-to-end benchmark's longer run.
    Pipeline,
}

impl Case {
    /// The window `span` names (`None` for a pipeline window the case does not have).
    pub fn span(&self, span: Span) -> Option<Window> {
        match span {
            Span::Kernels => Some(self.window),
            Span::Pipeline => self.pipeline,
        }
    }

    /// The pinned hash of `span`'s fixture.
    pub fn span_sha256(&self, span: Span) -> Option<&String> {
        match span {
            Span::Kernels => self.fixture_sha256.as_ref(),
            Span::Pipeline => self.pipeline_sha256.as_ref(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Manifest {
    pub release: Release,
    pub provenance: String,
    /// Bumped whenever the fixture bytes for an unchanged window would change (decoder flags, layout).
    pub extractor: u32,
    pub cases: Vec<Case>,
}

/// `rust/bench`.
pub fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

pub fn manifest_path() -> PathBuf {
    crate_dir().join("cases.json")
}

pub fn manifest() -> Manifest {
    let path = manifest_path();
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("bad {}: {e}", path.display()))
}

/// Where the recordings are: `LONGSCREEN_CASES` when set (a directory that already holds them, never written to),
/// otherwise a download cache under `rust/target/bench-cases`.
pub fn cases_dir() -> (PathBuf, bool) {
    match std::env::var_os("LONGSCREEN_CASES") {
        Some(dir) => (PathBuf::from(dir), true),
        None => (crate_dir().join("../target/bench-cases"), false),
    }
}

/// Where the fixtures are: `LONGSCREEN_FIXTURES` when set, otherwise `rust/target/bench-fixtures/extractor-N`.
pub fn fixtures_dir(manifest: &Manifest) -> PathBuf {
    match std::env::var_os("LONGSCREEN_FIXTURES") {
        Some(dir) => PathBuf::from(dir),
        None => crate_dir().join(format!(
            "../target/bench-fixtures/extractor-{}",
            manifest.extractor
        )),
    }
}

pub fn fixture_path(manifest: &Manifest, case: &Case) -> PathBuf {
    span_path(manifest, case, Span::Kernels)
}

/// The fixture file of one of a case's windows.
pub fn span_path(manifest: &Manifest, case: &Case, span: Span) -> PathBuf {
    match span {
        Span::Kernels => fixtures_dir(manifest).join(format!("{}.yuv", case.id)),
        Span::Pipeline => fixtures_dir(manifest).join(format!("{}-pipeline.yuv", case.id)),
    }
}

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

impl Case {
    /// Bytes per sample in the decoded planes: 1 for 8-bit formats, 2 (little-endian) for 10-bit ones.
    pub fn sample_bytes(&self) -> usize {
        match self.pix_fmt.as_str() {
            "yuv420p" => 1,
            "yuv420p10le" => 2,
            other => panic!("{}: unsupported pixel format {other}", self.id),
        }
    }

    /// One decoded frame in the fixture: 4:2:0 planes Y, U, V, each tightly packed.
    pub fn frame_bytes(&self) -> usize {
        let (cw, ch) = (self.width.div_ceil(2), self.height.div_ceil(2));
        (self.width * self.height + 2 * cw * ch) * self.sample_bytes()
    }

    /// The core's colour code (`yuv::Signal::from_code`): transfer × 8 + matrix × 2 + full range.
    pub fn signal_code(&self) -> u32 {
        let transfer = match self.transfer.as_str() {
            "bt709" | "bt470bg" | "smpte170m" | "iec61966-2-1" => 0,
            "smpte2084" => 1,
            "arib-std-b67" => 2,
            other => panic!("{}: unsupported transfer {other}", self.id),
        };
        let matrix = match self.matrix.as_str() {
            "bt709" => 0,
            "bt470bg" | "smpte170m" => 1,
            "bt2020nc" => 2,
            other => panic!("{}: unsupported matrix {other}", self.id),
        };
        transfer * 8 + matrix * 2 + (self.range == "pc") as u32
    }
}

/// A fixture's frames as 8-bit I420, the planes `VideoFrame.copyTo` hands the core: 10-bit samples keep their top
/// eight bits, as a browser's 8-bit copy of a 10-bit frame does.
pub struct Fixture {
    pub case: Case,
    pub frames: Vec<Vec<u8>>,
}

pub fn load_fixture(manifest: &Manifest, case: &Case) -> Fixture {
    load_span(manifest, case, Span::Kernels)
}

/// The frames of one of a case's windows (see [`load_fixture`]).
pub fn load_span(manifest: &Manifest, case: &Case, span: Span) -> Fixture {
    let path = span_path(manifest, case, span);
    let window = case
        .span(span)
        .unwrap_or_else(|| panic!("{}: no {span:?} window", case.id));
    let bytes = std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "fixture {} is missing ({e}); run `cargo run -p long-screen-bench --bin cases -- fixtures` first",
            path.display()
        )
    });
    let size = case.frame_bytes();
    assert_eq!(
        bytes.len(),
        size * window.count as usize,
        "{}: fixture size does not match its window",
        case.id
    );
    let frames = bytes
        .chunks_exact(size)
        .map(|frame| match case.sample_bytes() {
            1 => frame.to_vec(),
            _ => frame
                .chunks_exact(2)
                .map(|s| (u16::from_le_bytes([s[0], s[1]]) >> 2) as u8)
                .collect(),
        })
        .collect();
    Fixture {
        case: case.clone(),
        frames,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_cases_are_complete_and_distinct() {
        let m = manifest();
        assert!(m.release.url.contains("{file}"));
        let mut ids: Vec<_> = m.cases.iter().map(|c| c.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), m.cases.len(), "case ids must be distinct");
        for c in &m.cases {
            assert_eq!(c.sha256.len(), 64, "{}", c.id);
            assert!(c.window.count >= 3, "{}: benches need three frames", c.id);
            assert!(c.window.start + c.window.count <= c.frames, "{}", c.id);
            assert!(
                long_screen::kernels::yuv::Signal::from_code(c.signal_code()).is_some(),
                "{}",
                c.id
            );
        }
    }

    #[test]
    fn ten_bit_samples_keep_their_top_eight_bits() {
        let case = Case {
            id: "t".into(),
            file: String::new(),
            bytes: 0,
            sha256: String::new(),
            codec: "hevc".into(),
            width: 2,
            height: 2,
            pix_fmt: "yuv420p10le".into(),
            range: "tv".into(),
            matrix: "bt2020nc".into(),
            transfer: "smpte2084".into(),
            primaries: "bt2020".into(),
            frames: 1,
            note: String::new(),
            window: Window { start: 0, count: 1 },
            fixture_sha256: None,
            pipeline: None,
            pipeline_sha256: None,
        };
        assert_eq!(case.frame_bytes(), 12);
        assert_eq!(case.signal_code(), 12);
        let dir = std::env::temp_dir().join("long-screen-bench-test");
        std::fs::create_dir_all(&dir).unwrap();
        let samples: [u16; 6] = [0, 3, 4, 1023, 512, 64];
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        std::fs::write(dir.join("t.yuv"), bytes).unwrap();
        std::env::set_var("LONGSCREEN_FIXTURES", &dir);
        let m = Manifest {
            release: manifest().release,
            provenance: String::new(),
            extractor: 0,
            cases: vec![],
        };
        let f = load_fixture(&m, &case);
        std::env::remove_var("LONGSCREEN_FIXTURES");
        assert_eq!(f.frames, vec![vec![0, 0, 1, 255, 128, 16]]);
    }
}
