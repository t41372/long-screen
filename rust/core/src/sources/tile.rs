use super::*;
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize)]
pub struct TileHistory {
    version: u32,
    pub size: usize,
    pub tx: i32,
    pub ty: i32,
    pub noise: u8,
    pub pages: u32,
    pub blocks: BTreeMap<u16, History>,
}
#[derive(Serialize, Deserialize)]
pub struct SpillEntry {
    pub block: u16,
    pub candidate: Candidate,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    #[serde(default)]
    pub occlusions: Vec<Occlusion>,
    pub state: Option<u32>,
    pub width: usize,
    pub height: usize,
    pub frame: u32,
    pub time: f64,
    pub pose_x: f64,
    pub pose_y: f64,
    pub code: u8,
    pub quality: u16,
}
#[derive(Deserialize)]
pub struct Occlusion {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TileStats {
    pub blocks: usize,
    pub candidates: usize,
    pub resident_bytes: usize,
    pub pages: u32,
}

impl TileHistory {
    pub fn new(size: usize, tx: i32, ty: i32, noise: u8, disputes: &[u8]) -> Self {
        let mut blocks = BTreeMap::new();
        // The index already carries a halo across shard/tile boundaries.
        for (i, &v) in disputes.iter().enumerate() {
            if v != 0 {
                blocks.insert(i as u16, History::default());
            }
        }
        Self {
            version: 1,
            size,
            tx,
            ty,
            noise,
            pages: 0,
            blocks,
        }
    }
    pub fn encode(&self) -> Result<Vec<u8>, postcard::Error> {
        archive::encode(self)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, postcard::Error> {
        let s: Self = archive::decode(bytes)?;
        if s.version != 1 || s.size == 0 || !s.size.is_multiple_of(SIDE) {
            return Err(postcard::Error::DeserializeBadEncoding);
        }
        Ok(s)
    }
    pub fn capture(&mut self, input: &Capture, rgba: &[u8], labels: &[u8], visibility: &[u8]) {
        self.capture_owned(input, rgba, labels, visibility, None, None);
    }
    pub fn capture_owned(
        &mut self,
        input: &Capture,
        rgba: &[u8],
        labels: &[u8],
        visibility: &[u8],
        ownership: Option<&[u8]>,
        context_visibility: Option<&[u8]>,
    ) {
        let n = self.size / SIDE;
        let (pose_x, pose_y) = (
            crate::geometry::js_round(input.pose_x),
            crate::geometry::js_round(input.pose_y),
        );
        for (&block, history) in &mut self.blocks {
            let bx = self.tx * self.size as i32 + (block as usize % n * SIDE) as i32 - pose_x;
            let by = self.ty * self.size as i32 + (block as usize / n * SIDE) as i32 - pose_y;
            if bx >= input.width as i32
                || by >= input.height as i32
                || bx + SIDE as i32 <= 0
                || by + SIDE as i32 <= 0
            {
                continue;
            }
            let mut pixels = vec![0; PIXELS * 4];
            let mut states = vec![Visibility::Outside; PIXELS];
            let mut present = false;
            for y in 0..SIDE {
                for x in 0..SIDE {
                    let (sx, sy) = (bx + x as i32, by + y as i32);
                    if sx < 0 || sy < 0 || sx >= input.width as i32 || sy >= input.height as i32 {
                        continue;
                    }
                    let src = sy as usize * input.width + sx as usize;
                    if labels[src] != input.code {
                        continue;
                    }
                    let dst = y * SIDE + x;
                    pixels[dst * 4..dst * 4 + 4].copy_from_slice(&rgba[src * 4..src * 4 + 4]);
                    states[dst] = match visibility[src] {
                        1 => Visibility::Visible,
                        2 => Visibility::Occluded,
                        3 => Visibility::Outside,
                        4 => Visibility::Background,
                        _ => Visibility::Unknown,
                    };
                    let foreign = ownership.is_some_and(|a| a[src] != input.code);
                    if foreign {
                        states[dst] = match context_visibility.map(|v| v[src]) {
                            Some(2) => Visibility::ContextOccluded,
                            Some(1) => Visibility::Context,
                            Some(4) => Visibility::ContextBackground,
                            _ => Visibility::ContextExcluded,
                        };
                    }
                    if input.occlusions.iter().any(|r| {
                        (sx as f64) >= r.x
                            && (sy as f64) >= r.y
                            && (sx as f64) < r.x + r.width
                            && (sy as f64) < r.y + r.height
                    }) {
                        states[dst] = if foreign {
                            Visibility::ContextPlacementOccluded
                        } else {
                            Visibility::PlacementOccluded
                        };
                    }
                    present |= states[dst] != Visibility::Outside;
                }
            }
            if present {
                let mut candidate = Candidate::new(
                    input.frame,
                    input.time,
                    pose_x,
                    pose_y,
                    pixels,
                    states,
                    input.quality,
                );
                candidate.source_state = input.state.unwrap_or(input.frame);
                history.observe(candidate, self.noise);
            }
        }
    }
    pub fn spill(&mut self) -> Result<Option<Vec<u8>>, postcard::Error> {
        let entries: Vec<_> = self
            .blocks
            .iter_mut()
            .flat_map(|(&block, h)| {
                h.take_spilled()
                    .into_iter()
                    .map(move |candidate| SpillEntry { block, candidate })
            })
            .collect();
        if entries.is_empty() {
            return Ok(None);
        }
        self.pages += 1;
        archive::encode(&(1u32, entries)).map(Some)
    }
    pub fn stats(&self) -> TileStats {
        TileStats {
            blocks: self.blocks.len(),
            candidates: self
                .blocks
                .values()
                .map(|h| h.resident.len() + h.spilled.len())
                .sum(),
            resident_bytes: std::mem::size_of::<Self>()
                + self
                    .blocks
                    .values()
                    .map(History::resident_bytes)
                    .sum::<usize>(),
            pages: self.pages,
        }
    }
}

pub fn decode_page(bytes: &[u8]) -> Result<Vec<SpillEntry>, postcard::Error> {
    let (version, entries): (u32, Vec<SpillEntry>) = archive::decode(bytes)?;
    if version != 1 {
        return Err(postcard::Error::DeserializeBadEncoding);
    }
    Ok(entries)
}
