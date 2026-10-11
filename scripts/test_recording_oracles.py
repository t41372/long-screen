"""Failure cases for the recording oracles' run completeness and single-frame (epoch) certification.

Run: python3 scripts/test_recording_oracles.py
"""
import json
from pathlib import Path
import sys
import tempfile
import unittest

from importlib.util import module_from_spec, spec_from_file_location

# Loading the checker as a module would otherwise leave a __pycache__ next to it.
sys.dont_write_bytecode = True
spec = spec_from_file_location('oracles', Path(__file__).with_name('check-recording-oracles.py'))
oracles = module_from_spec(spec)
spec.loader.exec_module(oracles)

UNTOUCHED, MIXED = -1, -2


def evidence(*rows):
    return {'rows': {'reveal/': list(rows)}}


def provenance(source, canvas='canvas', gx=0, gy=0, bw=2, bh=2, version=1):
    """A reveal/<canvas> row: per 16-pixel block of the bw×bh grid at block (gx, gy), the frame it was copied from."""
    return {'key': f'reveal/{canvas}', 'version': version, 'gx': gx, 'gy': gy, 'bw': bw, 'bh': bh, 'source': source}


class EpochCertification(unittest.TestCase):
    def test_blocks_from_one_frame_certify_it(self):
        plans = oracles.complete_epoch_plans(evidence(provenance([7, 7, 7, 7])), 'canvas', [0, 0, 32, 32])
        self.assertEqual([p['frame'] for p in plans], [7])

    def test_blocks_from_two_frames_never_certify(self):
        self.assertEqual(oracles.complete_epoch_plans(evidence(provenance([7, 7, 7, 8])), 'canvas', [0, 0, 32, 32]), [])

    def test_untouched_or_mixed_blocks_never_certify(self):
        for marker in [UNTOUCHED, MIXED]:
            row = provenance([marker] * 4)
            self.assertEqual(oracles.complete_epoch_plans(evidence(row), 'canvas', [0, 0, 32, 32]), [], marker)
            row = provenance([7, 7, 7, marker])
            self.assertEqual(oracles.complete_epoch_plans(evidence(row), 'canvas', [0, 0, 32, 32]), [], marker)

    def test_only_the_blocks_under_the_rectangle_count(self):
        # The rectangle covers the top-left block alone; the others may come from anywhere.
        row = provenance([7, MIXED, UNTOUCHED, 9])
        self.assertEqual([p['frame'] for p in oracles.complete_epoch_plans(evidence(row), 'canvas', [2, 3, 10, 10])], [7])

    def test_negative_world_coordinates(self):
        row = provenance([7, 7, 7, 7], gx=-1, gy=-1)
        plans = oracles.complete_epoch_plans(evidence(row), 'canvas', [-16, -16, 32, 32])
        self.assertEqual([p['frame'] for p in plans], [7])
        # One pixel past the grid's left edge.
        self.assertEqual(oracles.complete_epoch_plans(evidence(row), 'canvas', [-17, -16, 32, 32]), [])

    def test_a_rectangle_outside_the_grid_is_not_certified(self):
        self.assertEqual(oracles.complete_epoch_plans(evidence(provenance([7] * 4)), 'canvas', [16, 16, 32, 32]), [])

    def test_foreign_canvas_is_not_a_certificate(self):
        self.assertEqual(oracles.complete_epoch_plans(evidence(provenance([7] * 4, canvas='other')), 'canvas', [0, 0, 32, 32]), [])

    def test_unsupported_version_is_rejected(self):
        with self.assertRaises(ValueError):
            oracles.complete_epoch_plans(evidence(provenance([7] * 4, version=2)), 'canvas', [0, 0, 32, 32])

    def test_a_source_list_that_does_not_fill_the_grid_is_rejected(self):
        with self.assertRaises(ValueError):
            oracles.complete_epoch_plans(evidence(provenance([7] * 3)), 'canvas', [0, 0, 16, 16])


class RunCompleteness(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def outcome(self, **changes):
        row = {'status': 'complete', 'source': {'frames': 2}, 'pipeline': {'frames': 2, 'renderedFrames': 2}}
        row.update(changes)
        (self.root / 'benchmark-pass-1.json').write_text(json.dumps(row))

    def test_missing_engine_outcome_fails_closed(self):
        self.assertFalse(oracles.engine_completeness(self.root)['complete'])

    def test_partial_or_failed_run_cannot_certify_pixels(self):
        for status in ['stopped', 'error', 'partial']:
            self.outcome(status=status)
            self.assertFalse(oracles.engine_completeness(self.root)['complete'], status)
        self.outcome(pipeline={'frames': 2, 'renderedFrames': 1})
        self.assertFalse(oracles.engine_completeness(self.root)['complete'])
        self.outcome(source={'frames': 3})
        self.assertFalse(oracles.engine_completeness(self.root)['complete'])
        self.outcome(pipeline={'frames': 0, 'renderedFrames': 0})
        self.assertFalse(oracles.engine_completeness(self.root)['complete'])

    def test_complete_run_is_accepted(self):
        self.outcome()
        self.assertTrue(oracles.engine_completeness(self.root)['complete'])


if __name__ == '__main__':
    unittest.main()
