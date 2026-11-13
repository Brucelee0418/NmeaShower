#!/usr/bin/env python3
"""NMEA 文件分析脚本（task1）。

从 GNSS 接收机记录的 NMEA 0183 文件中解析出时间、经纬度、高度、速度、
航向与卫星信息，并在终端打印统计摘要；可选导出 CSV / JSON 供后续处理。

用法示例::

    python analyze_nmea.py nmea.log
    python analyze_nmea.py nmea.log --csv out/epochs.csv --sky-csv out/sky.csv
    python analyze_nmea.py nmea.log --json out/nmea.json

只依赖 Python 标准库（3.10+）。
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

from nmea_parser import Epoch, ParseResult, parse_file, summarize

EPOCH_COLUMNS = [
    ("datetime", lambda e: e.datetime_iso),
    ("time", lambda e: e.time),
    ("date", lambda e: e.date.isoformat() if e.date else None),
    ("lat", lambda e: _round(e.lat, 9)),
    ("lon", lambda e: _round(e.lon, 9)),
    ("altitude_m", lambda e: _round(e.altitude, 3)),
    ("ellipsoid_height_m", lambda e: _round(e.ellipsoid_height, 3)),
    ("geoid_separation_m", lambda e: _round(e.geoid_separation, 3)),
    ("speed_knots", lambda e: _round(e.speed_knots, 3)),
    ("speed_kmh", lambda e: _round(e.speed_kmh, 3)),
    ("course_deg", lambda e: _round(e.course, 2)),
    ("fix_quality", lambda e: e.fix_quality),
    ("fix_type", lambda e: e.fix_type),
    ("fix_label", lambda e: e.fix_label),
    ("sats_used", lambda e: e.num_sats_used),
    ("sats_view", lambda e: e.num_sats_view),
    ("hdop", lambda e: _round(e.hdop, 2)),
    ("pdop", lambda e: _round(e.pdop, 2)),
    ("vdop", lambda e: _round(e.vdop, 2)),
]

SKY_COLUMNS = ["datetime", "time", "system", "prn", "elevation_deg", "azimuth_deg", "cn0_dbhz"]


def _round(value: float | None, digits: int) -> float | None:
    return None if value is None else round(value, digits)


# --------------------------------------------------------------------------- #
# 导出
# --------------------------------------------------------------------------- #
def write_epoch_csv(result: ParseResult, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow([name for name, _ in EPOCH_COLUMNS])
        for epoch in result.epochs:
            writer.writerow([getter(epoch) for _, getter in EPOCH_COLUMNS])


def write_sky_csv(result: ParseResult, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(SKY_COLUMNS)
        for epoch in result.epochs:
            for satellite in epoch.satellites.values():
                writer.writerow(
                    [
                        epoch.datetime_iso,
                        epoch.time,
                        satellite.system,
                        satellite.prn,
                        _round(satellite.elevation, 2),
                        _round(satellite.azimuth, 2),
                        _round(satellite.cn0, 2),
                    ]
                )


def write_json(result: ParseResult, path: Path, *, summary_only: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = summarize(result) if summary_only else result.to_dict()
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


# --------------------------------------------------------------------------- #
# 终端摘要
# --------------------------------------------------------------------------- #
def _fmt(value, unit: str = "", digits: int = 2) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:.{digits}f}{unit}"
    return f"{value}{unit}"


def print_summary(result: ParseResult, source: str) -> None:
    summary = summarize(result)
    file_info = summary["file"]

    print("=" * 66)
    print(f"NMEA 分析报告  {source}")
    print("=" * 66)
    print(f"语句行数      : {file_info['lines']}")
    print(f"有效语句      : {file_info['sentences']}")
    print(f"忽略/私有语句 : {file_info['ignored']}")
    print(f"校验和错误    : {file_info['checksumErrors']}")

    types = sorted(file_info["byType"].items(), key=lambda item: -item[1])
    print("语句类型      : " + ", ".join(f"{name}×{count}" for name, count in types))

    time_info = summary.get("time")
    if time_info:
        print("-" * 66)
        print(f"起始时刻 (UTC): {time_info['start']}")
        print(f"结束时刻 (UTC): {time_info['end']}")
        print(f"观测时长      : {_fmt(time_info['durationSeconds'], ' s', 3)}")
        print(f"历元数        : {summary['epochs']} (有效定位 {summary['fixEpochs']})")
        print(f"平均采样间隔  : {_fmt(time_info.get('meanIntervalSeconds'), ' s', 3)}")

    track = summary.get("track")
    if track:
        print("-" * 66)
        print(f"起点          : {track['start']['lat']:.9f}, {track['start']['lon']:.9f}")
        print(f"终点          : {track['end']['lat']:.9f}, {track['end']['lon']:.9f}")
        print(f"轨迹长度      : {_fmt(track['distanceMeters'], ' m', 1)}")

    altitude = summary.get("altitudeMeters")
    if altitude:
        print(f"海拔高        : {altitude['min']:.2f} ~ {altitude['max']:.2f} m (均值 {altitude['mean']:.2f})")

    speed = summary.get("speedKmh")
    if speed:
        print(f"地面速度      : {speed['min']:.2f} ~ {speed['max']:.2f} km/h (均值 {speed['mean']:.2f})")

    course = summary.get("courseDeg")
    if course:
        print(f"真航向        : {course['min']:.1f}° ~ {course['max']:.1f}°")

    used = summary.get("satsUsed")
    visible = summary.get("satsVisible")
    if used or visible:
        print("-" * 66)
        if used:
            print(f"参与解算卫星  : {used['min']} ~ {used['max']} (均值 {used['mean']})")
        if visible:
            print(f"可见卫星      : {visible['min']} ~ {visible['max']} (均值 {visible['mean']})")
        systems = summary.get("systems") or {}
        if systems:
            print("星座分布      : " + ", ".join(f"{name} {count} 颗" for name, count in systems.items()))
        cn0 = summary.get("cn0")
        if cn0:
            print(f"载噪比 cn0    : {cn0['min']} ~ {cn0['max']} dB-Hz (均值 {cn0['mean']})")

    fix = summary.get("fixQuality") or {}
    if fix:
        print(f"定位状态      : " + ", ".join(f"{name} {count}" for name, count in fix.items()))
    hdop = summary.get("hdop")
    if hdop:
        print(f"HDOP          : {hdop['min']} ~ {hdop['max']}")
    print("=" * 66)


def _preview(result: ParseResult, limit: int) -> None:
    print(f"\n前 {min(limit, len(result.epochs))} 个历元预览:")
    header = f"{'时刻':<14}{'纬度':>12}{'经度':>13}{'海拔':>8}{'速度km/h':>10}{'航向':>8}{'星数':>6}"
    print(header)
    for epoch in result.epochs[:limit]:
        print(
            f"{_fmt(epoch.time, '', 3):<14}"
            f"{_fmt(epoch.lat, '', 7):>12}"
            f"{_fmt(epoch.lon, '', 7):>13}"
            f"{_fmt(epoch.altitude, '', 1):>8}"
            f"{_fmt(epoch.speed_kmh, '', 2):>10}"
            f"{_fmt(epoch.course, '', 1):>8}"
            f"{_fmt(epoch.num_sats_used, '', 0):>6}"
        )


# --------------------------------------------------------------------------- #
# 入口
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="解析 NMEA 0183 文件，输出时间/位置/高度/速度/航向/卫星信息",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("file", nargs="?", default="nmea.log", help="NMEA 文件路径")
    parser.add_argument("--csv", type=Path, help="导出的历元级 CSV 路径")
    parser.add_argument("--sky-csv", type=Path, help="导出的卫星明细 CSV 路径")
    parser.add_argument("--json", type=Path, help="导出的 JSON 路径（含卫星明细）")
    parser.add_argument("--summary-json", type=Path, help="只导出统计摘要的 JSON 路径")
    parser.add_argument("--preview", type=int, default=5, help="预览历元数量，0 表示不预览")
    parser.add_argument(
        "--no-strict-checksum",
        action="store_true",
        help="校验和错误的语句仍然参与解析",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = build_parser().parse_args(argv)

    source = Path(args.file)
    if not source.is_file():
        print(f"找不到文件: {source}", file=sys.stderr)
        return 2

    result = parse_file(str(source), strict_checksum=not args.no_strict_checksum)
    if not result.epochs:
        print("未解析出任何历元，请检查文件格式。", file=sys.stderr)
        return 1

    print_summary(result, str(source))
    if args.preview > 0:
        _preview(result, args.preview)

    if args.csv:
        write_epoch_csv(result, args.csv)
        print(f"已写出历元 CSV   : {args.csv}")
    if args.sky_csv:
        write_sky_csv(result, args.sky_csv)
        print(f"已写出卫星 CSV   : {args.sky_csv}")
    if args.json:
        write_json(result, args.json)
        print(f"已写出 JSON      : {args.json}")
    if args.summary_json:
        write_json(result, args.summary_json, summary_only=True)
        print(f"已写出摘要 JSON  : {args.summary_json}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
