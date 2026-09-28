//! Version 2 dictionaries share exact native planes while retaining every observation in order.

use super::{
    archive,
    pixels::Pixels,
    tile::{SpillEntry, TileHistory},
    Candidate, Exposure, FrameSpan, History, Visibility,
};
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    collections::{BTreeMap, HashMap},
};

#[derive(Serialize, Deserialize)]
struct VisibilityPlane(#[serde(with = "super::visibility")] Vec<Visibility>);
#[derive(Serialize, Deserialize)]
struct Observation<'a> {
    source_state: u32,
    frame: u32,
    time: f64,
    pose_x: i32,
    pose_y: i32,
    rgba: usize,
    visibility: usize,
    quality: u16,
    frames: Cow<'a, [FrameSpan]>,
    exposures: Cow<'a, [Exposure]>,
}
#[derive(Serialize, Deserialize)]
struct PackedHistory<'a> {
    resident: Vec<Observation<'a>>,
    spilled: Vec<Observation<'a>>,
}
#[derive(Serialize, Deserialize)]
struct Header {
    size: usize,
    tx: i32,
    ty: i32,
    noise: u8,
    pages: u32,
}
#[derive(Serialize, Deserialize)]
struct PageArchive<'a> {
    version: u32,
    rgba: Vec<Pixels>,
    visibility: Vec<VisibilityPlane>,
    observations: Vec<(u16, Observation<'a>)>,
}
#[derive(Serialize, Deserialize)]
struct StateArchive<'a> {
    version: u32,
    header: Header,
    rgba: Vec<Pixels>,
    visibility: Vec<VisibilityPlane>,
    blocks: Vec<(u16, PackedHistory<'a>)>,
}
#[derive(Default)]
struct Dictionaries {
    rgba: Vec<Pixels>,
    visibility: Vec<VisibilityPlane>,
    colours: HashMap<u32, Vec<usize>>,
    allocations: HashMap<usize, (Pixels, usize)>,
    masks: HashMap<u32, Vec<usize>>,
}
impl Dictionaries {
    fn observation<'a>(&mut self, c: &'a Candidate) -> Observation<'a> {
        // The dictionary owns a clone, so this allocation cannot disappear or change while its
        // key is live. Pointer keys stay in memory; archive ordering is still first byte occurrence.
        let allocation = c.rgba.allocation_key();
        let rgba = if let Some((_, at)) = self.allocations.get(&allocation) {
            *at
        } else {
            let hash = crc32fast::hash(&c.rgba);
            let matches = self.colours.entry(hash).or_default();
            let at = if let Some(&at) = matches.iter().find(|&&i| self.rgba[i] == c.rgba) {
                at
            } else {
                let at = self.rgba.len();
                self.rgba.push(c.rgba.clone());
                matches.push(at);
                at
            };
            self.allocations.insert(allocation, (c.rgba.clone(), at));
            at
        };
        // Hashing is only an index: a collision never aliases different visibility or RGBA.
        let hash = crc32fast::hash(super::visibility::bytes(&c.visibility));
        let matches = self.masks.entry(hash).or_default();
        let visibility = if let Some(&at) = matches
            .iter()
            .find(|&&i| self.visibility[i].0 == c.visibility)
        {
            at
        } else {
            let at = self.visibility.len();
            self.visibility.push(VisibilityPlane(c.visibility.clone()));
            matches.push(at);
            at
        };
        Observation {
            source_state: c.source_state,
            frame: c.frame,
            time: c.time,
            pose_x: c.pose_x,
            pose_y: c.pose_y,
            rgba,
            visibility,
            quality: c.quality,
            frames: Cow::Borrowed(&c.frames),
            exposures: Cow::Borrowed(&c.exposures),
        }
    }
}
impl Observation<'_> {
    fn candidate(
        self,
        rgba: &[Pixels],
        visibility: &[VisibilityPlane],
    ) -> Result<Candidate, postcard::Error> {
        let bad = || postcard::Error::DeserializeBadEncoding;
        let rgba = rgba
            .get(self.rgba)
            .filter(|p| p.len() == super::PIXELS * 4)
            .ok_or_else(bad)?
            .clone();
        let visibility = visibility
            .get(self.visibility)
            .filter(|p| p.0.len() == super::PIXELS)
            .ok_or_else(bad)?
            .0
            .clone();
        Ok(Candidate {
            source_state: self.source_state,
            frame: self.frame,
            time: self.time,
            pose_x: self.pose_x,
            pose_y: self.pose_y,
            rgba,
            visibility,
            quality: self.quality,
            frames: self.frames.into_owned(),
            exposures: self.exposures.into_owned(),
        })
    }
}
pub(super) fn encode_page(entries: &[SpillEntry]) -> Result<Vec<u8>, postcard::Error> {
    let mut dictionaries = Dictionaries::default();
    let observations: Vec<_> = entries
        .iter()
        .map(|e| (e.block, dictionaries.observation(&e.candidate)))
        .collect();
    archive::encode(&PageArchive {
        version: 2,
        rgba: dictionaries.rgba,
        visibility: dictionaries.visibility,
        observations,
    })
}
pub(super) fn decode_page(raw: &[u8]) -> Result<Vec<SpillEntry>, postcard::Error> {
    let PageArchive {
        rgba,
        visibility,
        observations,
        ..
    } = postcard::from_bytes::<PageArchive<'_>>(raw)?;
    let mut entries = Vec::with_capacity(observations.len());
    for (block, c) in observations {
        entries.push(SpillEntry {
            block,
            candidate: c.candidate(&rgba, &visibility)?,
        });
    }
    Ok(entries)
}
pub(super) fn encode_state(state: &TileHistory) -> Result<Vec<u8>, postcard::Error> {
    let mut dictionaries = Dictionaries::default();
    let blocks: Vec<_> = state
        .blocks
        .iter()
        .map(|(&block, history)| {
            (
                block,
                PackedHistory {
                    resident: history
                        .resident
                        .iter()
                        .map(|c| dictionaries.observation(c))
                        .collect(),
                    spilled: history
                        .spilled
                        .iter()
                        .map(|c| dictionaries.observation(c))
                        .collect(),
                },
            )
        })
        .collect();
    let header = Header {
        size: state.size,
        tx: state.tx,
        ty: state.ty,
        noise: state.noise,
        pages: state.pages,
    };
    archive::encode(&StateArchive {
        version: 2,
        header,
        rgba: dictionaries.rgba,
        visibility: dictionaries.visibility,
        blocks,
    })
}
pub(super) fn decode_state(raw: &[u8]) -> Result<TileHistory, postcard::Error> {
    let StateArchive {
        header,
        rgba,
        visibility,
        blocks,
        ..
    } = postcard::from_bytes::<StateArchive<'_>>(raw)?;
    let mut histories = BTreeMap::new();
    for (block, history) in blocks {
        // collect<Result<Vec<_>, _>> loses the exact lower size hint and rounds small vectors
        // up to capacity four. The legacy loader reserves their actual lengths; that capacity
        // participates in LRU accounting and must not change model input order on real recordings.
        let mut resident = Vec::with_capacity(history.resident.len());
        for c in history.resident {
            resident.push(c.candidate(&rgba, &visibility)?);
        }
        let mut spilled = Vec::with_capacity(history.spilled.len());
        for c in history.spilled {
            spilled.push(c.candidate(&rgba, &visibility)?);
        }
        histories.insert(block, History { resident, spilled });
    }
    Ok(TileHistory {
        version: 1,
        size: header.size,
        tx: header.tx,
        ty: header.ty,
        noise: header.noise,
        pages: header.pages,
        blocks: histories,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::{
        archive,
        tile::{decode_page, SpillEntry, TileHistory},
        Candidate, Visibility, PIXELS,
    };

    #[test]
    fn dictionaries_preserve_every_observation_and_read_legacy_pages() {
        let mut entries = Vec::new();
        for frame in 0..20 {
            let mut candidate = Candidate::new(
                frame,
                frame as f64 / 30.,
                frame as i32 - 10,
                -30,
                [30, 30, 30, 255].repeat(PIXELS),
                vec![Visibility::Unknown; PIXELS],
                100,
            );
            if frame == 9 {
                candidate.rgba[1023] = 254;
            }
            if frame == 11 {
                candidate.rgba[1000] = 31;
            }
            if frame == 13 {
                candidate.visibility[255] = Visibility::Visible;
            }
            entries.push(SpillEntry {
                block: (frame % 4) as u16,
                candidate,
            });
        }
        let expected = postcard::to_allocvec(&entries).unwrap();
        let packed = encode_page(&entries).unwrap();
        assert_eq!(
            postcard::to_allocvec(&decode_page(&packed).unwrap()).unwrap(),
            expected
        );
        let legacy = archive::encode(&(1u32, &entries)).unwrap();
        assert_eq!(
            postcard::to_allocvec(&decode_page(&legacy).unwrap()).unwrap(),
            expected
        );
        assert!(
            archive::unpack(&packed).unwrap().len() < archive::unpack(&legacy).unwrap().len() / 3
        );

        let mut state = TileHistory::new(32, -1, 2, 2, &[1, 1, 1, 1]);
        state.pages = 3;
        for entry in entries {
            state
                .blocks
                .get_mut(&entry.block)
                .unwrap()
                .resident
                .push(entry.candidate);
        }
        let expected = postcard::to_allocvec(&state).unwrap();
        let legacy_resident = TileHistory::decode(&archive::encode(&state).unwrap())
            .unwrap()
            .stats()
            .resident_bytes;
        for bytes in [
            encode_state(&state).unwrap(),
            archive::encode(&state).unwrap(),
        ] {
            let restored = TileHistory::decode(&bytes).unwrap();
            assert_eq!(postcard::to_allocvec(&restored).unwrap(), expected);
            assert_eq!(
                restored.stats().resident_bytes,
                legacy_resident,
                "loader vector capacity must not move LRU boundaries or model sample order"
            );
        }
    }
}
