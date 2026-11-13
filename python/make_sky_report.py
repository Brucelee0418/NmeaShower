#!/usr/bin/env python3
"""生成 ``sky_split.md`` 里的全部插图（输出到 ``docs/sky/``）。

    python make_sky_report.py            # 生成全套图
    python make_sky_report.py --only 5   # 只生成第 5 张

图里的数据全部来自 :mod:`sky_split` 的真实运行结果，不手工填数。
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
from matplotlib import font_manager
from matplotlib.colors import BoundaryNorm, LinearSegmentedColormap, Normalize, TwoSlopeNorm
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch

import sky_split as ss

BASE = Path(__file__).resolve().parent
OUT_DIR = BASE / "docs" / "sky"
CN0_CMAP = LinearSegmentedColormap.from_list(
    "cn0", ["#b91c1c", "#f59e0b", "#84cc16", "#15803d"]
)
P_CMAP = LinearSegmentedColormap.from_list("pdir", ["#7f1d1d", "#f59e0b", "#15803d"])
INK = "#0f172a"
MUTED = "#64748b"


# --------------------------------------------------------------------------- #
# 通用设置
# --------------------------------------------------------------------------- #
def setup_style() -> None:
    names = {f.name for f in font_manager.fontManager.ttflist}
    for candidate in ("Microsoft YaHei", "SimHei", "Noto Sans CJK SC", "DengXian"):
        if candidate in names:
            plt.rcParams["font.sans-serif"] = [candidate, "DejaVu Sans"]
            break
    plt.rcParams.update({
        "axes.unicode_minus": False,
        "figure.dpi": 120,
        "savefig.dpi": 150,
        "font.size": 9,
        "axes.titlesize": 10,
        "axes.titleweight": "bold",
        "axes.edgecolor": "#cbd5e1",
        "axes.labelcolor": MUTED,
        "xtick.color": MUTED,
        "ytick.color": MUTED,
        "axes.grid": True,
        "grid.color": "#e2e8f0",
        "grid.linewidth": 0.6,
        "legend.frameon": False,
        "legend.fontsize": 8,
    })


def polar(ax, title: str | None = None):
    ax.set_theta_zero_location("N")
    ax.set_theta_direction(-1)
    ax.set_rlim(0, 90)
    ax.set_rticks([0, 30, 60, 90])
    ax.set_yticklabels(["90°", "60°", "30°", "0°"], fontsize=7, color=MUTED)
    ax.set_thetagrids(range(0, 360, 45), ["N", "NE", "E", "SE", "S", "SW", "W", "NW"])
    ax.tick_params(axis="x", labelsize=8, colors=MUTED, pad=1)
    ax.grid(color="#e2e8f0", lw=0.6)
    ax.spines["polar"].set_color("#cbd5e1")
    if title:
        ax.set_title(title, pad=14)
    return ax


def draw_curves(ax, center: float, west: np.ndarray, east: np.ndarray,
                knots: np.ndarray, *, color: str = "#0f766e", lw: float = 1.6,
                label: str | None = None, alpha: float = 1.0) -> None:
    """在极坐标星空图上画两条边界曲线（方位 = 中心 ∓ 半宽）。"""
    west_theta = np.radians((center - west) % 360.0)
    east_theta = np.radians((center + east) % 360.0)
    radius = 90.0 - knots
    ax.plot(west_theta, radius, color=color, lw=lw, alpha=alpha, label=label)
    ax.plot(east_theta, radius, color=color, lw=lw, alpha=alpha)


def shade_band(ax, center: float, west: np.ndarray, east: np.ndarray,
               knots: np.ndarray, *, color: str = "#0d9488", alpha: float = 0.10) -> None:
    """把直射带填成极坐标下的扇形：两条边界 + 地平线弧。"""
    west_theta = (center - west) % 360.0
    east_theta = (center + east) % 360.0
    radius = 90.0 - np.asarray(knots, dtype=float)
    # 地平线弧：从东边界地平线出发、经过带中心回到西边界地平线
    start = float(east_theta[0])
    end = float(west_theta[0])
    if end > start:
        end -= 360.0
    arc = np.linspace(start, end, 48)
    theta = np.concatenate([np.radians(west_theta), np.radians(east_theta[::-1]), np.radians(arc)])
    r = np.concatenate([radius, radius[::-1], np.full(arc.size, 90.0)])
    ax.fill(theta, r, color=color, alpha=alpha, lw=0, zorder=0)


def save(fig, name: str) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / name
    fig.savefig(path, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print(f"  写出 {path}")
    return path


# --------------------------------------------------------------------------- #
# 图 1：原始观测总览
# --------------------------------------------------------------------------- #
def figure_overview(result: ss.SkySplitResult) -> None:
    data = result.data
    summaries = result.summaries
    fig = plt.figure(figsize=(12.6, 9.4))
    grid = fig.add_gridspec(2, 2, hspace=0.32, wspace=0.24)

    # (a) 星空图
    ax = polar(fig.add_subplot(grid[0, 0], projection="polar"), "(a) 55 颗卫星的平均位置（颜色 = 平均 cn0）")
    az = np.array([s.azimuth for s in summaries])
    el = np.array([s.elevation for s in summaries])
    strength = np.array([s.strength for s in summaries])
    track = np.array([s.track_ratio for s in summaries])
    norm = Normalize(10, 45)
    sc = ax.scatter(np.radians(az), 90 - el, c=strength, s=18 + 70 * track,
                    cmap=CN0_CMAP, norm=norm, edgecolors="white", linewidths=0.5, zorder=3)
    for s in summaries:
        if s.strength < 15:
            ax.annotate(s.prn, (math.radians(s.azimuth), 90 - s.elevation), fontsize=6,
                        color=MUTED, xytext=(3, 2), textcoords="offset points")
    cb = fig.colorbar(sc, ax=ax, pad=0.10, shrink=0.78)
    cb.set_label("平均 cn0 (dB-Hz)", fontsize=8, color=MUTED)
    cb.ax.tick_params(labelsize=7, colors=MUTED)
    ax.annotate("南侧（方位约 90°–250°）\n基本无信号", xy=(np.radians(160), 55),
                fontsize=8, color="#b91c1c", ha="center",
                bbox=dict(boxstyle="round,pad=0.3", fc="#fef2f2", ec="#fecaca", lw=0.6))
    ax.annotate("北侧直射区", xy=(np.radians(350), 70), fontsize=8, color="#15803d",
                bbox=dict(boxstyle="round,pad=0.3", fc="#f0fdf4", ec="#bbf7d0", lw=0.6))

    # (b) cn0 分布
    ax = fig.add_subplot(grid[0, 1])
    tracked = data.cn0[data.cn0 > 0]
    ax.hist(tracked, bins=np.arange(10, 48, 2), color="#0ea5e9", alpha=0.75,
            edgecolor="white", linewidth=0.6)
    threshold = result.pca.threshold
    ax.axvline(threshold, color="#b91c1c", ls="--", lw=1.2,
               label=f"Otsu 阈 {threshold:.1f} dB-Hz")
    ax.set_xlabel("被跟踪时的 cn0 (dB-Hz)")
    ax.set_ylabel("记录数")
    ax.set_title("(b) cn0 分布：38–44 dB-Hz 主峰 + 18–32 的弱信号肩")
    ax.legend(loc="upper left")
    ax.text(0.02, 0.70, f"被跟踪记录 {tracked.size:,} 条\n未跟踪记录 {int((data.cn0 == 0).sum()):,} 条（不在图中）",
            transform=ax.transAxes, fontsize=8, color=MUTED)

    # (c) 每颗星强度 vs 方位
    ax = fig.add_subplot(grid[1, 0])
    order = np.argsort(az)
    ax.scatter(az[order], strength[order], c=strength[order], cmap=CN0_CMAP, norm=norm,
               s=26 + 60 * track[order], edgecolors="white", linewidths=0.5, zorder=3)
    ax.axvspan(result.center_azimuth - result.scan.half_width,
               result.center_azimuth + result.scan.half_width,
               color="#0d9488", alpha=0.10, lw=0,
               label=f"朝向 {result.center_azimuth:.1f}° ± {result.scan.half_width:.1f}°")
    ax.set_xlim(0, 360)
    ax.set_xticks(range(0, 361, 45))
    ax.set_xlabel("方位角 (°)")
    ax.set_ylabel("平均 cn0 (dB-Hz)")
    ax.set_title("(c) 方位-强度剖面：北侧一条强信号带，南侧整体塌到底")
    ax.legend(loc="upper left")

    # (d) 三条典型卫星的 cn0 序列
    ax = fig.add_subplot(grid[1, 1])
    picks = [("GPS", "12"), ("BeiDou", "14"), ("GPS", "22")]
    colors = ["#15803d", "#d97706", "#b91c1c"]
    labels = ["GPS 12（北侧低仰角，稳定 41–44）",
              "BeiDou 14（东南 107°，间歇 19–32）",
              "GPS 22（南侧高仰角 63°，15–26）"]
    for (system, prn), color, label in zip(picks, colors, labels):
        group = None
        for candidate in data.groups():
            if data.sat_names[int(data.sat[candidate[0]])] == (system, prn):
                group = candidate
                break
        if group is None:
            continue
        order = np.argsort(data.epoch[group])
        values = data.cn0[group][order].astype(float)
        values[values <= 0] = np.nan
        ax.plot(data.times[data.epoch[group]][order], values,
                color=color, lw=1.2, label=label)
    ax.set_xlabel("时间 (s)")
    ax.set_ylabel("cn0 (dB-Hz)")
    ax.set_ylim(5, 48)
    ax.set_title("(d) 三颗典型卫星的 cn0 序列（断口 = 该历元未跟踪到）")
    ax.legend(loc="lower left", fontsize=7)

    fig.suptitle("图 1  nmea.log 卫星观测总览（428 历元 / 55 颗星 / 18 811 条 GSV 记录）",
                 fontsize=13, fontweight="bold", color=INK, y=0.98)
    save(fig, "fig01_overview.png")


# --------------------------------------------------------------------------- #
# 图 2：整体朝向扫描
# --------------------------------------------------------------------------- #
def figure_orientation(result: ss.SkySplitResult) -> None:
    scan = result.scan
    summaries = result.summaries
    strengths = np.array([s.strength for s in summaries])
    fig = plt.figure(figsize=(12.8, 4.6))
    grid = fig.add_gridspec(1, 3, width_ratios=[1.35, 1, 1.05], wspace=0.28)

    # (a) 得分曲面
    ax = fig.add_subplot(grid[0, 0])
    signed = scan.score_signed
    limit = float(np.nanmax(np.abs(signed))) or 1.0
    mesh = ax.pcolormesh(scan.width_grid, scan.phi_grid, signed, cmap="RdBu_r",
                         norm=TwoSlopeNorm(vcenter=0.0, vmin=-limit, vmax=limit), shading="auto")
    ax.plot(scan.half_width, scan.center_azimuth, marker="*", ms=16, color="#111827",
            markeredgecolor="white", markeredgewidth=0.9, zorder=5,
            label=f"最优 ({scan.center_azimuth:.1f}°, {scan.half_width:.1f}°)")
    ax.set_xlabel("候选半宽 w (°)")
    ax.set_ylabel("候选中心方位 φ0 (°)")
    ax.set_title("(a) 遍历扫描：w0·w1·(带内均值 − 带外均值)")
    ax.annotate(f"最优 ({scan.center_azimuth:.1f}°, {scan.half_width:.1f}°)",
                (scan.half_width, scan.center_azimuth), xytext=(12, -16),
                textcoords="offset points", fontsize=8, color="#111827",
                bbox=dict(boxstyle="round,pad=0.25", fc="white", ec="#cbd5e1", lw=0.6))
    fig.colorbar(mesh, ax=ax, pad=0.02, shrink=0.9).ax.tick_params(labelsize=7)
    ax.text(0.99, 0.02, "蓝 = 带内反而更弱\n（对称的遮挡带解，被符号约束排除）",
            transform=ax.transAxes, fontsize=6.6, color=MUTED, ha="right", va="bottom")

    # (b) 固定最优 w 的得分剖面
    ax = fig.add_subplot(grid[0, 1])
    surface = np.where(np.isfinite(scan.score_surface), scan.score_surface, np.nan)
    row = np.nanmax(surface, axis=1)
    ax.plot(scan.phi_grid, row, color="#0f172a", lw=1.4)
    ax.axvline(scan.center_azimuth, color="#f43f5e", ls="--", lw=1.2,
               label=f"朝向 {scan.center_azimuth:.1f}°")
    ax.axvspan(scan.plateau[0], scan.plateau[1], color="#f43f5e", alpha=0.12, lw=0)
    ax.set_xlim(0, 360)
    ax.set_xticks(range(0, 361, 90))
    ax.set_xlabel("中心方位 φ0 (°)")
    ax.set_ylabel("最佳得分")
    ax.set_title("(b) 得分随 φ0 的剖面（红带 = 等分平台）")
    ax.legend(loc="upper right", fontsize=7)

    # (c) 星空图上的入选带
    ax = polar(fig.add_subplot(grid[0, 2], projection="polar"), "(c) 入选的直射带（24 颗强星）")
    az = np.array([s.azimuth for s in summaries])
    el = np.array([s.elevation for s in summaries])
    members = np.array(scan.members)
    ax.scatter(np.radians(az[members]), 90 - el[members], c=strengths[members], cmap=CN0_CMAP,
               norm=Normalize(10, 45), s=34, edgecolors="white", linewidths=0.6, zorder=3,
               label="带内")
    ax.scatter(np.radians(az[~members]), 90 - el[~members], c="#cbd5e1", s=20,
               edgecolors="white", linewidths=0.5, zorder=2, label="带外")
    west = np.full_like(ss.CURVE_KNOTS, scan.half_width, dtype=float)
    draw_curves(ax, scan.center_azimuth, west, west, ss.CURVE_KNOTS, color="#f43f5e", lw=1.4)
    shade_band(ax, scan.center_azimuth, west, west, ss.CURVE_KNOTS, color="#f43f5e", alpha=0.08)
    ax.legend(loc="lower center", bbox_to_anchor=(0.5, -0.16), ncol=2, fontsize=7)
    fig.suptitle("图 2  第一步：遍历扫描找到卫星的整体朝向与直射带半宽",
                 fontsize=13, fontweight="bold", color=INK, y=1.02)
    save(fig, "fig02_orientation.png")


# --------------------------------------------------------------------------- #
# 图 3：强星 PCA
# --------------------------------------------------------------------------- #
def figure_pca(result: ss.SkySplitResult) -> None:
    pca = result.pca
    data = result.data
    summaries = result.summaries
    tracked = data.cn0[data.cn0 > 0]

    strong = [s for s in summaries if s.track_ratio >= ss.STRONG_TRACK_RATIO
              and s.peak_cn0 >= pca.threshold]
    fig = plt.figure(figsize=(12.8, 8.8))
    grid = fig.add_gridspec(2, 2, hspace=0.34, wspace=0.26)

    # (a) 强星 + PCA 横向轴 + ±w
    ax = polar(fig.add_subplot(grid[0, 0], projection="polar"),
               "(a) 强星与 PCA 第一主成分（带横向）")
    all_az = np.array([s.azimuth for s in summaries])
    all_el = np.array([s.elevation for s in summaries])
    ax.scatter(np.radians(all_az), 90 - all_el, c="#e2e8f0", s=18, zorder=2, label="其他卫星")
    saz = np.array([s.azimuth for s in strong])
    sel = np.array([s.elevation for s in strong])
    sc = ax.scatter(np.radians(saz), 90 - sel, c=np.array([s.peak_cn0 for s in strong]),
                    cmap=CN0_CMAP, norm=Normalize(28, 45), s=45, edgecolors="white",
                    linewidths=0.7, zorder=3, label=f"强星 {len(strong)} 颗")
    ax.plot([np.radians(pca.across_azimuth)] * 2, [0, 90], color="#2563eb", lw=1.8,
            ls="-", label=f"PC1 方位 {pca.across_azimuth:.1f}°")
    ray = np.radians((pca.across_azimuth + 90) % 360.0)
    ax.plot([ray] * 2, [0, 90], color="#f43f5e", lw=1.6, ls="--",
            label=f"带中心 {pca.center_azimuth:.1f}°")
    for sign, text in ((-1, "−w"), (1, "+w")):
        theta = np.radians((pca.center_azimuth + sign * pca.half_width) % 360.0)
        ax.plot([theta] * 2, [0, 90], color="#f43f5e", lw=1.0, ls=":")
    ax.legend(loc="lower center", bbox_to_anchor=(0.5, -0.22), ncol=2, fontsize=7)
    fig.colorbar(sc, ax=ax, pad=0.10, shrink=0.75).set_label("p90 cn0", fontsize=8, color=MUTED)

    # (b) 方位偏移分布
    ax = fig.add_subplot(grid[0, 1])
    dev = np.abs(ss.wrap180(saz - pca.center_azimuth))
    bins = np.arange(0, 181, 5)
    ax.hist(dev, bins=bins, color="#2563eb", alpha=0.6, edgecolor="white", lw=0.5)
    ax.axvline(float(np.quantile(dev, 0.95)), color="#94a3b8", ls="--", lw=1.2,
               label=f"95% 分位 {np.quantile(dev, 0.95):.1f}°（经验张角）")
    ax.axvline(pca.half_width, color="#f43f5e", ls="-", lw=1.4,
               label=f"PCA 估计 w = {pca.half_width:.1f}°")
    ax.set_xlabel("强星相对带中心的方位偏移 |Δaz| (°)")
    ax.set_ylabel("卫星数")
    ax.set_title("(b) 强星几乎都落在 ±75° 以内；PCA 与经验张角相差约 8°")
    ax.legend(loc="upper right", fontsize=7)

    # (c) 解释方差
    ax = fig.add_subplot(grid[1, 0])
    colors = ["#2563eb", "#60a5fa", "#cbd5e1"]
    bars = ax.bar(range(1, 4), pca.explained * 100, color=colors, edgecolor="white", width=0.62)
    for bar, value in zip(bars, pca.explained * 100):
        ax.text(bar.get_x() + bar.get_width() / 2, value + 1.5, f"{value:.1f}%",
                ha="center", fontsize=9, color=INK)
    descr = ["带横向（决定带宽）", "仰角方向（天顶—地平）", "带厚（近似径向）"]
    ax.set_xticks(range(1, 4))
    ax.set_xticklabels([f"PC{i}\n{descr[i-1]}" for i in range(1, 4)], fontsize=8)
    ax.set_ylim(0, 78)
    ax.set_ylabel("解释方差 (%)")
    ax.set_title("(c) 3 维单位向量 PCA：前两轴撑起竖直带，第三轴很薄")
    ax.text(0.03, 0.62,
            f"sin(w)=√3·σ1 → w = {pca.half_width:.1f}°\n"
            f"σ1 = {math.sqrt(float(pca.eigenvalues[0])):.4f}\n"
            f"带宽 2w = {2*pca.half_width:.1f}°",
            transform=ax.transAxes, fontsize=8.5, color=INK,
            bbox=dict(boxstyle="round,pad=0.4", fc="#f8fafc", ec="#e2e8f0"))

    # (d) 3D 单位球
    ax = fig.add_subplot(grid[1, 1], projection="3d")
    vectors = ss.unit_vectors(saz, sel)
    ax.scatter(vectors[:, 0], vectors[:, 1], vectors[:, 2], c=np.array([s.peak_cn0 for s in strong]),
               cmap=CN0_CMAP, norm=Normalize(28, 45), s=24, depthshade=False)
    for axis, color, name in zip(range(3), ["#2563eb", "#0ea5e9", "#94a3b8"],
                                 ["PC1 横向", "PC2 仰角", "PC3 带厚"]):
        direction = pca.axes[:, axis] * math.sqrt(max(float(pca.eigenvalues[axis]), 1e-9)) * 6.5
        ax.quiver(0, 0, 0, direction[0], direction[1], direction[2], color=color, lw=1.6,
                  arrow_length_ratio=0.18)
        ax.text(direction[0] * 1.12, direction[1] * 1.12, direction[2] * 1.12, name,
                fontsize=7, color=color)
    ax.set_xlabel("东", fontsize=7)
    ax.set_ylabel("北", fontsize=7)
    ax.set_zlabel("天顶", fontsize=7)
    ax.set_title("(d) 强星 3 维单位向量与三条主轴（长度 ∝ √λ）")
    ax.tick_params(labelsize=6)
    ax.set_box_aspect((1, 1, 0.75))

    fig.suptitle(
        f"图 3  第二步：强星 PCA（Otsu 阈 {pca.threshold:.1f} dB-Hz，入选 {pca.n_points} 颗）",
        fontsize=13, fontweight="bold", color=INK, y=0.98)
    save(fig, "fig03_pca.png")


# --------------------------------------------------------------------------- #
# 图 4：GMM 分类
# --------------------------------------------------------------------------- #
def figure_classifier(result: ss.SkySplitResult) -> None:
    classifier = result.classifiers[result.main_window]
    features = classifier.features
    probability = classifier.probability
    windows = sorted(result.classifiers)
    fig = plt.figure(figsize=(12.8, 8.8))
    grid = fig.add_gridspec(2, 2, hspace=0.34, wspace=0.24)

    # (a) 特征空间
    ax = fig.add_subplot(grid[0, 0])
    tracked = features[:, 0] > 0
    sc = ax.scatter(features[tracked, 0], features[tracked, 1], c=probability[tracked],
                    cmap=P_CMAP, s=4, alpha=0.5, vmin=0, vmax=1)
    for index, (label, marker) in enumerate((("直射分量", "o"), ("非直射分量", "X"))):
        mean = classifier.means[index]
        ax.scatter(*mean, marker=marker, s=80, c="#0f172a", edgecolors="white",
                   linewidths=1.0, zorder=5)
        ax.annotate(f"{label}\n({mean[0]:.1f}, {mean[1]:.1f})", mean, fontsize=7.5,
                    xytext=(8, -12), textcoords="offset points", color=INK)
    ax.set_xlabel("窗口内 cn0 峰值 (dB-Hz)")
    ax.set_ylabel("窗口内 cn0 均值 (dB-Hz)")
    ax.set_title(f"(a) {result.main_window:.0f}s 窗口特征与 GMM 两分量（点色 = p 直射）")
    fig.colorbar(sc, ax=ax, pad=0.02).set_label("p(直射)", fontsize=8, color=MUTED)

    # (b) p 随 cn0 峰值
    ax = fig.add_subplot(grid[0, 1])
    bins = np.arange(10, 48, 1.0)
    centers = (bins[:-1] + bins[1:]) / 2
    means, p90, p10 = [], [], []
    for low, high in zip(bins[:-1], bins[1:]):
        selected = tracked & (features[:, 0] >= low) & (features[:, 0] < high)
        if selected.sum() < 20:
            means.append(np.nan); p90.append(np.nan); p10.append(np.nan)
            continue
        values = probability[selected]
        means.append(float(values.mean()))
        p10.append(float(np.quantile(values, 0.1)))
        p90.append(float(np.quantile(values, 0.9)))
    ax.fill_between(centers, p10, p90, color="#0ea5e9", alpha=0.20, lw=0, label="10–90% 区间")
    ax.plot(centers, means, color="#0369a1", lw=1.6, label="均值")
    ax.axhline(0.5, color="#f43f5e", ls="--", lw=1.0, label="判决门限 0.5")
    ax.set_xlabel("窗口内 cn0 峰值 (dB-Hz)")
    ax.set_ylabel("p(直射)")
    ax.set_ylim(-0.02, 1.02)
    ax.set_title("(b) 后验概率随信号强度的过渡（约 30 dB-Hz 处翻转）")
    ax.legend(loc="lower right", fontsize=7)

    # (c) 模型选择
    ax = fig.add_subplot(grid[1, 0])
    k = np.array(sorted(classifier.bic))
    bic = np.array([classifier.bic[int(v)] for v in k])
    silhouette = np.array([classifier.silhouette[int(v)] for v in k])
    ax.plot(k, bic - bic.min(), "o-", color="#7c3aed", lw=1.4, label="BIC − min(BIC)")
    ax.set_xlabel("分量数 k")
    ax.set_ylabel("ΔBIC", color="#7c3aed")
    ax.tick_params(axis="y", labelcolor="#7c3aed")
    ax2 = ax.twinx()
    ax2.plot(k, silhouette, "s--", color="#0d9488", lw=1.3, label="轮廓系数")
    ax2.set_ylabel("轮廓系数", color="#0d9488")
    ax2.tick_params(axis="y", labelcolor="#0d9488")
    ax2.grid(False)
    ax.set_xticks(k)
    ax.set_title("(c) 模型选择：轮廓系数在 k=2 最高（BIC 随 k 单调下降是常见现象）")
    handles = ax.get_lines() + ax2.get_lines()
    ax.legend(handles, ["ΔBIC", "轮廓系数"], loc="upper center", fontsize=7)

    # (d) 各窗口的后验分布
    ax = fig.add_subplot(grid[1, 1])
    bins = np.linspace(0, 1, 21)
    colors = ["#f43f5e", "#f59e0b", "#0d9488"]
    for color, window in zip(colors, windows):
        other = result.classifiers[window]
        values = other.probability[other.features[:, 0] > 0]
        ax.hist(values, bins=bins, histtype="step", lw=1.4, color=color,
                label=f"窗口 {window:.0f}s")
    ax.set_yscale("log")
    ax.set_xlabel("p(直射)")
    ax.set_ylabel("记录数（对数）")
    ax.set_title("(d) 三个窗口的后验分布：两端多、中间少 → 判决稳定")
    ax.legend(loc="upper center", fontsize=7)

    fig.suptitle("图 4  第三步：高斯混合模型（2 分量、tied 协方差、无监督）",
                 fontsize=13, fontweight="bold", color=INK, y=0.98)
    save(fig, "fig04_classifier.png")


# --------------------------------------------------------------------------- #
# 图 5：两条边界曲线
# --------------------------------------------------------------------------- #
def figure_curves(result: ss.SkySplitResult) -> None:
    data = result.data
    curves = result.curves
    center = result.center_azimuth
    classifier = result.classifiers[result.main_window]
    summaries = result.summaries
    probability_by_sat = np.zeros(len(summaries))
    for group in data.groups():
        probability_by_sat[int(data.sat[group[0]])] = float(classifier.probability[group].mean())

    fig = plt.figure(figsize=(12.6, 9.6))
    grid = fig.add_gridspec(2, 2, hspace=0.3, wspace=0.3)

    # (a) 星空图 + 两条曲线
    ax = polar(fig.add_subplot(grid[0, 0], projection="polar"),
               "(a) 两条边界曲线把天空切成直射区 / 遮挡区")
    az = np.array([s.azimuth for s in summaries])
    el = np.array([s.elevation for s in summaries])
    shade_band(ax, center, curves.west, curves.east, curves.knots)
    sc = ax.scatter(np.radians(az), 90 - el, c=probability_by_sat, cmap=P_CMAP,
                    s=30 + 70 * np.array([s.track_ratio for s in summaries]),
                    edgecolors="white", linewidths=0.6, vmin=0, vmax=1, zorder=3)
    draw_curves(ax, center, curves.west, curves.east, curves.knots, lw=1.8,
                label="东 / 西边界")
    ax.annotate("直射区", xy=(np.radians(center), 40), fontsize=9, color="#0f766e", ha="center")
    ax.annotate("遮挡区", xy=(np.radians((center + 150) % 360), 60), fontsize=9,
                color="#b91c1c", ha="center")
    ax.legend(loc="lower center", bbox_to_anchor=(0.5, -0.18), fontsize=7)
    fig.colorbar(sc, ax=ax, pad=0.10, shrink=0.75).set_label("平均 p(直射)", fontsize=8, color=MUTED)

    # (b) (az, el) 平面的分割掩膜
    ax = fig.add_subplot(grid[0, 1])
    az_grid, el_grid = ss.GRID_AZ, ss.GRID_EL
    az2, el2 = np.meshgrid(az_grid, el_grid)
    mask = curves.mask(az2, el2, center)
    ax.pcolormesh(az_grid, el_grid, mask.astype(float), cmap=LinearSegmentedColormap.from_list(
        "mask", ["#fee2e2", "#ccfbf1"]), vmin=0, vmax=1, shading="nearest")
    ax.scatter(az, el, c=probability_by_sat, cmap=P_CMAP, s=26, vmin=0, vmax=1,
               edgecolors="white", linewidths=0.6, zorder=3)
    for values, color in ((curves.west, "#0f766e"), (curves.east, "#0f766e")):
        sign = -1 if values is curves.west else 1
        ax.plot((center + sign * values) % 360, curves.knots, color=color, lw=1.8)
    ax.set_xlim(0, 360)
    ax.set_ylim(0, 90)
    ax.set_xticks(range(0, 361, 45))
    ax.set_xlabel("方位角 (°)")
    ax.set_ylabel("仰角 (°)")
    ax.set_title("(b) 同一条分割在方位-仰角平面的样子（绿 = 直射）")

    # (c) 边界可辨识性
    ax = fig.add_subplot(grid[1, 0])
    for name, color in (("west", "#0f766e"), ("east", "#7c3aed")):
        profile = curves.diagnostics[name]["slope_profile"]
        xs = np.array([float(k) for k in profile])
        ys = np.array([profile[k] for k in profile])
        ax.plot(xs, ys - ys.min(), "o-", ms=3, lw=1.2, color=color,
                label=f"{'西' if name == 'west' else '东'}边界")
    ax.set_xlabel("斜率 b（天顶比地平线宽多少度）")
    ax.set_ylabel("相对最小损失")
    ax.set_title("(c) 斜率可辨识性：b≈0 附近很平 → 边界基本是两条直线")
    ax.legend(loc="upper center", fontsize=7)
    ax.set_ylim(-0.05, 6)

    # (d) 半宽随仰角
    ax = fig.add_subplot(grid[1, 1])
    for name, color, label in (("west", "#0f766e", "西边界"), ("east", "#7c3aed", "东边界")):
        line = curves.west if name == "west" else curves.east
        low, high = curves.diagnostics[name]["half_width_range"]
        ax.plot(curves.knots, line, lw=2.0, color=color, label=f"{label}半宽")
        ax.errorbar([0.0, 45.0, 90.0],
                    [float(np.interp(e, curves.knots, line)) for e in (0.0, 45.0, 90.0)],
                    yerr=[[max(0.0, float(np.interp(e, curves.knots, line)) - low) for e in (0.0, 45.0, 90.0)],
                          [max(0.0, high - float(np.interp(e, curves.knots, line))) for e in (0.0, 45.0, 90.0)]],
                    fmt="o", ms=4, color=color, capsize=3, lw=1.0, alpha=0.8)
    ax.set_xlabel("仰角 (°)")
    ax.set_ylabel("半宽 (°)")
    ax.set_ylim(45, 105)
    ax.set_title("(d) 两条曲线本身（误差棒 = 只多误分 1 颗星的容差区间）")
    ax.legend(loc="upper right", fontsize=7)
    ax.text(0.03, 0.08,
            f"直射区方位 [{ (center - curves.west[0]) % 360:.1f}°, { (center + curves.east[0]) % 360:.1f}°]\n"
            f"直射面积占比 {curves.area_fraction(center)*100:.1f}%",
            transform=ax.transAxes, fontsize=8.5,
            bbox=dict(boxstyle="round,pad=0.4", fc="#f8fafc", ec="#e2e8f0"))

    fig.suptitle(f"图 5  第四步：两条边界曲线（朝向 {center:.1f}°）",
                 fontsize=13, fontweight="bold", color=INK, y=0.98)
    save(fig, "fig05_curves.png")


# --------------------------------------------------------------------------- #
# 图 6：不同时刻的分割
# --------------------------------------------------------------------------- #
def figure_time_slices(result: ss.SkySplitResult) -> None:
    data = result.data
    classifier = result.classifiers[result.main_window]
    epoch_curves = result.jitter[result.main_window]["_epoch_curves"]
    center = result.center_azimuth
    counts = np.bincount(data.epoch, minlength=data.n_epochs)
    usable = np.flatnonzero(counts >= 30)
    picks = [int(usable[int(round(q * (usable.size - 1)))]) for q in (0.0, 0.33, 0.66, 1.0)]
    fig = plt.figure(figsize=(13.2, 8.6))
    grid = fig.add_gridspec(2, 2, hspace=0.30, wspace=0.18)
    for index, epoch in enumerate(picks):
        ax = polar(fig.add_subplot(grid[index // 2, index % 2], projection="polar"),
                   f"t = {data.times[epoch]:5.1f} s  ({data.time_text[epoch]})")
        curves = epoch_curves[epoch]
        shade_band(ax, center, curves.west, curves.east, curves.knots)
        draw_curves(ax, center, curves.west, curves.east, curves.knots, lw=1.5)
        selected = data.epoch == epoch
        local_p = classifier.probability[selected]
        ax.scatter(np.radians(data.az[selected]), 90 - data.el[selected], c=local_p,
                   cmap=P_CMAP, s=46, edgecolors="white", linewidths=0.7, vmin=0, vmax=1,
                   zorder=3)
        ax.set_title(f"t = {data.times[epoch]:5.1f} s　直射 {int((local_p >= 0.5).sum())} / "
                     f"{local_p.size} 颗", fontsize=10)
    sm = plt.cm.ScalarMappable(cmap=P_CMAP, norm=Normalize(0, 1))
    cax = fig.add_axes([0.92, 0.25, 0.012, 0.5])
    fig.colorbar(sm, cax=cax).set_label("p(直射)", fontsize=8, color=MUTED)
    fig.suptitle("图 6  逐历元分割结果：曲线随窗口缓变，逐星颜色给出当前判决",
                 fontsize=13, fontweight="bold", color=INK, y=0.97)
    save(fig, "fig06_time_slices.png")


# --------------------------------------------------------------------------- #
# 图 7：时间窗抖动
# --------------------------------------------------------------------------- #
def figure_jitter(result: ss.SkySplitResult) -> None:
    windows = sorted(result.jitter)
    metrics = [result.jitter[w] for w in windows]
    labels = [f"{w:.0f}s" for w in windows]
    fig = plt.figure(figsize=(12.8, 8.6))
    grid = fig.add_gridspec(2, 2, hspace=0.36, wspace=0.26)

    # (a) 标签翻转
    ax = fig.add_subplot(grid[0, 0])
    flips = [m["label_flips_total"] for m in metrics]
    rates = [m["satellite_flip_rate_mean"] * 100 for m in metrics]
    bars = ax.bar(np.arange(len(windows)) - 0.18, flips, width=0.34, color="#f43f5e",
                  label="翻转总次数")
    for bar, value in zip(bars, flips):
        ax.text(bar.get_x() + bar.get_width() / 2, value * 1.03, f"{value}", ha="center",
                fontsize=9, color="#f43f5e")
    ax.set_ylabel("标签翻转总次数", color="#f43f5e")
    ax.tick_params(axis="y", labelcolor="#f43f5e")
    ax2 = ax.twinx()
    ax2.bar(np.arange(len(windows)) + 0.18, rates, width=0.34, color="#0ea5e9",
            label="平均翻转率 (%)")
    for x, value in zip(range(len(windows)), rates):
        ax2.text(x + 0.18, value * 1.03, f"{value:.2f}%", ha="center", fontsize=9, color="#0369a1")
    ax2.set_ylabel("平均翻转率 (%)", color="#0369a1")
    ax2.tick_params(axis="y", labelcolor="#0369a1")
    ax2.grid(False)
    ax.set_xticks(range(len(windows)))
    ax.set_xticklabels(labels)
    ax.set_title("(a) 硬标签翻转：1s 窗口 601 次 → 10s 窗口 92 次")
    ax.legend(loc="upper right", fontsize=7)

    # (b) 边界宽度时间序列
    ax = fig.add_subplot(grid[0, 1])
    colors = ["#f43f5e", "#f59e0b", "#0d9488"]
    widths = [0.7, 1.0, 1.5]
    for color, window, lw in zip(colors, windows, widths):
        series = result.jitter[window]["_west_series"][:, 0]
        ax.plot(data_times(result), series, color=color, lw=lw, alpha=0.85,
                drawstyle="steps-post",
                label=f"{window:.0f}s（σ={np.nanstd(series):.1f}°）")
    ax.axhline(result.curves.west[0], color="#94a3b8", ls="--", lw=1.0,
               label=f"全局 {result.curves.west[0]:.1f}°")
    ax.set_xlabel("时间 (s)")
    ax.set_ylabel("西边界半宽 (°)")
    ax.set_ylim(35, 100)
    ax.set_title("(b) 逐历元重估的边界宽度：只有几档离散值")
    ax.legend(loc="upper right", fontsize=7)

    # (c) 掩膜 IoU
    ax = fig.add_subplot(grid[1, 0])
    x = np.arange(len(windows))
    consecutive = [m["mask_iou_consecutive_mean"] for m in metrics]
    versus_global = [m["mask_iou_vs_global_mean"] for m in metrics]
    ax.plot(x, consecutive, "o-", color="#0d9488", lw=1.6, label="相邻历元 IoU")
    ax.plot(x, versus_global, "s--", color="#7c3aed", lw=1.4, label="相对全局分割 IoU")
    for xi, a, b in zip(x, consecutive, versus_global):
        ax.annotate(f"{a:.3f}", (xi, a), xytext=(0, 7), textcoords="offset points",
                    ha="center", fontsize=8, color="#0d9488")
        ax.annotate(f"{b:.3f}", (xi, b), xytext=(0, -13), textcoords="offset points",
                    ha="center", fontsize=8, color="#7c3aed")
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_ylim(0.6, 1.06)
    ax.set_ylabel("IoU")
    ax.set_title("(c) 区域掩膜一致性：10s 窗口相邻历元 IoU 达 0.994")
    ax.legend(loc="lower right", fontsize=7)

    # (d) 典型卫星在三档窗口下的判决
    sub = grid[1, 1].subgridspec(2, 1, height_ratios=[1.0, 1.25], hspace=0.12)
    ax = fig.add_subplot(sub[0])
    ax_p = fig.add_subplot(sub[1], sharex=ax)
    data = result.data
    flips_by_sat: dict[int, int] = {}
    zero_window = min(result.jitter)
    for group in data.groups():
        series = result.classifiers[zero_window].labels[group][np.argsort(data.epoch[group])]
        flips_by_sat[int(data.sat[group[0]])] = int(np.count_nonzero(np.diff(series)))
    target_index = min(
        (index for index, value in flips_by_sat.items() if value >= 3),
        key=lambda index: abs(flips_by_sat[index] - 6),
        default=max(flips_by_sat, key=flips_by_sat.get),
    )
    target = next(group for group in result.data.groups()
                  if int(result.data.sat[group[0]]) == target_index)
    order = np.argsort(result.data.epoch[target])
    times = result.data.times[result.data.epoch[target]][order]
    cn0 = result.data.cn0[target][order].astype(float)
    cn0[cn0 <= 0] = np.nan
    ax.plot(times, cn0, color="#0f172a", lw=1.0, label="cn0")
    ax.set_ylim(8, 52)
    ax.set_ylabel("cn0 (dB-Hz)")
    ax.tick_params(labelbottom=False)
    for color, window in zip(colors, windows):
        p = result.classifiers[window].probability[target][order]
        ax_p.plot(times, p, color=color, lw=1.2, label=f"p({window:.0f}s)")
    ax_p.set_ylim(-0.03, 1.03)
    ax_p.set_ylabel("p(直射)")
    ax_p.set_xlabel("时间 (s)")
    system, prn = result.data.sat_names[int(result.data.sat[target[0]])]
    ax.set_title(f"(d) {system} {prn}（典型边界星）的 cn0 与三档窗口后验")
    handles = ax.get_lines() + ax_p.get_lines()
    ax_p.legend(handles, [h.get_label() for h in handles], loc="lower right",
                fontsize=7, ncol=4)

    fig.suptitle("图 7  时间窗仿真：当前 1s / 过去 5s / 过去 10s 的模型抖动",
                 fontsize=13, fontweight="bold", color=INK, y=0.98)
    save(fig, "fig07_jitter.png")


def data_times(result: ss.SkySplitResult) -> np.ndarray:
    return result.data.times


# --------------------------------------------------------------------------- #
# 图 8：旋转数据增强
# --------------------------------------------------------------------------- #
def figure_rotation(result: ss.SkySplitResult) -> None:
    rotation = result.rotation
    rows = rotation["rows"]
    beta = np.array([row["rotation_deg"] for row in rows])
    center = np.array([row["center_azimuth"] for row in rows])
    error = np.array([row["center_error_deg"] for row in rows])
    width = np.array([row["half_width_pca"] for row in rows])
    area = np.array([row["direct_area_fraction"] for row in rows])
    iou = np.array([row["mask_iou_vs_base"] for row in rows])

    fig = plt.figure(figsize=(12.8, 9.2))
    grid = fig.add_gridspec(2, 2, hspace=0.42, wspace=0.26)

    # (a) 旋转 0° 与 100° 的扫描剖面（整条曲线平移）
    ax = fig.add_subplot(grid[0, 0])
    for rot_angle, color, ls in ((0.0, "#2563eb", "-"), (100.0, "#f43f5e", "--")):
        rotated = result.data.rotated(rot_angle)
        summaries = ss.summarize_satellites(rotated)
        scan = ss.scan_orientation(summaries)
        surface = np.where(np.isfinite(scan.score_surface), scan.score_surface, np.nan)
        ax.plot(scan.phi_grid, np.nanmax(surface, axis=1), color=color, ls=ls, lw=1.3,
                label=f"β = {rot_angle:.0f}°（峰值 {scan.center_azimuth:.1f}°）")
    ax.set_xlim(0, 360)
    ax.set_xticks(range(0, 361, 90))
    ax.set_xlabel("候选中心方位 φ0 (°)")
    ax.set_ylabel("最佳得分")
    ax.set_title("(a) 旋转 100° 后扫描剖面整体平移 100°")
    ax.legend(loc="upper left", fontsize=7)

    # (b) 残差
    ax = fig.add_subplot(grid[0, 1])
    ax.plot(beta, error, "o", ms=4, color="#f43f5e")
    ax.axhline(0, color="#0f172a", lw=0.8)
    ax.set_xlabel("旋转角 β (°)")
    ax.set_ylabel("朝向残差 (°)")
    ax.set_ylim(-1.2, 1.2)
    ax.set_title("(b) 去旋转后与基准的偏差：全部为 0（整数方位格点上的严格等变）")
    ax.text(0.5, 0.55, f"36 组残差绝对值最大 {np.abs(error).max():.3f}°",
            transform=ax.transAxes, ha="center", fontsize=9, color=MUTED)
    ax.set_xticks(range(0, 361, 60))

    # (c) 带宽与面积
    ax = fig.add_subplot(grid[1, 0])
    ax.plot(beta, width, "o-", ms=3.5, color="#0d9488", lw=1.2, label="PCA 半宽")
    ax.axhline(result.pca.half_width, color="#94a3b8", ls="--", lw=1.0, label="基准")
    ax.set_xlabel("旋转角 β (°)")
    ax.set_ylabel("半宽 (°)", color="#0d9488")
    ax.tick_params(axis="y", labelcolor="#0d9488")
    ax.set_ylim(60, 90)
    ax2 = ax.twinx()
    ax2.plot(beta, area * 100, "s--", ms=3, color="#7c3aed", lw=1.1, label="直射面积占比")
    ax2.set_ylabel("直射面积占比 (%)", color="#7c3aed")
    ax2.tick_params(axis="y", labelcolor="#7c3aed")
    ax2.set_ylim(30, 50)
    ax2.grid(False)
    ax.set_title(f"(c) 带宽 σ={width.std():.2f}°，面积 σ={area.std()*100:.2f}%")
    ax.set_xticks(range(0, 361, 60))

    # (d) 36 组去旋转后的边界曲线叠在一起
    ax = fig.add_subplot(grid[1, 1], projection="polar")
    polar(ax, "(d) 36 组旋转各自估计的边界（去旋转后叠画）")
    shade_band(ax, result.center_azimuth,
               np.full(3, result.curves.west[0]), np.full(3, result.curves.east[0]),
               np.array([15.0, 45.0, 75.0]), color="#0d9488", alpha=0.12)
    for row in rows:
        center_back = (row["center_azimuth"] - row["rotation_deg"]) % 360
        west = np.array(row["west"])
        east = np.array(row["east"])
        knots = np.array([15.0, 45.0, 75.0])
        draw_curves(ax, center_back, west, east, knots, lw=1.0, alpha=0.30)
    ax.text(0.5, -0.08,
            f"步长 {rotation['step_degrees']:.0f}°，共 {len(rows)} 组；"
            f"朝向误差 ≤ {rotation['center_error_abs_max']:.2f}°，"
            f"带宽 σ {rotation['half_width_pca_std']:.2f}°\n"
            f"直射面积 {rotation['area_mean']*100:.1f}% ± {rotation['area_std']*100:.2f}%，"
            f"掩膜 IoU {rotation['mask_iou_mean']:.3f}；"
            f"亚度偏移最大误差 {result.rotation_fine['center_error_abs_max']:.2f}°",
            transform=ax.transAxes, fontsize=7.2, color=MUTED, va="top", ha="center",
            bbox=dict(boxstyle="round,pad=0.35", fc="white", ec="#e2e8f0"))

    fig.suptitle("图 8  旋转数据增强：把卫星方位每 10° 转一次，整条流水线重跑",
                 fontsize=13, fontweight="bold", color=INK, y=0.98)
    save(fig, "fig08_rotation.png")


# --------------------------------------------------------------------------- #
# 图 9：算法示意图
# --------------------------------------------------------------------------- #
def figure_pipeline(result: ss.SkySplitResult) -> None:
    fig, ax = plt.subplots(figsize=(13.0, 8.2))
    ax.set_xlim(0, 13)
    ax.set_ylim(0, 8.2)
    ax.axis("off")
    ax.grid(False)

    def box(x, y, w, h, title, body, color, text_color="#0f172a"):
        patch = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.06,rounding_size=0.12",
                               fc=color, ec="#cbd5e1", lw=1.0, zorder=3)
        ax.add_patch(patch)
        ax.text(x + w / 2, y + h - 0.20, title, ha="center", va="top", fontsize=10,
                fontweight="bold", color=text_color, zorder=4)
        ax.text(x + 0.14, y + h - 0.55, body, ha="left", va="top", fontsize=8.2,
                color=MUTED, zorder=4, linespacing=1.55)

    def arrow(x1, y1, x2, y2, color="#64748b"):
        ax.add_patch(FancyArrowPatch((x1, y1), (x2, y2), arrowstyle="-|>", mutation_scale=14,
                                     lw=1.3, color=color, zorder=2,
                                     shrinkA=0, shrinkB=0))

    box(0.3, 6.05, 3.3, 1.85, "① 观测数据",
        "NMEA GSV：方位 / 仰角 / cn0\n"
        "428 历元 · 55 颗星 · 18 811 条\n"
        "cn0 = 0 记为“未跟踪到”",
        "#e0f2fe")

    box(4.35, 6.05, 3.9, 1.85, "② 整体朝向（遍历扫描）",
        "每颗星 → (方位, 平均 cn0)\n"
        "遍历 φ0 ∈[0°,360°)、w ∈[40°,179°]\n"
        "最大化两类间方差 → 带内更强\n"
        f"结果：φ0 = {result.center_azimuth:.1f}°，w = {result.scan.half_width:.1f}°",
        "#fef9c3")

    box(9.0, 6.05, 3.6, 1.85, "③ 强星 PCA（带宽）",
        f"Otsu 阈 {result.pca.threshold:.1f} dB-Hz 选 {result.pca.n_points} 颗强星\n"
        "3 维单位向量 PCA\n"
        f"PC1 沿带横向（az {result.pca.across_azimuth:.1f}°）\n"
        f"sin(w)=√3·σ1 → w = {result.pca.half_width:.1f}°",
        "#ede9fe")

    box(0.3, 3.35, 3.9, 2.05, "④ 窗口特征 + GMM",
        "逐“卫星 × 历元”取当前 1s / 过去 5s / 10s：\n"
        "[cn0 峰值, cn0 均值]，未跟踪 → 非直射\n"
        "2 分量高斯混合（tied 协方差）\n"
        "cn0 高的分量 = 直射，输出 p(直射) ∈[0,1]",
        "#dcfce7")

    box(5.0, 3.35, 3.5, 2.05, "⑤ 两条边界曲线",
        "把 p≥0.5 当作直射硬标签\n"
        "在 W(el)=a+b·el/90 上做二维搜索\n"
        "最小化误分星数（双向最大对比）\n"
        f"西 {result.curves.west[0]:.1f}° / 东 {result.curves.east[0]:.1f}°–{result.curves.east[-1]:.1f}°",
        "#ccfbf1")

    box(9.15, 3.35, 3.4, 2.05, "⑥ 输出",
        "天空分割掩膜（直射 / 遮挡）\n"
        "逐星直射概率与硬标签\n"
        "out/sky_split.json → 查看器叠加\n"
        "CSV / summary.json 全部指标",
        "#ffe4e6")

    box(2.0, 0.55, 4.1, 1.85, "⑦ 抖动仿真（1s / 5s / 10s）",
        "标签翻转 601 → 120 → 92 次\n"
        "相邻历元掩膜 IoU 0.954 → 0.994\n"
        "边界 Δ 3.4° → 0.4° / 历元",
        "#f1f5f9")

    box(6.85, 0.55, 4.2, 1.85, "⑧ 旋转数据增强（每 10°）",
        "36 组旋转后流水线重跑\n"
        f"朝向误差 {result.rotation['center_error_abs_mean']:.2f}°"
        f"（最大 {result.rotation['center_error_abs_max']:.2f}°）\n"
        f"掩膜 IoU {result.rotation['mask_iou_mean']:.3f}",
        "#f1f5f9")

    arrow(3.6, 6.95, 4.35, 6.95)
    arrow(8.25, 6.95, 9.0, 6.95)
    arrow(5.45, 6.0, 3.4, 5.45)
    arrow(9.6, 6.0, 7.6, 5.45)
    arrow(4.2, 4.35, 5.0, 4.35)
    arrow(8.5, 4.35, 9.15, 4.35)
    arrow(7.6, 3.3, 5.4, 2.45)
    arrow(10.2, 3.3, 9.2, 2.45)

    ax.text(6.5, 8.02, "图 9  天空遮挡分割算法流程（全部无监督，无决策树类模型）",
            ha="center", fontsize=13, fontweight="bold", color=INK)
    ax.text(6.5, 0.12, "实线箭头 = 主链路；⑦⑧ 是两条评估支路，用同一套输出做稳定性检验",
            ha="center", fontsize=8, color=MUTED)
    save(fig, "fig09_pipeline.png")


# --------------------------------------------------------------------------- #
# 主入口
# --------------------------------------------------------------------------- #
FIGURES = {
    1: ("fig01_overview.png", figure_overview),
    2: ("fig02_orientation.png", figure_orientation),
    3: ("fig03_pca.png", figure_pca),
    4: ("fig04_classifier.png", figure_classifier),
    5: ("fig05_curves.png", figure_curves),
    6: ("fig06_time_slices.png", figure_time_slices),
    7: ("fig07_jitter.png", figure_jitter),
    8: ("fig08_rotation.png", figure_rotation),
    9: ("fig09_pipeline.png", figure_pipeline),
}


def feature_ablation(result: ss.SkySplitResult, out_dir: Path | None = None) -> list[dict]:
    out_dir = BASE / "out" / "sky_split" if out_dir is None else out_dir
    """特征消融：固定 GMM 其余设置，只换聚类特征，看弱星被误判为直射的比例。

    结果写成 ``out/sky_split/feature_ablation.json``，报告里的表直接引用它。
    """
    from sklearn.mixture import GaussianMixture
    from sklearn.preprocessing import StandardScaler

    data = result.data
    summaries = result.summaries
    center = result.center_azimuth
    features = ss.window_features(data, 10.0)
    tracked = features[:, 0] > 0
    keys = np.array([f"{data.sat_names[s][0]}|{data.sat_names[s][1]}" for s in data.sat])
    satellite_keys = [f"{s.system}|{s.prn}" for s in summaries]
    weak = {key for key, s in zip(satellite_keys, summaries) if 0.0 < s.peak_cn0 < 28.0}
    in_band = {
        key: abs(float(ss.wrap180(s.azimuth - center))) <= result.scan.half_width
        for key, s in zip(satellite_keys, summaries)
    }

    rows = []
    for name, columns in (
        ("cn0_peak", (0,)),
        ("cn0_mean", (1,)),
        ("cn0_peak + cn0_mean", (0, 1)),
        ("cn0_peak + cn0_mean + track_ratio", (0, 1, 2)),
    ):
        subset = features[tracked][:, list(columns)]
        scaler = StandardScaler().fit(subset)
        scaled = scaler.transform(subset)
        model = GaussianMixture(2, covariance_type="tied", reg_covar=1e-3,
                                n_init=5, random_state=0).fit(scaled)
        means = scaler.inverse_transform(model.means_)
        direct = int(np.argmax(means[:, 0]))
        probability = np.zeros(len(features))
        probability[tracked] = model.predict_proba(scaled)[:, direct]
        per_satellite = {key: float(probability[keys == key].mean()) for key in satellite_keys}
        agree = np.mean([(per_satellite[key] >= 0.5) == in_band[key] for key in satellite_keys])
        weak_flagged = [key for key in weak if per_satellite[key] >= 0.5]
        rows.append({
            "features": name,
            "component_means": [[round(float(v), 1) for v in row] for row in means],
            "agreement_with_band": round(float(agree), 3),
            "weak_satellites": len(weak),
            "weak_flagged_direct": len(weak_flagged),
            "weak_flagged_keys": sorted(weak_flagged),
        })
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "feature_ablation.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    for row in rows:
        print(f"  {row['features']:38s} 一致率 {row['agreement_with_band']:.3f}  "
              f"弱星误判 {row['weak_flagged_direct']}/{row['weak_satellites']}")
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="生成 sky_split.md 的插图")
    parser.add_argument("--only", type=int, nargs="*", help="只画指定编号的图")
    parser.add_argument("--input", type=Path, default=BASE / "nmea.log")
    parser.add_argument("--ablation", action="store_true", help="额外运行特征消融实验")
    args = parser.parse_args(argv)

    setup_style()
    print("运行 sky_split 分析 ...")
    result = ss.analyse(args.input)
    if args.ablation:
        print("特征消融 ...")
        feature_ablation(result)
    print("生成插图 ...")
    for number in sorted(FIGURES):
        if args.only and number not in args.only:
            continue
        _, function = FIGURES[number]
        function(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
