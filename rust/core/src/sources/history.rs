use super::*;

fn equivalent(a: &Candidate, b: &Candidate, noise: u8) -> bool {
    if a.source_state != b.source_state || a.pose_x != b.pose_x || a.pose_y != b.pose_y {
        return false;
    }
    // Until visibility is established, even a codec-sized change may be the only clean reveal.
    // Preserve those native observations; noise-tolerant aliases are safe only for visible sources.
    let noise = if a
        .visibility
        .iter()
        .all(|v| matches!(v, Visibility::Visible | Visibility::Outside))
    {
        noise
    } else {
        0
    };
    a.visibility == b.visibility
        && a.rgba
            .chunks_exact(4)
            .zip(b.rgba.chunks_exact(4))
            .zip(&a.visibility)
            .all(|((x, y), v)| {
                *v == Visibility::Outside
                    || (x[3] == y[3]
                        && (0..3).map(|c| x[c].abs_diff(y[c]) as u32).sum::<u32>()
                            <= noise as u32 * 3)
            })
}

impl History {
    pub fn observe(&mut self, mut candidate: Candidate, noise: u8) {
        assert_eq!(candidate.rgba.len(), PIXELS * 4);
        assert_eq!(candidate.visibility.len(), PIXELS);
        let states: Vec<_> = candidate.visibility.iter().map(|v| *v as u8).collect();
        let exposure = Exposure {
            x: candidate.pose_x.div_euclid(16),
            y: candidate.pose_y.div_euclid(16),
            visibility: crc32fast::hash(&states),
        };
        candidate.exposures.push(exposure);
        if let Some(at) = self
            .resident
            .iter()
            .position(|c| equivalent(c, &candidate, noise) && c.frames.len() < 64)
        {
            let old = &mut self.resident[at];
            let frame = candidate.frame;
            if let Some(last) = old.frames.last_mut().filter(|s| {
                s.last.checked_add(1) == Some(frame)
                    && s.pose_x == candidate.pose_x
                    && s.pose_y == candidate.pose_y
            }) {
                last.last = frame;
            } else if !old.contains_frame(frame) {
                old.frames.push(FrameSpan {
                    first: frame,
                    last: frame,
                    pose_x: candidate.pose_x,
                    pose_y: candidate.pose_y,
                });
            }
            if old.exposures.len() < 8 && !old.exposures.contains(&exposure) {
                old.exposures.push(exposure);
            }
            if candidate.quality > old.quality {
                candidate.frames = std::mem::take(&mut old.frames);
                candidate.exposures = std::mem::take(&mut old.exposures);
                *old = candidate;
            }
            return;
        }
        if self.resident.len() == RESIDENT_CANDIDATES {
            // The disk archive is authoritative. Keep the strongest visible witnesses hot, but spill
            // every displaced candidate including its frame intervals and exact source provenance.
            let at = self
                .resident
                .iter()
                .enumerate()
                .min_by_key(|(_, c)| {
                    (
                        c.visibility
                            .iter()
                            .filter(|v| **v == Visibility::Visible)
                            .count(),
                        c.quality,
                        c.frame,
                    )
                })
                .map(|(i, _)| i)
                .unwrap();
            self.spilled.push(self.resident.remove(at));
        }
        self.resident.push(candidate);
    }

    pub fn take_spilled(&mut self) -> Vec<Candidate> {
        std::mem::take(&mut self.spilled)
    }
    pub fn resident_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.resident.capacity() * std::mem::size_of::<Candidate>()
            + self.spilled.capacity() * std::mem::size_of::<Candidate>()
            + self
                .resident
                .iter()
                .chain(&self.spilled)
                .map(|c| {
                    c.rgba.capacity()
                        + c.visibility.capacity() * std::mem::size_of::<Visibility>()
                        + c.frames.capacity() * std::mem::size_of::<FrameSpan>()
                        + c.exposures.capacity() * std::mem::size_of::<Exposure>()
                })
                .sum::<usize>()
    }
}
