//! The solve pass's keyframe index: which earlier keyframes a frame might be revisiting, by visual words.
//!
//! The index keeps only word postings in memory (per layer, per word, the keyframes that saw it, one per frame in
//! frame order), as the TypeScript `KeyframeIndex` it replaces did. The keyframes themselves are rows the host
//! stores (`keyframe/<id>`) and reads back. A revisit search is declare-then-provide: [`KeyframeIndex::retrieve`]
//! names up to [`MAX_CANDIDATES`] candidate keyframes, the host loads those rows, keeps the ones
//! [`Retrieval::admits`], and scores them with `long_screen_core`'s candidate evaluation.

use long_screen_core::features::{feature_words, DESCRIPTOR_WORDS};
use std::collections::{HashMap, HashSet};

/// A query needs at least this many features to search at all.
pub const MIN_FEATURES: usize = 8;
/// Words sampled from a query, spread evenly over all of its words.
pub const QUERY_WORDS: usize = 48;
/// Keyframes taken from each end of one word's posting.
pub const POSTING_SPREAD: usize = 48;
/// A posting longer than this overran the retrieval budget: [`BUDGET_DIAGNOSTIC`] is due for the layer.
pub const RETRIEVAL_BUDGET: usize = 96;
/// Candidates handed to evaluation, by vote count.
pub const MAX_CANDIDATES: usize = 12;
/// Votes a candidate needs.
pub const MIN_VOTES: u32 = 3;
/// Keyframes closer than this many frames to the query are odometry, not revisits, unless the query says otherwise.
pub const DEFAULT_MIN_GAP: u32 = 3;
/// The diagnostic code (severity warning) the host emits when [`Retrieval::budget_warning`] is set.
pub const BUDGET_DIAGNOSTIC: &str = "RELOCALIZATION_BUDGET";

/// One word's postings in one layer: interned keyframe ids in ascending frame order, one per frame.
#[derive(Default)]
struct Posting {
    frames: Vec<u32>,
    ids: Vec<u32>,
}

/// Visual words of the even-indexed descriptors (every other feature), as the index has always hashed them.
fn words(descriptors: &[[u32; DESCRIPTOR_WORDS]]) -> Vec<u32> {
    let even: Vec<[u32; DESCRIPTOR_WORDS]> = descriptors.iter().step_by(2).copied().collect();
    feature_words(&even)
}

/// The outcome of [`KeyframeIndex::retrieve`].
#[derive(Clone, Debug, PartialEq)]
pub struct Retrieval {
    /// Keyframe ids to load and evaluate, most votes first (ties in the order they first got a vote).
    pub candidates: Vec<String>,
    /// A posting overran [`RETRIEVAL_BUDGET`] and this layer has not been warned yet: emit [`BUDGET_DIAGNOSTIC`].
    pub budget_warning: bool,
    frame: u32,
    min_gap: u32,
}

impl Retrieval {
    /// Whether a loaded candidate keyframe at `keyframe_frame` is far enough from the query frame to be a revisit.
    pub fn admits(&self, keyframe_frame: u32) -> bool {
        keyframe_frame.abs_diff(self.frame) >= self.min_gap
    }
}

#[derive(Default)]
pub struct KeyframeIndex {
    ids: Vec<String>,
    interned: HashMap<String, u32>,
    postings: HashMap<String, HashMap<u32, Posting>>,
    warned_layers: HashSet<String>,
}

impl KeyframeIndex {
    pub fn new() -> Self {
        Self::default()
    }

    fn intern(&mut self, id: &str) -> u32 {
        if let Some(&i) = self.interned.get(id) {
            return i;
        }
        let i = self.ids.len() as u32;
        self.ids.push(id.to_string());
        self.interned.insert(id.to_string(), i);
        i
    }

    /// Posts keyframe `id` (of `layer`, at `frame`) under the words of its features' descriptors. A keyframe at a
    /// frame that already has one in a posting replaces it there.
    pub fn add(
        &mut self,
        id: &str,
        layer: &str,
        frame: u32,
        descriptors: &[[u32; DESCRIPTOR_WORDS]],
    ) {
        let interned = self.intern(id);
        let postings = self.postings.entry(layer.to_string()).or_default();
        for word in words(descriptors) {
            let Posting { frames, ids } = postings.entry(word).or_default();
            // Keyframes arrive in frame order, so this is almost always an append.
            let mut at = frames.len();
            while at > 0 && frames[at - 1] > frame {
                at -= 1;
            }
            if at > 0 && frames[at - 1] == frame {
                ids[at - 1] = interned;
            } else {
                frames.insert(at, frame);
                ids.insert(at, interned);
            }
        }
    }

    /// Candidate keyframes of `layer` for a query at `frame` with these feature descriptors, by word votes. Each
    /// sampled word votes for the earliest [`POSTING_SPREAD`] keyframes in its posting and, when the posting is
    /// longer, the latest ones too (so recent keyframes still get found on a long recording); `exclude` never gets
    /// a vote. `min_gap` (default [`DEFAULT_MIN_GAP`]) is what [`Retrieval::admits`] checks.
    pub fn retrieve(
        &mut self,
        layer: &str,
        frame: u32,
        descriptors: &[[u32; DESCRIPTOR_WORDS]],
        exclude: Option<&str>,
        min_gap: Option<u32>,
    ) -> Retrieval {
        let mut retrieval = Retrieval {
            candidates: Vec::new(),
            budget_warning: false,
            frame,
            min_gap: min_gap.unwrap_or(DEFAULT_MIN_GAP),
        };
        if descriptors.len() < MIN_FEATURES {
            return retrieval;
        }
        let all = words(descriptors);
        let step = (all.len() / QUERY_WORDS).max(1);
        let sampled = all.iter().step_by(step).take(QUERY_WORDS);
        let exclude = exclude.and_then(|id| self.interned.get(id).copied());
        // Insertion-ordered tally: the sort below is stable, so equal counts keep first-vote order.
        let mut votes: Vec<(u32, u32)> = Vec::new();
        let mut slot: HashMap<u32, usize> = HashMap::new();
        let mut vote = |id: u32| match slot.get(&id) {
            Some(&i) => votes[i].1 += 1,
            None => {
                slot.insert(id, votes.len());
                votes.push((id, 1));
            }
        };
        let mut truncated = false;
        let postings = self.postings.get(layer);
        for word in sampled {
            let ids = postings
                .and_then(|p| p.get(word))
                .map_or(&[][..], |p| p.ids.as_slice());
            if ids.len() > RETRIEVAL_BUDGET {
                truncated = true;
            }
            let mut seen = HashSet::new();
            for &id in ids.iter().take(POSTING_SPREAD) {
                if Some(id) == exclude {
                    continue;
                }
                seen.insert(id);
                vote(id);
            }
            if ids.len() > POSTING_SPREAD {
                for &id in ids[ids.len() - POSTING_SPREAD..].iter().rev() {
                    if Some(id) == exclude || !seen.insert(id) {
                        continue;
                    }
                    vote(id);
                }
            }
        }
        if truncated && self.warned_layers.insert(layer.to_string()) {
            retrieval.budget_warning = true;
        }
        votes.sort_by(|a, b| b.1.cmp(&a.1));
        retrieval.candidates = votes
            .into_iter()
            .take(MAX_CANDIDATES)
            .filter(|&(_, count)| count >= MIN_VOTES)
            .map(|(id, _)| self.ids[id as usize].clone())
            .collect();
        retrieval
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A descriptor whose first band hashes to word `w` (< 4096) and whose other bands hash to `w + 1000k`-ish
    /// words of their own; `d[k*2] ^ (d[k*2+1] >> 8)` is the band's word, so `d[k*2+1] = 0` makes it `d[k*2]`.
    fn descriptor(w: u32) -> [u32; DESCRIPTOR_WORDS] {
        let mut d = [0u32; DESCRIPTOR_WORDS];
        for k in 0..4 {
            d[k * 2] = (w + 1000 * k as u32) & 4095;
        }
        d
    }

    /// Features whose even-indexed descriptors carry `words` (odd ones are noise the index ignores).
    fn features(words: &[u32]) -> Vec<[u32; DESCRIPTOR_WORDS]> {
        words
            .iter()
            .flat_map(|&w| [descriptor(w), descriptor(4000)])
            .collect()
    }

    #[test]
    fn a_query_with_too_few_features_finds_nothing_and_never_warns() {
        let mut index = KeyframeIndex::new();
        index.add("L/1", "L", 1, &features(&[1, 2, 3, 4]));
        let r = index.retrieve("L", 50, &features(&[1, 2, 3, 4])[..7], None, None);
        assert_eq!(r.candidates, Vec::<String>::new());
        assert!(!r.budget_warning);
    }

    #[test]
    fn a_keyframe_needs_three_votes_and_only_its_own_layer_counts() {
        let mut index = KeyframeIndex::new();
        index.add("L/1", "L", 1, &features(&[1, 2, 3, 4]));
        index.add("L/2", "L", 2, &features(&[1, 2, 90, 91]));
        index.add("M/3", "M", 3, &features(&[1, 2, 3, 4]));
        let r = index.retrieve("L", 50, &features(&[1, 2, 3, 4]), None, None);
        // Each word's four bands vote: L/1 shares all bands of 1..4, L/2 those of 1 and 2.
        assert_eq!(r.candidates, ["L/1", "L/2"]);
        let none = index.retrieve("L", 50, &features(&[200, 201, 202, 203]), None, None);
        assert!(none.candidates.is_empty());
    }

    #[test]
    fn exclude_gets_no_vote() {
        let mut index = KeyframeIndex::new();
        index.add("L/1", "L", 1, &features(&[1, 2, 3, 4]));
        index.add("L/2", "L", 2, &features(&[1, 2, 3, 4]));
        let r = index.retrieve("L", 50, &features(&[1, 2, 3, 4]), Some("L/1"), None);
        assert_eq!(r.candidates, ["L/2"]);
    }

    #[test]
    fn ties_keep_first_vote_order_and_at_most_twelve_come_back() {
        let mut index = KeyframeIndex::new();
        for f in (0..20u32).rev() {
            // Added out of order on purpose: postings stay in frame order regardless.
            index.add(&format!("L/{f:02}"), "L", f, &features(&[1, 2, 3, 4]));
        }
        let r = index.retrieve("L", 500, &features(&[1, 2, 3, 4]), None, None);
        let expected: Vec<String> = (0..12).map(|f| format!("L/{f:02}")).collect();
        assert_eq!(r.candidates, expected);
    }

    /// The search reads a long posting as its earliest and its latest keyframes, so a posting must stay in frame
    /// order. Failure case: a keyframe for an earlier frame arriving after later ones (two layers' solve steps
    /// interleave, or a region re-minted from an older frame) appended at the end, taken for one of the latest.
    #[test]
    fn postings_stay_in_frame_order_whatever_order_keyframes_arrive_in() {
        let mut index = KeyframeIndex::new();
        for frame in [30u32, 10, 50, 20] {
            index.add(
                &format!("body/{frame}"),
                "body",
                frame,
                &features(&[1, 2, 3, 4]),
            );
        }
        let postings = &index.postings["body"];
        assert!(!postings.is_empty());
        for Posting { frames, ids } in postings.values() {
            assert_eq!(frames, &[10, 20, 30, 50]);
            let named: Vec<&str> = ids
                .iter()
                .map(|&i| index.ids[i as usize].as_str())
                .collect();
            assert_eq!(named, ["body/10", "body/20", "body/30", "body/50"]);
        }
    }

    #[test]
    fn a_later_keyframe_at_the_same_frame_replaces_the_earlier_one() {
        let mut index = KeyframeIndex::new();
        index.add("L/a", "L", 7, &features(&[1, 2, 3, 4]));
        index.add("L/b", "L", 7, &features(&[1, 2, 3, 4]));
        let r = index.retrieve("L", 50, &features(&[1, 2, 3, 4]), None, None);
        assert_eq!(r.candidates, ["L/b"]);
    }

    #[test]
    fn a_long_posting_votes_for_its_latest_keyframes_too_and_warns_once_per_layer() {
        let mut index = KeyframeIndex::new();
        for f in 0..120u32 {
            index.add(&format!("L/{f:03}"), "L", f, &features(&[1, 2, 3, 4]));
            index.add(&format!("M/{f:03}"), "M", f, &features(&[1, 2, 3, 4]));
        }
        let first = index.retrieve("L", 500, &features(&[1, 2, 3, 4]), None, None);
        assert!(
            first.budget_warning,
            "a 120-long posting overran the budget of 96"
        );
        // Earliest and latest get the same votes; earliest voted first.
        assert_eq!(first.candidates.len(), 12);
        assert_eq!(first.candidates[0], "L/000");
        let again = index.retrieve("L", 500, &features(&[1, 2, 3, 4]), None, None);
        assert!(!again.budget_warning, "warned once per layer");
        assert!(
            index
                .retrieve("M", 500, &features(&[1, 2, 3, 4]), None, None)
                .budget_warning
        );
        // Only the latest end of a posting, past the first 48: still found.
        let latest = index.retrieve("L", 500, &features(&[1, 2, 3, 4]), Some("L/000"), None);
        assert!(!latest.candidates.contains(&"L/000".to_string()));
    }

    #[test]
    fn the_latest_keyframes_of_a_long_posting_are_found() {
        let mut index = KeyframeIndex::new();
        for f in 0..60u32 {
            index.add(&format!("L/{f:03}"), "L", f, &features(&[1, 2, 3, 4]));
        }
        // The latest keyframe also carries extra words, so it out-votes the earliest ones.
        index.add("L/999", "L", 999, &features(&[1, 2, 3, 4, 5, 6]));
        let r = index.retrieve("L", 2000, &features(&[1, 2, 3, 4, 5, 6]), None, None);
        assert_eq!(r.candidates[0], "L/999");
        assert!(!r.budget_warning);
    }

    #[test]
    fn admits_keeps_odometry_neighbours_out() {
        let mut index = KeyframeIndex::new();
        let r = index.retrieve("L", 10, &[], None, None);
        assert!(!r.admits(8) && !r.admits(12) && r.admits(7) && r.admits(13));
        let wide = index.retrieve("L", 10, &[], None, Some(6));
        assert!(!wide.admits(5) && wide.admits(4) && wide.admits(16));
    }
}
