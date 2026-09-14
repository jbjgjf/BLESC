"""Both write paths must enforce the same maximum retention for new text."""
import os
import unittest
from unittest.mock import patch

from app.services.raw_text_crypto import retention_days


class RawTextRetentionTest(unittest.TestCase):
    def test_default(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(retention_days(), 90)

    def test_overrides_cannot_extend_retention(self):
        for value in ["", "0", "-1", "NaN", "Infinity", "1.5", "1e2", "junk", "91", "180", "9007199254740993"]:
            with self.subTest(value=value), patch.dict(os.environ, {"RESEARCH_RAW_TEXT_RETENTION_DAYS": value}):
                self.assertEqual(retention_days(), 90)

    def test_valid_shorter_windows(self):
        for value, expected in [("30", 30), (" 1 ", 1), ("90", 90)]:
            with patch.dict(os.environ, {"RESEARCH_RAW_TEXT_RETENTION_DAYS": value}):
                self.assertEqual(retention_days(), expected)
