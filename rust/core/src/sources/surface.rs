//! A tracked object's native appearance, including the flat surface between its textured anchors.
//! The object must first be identified by motion; these pixels only transfer that identity through
//! pauses, reversals and brief disappearance. Colour mismatches remain unknown.
use super::objects::{Bounds, MaskRun, View};
#[derive(Clone)]
pub struct Surface {
    pub bounds: Bounds,
    rgba: Vec<u8>,
    valid: Vec<u8>,
}
impl Surface {
    pub fn bytes(&self) -> usize {
        self.rgba.capacity() + self.valid.capacity()
    }
    pub fn shift(&mut self, dx: i32, dy: i32) {
        self.bounds.x += dx;
        self.bounds.y += dy;
    }
    pub fn updated(
        old: Option<&Self>,
        view: View<'_>,
        runs: &[MaskRun],
        budget: usize,
    ) -> Option<Self> {
        let mut bounds = old.map(|s| s.bounds);
        for run in runs {
            let r = Bounds {
                x: run.x,
                y: run.y,
                width: run.length as i32,
                height: 1,
            };
            bounds = Some(if let Some(b) = bounds {
                let x = b.x.min(r.x);
                let y = b.y.min(r.y);
                Bounds {
                    x,
                    y,
                    width: (b.x + b.width).max(r.x + r.width) - x,
                    height: (b.y + b.height).max(r.y + r.height) - y,
                }
            } else {
                r
            });
        }
        let b = bounds?;
        let n = b.width as usize * b.height as usize;
        if n * 4 + n.div_ceil(8) > budget {
            return None;
        }
        let mut next = Self {
            bounds: b,
            rgba: vec![0; n * 4],
            valid: vec![0; n.div_ceil(8)],
        };
        if let Some(old) = old {
            for y in 0..old.bounds.height {
                for x in 0..old.bounds.width {
                    let i = (y * old.bounds.width + x) as usize;
                    if old.valid[i / 8] & (1 << (i & 7)) == 0 {
                        continue;
                    }
                    let at = ((y + old.bounds.y - b.y) * b.width + x + old.bounds.x - b.x) as usize;
                    next.rgba[at * 4..at * 4 + 4].copy_from_slice(&old.rgba[i * 4..i * 4 + 4]);
                    next.valid[at / 8] |= 1 << (at & 7);
                }
            }
        }
        for run in runs {
            for x in run.x..run.x + run.length as i32 {
                let at = ((run.y - b.y) * b.width + x - b.x) as usize;
                let src = (run.y as usize * view.width + x as usize) * 4;
                next.rgba[at * 4..at * 4 + 4].copy_from_slice(&view.rgba[src..src + 4]);
                next.valid[at / 8] |= 1 << (at & 7);
            }
        }
        Some(next)
    }
    pub fn matching(&self, view: View<'_>, noise: u8, _visibility: &mut [u8]) -> Vec<MaskRun> {
        let b = self.bounds;
        let mut runs = Vec::new();
        for y in b.y.max(0)..(b.y + b.height).min(view.height as i32) {
            let mut start = None;
            for x in b.x.max(0)..=(b.x + b.width).min(view.width as i32) {
                let on = if x < (b.x + b.width).min(view.width as i32) {
                    let at = ((y - b.y) * b.width + x - b.x) as usize;
                    let i = y as usize * view.width + x as usize;
                    self.valid[at / 8] & (1 << (at & 7)) != 0
                        && view.labels[i] != 0
                        && (0..3)
                            .map(|c| self.rgba[at * 4 + c].abs_diff(view.rgba[i * 4 + c]) as u32)
                            .sum::<u32>()
                            <= noise as u32 * 3
                } else {
                    false
                };
                if on && start.is_none() {
                    start = Some(x);
                }
                if !on {
                    if let Some(s) = start.take() {
                        runs.push(MaskRun {
                            x: s,
                            y,
                            length: (x - s) as u32,
                        });
                    }
                }
            }
        }
        runs
    }
}
