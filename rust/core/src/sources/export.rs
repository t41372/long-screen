//! Interoperable exports of archived alternatives: a native 16px patch sheet and explicit source
//! metadata, so inspecting a project does not require a Postcard decoder or the original recording.
use super::tile::{decode_page, SpillEntry, TileHistory};
use super::*;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSource {
    pub block: u16,
    pub x: usize,
    pub y: usize,
    pub frame: u32,
    pub time: f64,
    pub pose_x: i32,
    pub pose_y: i32,
    pub frames: Vec<FrameSpan>,
    pub visibility: Vec<(usize, usize, u8)>,
    pub quality: u16,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSheet {
    pub version: u32,
    pub width: usize,
    pub height: usize,
    pub patch_size: usize,
    pub patches: Vec<PatchSource>,
}
pub fn entries(data: &[u8], page: i32) -> Result<Vec<SpillEntry>, postcard::Error> {
    if page < 0 {
        Ok(TileHistory::decode(data)?
            .blocks
            .into_iter()
            .flat_map(|(block, h)| {
                h.resident
                    .into_iter()
                    .map(move |candidate| SpillEntry { block, candidate })
            })
            .collect())
    } else {
        decode_page(data)
    }
}
pub fn sheet(entries: Vec<SpillEntry>) -> (PatchSheet, Vec<u8>) {
    let width = 16 * SIDE;
    let height = entries.len().div_ceil(16).max(1) * SIDE;
    let mut rgba = vec![0; width * height * 4];
    let mut patches = Vec::new();
    for (i, e) in entries.into_iter().enumerate() {
        let (x, y) = (i % 16 * SIDE, i / 16 * SIDE);
        let c = e.candidate;
        for row in 0..SIDE {
            rgba[((y + row) * width + x) * 4..((y + row) * width + x + SIDE) * 4]
                .copy_from_slice(&c.rgba[row * SIDE * 4..(row + 1) * SIDE * 4]);
        }
        let mut runs: Vec<(usize, usize, u8)> = Vec::new();
        for (at, v) in c.visibility.into_iter().enumerate() {
            if let Some(last) = runs.last_mut().filter(|r| r.2 == v as u8) {
                last.1 += 1;
            } else {
                runs.push((at, 1, v as u8));
            }
        }
        patches.push(PatchSource {
            block: e.block,
            x,
            y,
            frame: c.frame,
            time: c.time,
            pose_x: c.pose_x,
            pose_y: c.pose_y,
            frames: c.frames,
            visibility: runs,
            quality: c.quality,
        });
    }
    (
        PatchSheet {
            version: 1,
            width,
            height,
            patch_size: SIDE,
            patches,
        },
        rgba,
    )
}
pub fn encode_png(sheet: &PatchSheet, rgba: &[u8]) -> Result<Vec<u8>, png::EncodingError> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, sheet.width as u32, sheet.height as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        enc.write_header()?.write_image_data(rgba)?;
    }
    Ok(out)
}
