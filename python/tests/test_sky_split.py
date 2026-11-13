"""sky_split 的单元测试（标准库 unittest + numpy/sklearn）。

运行::

    python -m unittest discover -s tests -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import sky_split as ss  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def make_sky_data(
    azimuths: np.ndarray,
    elevations: np.ndarray,
    cn0: np.ndarray,
    n_epochs: int = 60,
    systems: list[str] | None = None,
) -> ss.SkyData:
    """把"每颗星一个固定位置 + 一条 cn0 序列"拼成 SkyData。"""
    azimuths = np.asarray(azimuths, dtype=float)
    elevations = np.asarray(elevations, dtype=float)
    cn0 = np.asarray(cn0, dtype=float)          # (n_sat, n_epochs)
    n_sat = azimuths.size
    systems = systems or ["GPS"] * n_sat

    epoch = np.repeat(np.arange(n_epochs, dtype=np.int32), n_sat)
    sat = np.tile(np.arange(n_sat, dtype=np.int32), n_epochs)
    el = np.tile(elevations, n_epochs)
    az = np.tile(azimuths, n_epochs)
    values = cn0.T.reshape(-1).astype(float)

    return ss.SkyData(
        times=np.arange(n_epochs, dtype=float),
        time_text=[f"00:00:{index:02d}.000" for index in range(n_epochs)],
        epoch=epoch,
        sat=sat,
        sat_names=[(system, f"{index + 1:02d}") for index, system in enumerate(systems)],
        el=el,
        az=az,
        cn0=values,
        source="synthetic",
    )


def synthetic_scene(
    center: float = 0.0,
    half_width: float = 70.0,
    n_direct: int = 22,
    n_blocked: int = 20,
    seed: int = 7,
) -> ss.SkyData:
    """构造"朝 center 的直射带 + 其余方向遮挡"的合成观测。"""
    rng = np.random.default_rng(seed)
    direct_az = center + rng.uniform(-half_width, half_width, n_direct)
    direct_el = rng.uniform(8.0, 85.0, n_direct)
    blocked_az = center + 110.0 + rng.uniform(0.0, 140.0, n_blocked)
    blocked_el = rng.uniform(5.0, 85.0, n_blocked)

    n_epochs = 60
    direct_cn0 = rng.normal(38.0, 1.5, size=(n_direct, n_epochs))
    blocked_cn0 = rng.normal(22.0, 1.5, size=(n_blocked, n_epochs))
    # 三分之一的遮挡星完全跟踪不到
    blocked_cn0[: n_blocked // 3] = 0.0
    cn0 = np.vstack([direct_cn0, blocked_cn0])

    return make_sky_data(
        np.concatenate([direct_az, blocked_az]) % 360.0,
        np.concatenate([direct_el, blocked_el]),
        cn0,
        n_epochs=n_epochs,
    )


class HelpersTest(unittest.TestCase):
    def test_wrap180(self):
        self.assertAlmostEqual(float(ss.wrap180(350.0)), -10.0)
        self.assertAlmostEqual(float(ss.wrap180(-190.0)), 170.0)

    def test_circular_mean_wraps(self):
        value = ss.circular_mean(np.array([350.0, 10.0]))
        self.assertLess(abs(ss.wrap180(value)), 1e-9)

    def test_otsu_splits_two_modes(self):
        values = np.concatenate([np.full(400, 20.0), np.full(400, 40.0)])
        threshold = ss.otsu_threshold(values)
        self.assertTrue(20.0 < threshold < 40.0)

    def test_unit_vectors(self):
        vector = ss.unit_vectors(np.array([90.0]), np.array([0.0]))[0]
        self.assertAlmostEqual(float(vector[0]), 1.0)   # 东
        self.assertAlmostEqual(float(vector[1]), 0.0, places=9)
        self.assertAlmostEqual(float(ss.unit_vectors(np.array([0.0]), np.array([90.0]))[0][2]), 1.0)


class GeometryTest(unittest.TestCase):
    def test_scan_recovers_orientation(self):
        data = synthetic_scene(center=0.0, half_width=70.0)
        scan = ss.scan_orientation(ss.summarize_satellites(data))
        self.assertLess(abs(float(ss.wrap180(scan.center_azimuth))), 12.0)
        self.assertAlmostEqual(scan.half_width, 70.0, delta=18.0)

    def test_scan_is_rotation_equivariant(self):
        for beta in (10.0, 90.0, 233.0):
            data = synthetic_scene(center=0.0).rotated(beta)
            scan = ss.scan_orientation(ss.summarize_satellites(data))
            self.assertLess(abs(float(ss.wrap180(scan.center_azimuth - beta))), 12.0)

    def test_pca_width(self):
        data = synthetic_scene(center=0.0, half_width=70.0)
        summaries = ss.summarize_satellites(data)
        scan = ss.scan_orientation(summaries)
        pca = ss.band_pca(data, summaries, reference_azimuth=scan.center_azimuth)
        self.assertGreater(pca.n_points, 8)
        # PCA 给的是密度加权尺度（不是边界），允许 25° 的偏差
        self.assertAlmostEqual(pca.half_width, 70.0, delta=25.0)
        self.assertGreater(pca.half_width, 35.0)
        self.assertGreater(float(pca.explained[0]), 0.4)
        # PCA 中心是密度加权估计，只作为扫描朝向的交叉验证
        self.assertLess(abs(float(ss.wrap180(pca.center_azimuth - scan.center_azimuth))), 30.0)

    def test_band_curves(self):
        data = synthetic_scene(center=0.0, half_width=70.0)
        summaries = ss.summarize_satellites(data)
        scan = ss.scan_orientation(summaries)
        nearest = min(summaries, key=lambda sat: abs(float(ss.wrap180(sat.azimuth - scan.center_azimuth))))
        probability = np.array([
            1.0 if abs(float(ss.wrap180(s.azimuth - nearest.azimuth))) <= 72.0 else 0.0
            for s in summaries
        ])
        curves = ss.fit_band_curves(
            np.array([s.azimuth for s in summaries]),
            np.array([s.elevation for s in summaries]),
            probability,
            scan.center_azimuth,
        )
        self.assertAlmostEqual(curves.west[0], 72.0, delta=18.0)
        self.assertAlmostEqual(curves.east[0], 72.0, delta=18.0)
        self.assertLess(abs(curves.area_fraction(scan.center_azimuth) - 0.4), 0.12)
        # 掩膜与曲线自洽：边界上的点应当正好在边界上
        inside = curves.mask(np.array([scan.center_azimuth + 10.0]), np.array([30.0]), scan.center_azimuth)
        outside = curves.mask(np.array([scan.center_azimuth + 170.0]), np.array([30.0]), scan.center_azimuth)
        self.assertTrue(bool(inside[0]))
        self.assertFalse(bool(outside[0]))


class FeatureAndModelTest(unittest.TestCase):
    def test_window_features(self):
        data = synthetic_scene()
        current = ss.window_features(data, 0.0)
        past = ss.window_features(data, 5.0)
        self.assertEqual(current.shape, (data.n_records, 3))
        # 0 秒窗口：峰值 == 均值 == 当前 cn0
        np.testing.assert_allclose(current[:, 0], data.cn0)
        np.testing.assert_allclose(current[:, 1], data.cn0)
        # 5 秒窗口的均值不应超过峰值
        self.assertTrue(np.all(past[:, 1] <= past[:, 0] + 1e-9))

    def test_classifier_separates_direct_and_blocked(self):
        data = synthetic_scene(center=0.0, half_width=70.0)
        features = ss.window_features(data, 5.0)
        classifier = ss.fit_classifier(features, 5.0)
        # 合成数据里"直射星"的 cn0 均值在 38 左右，"遮挡星"在 22 或 0
        truth = {}
        for group in data.groups():
            truth[int(data.sat[group[0]])] = float(data.cn0[group].mean()) > 30.0
        satellite_probability = {}
        for group in data.groups():
            satellite_probability[int(data.sat[group[0]])] = float(classifier.probability[group].mean())
        direct = [satellite_probability[index] for index, value in truth.items() if value]
        blocked = [satellite_probability[index] for index, value in truth.items() if not value]
        self.assertTrue(direct)
        self.assertTrue(blocked)
        self.assertGreater(min(direct), 0.9)
        self.assertLess(max(blocked), 0.1)
        self.assertEqual(int(classifier.direct_component), int(np.argmax(classifier.means[:, 0])))

    def test_curve_scaling_stays_inside_limits(self):
        data = synthetic_scene()
        summaries = ss.summarize_satellites(data)
        scan = ss.scan_orientation(summaries)
        curves = ss.fit_band_curves(
            np.array([s.azimuth for s in summaries]),
            np.array([s.elevation for s in summaries]),
            np.array([1.0 if s.strength > 30 else 0.0 for s in summaries]),
            scan.center_azimuth,
        )
        west_scale, east_scale = ss.scale_band_curves(
            curves,
            np.array([s.azimuth for s in summaries]),
            np.array([s.elevation for s in summaries]),
            np.array([1.0 if s.strength > 30 else 0.0 for s in summaries]),
            scan.center_azimuth,
        )
        self.assertGreaterEqual(west_scale, 0.6)
        self.assertLessEqual(east_scale, 1.5)


class RealLogTest(unittest.TestCase):
    """对仓库里的 nmea.log 做一次快速校验（只跑几何部分，不跑全流水线）。"""

    @classmethod
    def setUpClass(cls):
        path = ROOT / "nmea.log"
        if not path.is_file():
            raise unittest.SkipTest("缺少 nmea.log")
        cls.data = ss.load_sky_data(path)
        cls.summaries = ss.summarize_satellites(cls.data)
        cls.scan = ss.scan_orientation(cls.summaries)
        cls.pca = ss.band_pca(cls.data, cls.summaries, reference_azimuth=cls.scan.center_azimuth)

    def test_epochs_and_satellites(self):
        self.assertEqual(self.data.n_epochs, 428)
        self.assertEqual(len(self.summaries), 55)
        self.assertEqual(self.data.n_records, 18811)

    def test_orientation_matches_expected_north_band(self):
        self.assertAlmostEqual(self.scan.center_azimuth, 332.8, delta=6.0)
        self.assertAlmostEqual(self.scan.half_width, 71.6, delta=6.0)
        self.assertAlmostEqual(self.pca.half_width, 72.7, delta=6.0)

    def test_south_is_blocked(self):
        """南侧可以有弱信号（绕射/多径），但不应该有强信号；北侧相反。"""
        south_means = []
        north_means = []
        for group, summary in zip(self.data.groups(), self.summaries):
            offset = float(ss.wrap180(summary.azimuth - self.scan.center_azimuth))
            mean_cn0 = float(self.data.cn0[group].mean())
            if 95.0 < abs(offset) < 165.0:
                south_means.append(mean_cn0)
            elif abs(offset) < 55.0:
                north_means.append(mean_cn0)
        self.assertTrue(south_means)
        self.assertLess(max(south_means), 27.0)
        self.assertGreater(min(north_means), 20.0)
        self.assertGreater(max(north_means), 35.0)


if __name__ == "__main__":
    unittest.main()
