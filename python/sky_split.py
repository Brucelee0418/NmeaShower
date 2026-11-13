#!/usr/bin/env python3
"""task3：用无监督学习从 NMEA 卫星观测里分割"直射天空 / 建筑遮挡天空"。

算法分成四层，全部无监督、不使用决策树类模型：

1. **整体朝向扫描**：把每颗卫星在整个观测时段内的平均载噪比当作"这条方位上
   天空好不好"的证据，遍历 ``(中心方位 φ0, 半宽 w)`` 组合，用两类间方差
   （Otsu 型判据）找把天空分成"强 / 弱"两半最干净的那条带，得到卫星的整体朝向。
2. **强星 PCA**：对强星的 3 维单位球坐标做主成分分析。直射区若是一条竖直的带
   （lune），第一主成分沿带的横向，其标准差 σ1 与带的半宽满足
   ``sin(w) = √3·σ1``（带内方位均匀分布），据此得到直射带宽度。
3. **监督信号分类（GMM）**：对每条"卫星 × 历元"观测，取当前/过去 5 s/过去 10 s
   窗口内的 ``[cn0 峰值, cn0 均值, 跟踪率]``，用高斯混合模型做 2 类软聚类，
   cn0 高的分量判为直射、低的分量为非直射（NLOS）。这是任务里"用机器学习模型"
   的部分，属于无监督密度聚类，不含任何树模型。
4. **两条边界曲线**：在朝向坐标系里，对每个仰角带分别用加权最大对比割确定
   "直射带东边界 / 西边界"，再按仰角线性回归得到两条光滑曲线，把天空分成
   带内（直射）与带外（遮挡）。这两条曲线也是星空图上叠加显示的分割结果。

此外还提供两项稳定性实验：

* **时间窗抖动仿真**：分别用当前 1 s、过去 5 s、过去 10 s 的观测重算分类与边界，
  统计标签翻转率、边界抖动、相邻历元掩膜 IoU 等指标，量化"模型抖动"。
* **旋转数据增强**：把方位角每 10° 旋转一次（共 36 组），整条流水线重跑，
  检验朝向、带宽、遮挡面积、分割掩膜是否随旋转等变。

用法::

    python sky_split.py                     # 分析 nmea.log，写出 out/sky_split/* 与 out/sky_split.json
    python sky_split.py --window 5          # 只跑 5 s 窗口
    python sky_split.py --rot-step 10       # 旋转增强步长
    python sky_split.py --print              # 额外打印关键指标

依赖：numpy、scikit-learn（解析部分仍只用标准库）。
"""

from __future__ import annotations

import argparse
import json
import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

# sklearn 在 Windows 上探测物理核数会调用 wmic，屏蔽这条无关警告
os.environ.setdefault("LOKY_MAX_CPU_COUNT", "4")

import numpy as np

from nmea_parser import parse_file

BASE = Path(__file__).resolve().parent

__all__ = [
    "SkyData",
    "SatelliteSummary",
    "OrientationScan",
    "BandPCA",
    "BandCurves",
    "SkySplitResult",
    "load_sky_data",
    "summarize_satellites",
    "scan_orientation",
    "band_pca",
    "window_features",
    "fit_classifier",
    "fit_band_curves",
    "analyse",
    "jitter_study",
    "rotation_study",
    "validate",
]

# --------------------------------------------------------------------------- #
# 常量
# --------------------------------------------------------------------------- #
#: 参与抖动仿真的时间窗（秒）。0 = 只用当前 1 s 历元
DEFAULT_WINDOWS: tuple[float, ...] = (0.0, 5.0, 10.0)
#: 边界曲线拟合使用的仰角带
ELEVATION_BANDS: tuple[tuple[float, float], ...] = ((0.0, 30.0), (30.0, 60.0), (60.0, 90.0))
#: 边界曲线输出用的仰角节点
CURVE_KNOTS = np.arange(0.0, 90.0 + 1e-9, 5.0)
#: 区域统计 / 掩膜用的天空网格
GRID_AZ = np.arange(0.0, 360.0, 2.0)
GRID_EL = np.arange(2.5, 90.0, 5.0)
#: 强星筛选：跟踪率下限
STRONG_TRACK_RATIO = 0.85
#: 强星筛选：峰值 cn0 至少要比 Otsu 阈值高这么多
STRONG_MARGIN = 0.0
#: 分类特征名（跟踪信息通过 cn0_mean 的零值与"未跟踪即非直射"先验进入模型）
FEATURE_NAMES = ("cn0_peak", "cn0_mean")
#: 参与聚类的特征列（track_ratio 受各星座 GSV 播报节奏影响，见报告说明）
CLUSTER_COLUMNS = (0, 1)
#: 分类器随机种子
RANDOM_SEED = 20261106


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #
def wrap180(values: np.ndarray | float) -> np.ndarray | float:
    """把角度差折算到 (-180, 180]。"""
    return (np.asarray(values) + 180.0) % 360.0 - 180.0


def circular_mean(angles: np.ndarray, weights: np.ndarray | None = None) -> float:
    """加权圆均值，返回 [0, 360)。"""
    angles = np.asarray(angles, dtype=float)
    if angles.size == 0:
        return float("nan")
    weights = np.ones_like(angles) if weights is None else np.asarray(weights, dtype=float)
    total = weights.sum()
    if total <= 0:
        return float("nan")
    x = float((np.cos(np.radians(angles)) * weights).sum() / total)
    y = float((np.sin(np.radians(angles)) * weights).sum() / total)
    return math.degrees(math.atan2(y, x)) % 360.0


def unit_vectors(az: np.ndarray, el: np.ndarray) -> np.ndarray:
    """方位/仰角（度）-> 3 维单位向量，x=东、y=北、z=天顶。"""
    az_rad = np.radians(np.asarray(az, dtype=float))
    el_rad = np.radians(np.asarray(el, dtype=float))
    cos_el = np.cos(el_rad)
    return np.column_stack([cos_el * np.sin(az_rad), cos_el * np.cos(az_rad), np.sin(el_rad)])


def otsu_threshold(values: np.ndarray, bins: int = 128) -> float:
    """一维 Otsu 阈值（两类间方差最大）。"""
    values = np.asarray(values, dtype=float)
    values = values[np.isfinite(values)]
    if values.size < 4:
        return float(np.median(values)) if values.size else 0.0
    counts, edges = np.histogram(values, bins=bins)
    centers = (edges[:-1] + edges[1:]) / 2.0
    total = counts.sum()
    w0 = np.cumsum(counts) / total
    w1 = 1.0 - w0
    m0 = np.cumsum(counts * centers) / np.maximum(np.cumsum(counts), 1)
    total_mean = (counts * centers).sum() / total
    m1 = (total_mean - np.cumsum(counts * centers) / total) / np.maximum(w1, 1e-12)
    between = w0 * w1 * (m0 - m1) ** 2
    between = np.where((w0 > 0.02) & (w1 > 0.02), between, -np.inf)
    return float(centers[int(np.argmax(between))])


def _largest_gap_center(azimuths: np.ndarray) -> tuple[float, float] | None:
    """方位角集合的最小覆盖弧：返回 ``(弧中心, 弧跨角)``；覆盖全圆时返回 None。"""
    values = np.sort(np.mod(np.asarray(azimuths, dtype=float), 360.0))
    if values.size < 2:
        return None
    gaps = np.diff(np.r_[values, values[0] + 360.0])
    index = int(np.argmax(gaps))
    if gaps[index] < 5.0:  # 没有明显缺口，无法定义"带"
        return None
    extent = 360.0 - float(gaps[index])
    start = float(values[(index + 1) % values.size])
    return (start + extent / 2.0) % 360.0, extent


# --------------------------------------------------------------------------- #
# 数据
# --------------------------------------------------------------------------- #
@dataclass
class SkyData:
    """一次观测会话里所有"卫星 × 历元"的 GSV 观测。

    数组均按记录（record）展开：第 ``i`` 条记录表示"第 ``epoch[i]`` 个历元看到
    第 ``sat[i]`` 颗星，仰角 ``el[i]``、方位角 ``az[i]``、载噪比 ``cn0[i]``"。
    ``cn0 == 0`` 表示该历元这颗星可见但没有被跟踪到（GSV 里 cn0 为空）。
    """

    times: np.ndarray          # (T,) 每个历元相对起点的秒数
    time_text: list[str]       # (T,) 每个历元的 HH:MM:SS.sss
    epoch: np.ndarray          # (N,) 记录所属历元下标
    sat: np.ndarray            # (N,) 记录所属卫星下标
    sat_names: list[tuple[str, str]]
    el: np.ndarray
    az: np.ndarray
    cn0: np.ndarray
    source: str = ""

    @property
    def n_epochs(self) -> int:
        return int(self.times.size)

    @property
    def n_records(self) -> int:
        return int(self.epoch.size)

    def groups(self) -> list[np.ndarray]:
        """每颗卫星的记录下标（按历元升序）。"""
        order = np.lexsort((self.epoch, self.sat))
        sat_sorted = self.sat[order]
        bounds = np.flatnonzero(np.diff(sat_sorted)) + 1
        return [chunk for chunk in np.split(order, bounds) if chunk.size]

    def rotated(self, degrees: float) -> "SkyData":
        """方位角整体旋转 ``degrees`` 度（数据增强）。"""
        return SkyData(
            times=self.times,
            time_text=self.time_text,
            epoch=self.epoch,
            sat=self.sat,
            sat_names=self.sat_names,
            el=self.el,
            az=(self.az + degrees) % 360.0,
            cn0=self.cn0,
            source=self.source,
        )


def load_sky_data(path: str | Path, *, min_observations: int = 2) -> SkyData:
    """解析 NMEA 日志，抽出所有 GSV 观测。"""
    result = parse_file(str(path))
    if not result.epochs:
        raise SystemExit(f"{path} 没有解析出任何历元")

    # 历元时间（秒）
    moments = [epoch.datetime for epoch in result.epochs]
    if all(moment is not None for moment in moments):
        base = moments[0]
        times = np.array([(moment - base).total_seconds() for moment in moments], dtype=float)
    else:  # 没有日期时退化为用采样序号
        times = np.arange(len(result.epochs), dtype=float)
    time_text = [epoch.time or "" for epoch in result.epochs]

    sat_index: dict[tuple[str, str], int] = {}
    sat_names: list[tuple[str, str]] = []
    records: list[tuple[int, int, float, float, float]] = []

    for epoch_index, epoch in enumerate(result.epochs):
        for key, satellite in epoch.satellites.items():
            if satellite.elevation is None or satellite.azimuth is None:
                continue
            if not (0.0 <= satellite.elevation <= 90.0):
                continue
            if key not in sat_index:
                sat_index[key] = len(sat_names)
                sat_names.append(key)
            cn0 = satellite.cn0 if (satellite.cn0 is not None and satellite.cn0 > 0) else 0.0
            records.append(
                (epoch_index, sat_index[key], float(satellite.elevation), float(satellite.azimuth), float(cn0))
            )

    if not records:
        raise SystemExit("没有可用的卫星观测")

    epoch_arr = np.array([r[0] for r in records], dtype=np.int32)
    sat_arr = np.array([r[1] for r in records], dtype=np.int32)
    el_arr = np.array([r[2] for r in records], dtype=float)
    az_arr = np.array([r[3] for r in records], dtype=float)
    cn0_arr = np.array([r[4] for r in records], dtype=float)

    # 丢掉只被看见 1 次的星（多为末尾/开头的残片），避免污染 PCA 与统计
    counts = np.bincount(sat_arr, minlength=len(sat_names))
    keep_sat = counts >= min_observations
    keep = keep_sat[sat_arr]
    # 重新编号卫星
    remap = -np.ones(len(sat_names), dtype=np.int32)
    remap[np.flatnonzero(keep_sat)] = np.arange(int(keep_sat.sum()), dtype=np.int32)
    sat_names = [name for name, ok in zip(sat_names, keep_sat) if ok]

    return SkyData(
        times=times,
        time_text=time_text,
        epoch=epoch_arr[keep],
        sat=remap[sat_arr[keep]],
        sat_names=sat_names,
        el=el_arr[keep],
        az=az_arr[keep],
        cn0=cn0_arr[keep],
        source=str(path),
    )


# --------------------------------------------------------------------------- #
# 卫星汇总
# --------------------------------------------------------------------------- #
@dataclass
class SatelliteSummary:
    system: str
    prn: str
    azimuth: float       # 圆均值，度
    elevation: float     # 算术均值，度
    strength: float      # 平均 cn0（未跟踪的历元按 0 计）
    track_ratio: float   # 被跟踪到的历元比例
    peak_cn0: float      # 被跟踪时的 cn0 90 分位
    samples: int

    @property
    def key(self) -> str:
        return f"{self.system}|{self.prn}"


def summarize_satellites(data: SkyData) -> list[SatelliteSummary]:
    summaries: list[SatelliteSummary] = []
    for group in data.groups():
        system, prn = data.sat_names[int(data.sat[group[0]])]
        cn0 = data.cn0[group]
        tracked = cn0[cn0 > 0]
        summaries.append(
            SatelliteSummary(
                system=system,
                prn=prn,
                azimuth=circular_mean(data.az[group]),
                elevation=float(data.el[group].mean()),
                strength=float(cn0.mean()),
                track_ratio=float((cn0 > 0).mean()),
                peak_cn0=float(np.percentile(tracked, 90)) if tracked.size else 0.0,
                samples=int(group.size),
            )
        )
    return summaries


def aggregate_satellite_samples(
    sat: np.ndarray,
    azimuth: np.ndarray,
    elevation: np.ndarray,
    probability: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """按卫星把重复观测聚合成一个点（圆均值方位 / 平均仰角 / 平均直射概率）。

    同一条边界不应该因为某颗星在几百个历元里被反复看到而获得几百倍权重。
    """
    order = np.argsort(sat, kind="stable")
    sat_sorted = sat[order]
    bounds = np.flatnonzero(np.diff(sat_sorted)) + 1
    az_out, el_out, p_out, ids = [], [], [], []
    for chunk in np.split(order, bounds):
        if chunk.size == 0:
            continue
        ids.append(int(sat[chunk[0]]))
        az_out.append(circular_mean(azimuth[chunk]))
        el_out.append(float(np.mean(elevation[chunk])))
        p_out.append(float(np.mean(probability[chunk])))
    return (
        np.asarray(ids, dtype=int),
        np.asarray(az_out, dtype=float),
        np.asarray(el_out, dtype=float),
        np.asarray(p_out, dtype=float),
    )


# --------------------------------------------------------------------------- #
# 第一步：整体朝向扫描
# --------------------------------------------------------------------------- #
@dataclass
class OrientationScan:
    center_azimuth: float          # 直射带中心方位（整体朝向）
    half_width: float              # 直射带半宽
    score: float                   # 最佳两类间方差（归一化前）
    score_surface: np.ndarray      # (phi, width) 扫描得分
    score_signed: np.ndarray       # 带符号版本：w0·w1·(带内均值−带外均值)
    phi_grid: np.ndarray
    width_grid: np.ndarray
    plateau: tuple[float, float]   # 得分几乎相同的方位区间
    members: list[bool]            # 每颗星是否落在带内


def scan_orientation(
    summaries: Sequence[SatelliteSummary],
    *,
    phi_step: float = 1.0,
    width_min: float = 40.0,
    width_max: float = 179.0,
    width_step: float = 1.0,
    min_inside: int = 8,
    min_outside: int = 6,
) -> OrientationScan:
    """遍历 ``(φ0, w)``，用两类间方差找"强信号带"的朝向与半宽。"""
    az = np.array([s.azimuth for s in summaries], dtype=float)
    strength = np.array([s.strength for s in summaries], dtype=float)
    n = az.size
    if n < 12:
        raise ValueError("卫星数量太少，无法估计朝向")

    phi_grid = np.arange(0.0, 360.0, phi_step)
    width_grid = np.arange(width_min, width_max + 1e-9, width_step)
    surface = np.full((phi_grid.size, width_grid.size), -np.inf)
    surface_signed = np.full((phi_grid.size, width_grid.size), np.nan)

    for i, phi in enumerate(phi_grid):
        distance = np.abs(wrap180(az - phi))
        order = np.argsort(distance)
        sorted_distance = distance[order]
        sorted_strength = strength[order]
        cumulative = np.cumsum(sorted_strength)
        total = cumulative[-1]
        inside_count = np.searchsorted(sorted_distance, width_grid, side="right")
        valid = (inside_count >= min_inside) & (n - inside_count >= min_outside)
        if not valid.any():
            continue
        safe = np.maximum(inside_count, 1)
        inside_sum = np.where(inside_count > 0, cumulative[safe - 1], 0.0)
        outside_count = n - inside_count
        safe_out = np.maximum(outside_count, 1)
        inside_mean = inside_sum / safe
        outside_mean = (total - inside_sum) / safe_out
        signed = inside_count * outside_count / n**2 * (inside_mean - outside_mean)
        between = signed * (inside_mean - outside_mean)
        # 两类间方差对"哪一类在带内"是对称的，这里强制带内更强，
        # 否则会同时选出"遮挡区"这个等价解。
        between = np.where(inside_mean > outside_mean, between, -np.inf)
        surface[i] = np.where(valid, between, -np.inf)
        surface_signed[i] = np.where(valid, signed, np.nan)

    best = int(np.argmax(surface))
    i_best, j_best = np.unravel_index(best, surface.shape)
    best_score = float(surface[i_best, j_best])
    if not np.isfinite(best_score):
        raise ValueError("朝向扫描没有可行解")

    width = float(width_grid[j_best])
    distance = np.abs(wrap180(az - phi_grid[i_best]))
    members = [bool(d <= width) for d in distance]

    # 等价的 φ0 往往是一个区间（成员不变的平台），取平台范围便于报告
    row_max = surface.max(axis=1)
    plateau_mask = row_max >= best_score * 0.9995
    plateau_values = phi_grid[plateau_mask]
    if plateau_values.size == 0:
        plateau_values = np.array([phi_grid[i_best]])
    plateau = (float(plateau_values.min()), float(plateau_values.max()))

    # 用带内卫星的最小覆盖弧中心作为朝向：对卫星疏密不敏感
    member_az = [s.azimuth for s, inside in zip(summaries, members) if inside]
    arc = _largest_gap_center(np.array(member_az))
    if arc is not None:
        center, extent = arc
        half_width = extent / 2.0
    else:
        center = circular_mean(np.array(member_az), strength[members])
        half_width = width

    return OrientationScan(
        center_azimuth=center % 360.0,
        half_width=float(half_width),
        score=best_score,
        score_surface=surface,
        score_signed=surface_signed,
        phi_grid=phi_grid,
        width_grid=width_grid,
        plateau=plateau,
        members=members,
    )


# --------------------------------------------------------------------------- #
# 第二步：强星 PCA
# --------------------------------------------------------------------------- #
@dataclass
class BandPCA:
    n_points: int
    eigenvalues: np.ndarray       # 降序
    explained: np.ndarray         # 解释方差比
    axes: np.ndarray              # (3, 3) 列向量，与 eigenvalues 对应
    across_azimuth: float         # 第一主成分（带横向）方位
    center_azimuth: float         # 由第一主成分推出的带中心
    half_width: float             # sin(w)=√3σ1 得到的半宽
    boresight_elevation: float    # 强星平均方向（仰角）
    boresight_azimuth: float
    threshold: float              # 强星 cn0 阈值


def band_pca(
    data: SkyData,
    summaries: Sequence[SatelliteSummary],
    *,
    reference_azimuth: float | None = None,
    track_ratio_min: float = STRONG_TRACK_RATIO,
) -> BandPCA:
    """对强星单位向量做 PCA，得到直射带的宽度与指向。"""
    tracked = data.cn0[data.cn0 > 0]
    threshold = otsu_threshold(tracked)
    strong = [
        s for s in summaries
        if s.track_ratio >= track_ratio_min and s.peak_cn0 >= threshold + STRONG_MARGIN
    ]
    if len(strong) < 8:
        # 阈值过于苛刻时放宽到"峰值 cn0 的前 40%"
        strong = [s for s in summaries if s.peak_cn0 > 0]
        strong.sort(key=lambda s: -s.peak_cn0)
        strong = strong[: max(8, int(len(strong) * 0.4))]

    vectors = unit_vectors(
        np.array([s.azimuth for s in strong]),
        np.array([s.elevation for s in strong]),
    )
    centered = vectors - vectors.mean(axis=0)
    covariance = centered.T @ centered / max(1, len(strong) - 1)
    values, axes = np.linalg.eigh(covariance)          # 升序
    order = np.argsort(values)[::-1]
    values = values[order]
    axes = axes[:, order]
    total = float(values.sum()) or 1.0
    explained = values / total

    across = axes[:, 0]
    across_azimuth = math.degrees(math.atan2(across[0], across[1])) % 360.0  # x=东, y=北
    candidates = ((across_azimuth + 90.0) % 360.0, (across_azimuth - 90.0) % 360.0)
    if reference_azimuth is None:
        center = candidates[0]
    else:
        center = min(candidates, key=lambda a: abs(wrap180(a - reference_azimuth)))

    sigma = float(np.sqrt(max(values[0], 0.0)))
    half_width = math.degrees(math.asin(min(0.999, math.sqrt(3.0) * sigma)))

    mean_direction = vectors.mean(axis=0)
    mean_direction = mean_direction / max(np.linalg.norm(mean_direction), 1e-12)
    boresight_el = math.degrees(math.asin(float(np.clip(mean_direction[2], -1.0, 1.0))))
    boresight_az = math.degrees(math.atan2(mean_direction[0], mean_direction[1])) % 360.0

    return BandPCA(
        n_points=len(strong),
        eigenvalues=values,
        explained=explained,
        axes=axes,
        across_azimuth=across_azimuth,
        center_azimuth=center,
        half_width=float(min(90.0, half_width)),
        boresight_elevation=boresight_el,
        boresight_azimuth=boresight_az,
        threshold=threshold,
    )


# --------------------------------------------------------------------------- #
# 第三步：时间窗特征 + 高斯混合分类
# --------------------------------------------------------------------------- #
def window_features(data: SkyData, window_seconds: float) -> np.ndarray:
    """对每条记录计算窗口内的 ``[cn0 峰值, cn0 均值, 跟踪率]``。

    ``window_seconds == 0`` 表示只看当前历元（1 Hz 采样下的"当前 1 s"）。
    """
    features = np.zeros((data.n_records, 3), dtype=float)
    for group in data.groups():
        times = data.times[data.epoch[group]]
        cn0 = data.cn0[group]
        for position in range(group.size):
            start = int(np.searchsorted(times[: position + 1], times[position] - window_seconds - 1e-9, side="left"))
            block = cn0[start: position + 1]
            features[group[position]] = (block.max(), block.mean(), float(np.count_nonzero(block)) / block.size)
    return features


@dataclass
class Classifier:
    """两分量高斯混合：cn0 高的分量为直射（LOS），低的为非直射（NLOS）。

    只在"窗口内至少跟踪到一次"的样本上做聚类；整窗都没跟踪到的样本按物理先验
    直接判为非直射（没有载波就谈不上直射通路）。
    """

    window_seconds: float
    features: np.ndarray
    probability: np.ndarray          # (N,) 直射后验概率
    labels: np.ndarray               # (N,) 0/1 硬标签
    means: np.ndarray                # (2, 3) 原始量纲的分量均值
    covariances: np.ndarray          # (2, 3, 3) 原始量纲的协方差
    weights: np.ndarray
    direct_component: int
    bic: dict[int, float]
    silhouette: dict[int, float]
    kmeans_agreement: float
    tracked: np.ndarray              # (N,) 窗口内是否跟踪到过

    @property
    def n_direct(self) -> int:
        return int(self.labels.sum())


def _standardize(features: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mean = features.mean(axis=0)
    std = features.std(axis=0)
    std = np.where(std < 1e-9, 1.0, std)
    return (features - mean) / std, mean, std


def _silhouette(features: np.ndarray, labels: np.ndarray, seed: int = RANDOM_SEED, limit: int = 4000) -> float:
    from sklearn.metrics import silhouette_score

    if np.unique(labels).size < 2:
        return float("nan")
    rng = np.random.default_rng(seed)
    index = np.arange(len(features))
    if index.size > limit:
        index = rng.choice(index, size=limit, replace=False)
    try:
        return float(silhouette_score(features[index], labels[index]))
    except ValueError:
        return float("nan")


def fit_classifier(
    features: np.ndarray,
    window_seconds: float,
    *,
    seed: int = RANDOM_SEED,
    max_components: int = 4,
) -> Classifier:
    """拟合 2 分量 GMM，并用 BIC / 轮廓系数做模型选择诊断。

    "窗口内一次都没跟踪到"（``cn0_peak == 0``）的样本不参与聚类，直接按物理
    先验判为非直射。
    """
    from sklearn.cluster import KMeans
    from sklearn.mixture import GaussianMixture

    features = np.asarray(features, dtype=float)
    tracked = features[:, 0] > 0
    probability = np.zeros(len(features), dtype=float)
    if int(tracked.sum()) < 40:
        raise ValueError("被跟踪到的样本太少，无法拟合分类器")

    subset = features[tracked][:, CLUSTER_COLUMNS]
    scaled, mean, std = _standardize(subset)
    gmm = GaussianMixture(
        n_components=2,
        covariance_type="tied",
        reg_covar=1e-3,
        n_init=5,
        random_state=seed,
    ).fit(scaled)
    posterior = gmm.predict_proba(scaled)
    # 还原到原始量纲，按 cn0 峰值高低确定哪个分量是直射
    raw_means = gmm.means_ * std + mean
    raw_covariances = gmm.covariances_ * std[:, None] * std[None, :]
    direct_component = int(np.argmax(raw_means[:, 0]))
    probability[tracked] = posterior[:, direct_component]
    labels = (probability >= 0.5).astype(int)

    bic: dict[int, float] = {}
    silhouette: dict[int, float] = {}
    for k in range(2, max_components + 1):
        model = GaussianMixture(
            n_components=k,
            covariance_type="full",
            reg_covar=1e-3,
            n_init=3,
            random_state=seed,
        ).fit(scaled)
        bic[k] = float(model.bic(scaled))
        if k == 2:
            silhouette[k] = _silhouette(scaled, labels[tracked])
        else:
            silhouette[k] = _silhouette(scaled, model.predict(scaled))

    kmeans = KMeans(n_clusters=2, n_init=5, random_state=seed).fit(scaled)
    # 对齐 KMeans 的两个簇（cn0 峰值高的簇为直射）
    kmeans_direct = int(np.argmax([scaled[kmeans.labels_ == c, 0].mean() for c in (0, 1)]))
    kmeans_labels = (kmeans.labels_ == kmeans_direct).astype(int)
    agreement = float((kmeans_labels == labels[tracked]).mean())

    return Classifier(
        window_seconds=window_seconds,
        features=features,
        probability=probability,
        labels=labels,
        means=raw_means,
        covariances=raw_covariances,
        weights=gmm.weights_,
        direct_component=direct_component,
        bic=bic,
        silhouette=silhouette,
        kmeans_agreement=agreement,
        tracked=tracked,
    )


# --------------------------------------------------------------------------- #
# 第四步：两条边界曲线
# --------------------------------------------------------------------------- #
@dataclass
class BandCurves:
    """直射带的两条边界：``方位 = 朝向 ∓ 半宽(仰角)``。"""

    knots: np.ndarray
    west: np.ndarray       # 半宽（正值）
    east: np.ndarray
    band_edges: list[dict] = field(default_factory=list)
    west_line: tuple[float, float] = (90.0, 0.0)   # (仰角 0° 处半宽, 每 90° 仰角的增量)
    east_line: tuple[float, float] = (90.0, 0.0)
    diagnostics: dict = field(default_factory=dict)

    def half_width(self, elevation: np.ndarray, side: np.ndarray | float = 1.0) -> np.ndarray:
        elevation = np.asarray(elevation, dtype=float)
        east = np.interp(elevation, self.knots, self.east)
        west_values = np.interp(elevation, self.knots, self.west)
        return np.where(np.asarray(side) >= 0, east, west_values)

    def scaled(self, west_scale: float, east_scale: float) -> "BandCurves":
        """按整体缩放系数得到同一形状下的另一组边界（逐历元抖动仿真用）。"""
        return BandCurves(
            knots=self.knots,
            west=np.clip(self.west * west_scale, 3.0, 179.0),
            east=np.clip(self.east * east_scale, 3.0, 179.0),
            band_edges=self.band_edges,
            west_line=self.west_line,
            east_line=self.east_line,
            diagnostics=self.diagnostics,
        )

    def mask(self, azimuth: np.ndarray, elevation: np.ndarray, center_azimuth: float) -> np.ndarray:
        offset = wrap180(np.asarray(azimuth, dtype=float) - center_azimuth)
        limit = self.half_width(elevation, np.sign(offset))
        return np.abs(offset) <= limit

    def area_fraction(self, center_azimuth: float, az_grid: np.ndarray = GRID_AZ, el_grid: np.ndarray = GRID_EL) -> float:
        az2, el2 = np.meshgrid(az_grid, el_grid)
        inside = self.mask(az2, el2, center_azimuth)
        weights = np.cos(np.radians(el2))
        return float((inside * weights).sum() / weights.sum())

    def to_dict(self) -> dict:
        return {
            "knots": [round(float(v), 2) for v in self.knots],
            "west": [round(float(v), 2) for v in self.west],
            "east": [round(float(v), 2) for v in self.east],
        }


def _best_cut(distance: np.ndarray, probability: np.ndarray) -> float:
    """一维加权最大对比割：把 |Δaz| 切成"带内直射 / 带外非直射"最干净的位置。"""
    order = np.argsort(distance)
    distance = distance[order]
    probability = probability[order]
    n = probability.size
    cumulative = np.cumsum(probability)
    total = float(probability.sum())
    inside_count = np.arange(1, n + 1)
    # 割在 i 之后：带内 i 个样本、带外 n-i 个样本
    loss = (total - cumulative) + (inside_count - cumulative)
    index = int(np.argmin(loss))
    if index + 1 < n:
        return float((distance[index] + distance[index + 1]) / 2.0)
    return float(distance[index])


def _search_edge(
    distance: np.ndarray,
    elevation: np.ndarray,
    label: np.ndarray,
    *,
    min_width: float = 8.0,
    max_width: float = 175.0,
    slope_penalty: float = 0.8,
) -> tuple[float, float, float, dict]:
    """在 ``W(el) = a + b·el/90`` 上做二维网格搜索，最小化硬标签误分类数。

    比"逐仰角带取值 + 线性回归"稳定：即使某一仰角带只有一两颗星，
    也不会把整条曲线拽飞；``slope_penalty`` 让斜率在证据不足时退回常数。
    返回 ``(loss, a, b, 诊断)``，诊断里带斜率剖面与半宽的可辨识区间。
    """
    label = np.asarray(label, dtype=float)
    a_grid = np.arange(20.0, 156.0, 2.0)
    b_grid = np.arange(-45.0, 45.1, 5.0)   # 天顶处相对地平线处半宽的增量（度）
    best = (np.inf, 90.0, 0.0)
    slope_profile: dict[float, float] = {}
    best_loss_by_a: np.ndarray | None = None
    for slope in b_grid:
        widths = np.clip(a_grid[:, None] + slope * elevation[None, :] / 90.0, min_width, max_width)
        inside = distance[None, :] <= widths
        loss = (inside * (1.0 - label)[None, :]).sum(axis=1) + ((~inside) * label[None, :]).sum(axis=1)
        loss = loss + slope_penalty * (slope / 30.0) ** 2
        index = int(np.argmin(loss))
        slope_profile[round(float(slope), 1)] = round(float(loss[index]), 3)
        if loss[index] < best[0]:
            best = (float(loss[index]), float(a_grid[index]), float(slope))
            best_loss_by_a = loss.copy()

    # 固定最优斜率，给出"损失只多误分 1 颗星"的半宽区间
    width_range = [float(best[1]), float(best[1])]
    if best_loss_by_a is not None:
        acceptable = a_grid[best_loss_by_a <= best[0] + 1.0]
        if acceptable.size:
            width_range = [float(acceptable.min()), float(acceptable.max())]
    diagnostics = {
        "slope_profile": slope_profile,
        "half_width_range": [round(v, 1) for v in width_range],
    }
    return best[0], best[1], best[2], diagnostics


def fit_band_curves(
    azimuth: np.ndarray,
    elevation: np.ndarray,
    probability: np.ndarray,
    center_azimuth: float,
    *,
    min_samples: int = 6,
    knots: np.ndarray = CURVE_KNOTS,
) -> BandCurves:
    """由直射概率拟合"两条曲线"（东边界 / 西边界随仰角变化）。

    输入应当是**按卫星聚合后**的样本（每个方位只有一个点），否则同一颗星在
    几百个历元里的重复观测会让权重失衡。
    """
    offset = wrap180(np.asarray(azimuth, dtype=float) - center_azimuth)
    distance = np.abs(offset)
    elevation = np.asarray(elevation, dtype=float)
    label = (np.asarray(probability, dtype=float) >= 0.5).astype(float)

    edges: list[dict] = []
    lines: dict[str, tuple[float, float]] = {}
    diagnostics: dict[str, dict] = {}
    for side, name in ((-1.0, "west"), (1.0, "east")):
        selected = (np.sign(offset) == side)
        if int(selected.sum()) < min_samples:
            lines[name] = (90.0, 0.0)
            diagnostics[name] = {}
            edges.append({"side": name, "samples": int(selected.sum()), "note": "样本不足，取默认 90°"})
            continue
        loss, a, b, info = _search_edge(distance[selected], elevation[selected], label[selected])
        lines[name] = (a, b)
        diagnostics[name] = info
        edges.append({
            "side": name,
            "intercept_deg": round(a, 2),
            "slope_per_90deg": round(b, 2),
            "half_width_low": round(float(np.clip(a, 3, 179)), 2),
            "half_width_high": round(float(np.clip(a + b, 3, 179)), 2),
            "half_width_range": info["half_width_range"],
            "samples": int(selected.sum()),
            "misclassified": round(loss, 2),
        })

    west_a, west_b = lines["west"]
    east_a, east_b = lines["east"]
    west = np.clip(west_a + west_b * knots / 90.0, 3.0, 179.0)
    east = np.clip(east_a + east_b * knots / 90.0, 3.0, 179.0)
    return BandCurves(
        knots=np.asarray(knots, dtype=float),
        west=west,
        east=east,
        band_edges=edges,
        west_line=lines["west"],
        east_line=lines["east"],
        diagnostics=diagnostics,
    )


def scale_band_curves(
    curves: BandCurves,
    azimuth: np.ndarray,
    elevation: np.ndarray,
    probability: np.ndarray,
    center_azimuth: float,
    *,
    min_samples: int = 6,
) -> tuple[float, float]:
    """固定全局曲线形状，逐历元只估计东/西两侧的整体缩放系数。

    静态环境里天空边界不会每秒变形；逐历元重估一条自由曲线只会放大样本噪声，
    所以这里把"形状"交给全局拟合，"尺度"交给当前时间窗。
    """
    offset = wrap180(np.asarray(azimuth, dtype=float) - center_azimuth)
    distance = np.abs(offset)
    elevation = np.asarray(elevation, dtype=float)
    label = (np.asarray(probability, dtype=float) >= 0.5).astype(float)
    scales = []
    for side in (-1.0, 1.0):
        selected = np.sign(offset) == side
        base = curves.half_width(elevation[selected], side)
        base = np.maximum(base, 1e-6)
        if int(selected.sum()) < min_samples:
            scales.append(1.0)
            continue
        ratio = distance[selected] / base
        scales.append(_best_cut(ratio, label[selected]))
    return float(np.clip(scales[0], 0.6, 1.5)), float(np.clip(scales[1], 0.6, 1.5))


# --------------------------------------------------------------------------- #
# 评估：校验 / 抖动 / 旋转
# --------------------------------------------------------------------------- #
def validate(
    data: SkyData,
    summaries: Sequence[SatelliteSummary],
    probability: np.ndarray,
    curves: BandCurves,
    center_azimuth: float,
) -> dict:
    """用两类"确定性样本"与几何一致性做无标签校验。"""
    n_never = 0
    never_probability: list[float] = []
    always_probability: list[float] = []
    always_count = 0
    for group in data.groups():
        cn0 = data.cn0[group]
        tracked = cn0[cn0 > 0]
        if tracked.size == 0:
            n_never += 1
            never_probability.extend(probability[group].tolist())
        elif tracked.size == cn0.size and float(tracked.min()) >= 30.0:
            always_count += 1
            always_probability.extend(probability[group].tolist())

    never = np.array(never_probability)
    always = np.array(always_probability)
    inside = curves.mask(data.az, data.el, center_azimuth)
    hard = probability >= 0.5

    quadrants = {}
    for name, low, high in (("N", 315.0, 45.0), ("E", 45.0, 135.0), ("S", 135.0, 225.0), ("W", 225.0, 315.0)):
        if low < high:
            selected = (data.az >= low) & (data.az < high)
        else:
            selected = (data.az >= low) | (data.az < high)
        if selected.any():
            quadrants[name] = round(float(probability[selected].mean()), 3)

    return {
        "never_tracked_satellites": n_never,
        "never_tracked_p_direct": round(float(never.mean()), 4) if never.size else None,
        "never_tracked_flagged_direct": round(float((never >= 0.5).mean()), 4) if never.size else None,
        "always_strong_satellites": always_count,
        "always_strong_p_direct": round(float(always.mean()), 4) if always.size else None,
        "always_strong_flagged_direct": round(float((always >= 0.5).mean()), 4) if always.size else None,
        "extremes_accuracy": (
            round(float(((never < 0.5).sum() + (always >= 0.5).sum()) / max(1, never.size + always.size)), 4)
            if never.size + always.size else None
        ),
        "fusion_disagreement": round(float((hard != inside).mean()), 4),
        "quadrant_p_direct": quadrants,
    }


def _iou(a: np.ndarray, b: np.ndarray) -> float:
    union = np.logical_or(a, b).sum()
    if union == 0:
        return 1.0
    return float(np.logical_and(a, b).sum() / union)


def _flip_rate(labels: np.ndarray, epochs: np.ndarray) -> tuple[float, int, int]:
    order = np.argsort(epochs)
    series = labels[order]
    transitions = int(series.size - 1)
    if transitions <= 0:
        return 0.0, 0, 0
    flips = int(np.count_nonzero(np.diff(series)))
    return flips / transitions, flips, transitions


def jitter_study(
    data: SkyData,
    classifier: Classifier,
    center_azimuth: float,
    *,
    global_curves: BandCurves,
    grid_az: np.ndarray = GRID_AZ,
    grid_el: np.ndarray = GRID_EL,
) -> dict:
    """量化某个时间窗下分类与边界的抖动。"""
    probability = classifier.probability
    labels = classifier.labels
    window = classifier.window_seconds

    flip_rates: list[float] = []
    flips_total = 0
    transitions_total = 0
    for group in data.groups():
        if group.size < 10:
            continue
        rate, flips, transitions = _flip_rate(labels[group], data.epoch[group])
        flip_rates.append(rate)
        flips_total += flips
        transitions_total += transitions

    # 每个历元用窗口内的样本重新估计"边界尺度"
    epoch_curves: list[BandCurves] = []
    masks: list[np.ndarray] = []
    az2, el2 = np.meshgrid(grid_az, grid_el)
    for epoch in range(data.n_epochs):
        selected = data.times[data.epoch] <= data.times[epoch] + 1e-9
        selected &= data.times[data.epoch] >= data.times[epoch] - window - 1e-9
        if int(selected.sum()) < 12:
            epoch_curves.append(global_curves)
            masks.append(global_curves.mask(az2, el2, center_azimuth))
            continue
        _, az_a, el_a, p_a = aggregate_satellite_samples(
            data.sat[selected], data.az[selected], data.el[selected], probability[selected]
        )
        west_scale, east_scale = scale_band_curves(global_curves, az_a, el_a, p_a, center_azimuth)
        curves = global_curves.scaled(west_scale, east_scale)
        epoch_curves.append(curves)
        masks.append(curves.mask(az2, el2, center_azimuth))

    west_series = np.full((data.n_epochs, len(ELEVATION_BANDS)), np.nan)
    east_series = np.full((data.n_epochs, len(ELEVATION_BANDS)), np.nan)
    for index, curves in enumerate(epoch_curves):
        for band_index, (low, high) in enumerate(ELEVATION_BANDS):
            center = (low + high) / 2.0
            west_series[index, band_index] = float(np.interp(center, curves.knots, curves.west))
            east_series[index, band_index] = float(np.interp(center, curves.knots, curves.east))

    west_jitter = np.nanstd(west_series, axis=0)
    east_jitter = np.nanstd(east_series, axis=0)
    west_delta = np.nanmean(np.abs(np.diff(west_series, axis=0)), axis=0)
    east_delta = np.nanmean(np.abs(np.diff(east_series, axis=0)), axis=0)

    consecutive = [
        _iou(masks[i - 1], masks[i]) for i in range(1, len(masks))
        if masks[i - 1].any() or masks[i].any()
    ]
    global_mask = global_curves.mask(az2, el2, center_azimuth)
    vs_global = [_iou(mask, global_mask) for mask in masks]

    return {
        "window_seconds": window,
        "satellite_flip_rate_median": round(float(np.median(flip_rates)), 4) if flip_rates else None,
        "satellite_flip_rate_mean": round(float(np.mean(flip_rates)), 4) if flip_rates else None,
        "satellite_flip_rate_p90": round(float(np.percentile(flip_rates, 90)), 4) if flip_rates else None,
        "label_flips_total": flips_total,
        "label_flips_per_minute": round(flips_total / max(transitions_total, 1) * 60.0, 2),
        "boundary_sigma_west_deg": [round(float(v), 2) for v in west_jitter],
        "boundary_sigma_east_deg": [round(float(v), 2) for v in east_jitter],
        "boundary_sigma_max_deg": round(float(np.nanmax(np.r_[west_jitter, east_jitter])), 2),
        "boundary_delta_deg": round(float(np.nanmean(np.r_[west_delta, east_delta])), 2),
        "mask_iou_consecutive_mean": round(float(np.mean(consecutive)), 4) if consecutive else None,
        "mask_iou_vs_global_mean": round(float(np.mean(vs_global)), 4) if vs_global else None,
        "direct_area_fraction_mean": round(float(np.mean([
            float((mask * np.cos(np.radians(el2))).sum() / np.cos(np.radians(el2)).sum()) for mask in masks
        ])), 4),
        "confidence_mean": round(float(np.abs(probability - 0.5).mean() * 2.0), 4),
        "_west_series": west_series,
        "_east_series": east_series,
        "_epoch_curves": epoch_curves,
        "_global_mask": global_mask,
    }


def sub_degree_check(
    data: SkyData,
    base_center: float,
    base_half_width: float,
    *,
    offsets: Sequence[float] = (0.37, 1.71, 3.14, 6.28),
) -> dict:
    """叠加亚度级旋转偏移，检验等变性不是"整数格点对齐"的巧合。"""
    rows = []
    for offset in offsets:
        rotated = data.rotated(float(offset))
        summaries = summarize_satellites(rotated)
        scan = scan_orientation(summaries)
        pca = band_pca(rotated, summaries, reference_azimuth=scan.center_azimuth)
        rows.append({
            "rotation_deg": round(float(offset), 3),
            "center_error_deg": round(float(wrap180(scan.center_azimuth - offset - base_center)), 3),
            "half_width_scan": round(float(scan.half_width), 2),
            "half_width_pca": round(float(pca.half_width), 2),
        })
    errors = np.array([row["center_error_deg"] for row in rows], dtype=float)
    widths = np.array([row["half_width_pca"] for row in rows], dtype=float)
    return {
        "offsets_deg": [round(float(o), 3) for o in offsets],
        "center_error_abs_mean": round(float(np.abs(errors).mean()), 3),
        "center_error_abs_max": round(float(np.abs(errors).max()), 3),
        "half_width_deviation_max": round(float(np.abs(widths - base_half_width).max()), 3),
        "rows": rows,
    }


def rotation_study(
    data: SkyData,
    probability: np.ndarray,
    base_center: float,
    base_curves: BandCurves,
    *,
    step_degrees: float = 10.0,
    window_seconds: float = 10.0,
) -> dict:
    """方位角整体旋转的数据增强：检验朝向、宽度、面积、掩膜的等变性。"""
    grid_az, grid_el = GRID_AZ, GRID_EL
    az2, el2 = np.meshgrid(grid_az, grid_el)
    base_mask = base_curves.mask(az2, el2, base_center)
    base_area = base_curves.area_fraction(base_center)
    reference_elevations = (15.0, 45.0, 75.0)

    rows = []
    _, base_az, base_el, base_p = aggregate_satellite_samples(
        data.sat, data.az, data.el, probability
    )
    for beta in np.arange(0.0, 360.0, step_degrees):
        rotated = data.rotated(float(beta))
        summaries = summarize_satellites(rotated)
        scan = scan_orientation(summaries)
        pca = band_pca(rotated, summaries, reference_azimuth=scan.center_azimuth)
        curves = fit_band_curves(
            (base_az + beta) % 360.0, base_el, base_p, scan.center_azimuth
        )
        # 去旋转后与基准比较
        center_back = (scan.center_azimuth - beta) % 360.0
        mask_back = curves.mask(az2, el2, center_back)
        rows.append({
            "rotation_deg": round(float(beta), 1),
            "center_azimuth": round(float(scan.center_azimuth), 2),
            "center_error_deg": round(float(wrap180(scan.center_azimuth - beta - base_center)), 2),
            "half_width_scan": round(float(scan.half_width), 2),
            "half_width_pca": round(float(pca.half_width), 2),
            "center_pca_error_deg": round(float(wrap180(pca.center_azimuth - beta - base_center)), 2),
            "west": [round(float(np.interp(e, curves.knots, curves.west)), 2) for e in reference_elevations],
            "east": [round(float(np.interp(e, curves.knots, curves.east)), 2) for e in reference_elevations],
            "direct_area_fraction": round(curves.area_fraction(scan.center_azimuth), 4),
            "mask_iou_vs_base": round(_iou(base_mask, mask_back), 4),
        })

    def _stats(key: str) -> tuple[float, float, float]:
        values = np.array([row[key] for row in rows], dtype=float)
        return float(values.mean()), float(values.std()), float(values.max() - values.min())

    width_pca = np.array([row["half_width_pca"] for row in rows])
    area = np.array([row["direct_area_fraction"] for row in rows])
    iou = np.array([row["mask_iou_vs_base"] for row in rows])
    errors = np.array([row["center_error_deg"] for row in rows])
    base_west = np.array([np.interp(e, base_curves.knots, base_curves.west) for e in reference_elevations])
    base_east = np.array([np.interp(e, base_curves.knots, base_curves.east) for e in reference_elevations])
    west_dev = np.array([[abs(w - b) for w, b in zip(row["west"], base_west)] for row in rows])
    east_dev = np.array([[abs(e - b) for e, b in zip(row["east"], base_east)] for row in rows])
    center_mean, center_std, _ = _stats("center_error_deg")
    area_mean, area_std, _ = _stats("direct_area_fraction")

    return {
        "step_degrees": step_degrees,
        "window_seconds": window_seconds,
        "base_center": round(float(base_center), 2),
        "base_area_fraction": round(float(base_area), 4),
        "rows": rows,
        "center_error_abs_mean": round(float(np.abs(errors).mean()), 2),
        "center_error_abs_max": round(float(np.abs(errors).max()), 2),
        "center_error_signed_mean": round(center_mean, 2),
        "center_error_std": round(center_std, 2),
        "half_width_pca_mean": round(float(width_pca.mean()), 2),
        "half_width_pca_std": round(float(width_pca.std()), 2),
        "area_mean": round(float(area.mean()), 4),
        "area_std": round(float(area.std()), 4),
        "mask_iou_mean": round(float(iou.mean()), 4),
        "mask_iou_min": round(float(iou.min()), 4),
        "boundary_west_dev_mean": round(float(west_dev.mean()), 2),
        "boundary_east_dev_mean": round(float(east_dev.mean()), 2),
        "boundary_dev_max": round(float(max(west_dev.max(), east_dev.max())), 2),
    }


# --------------------------------------------------------------------------- #
# 汇总
# --------------------------------------------------------------------------- #
@dataclass
class SkySplitResult:
    data: SkyData
    summaries: list[SatelliteSummary]
    scan: OrientationScan
    pca: BandPCA
    classifiers: dict[float, Classifier]
    curves: BandCurves
    jitter: dict[float, dict]
    rotation: dict
    validation: dict
    center_azimuth: float
    main_window: float = 10.0
    rotation_fine: dict = field(default_factory=dict)

    def summary(self) -> dict:
        jitter_public = {
            f"{window:g}s": {k: v for k, v in metrics.items() if not k.startswith("_")}
            for window, metrics in self.jitter.items()
        }
        return {
            "source": self.data.source,
            "epochs": self.data.n_epochs,
            "records": self.data.n_records,
            "satellites": len(self.summaries),
            "mainWindowSeconds": round(float(self.main_window), 2),
            "time": {
                "start": self.data.time_text[0],
                "end": self.data.time_text[-1],
                "durationSeconds": round(float(self.data.times[-1]), 3),
            },
            "orientation": {
                "centerAzimuth": round(float(self.scan.center_azimuth), 2),
                "halfWidthScan": round(float(self.scan.half_width), 2),
                "scanScore": round(float(self.scan.score), 3),
                "plateauDeg": [round(float(self.scan.plateau[0]), 1), round(float(self.scan.plateau[1]), 1)],
                "centerAzimuthPCA": round(float(self.pca.center_azimuth), 2),
                "halfWidthPCA": round(float(self.pca.half_width), 2),
                "acrossAzimuthPCA": round(float(self.pca.across_azimuth), 2),
                "boresightElevation": round(float(self.pca.boresight_elevation), 2),
                "boresightAzimuth": round(float(self.pca.boresight_azimuth), 2),
            },
            "pca": {
                "points": int(self.pca.n_points),
                "strongThreshold": round(float(self.pca.threshold), 2),
                "eigenvalues": [float(v) for v in self.pca.eigenvalues],
                "explained": [round(float(v), 4) for v in self.pca.explained],
            },
            "curves": {
                **self.curves.to_dict(),
                "bandEdges": self.curves.band_edges,
                "edgeDiagnostics": self.curves.diagnostics,
                "westLine": [round(float(v), 2) for v in self.curves.west_line],
                "eastLine": [round(float(v), 2) for v in self.curves.east_line],
                "directAreaFraction": round(float(self.curves.area_fraction(self.scan.center_azimuth)), 4),
            },
            "classifier": {
                f"{window:g}s": {
                    "windowSeconds": window,
                    "features": list(FEATURE_NAMES),
                    "directFraction": round(float(classifier.labels.mean()), 4),
                    "componentMeans": [[round(float(v), 3) for v in row] for row in classifier.means],
                    "componentWeights": [round(float(v), 4) for v in classifier.weights],
                    "directComponent": int(classifier.direct_component),
                    "bic": {str(k): round(v, 1) for k, v in classifier.bic.items()},
                    "silhouette": {str(k): round(v, 4) for k, v in classifier.silhouette.items()},
                    "kmeansAgreement": round(float(classifier.kmeans_agreement), 4),
                }
                for window, classifier in self.classifiers.items()
            },
            "validation": self.validation,
            "jitter": jitter_public,
            "rotation": {k: v for k, v in self.rotation.items() if k != "rows"},
            "rotationRows": self.rotation["rows"],
            "rotationFine": {k: v for k, v in self.rotation_fine.items() if k != "rows"},
        }


def analyse(
    path: str | Path,
    *,
    windows: Iterable[float] = DEFAULT_WINDOWS,
    rotation_step: float = 10.0,
    main_window: float | None = None,
) -> SkySplitResult:
    """跑完整条流水线。``main_window`` 缺省取最大的时间窗（最稳的一档）。"""
    data = load_sky_data(path)
    summaries = summarize_satellites(data)
    scan = scan_orientation(summaries)
    pca = band_pca(data, summaries, reference_azimuth=scan.center_azimuth)
    center = scan.center_azimuth

    windows = tuple(float(w) for w in windows)
    if main_window is None:
        main_window = max(windows)

    classifiers: dict[float, Classifier] = {}
    for window in windows:
        features = window_features(data, float(window))
        classifiers[float(window)] = fit_classifier(features, float(window))

    if main_window not in classifiers:
        features = window_features(data, main_window)
        classifiers[main_window] = fit_classifier(features, main_window)

    main_classifier = classifiers[main_window]
    _, g_az, g_el, g_p = aggregate_satellite_samples(
        data.sat, data.az, data.el, main_classifier.probability
    )
    curves = fit_band_curves(g_az, g_el, g_p, center)

    jitter = {
        window: jitter_study(data, classifier, center, global_curves=curves)
        for window, classifier in classifiers.items()
    }
    rotation = rotation_study(
        data,
        main_classifier.probability,
        center,
        curves,
        step_degrees=rotation_step,
        window_seconds=main_window,
    )
    validation = validate(data, summaries, main_classifier.probability, curves, center)
    rotation_fine = sub_degree_check(data, center, pca.half_width)

    return SkySplitResult(
        data=data,
        summaries=summaries,
        scan=scan,
        pca=pca,
        classifiers=classifiers,
        curves=curves,
        jitter=jitter,
        rotation=rotation,
        validation=validation,
        center_azimuth=center,
        main_window=float(main_window),
        rotation_fine=rotation_fine,
    )


# --------------------------------------------------------------------------- #
# 导出
# --------------------------------------------------------------------------- #
def export_payload(result: SkySplitResult, window: float | None = None) -> dict:
    """导出给任意可视化查看器使用的分割数据（逐历元曲线 + 逐星直射概率）。"""
    window = result.main_window if window is None else window
    classifier = result.classifiers[window]
    data = result.data
    curves = result.curves
    center = result.center_azimuth
    epoch_curves = result.jitter[classifier.window_seconds]["_epoch_curves"]

    epochs = []
    for epoch in range(data.n_epochs):
        local = epoch_curves[epoch]
        west = [round(float(v), 1) for v in local.west]
        east = [round(float(v), 1) for v in local.east]
        selected = data.epoch == epoch
        probabilities = {}
        if selected.any():
            for record, probability in zip(np.flatnonzero(selected), classifier.probability[selected]):
                system, prn = data.sat_names[int(data.sat[record])]
                probabilities[f"{system}|{prn}"] = round(float(probability), 3)
        epochs.append({"west": west, "east": east, "p": probabilities})

    # 每条记录的概率只导出到 2 位小数，体积可控
    return {
        "version": 1,
        "source": Path(data.source).name,
        "generatedBy": "sky_split.py",
        "epochCount": data.n_epochs,
        "epochTimes": data.time_text,
        "windowSeconds": classifier.window_seconds,
        "orientation": {
            "centerAzimuth": round(float(center), 2),
            "halfWidth": round(float(result.scan.half_width), 2),
        },
        "knots": [round(float(v), 1) for v in curves.knots],
        "global": {
            "west": [round(float(v), 1) for v in curves.west],
            "east": [round(float(v), 1) for v in curves.east],
        },
        "epochs": epochs,
    }


def write_outputs(result: SkySplitResult, out_dir: Path, export_path: Path | None = None) -> dict:
    """写出 JSON / CSV / 可视化导出数据。"""
    import csv

    out_dir.mkdir(parents=True, exist_ok=True)
    summary = result.summary()
    (out_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    # 逐星汇总
    main_classifier = result.classifiers[result.main_window]
    mean_probability = np.zeros(len(result.summaries))
    for group in result.data.groups():
        sat_index = int(result.data.sat[group[0]])
        mean_probability[sat_index] = float(main_classifier.probability[group].mean())
    with (out_dir / "satellites.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["system", "prn", "azimuth", "elevation", "strength", "track_ratio",
                         "peak_cn0", "samples", "p_direct_mean", "label"])
        for index, sat in enumerate(result.summaries):
            writer.writerow([
                sat.system, sat.prn, round(sat.azimuth, 2), round(sat.elevation, 2),
                round(sat.strength, 2), round(sat.track_ratio, 3), round(sat.peak_cn0, 2),
                sat.samples, round(float(mean_probability[index]), 4),
                "direct" if mean_probability[index] >= 0.5 else "blocked",
            ])

    # 逐条记录标签（主窗口）
    with (out_dir / "labels.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["epoch", "time", "system", "prn", "elevation", "azimuth",
                         "cn0", "cn0_peak", "cn0_mean", "track_ratio", "p_direct", "label"])
        data = result.data
        for record in range(data.n_records):
            system, prn = data.sat_names[int(data.sat[record])]
            features = main_classifier.features[record]
            writer.writerow([
                int(data.epoch[record]), data.time_text[int(data.epoch[record])], system, prn,
                round(float(data.el[record]), 1), round(float(data.az[record]), 1),
                round(float(data.cn0[record]), 1), round(float(features[0]), 1),
                round(float(features[1]), 2), round(float(features[2]), 3),
                round(float(main_classifier.probability[record]), 4),
                "direct" if main_classifier.labels[record] else "blocked",
            ])

    # 边界曲线
    with (out_dir / "curves.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["elevation", "west_half_width", "east_half_width",
                         "west_azimuth", "east_azimuth"])
        for knot, west, east in zip(result.curves.knots, result.curves.west, result.curves.east):
            writer.writerow([
                round(float(knot), 1), round(float(west), 2), round(float(east), 2),
                round(float((result.center_azimuth - west) % 360), 2),
                round(float((result.center_azimuth + east) % 360), 2),
            ])

    if export_path is not None:
        payload = export_payload(result)
        export_path.parent.mkdir(parents=True, exist_ok=True)
        export_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    return summary


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def _print_summary(summary: dict) -> None:
    orientation = summary["orientation"]
    print("=" * 72)
    print(f"天空遮挡分割  {summary['source']}")
    print("=" * 72)
    print(f"历元 / 记录 / 卫星 : {summary['epochs']} / {summary['records']} / {summary['satellites']}")
    print(f"整体朝向           : {orientation['centerAzimuth']:.1f}° "
          f"(扫描平台 {orientation['plateauDeg'][0]:.0f}~{orientation['plateauDeg'][1]:.0f}°)")
    print(f"直射带半宽         : 扫描 {orientation['halfWidthScan']:.1f}° / PCA {orientation['halfWidthPCA']:.1f}°")
    print(f"PCA 解释方差       : " + " / ".join(f"{v*100:.1f}%" for v in summary["pca"]["explained"]))
    print(f"直射面积占比       : {summary['curves']['directAreaFraction']*100:.1f}%")
    print(f"西边界             : {summary['curves']['west'][0]:.1f}° (0°) → {summary['curves']['west'][-1]:.1f}° (90°)")
    print(f"东边界             : {summary['curves']['east'][0]:.1f}° (0°) → {summary['curves']['east'][-1]:.1f}° (90°)")
    print("-" * 72)
    for key, metrics in summary["jitter"].items():
        print(f"窗口 {key:>4}: 翻转率中位数 {metrics['satellite_flip_rate_median']:.3f}  "
              f"边界抖动 {metrics['boundary_sigma_max_deg']:.1f}°  "
              f"IoU(相邻) {metrics['mask_iou_consecutive_mean']:.4f}  "
              f"IoU(全局) {metrics['mask_iou_vs_global_mean']:.4f}")
    print("-" * 72)
    print(f"旋转 {summary['rotation']['step_degrees']:.0f}° 步长: "
          f"朝向误差 {summary['rotation']['center_error_abs_mean']:.2f}° ± "
          f"{summary['rotation']['center_error_abs_max']:.2f}°(max), "
          f"带宽 σ {summary['rotation']['half_width_pca_std']:.2f}°, "
          f"掩膜 IoU {summary['rotation']['mask_iou_mean']:.4f}")
    print("=" * 72)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="无监督天空遮挡分割（task3）")
    parser.add_argument("file", nargs="?", type=Path, default=BASE / "nmea.log", help="NMEA 文件路径")
    parser.add_argument("--window", type=float, nargs="*", default=list(DEFAULT_WINDOWS),
                        help="抖动仿真的时间窗（秒），0 表示只用当前历元")
    parser.add_argument("--rot-step", type=float, default=10.0, help="旋转增强步长（度）")
    parser.add_argument("--out", type=Path, default=BASE / "out" / "sky_split", help="结果输出目录")
    parser.add_argument("--json", type=Path, default=BASE / "out" / "sky_split.json",
                        help="可视化导出数据输出路径")
    parser.add_argument("--no-json", action="store_true", help="不写可视化导出数据")
    parser.add_argument("--print", dest="print_summary", action="store_true", help="打印关键指标")
    args = parser.parse_args(argv)

    result = analyse(
        args.file,
        windows=tuple(sorted(set(args.window))),
        rotation_step=args.rot_step,
    )
    summary = write_outputs(result, args.out, None if args.no_json else args.json)
    print(f"已写出 {args.out}/summary.json、satellites.csv、labels.csv、curves.csv")
    if not args.no_json:
        print(f"已写出 {args.json}")
    if args.print_summary:
        _print_summary(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
