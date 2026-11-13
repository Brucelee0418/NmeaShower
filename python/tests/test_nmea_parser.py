"""nmea_parser 的单元测试（标准库 unittest）。

运行::

    python -m unittest discover -s tests -v
"""

from __future__ import annotations

import datetime as dt
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nmea_parser import (  # noqa: E402
    haversine,
    nmea_checksum,
    parse_coordinate,
    parse_date,
    parse_lines,
    parse_sentence,
    parse_time,
    summarize,
)

def sentence(body: str) -> str:
    """按 NMEA 规则给语句正文补上正确的校验和。"""
    return f"${body}*{nmea_checksum(body):02X}"


RMC = sentence(
    "GNRMC,145009.55,A,3112.496210,N,12138.669951,E,2.1,305.6,061126,6.8,W,A,V"
)
GGA = sentence(
    "GNGGA,145009.55,3112.496210,N,12138.669951,E,1,12,1.5,36.2,M,12.4,M,,"
)
GSA = sentence("GNGSA,A,3,03,06,11,19,,,,,,,,,1.9,1.5,1.0,1")
VTG = sentence("GNVTG,305.6,T,312.4,M,2.1,N,3.9,K,A")
GSV1 = sentence("GPGSV,3,1,12,03,35,045,36,06,48,283,34,09,14,136,23,11,20,260,31,1")
GSV2 = sentence("GPGSV,3,2,12,12,05,323,43,17,67,041,24,19,54,332,40,22,64,211,24,1")
GSV3 = sentence("GPGSV,3,3,12,01,07,059,,04,15,183,,14,44,183,,21,05,208,,1")


class ChecksumTest(unittest.TestCase):
    def test_known_checksum(self):
        body = "GNRMC,145009.55,A,3112.496210,N,12138.669951,E,2.1,305.6,061126,6.8,W,A,V"
        self.assertEqual(nmea_checksum(body), 0x41)

    def test_parse_valid_sentence(self):
        parsed = parse_sentence(RMC, line_no=7)
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual((parsed.talker, parsed.type), ("GN", "RMC"))
        self.assertEqual(parsed.system, "MULTI")
        self.assertTrue(parsed.checksum_ok)
        self.assertEqual(parsed.line_no, 7)

    def test_bad_checksum_flagged(self):
        sentence_obj = parse_sentence(RMC[:-2] + "00")
        assert sentence_obj is not None
        self.assertFalse(sentence_obj.checksum_ok)

    def test_private_sentence_ignored(self):
        self.assertIsNone(parse_sentence("PQWM2,111, , 0S48,3S50,"))
        self.assertIsNone(parse_sentence(""))


class FieldParsingTest(unittest.TestCase):
    def test_coordinates(self):
        self.assertAlmostEqual(parse_coordinate("3112.496210", "N"), 31.20827016, places=7)
        self.assertAlmostEqual(parse_coordinate("12138.669951", "E"), 121.64449918, places=7)
        self.assertAlmostEqual(parse_coordinate("3112.496210", "S"), -31.20827016, places=7)
        self.assertAlmostEqual(parse_coordinate("00012.5", "W"), -0.20833333, places=6)
        self.assertIsNone(parse_coordinate("", "N"))
        self.assertIsNone(parse_coordinate("abc", "N"))

    def test_time_and_date(self):
        self.assertEqual(parse_time("145009.55"), ("14:50:09.550", 53409.55))
        self.assertIsNone(parse_time(""))
        self.assertIsNone(parse_time("999999"))
        self.assertEqual(parse_date("061126"), dt.date(2026, 11, 6))
        self.assertIsNone(parse_date("321326"))

    def test_haversine(self):
        # 纬度相差 1 度约 111.2 km
        self.assertAlmostEqual(haversine(31.0, 121.0, 32.0, 121.0), 111_195, delta=200)


class ParsingPipelineTest(unittest.TestCase):
    def _sample(self):
        return [GSV1, GSV2, GSV3, GSA, VTG, RMC, GGA]

    def test_epoch_fields(self):
        result = parse_lines(self._sample())
        self.assertEqual(len(result.epochs), 1)
        epoch = result.epochs[0]
        self.assertEqual(epoch.time, "14:50:09.550")
        self.assertEqual(epoch.date, dt.date(2026, 11, 6))
        self.assertEqual(epoch.datetime_iso, "2026-11-06T14:50:09.550")
        self.assertAlmostEqual(epoch.lat, 31.20827016, places=7)
        self.assertAlmostEqual(epoch.lon, 121.64449918, places=7)
        self.assertAlmostEqual(epoch.altitude, 36.2, places=3)
        self.assertAlmostEqual(epoch.geoid_separation, 12.4, places=3)
        self.assertAlmostEqual(epoch.ellipsoid_height, 48.6, places=3)
        self.assertAlmostEqual(epoch.speed_knots, 2.1, places=3)
        self.assertAlmostEqual(epoch.speed_kmh, 3.9, places=3)
        self.assertAlmostEqual(epoch.course, 305.6, places=1)
        self.assertEqual(epoch.fix_quality, 1)
        self.assertEqual(epoch.fix_type, 3)
        self.assertEqual(epoch.num_sats_used, 12)
        self.assertEqual(epoch.hdop, 1.5)
        self.assertEqual(epoch.pdop, 1.9)

    def test_satellites(self):
        result = parse_lines(self._sample())
        epoch = result.epochs[0]
        self.assertEqual(len(epoch.satellites), 12)
        first = epoch.satellites[("GPS", "03")]
        self.assertEqual((first.elevation, first.azimuth, first.cn0), (35, 45, 36))
        self.assertEqual(first.sky_r, 55)
        # cn0 为空的卫星仍然保留仰角/方位角
        no_cn0 = epoch.satellites[("GPS", "01")]
        self.assertIsNone(no_cn0.cn0)
        self.assertEqual(no_cn0.azimuth, 59)

    def test_gsv_before_anchor_belongs_to_first_epoch(self):
        result = parse_lines([GSV1, RMC, GGA, GSV2])
        self.assertEqual(len(result.epochs), 1)
        # 第二段 GSV 应并入同一历元，共 8 颗
        self.assertEqual(len(result.epochs[0].satellites), 8)

    def test_groups_epochs_by_timestamp(self):
        second_rmc = sentence(
            "GNRMC,145010.55,A,3112.510324,N,12138.664178,E,1.7,326.5,061126,6.8,W,A,V"
        )
        second_gga = sentence(
            "GNGGA,145010.55,3112.510324,N,12138.664178,E,1,12,0.7,40.0,M,12.4,M,,"
        )
        result = parse_lines([RMC, GGA, GSV1, second_rmc, second_gga, GSV2])
        self.assertEqual(len(result.epochs), 2)
        self.assertEqual(result.epochs[0].time, "14:50:09.550")
        self.assertEqual(result.epochs[1].time, "14:50:10.550")
        self.assertAlmostEqual(result.epochs[1].altitude, 40.0)
        self.assertEqual(len(result.epochs[0].satellites), 4)
        self.assertEqual(len(result.epochs[1].satellites), 4)

    def test_duplicate_prn_prefers_entry_with_cn0(self):
        weaker = sentence("GPGSV,1,1,01,03,35,045,,1")
        stronger = sentence("GPGSV,1,1,01,03,35,045,31,1")
        result = parse_lines([RMC, GGA, weaker, stronger])
        satellite = result.epochs[0].satellites[("GPS", "03")]
        self.assertEqual(satellite.cn0, 31)

    def test_checksum_error_dropped_by_default(self):
        broken = RMC[:-2] + "00"
        result = parse_lines([broken, GGA])
        self.assertEqual(result.stats["checksum_errors"], 1)
        self.assertEqual(result.stats["sentences"], 1)
        self.assertEqual(len(result.epochs), 1)

    def test_checksum_error_kept_when_not_strict(self):
        broken = RMC[:-2] + "00"
        result = parse_lines([broken, GGA], strict_checksum=False)
        self.assertEqual(result.stats["checksum_errors"], 1)
        self.assertEqual(result.stats["sentences"], 2)
        self.assertAlmostEqual(result.epochs[0].speed_kmh, 2.1 * 1.852, places=3)

    def test_invalid_fix_fields_ignored(self):
        empty = "$GPRMC,,V,,,,,,,,,,N,V*29"
        result = parse_lines([empty])
        self.assertEqual(result.epochs, [])
        self.assertEqual(result.stats["sentences"], 1)

    def test_summary(self):
        result = parse_lines(self._sample())
        summary = summarize(result)
        self.assertEqual(summary["epochs"], 1)
        self.assertEqual(summary["fixEpochs"], 1)
        self.assertEqual(summary["time"]["start"], "2026-11-06T14:50:09.550")
        self.assertAlmostEqual(summary["altitudeMeters"]["mean"], 36.2)
        self.assertEqual(summary["satsUsed"]["max"], 12)
        self.assertEqual(summary["systems"]["GPS"], 12)
        self.assertEqual(summary["cn0"]["samples"], 8)


if __name__ == "__main__":
    unittest.main()
