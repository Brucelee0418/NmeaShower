"""NMEA 0183 GNSS 报文解析库。

只依赖标准库，供 :mod:`analyze_nmea` 命令行工具与测试使用。

支持解析的语句：

* ``RMC`` —— 时间/日期、位置、地面速度（节）、真航向、定位状态
* ``GGA`` —— 位置、定位质量、参与解算卫星数、HDOP、海拔高、大地水准面差距
* ``GNS`` —— 位置、分系统定位模式、海拔高
* ``VTG`` —— 真航向、磁航向、速度（节 / km/h）
* ``GSA`` —— 定位类型（2D/3D）、DOP、参与解算的卫星
* ``GSV`` —— 可见卫星的仰角、方位角、载噪比（cn0）
* ``DTM`` —— 基准面（只做统计）

多星座语句通过 talker 区分：GP=GPS、GL=GLONASS、GA=Galileo、
GB/BD=BeiDou、GQ=QZSS、GN=多系统融合。
"""

from __future__ import annotations

import bisect
import datetime as dt
import math
import re
from collections import Counter, OrderedDict
from dataclasses import dataclass, field
from typing import Iterable, Iterator

__all__ = [
    "Satellite",
    "Epoch",
    "ParseResult",
    "Sentence",
    "nmea_checksum",
    "parse_sentence",
    "parse_lines",
    "parse_file",
    "summarize",
    "haversine",
]

# talker -> 星座名
TALKER_SYSTEMS = {
    "GP": "GPS",
    "GL": "GLONASS",
    "GA": "Galileo",
    "GB": "BeiDou",
    "BD": "BeiDou",
    "GQ": "QZSS",
    "GI": "NavIC",
    "GN": "MULTI",
}

# GGA 定位质量 -> 说明
FIX_QUALITY_LABELS = {
    0: "无效",
    1: "单点定位",
    2: "DGPS",
    3: "PPS",
    4: "RTK 固定",
    5: "RTK 浮动",
    6: "航位推算",
    7: "手动输入",
    8: "仿真",
}

# GSA 定位类型
FIX_TYPE_LABELS = {1: "无定位", 2: "2D", 3: "3D"}

_SENTENCE_RE = re.compile(r"^\$(?P<body>[^*]*)(?:\*(?P<cksum>[0-9A-Fa-f]{2}))?\s*$")


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #
def nmea_checksum(body: str) -> int:
    """计算 NMEA 校验和：``$`` 与 ``*`` 之间所有字符的 8 位异或。"""
    value = 0
    for ch in body:
        value ^= ord(ch)
    return value


def _parse_float(value: str) -> float | None:
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _parse_int(value: str) -> int | None:
    number = _parse_float(value)
    if number is None:
        return None
    return int(number)


def parse_coordinate(value: str, hemisphere: str) -> float | None:
    """把 ``ddmm.mmmm`` / ``dddmm.mmmm`` 转成十进制度，南纬/西经取负。"""
    raw = _parse_float(value)
    if raw is None:
        return None
    degrees = int(raw // 100)
    minutes = raw - degrees * 100.0
    decimal = degrees + minutes / 60.0
    if hemisphere.strip().upper() in ("S", "W"):
        decimal = -decimal
    return decimal


def parse_time(value: str) -> tuple[str, float] | None:
    """``hhmmss.ss`` -> (``HH:MM:SS.sss``, 当日秒数)。"""
    value = (value or "").strip()
    if len(value) < 6 or not value[:6].isdigit():
        return None
    hour = int(value[0:2])
    minute = int(value[2:4])
    seconds = float(value[4:])
    if not (0 <= hour <= 23 and 0 <= minute <= 59 and 0 <= seconds < 61):
        return None
    seconds_of_day = hour * 3600 + minute * 60 + seconds
    text = f"{hour:02d}:{minute:02d}:{seconds:06.3f}"
    return text, seconds_of_day


def parse_date(value: str) -> dt.date | None:
    """``ddmmyy`` -> :class:`datetime.date`。"""
    value = (value or "").strip()
    if len(value) < 6 or not value[:6].isdigit():
        return None
    day, month, year = int(value[0:2]), int(value[2:4]), int(value[4:6])
    # NMEA 用两位年；按 1980-2079 解释
    year += 2000 if year < 80 else 1900
    if not (1 <= day <= 31 and 1 <= month <= 12):
        return None
    try:
        return dt.date(year, month, day)
    except ValueError:
        return None


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """两点大圆距离，单位米。"""
    radius = 6_371_008.8
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = phi2 - phi1
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * radius * math.asin(min(1.0, math.sqrt(a)))


# --------------------------------------------------------------------------- #
# 语句解析
# --------------------------------------------------------------------------- #
@dataclass(slots=True)
class Sentence:
    """一条已拆分的 NMEA 语句。"""

    talker: str
    type: str
    fields: list[str]
    checksum_ok: bool | None = None
    line_no: int = 0
    raw: str = ""

    def get(self, index: int, default: str = "") -> str:
        try:
            return self.fields[index]
        except IndexError:
            return default

    def number(self, index: int) -> float | None:
        return _parse_float(self.get(index))

    @property
    def system(self) -> str:
        return TALKER_SYSTEMS.get(self.talker, self.talker or "UNKNOWN")


def parse_sentence(line: str, line_no: int = 0) -> Sentence | None:
    """解析单条语句；不是合法 NMEA 语句时返回 ``None``。

    校验和不匹配时仍返回语句（``checksum_ok=False``），由调用方决定是否剔除，
    这样便于统计坏数据而不必静默丢弃。
    """
    text = line.strip()
    match = _SENTENCE_RE.match(text)
    if not match:
        return None
    body = match.group("body")
    if not body:
        return None
    parts = body.split(",")
    address = parts[0].strip()
    if len(address) < 3:
        return None
    talker, sentence_type = address[:-3], address[-3:]
    if not sentence_type.isalpha():
        return None

    checksum_ok: bool | None = None
    checksum = match.group("cksum")
    if checksum is not None:
        checksum_ok = nmea_checksum(body) == int(checksum, 16)

    return Sentence(
        talker=talker.upper(),
        type=sentence_type.upper(),
        fields=parts[1:],
        checksum_ok=checksum_ok,
        line_no=line_no,
        raw=text,
    )


# --------------------------------------------------------------------------- #
# 数据模型
# --------------------------------------------------------------------------- #
@dataclass(slots=True)
class Satellite:
    """一颗可见卫星。"""

    system: str
    prn: str
    elevation: float | None = None  # 仰角，度
    azimuth: float | None = None  # 方位角，度（真北顺时针）
    cn0: float | None = None  # 载噪比 dB-Hz

    @property
    def sky_r(self) -> float | None:
        """极坐标半径：天顶=0，地平线=90。"""
        return None if self.elevation is None else max(0.0, 90.0 - self.elevation)

    def to_dict(self) -> dict:
        return {
            "system": self.system,
            "prn": self.prn,
            "elevation": self.elevation,
            "azimuth": self.azimuth,
            "cn0": self.cn0,
        }


@dataclass(slots=True)
class Epoch:
    """一个观测历元（同一 UTC 时刻的所有语句）。"""

    time: str | None = None  # HH:MM:SS.sss
    date: dt.date | None = None
    seconds_of_day: float | None = None

    lat: float | None = None
    lon: float | None = None
    altitude: float | None = None  # 海拔高（MSL），米
    geoid_separation: float | None = None  # 大地水准面差距，米

    speed_knots: float | None = None
    speed_kmh: float | None = None
    course: float | None = None  # 真航向，度

    fix_quality: int | None = None
    fix_type: int | None = None
    status: str | None = None  # RMC 定位状态 A/V
    mode_indicator: str | None = None  # RMC/GSV 定位模式
    gnss_modes: str | None = None  # GNS 分系统模式字符串

    num_sats_used: int | None = None
    num_sats_view: int | None = None
    hdop: float | None = None
    pdop: float | None = None
    vdop: float | None = None

    satellites: dict[tuple[str, str], Satellite] = field(default_factory=dict)
    sentence_types: set[str] = field(default_factory=set)

    # -- 派生属性 ---------------------------------------------------------- #
    @property
    def datetime(self) -> dt.datetime | None:
        if self.date is None or self.seconds_of_day is None:
            return None
        return dt.datetime.combine(self.date, dt.time()) + dt.timedelta(seconds=self.seconds_of_day)

    @property
    def datetime_iso(self) -> str | None:
        moment = self.datetime
        return moment.isoformat(timespec="milliseconds") if moment else None

    @property
    def ellipsoid_height(self) -> float | None:
        """椭球高 = 海拔高 + 大地水准面差距。"""
        if self.altitude is None:
            return None
        return self.altitude + (self.geoid_separation or 0.0)

    @property
    def fix_label(self) -> str:
        if self.fix_type is not None:
            return FIX_TYPE_LABELS.get(self.fix_type, f"类型{self.fix_type}")
        if self.fix_quality is not None:
            return FIX_QUALITY_LABELS.get(self.fix_quality, f"质量{self.fix_quality}")
        return "未知"

    def satellite_list(self) -> list[Satellite]:
        return list(self.satellites.values())

    def to_dict(self, with_satellites: bool = True) -> dict:
        data = {
            "time": self.time,
            "date": self.date.isoformat() if self.date else None,
            "datetime": self.datetime_iso,
            "secondsOfDay": self.seconds_of_day,
            "lat": self.lat,
            "lon": self.lon,
            "altitude": self.altitude,
            "ellipsoidHeight": self.ellipsoid_height,
            "geoidSeparation": self.geoid_separation,
            "speedKnots": self.speed_knots,
            "speedKmh": self.speed_kmh,
            "course": self.course,
            "fixQuality": self.fix_quality,
            "fixType": self.fix_type,
            "fixLabel": self.fix_label,
            "status": self.status,
            "numSatsUsed": self.num_sats_used,
            "numSatsView": self.num_sats_view,
            "hdop": self.hdop,
            "pdop": self.pdop,
            "vdop": self.vdop,
        }
        if with_satellites:
            data["satellites"] = [sat.to_dict() for sat in self.satellites.values()]
        return data


@dataclass
class ParseResult:
    """解析结果：历元序列 + 文件级统计。"""

    epochs: list[Epoch] = field(default_factory=list)
    stats: dict = field(default_factory=dict)

    def __len__(self) -> int:
        return len(self.epochs)

    def __iter__(self) -> Iterator[Epoch]:
        return iter(self.epochs)

    def to_dict(self, with_satellites: bool = True) -> dict:
        return {
            "stats": self.stats,
            "epochs": [epoch.to_dict(with_satellites) for epoch in self.epochs],
        }


# --------------------------------------------------------------------------- #
# 主解析流程
# --------------------------------------------------------------------------- #
def _sentence_time(sentence: Sentence) -> str | None:
    if sentence.type in ("RMC", "GGA", "GNS"):
        return sentence.get(0).strip() or None
    return None


def parse_lines(lines: Iterable[str], *, strict_checksum: bool = True) -> ParseResult:
    """解析 NMEA 文本流。

    历元以 ``RMC``/``GGA``/``GNS`` 携带的 UTC 时间为锚点。``GSV`` 归入其之前
    最近的历元，``GSA``/``VTG``/``DTM`` 归入其之后最近的历元 —— 这与常见接收机
    的输出顺序（GSA→VTG→RMC/GGA→GSV）一致。
    """
    stats = {
        "lines": 0,
        "sentences": 0,
        "ignored": 0,
        "checksum_errors": 0,
        "by_type": Counter(),
        "by_talker": Counter(),
    }
    sentences: list[Sentence] = []

    for index, line in enumerate(lines, start=1):
        stats["lines"] += 1
        text = line.strip()
        if not text:
            stats["ignored"] += 1
            continue
        parsed = parse_sentence(text, line_no=index)
        if parsed is None:
            stats["ignored"] += 1
            continue
        if parsed.checksum_ok is False:
            stats["checksum_errors"] += 1
            if strict_checksum:
                stats["ignored"] += 1
                continue
        stats["sentences"] += 1
        stats["by_type"][parsed.type] += 1
        stats["by_talker"][parsed.talker or "-"] += 1
        sentences.append(parsed)

    # ---- 第一遍：找出时间锚点 ------------------------------------------- #
    anchors: list[tuple[int, tuple[str | None, str]]] = []
    current_date: dt.date | None = None
    for position, sentence in enumerate(sentences):
        stamp = _sentence_time(sentence)
        if stamp is None:
            continue
        if sentence.type == "RMC":
            parsed_date = parse_date(sentence.get(8))
            if parsed_date is not None:
                current_date = parsed_date
        key = (current_date.isoformat() if current_date else None, stamp)
        if not anchors or anchors[-1][1] != key:
            anchors.append((position, key))

    epochs: "OrderedDict[tuple[str | None, str], Epoch]" = OrderedDict()
    for _, key in anchors:
        if key not in epochs:
            epoch = Epoch()
            epoch.time, epoch.seconds_of_day = parse_time(key[1]) or (None, None)  # type: ignore[misc]
            epoch.date = dt.date.fromisoformat(key[0]) if key[0] else None
            epochs[key] = epoch

    # 没有时间锚点时（例如只有 GSV 的片段）退化为单个历元，避免丢数据
    fallback = None
    if not anchors:
        fallback = Epoch()
        epochs[("unknown", "")] = fallback

    anchor_positions = [position for position, _ in anchors]

    def preceding_epoch(position: int) -> Epoch | None:
        if not anchors:
            return fallback
        k = bisect.bisect_right(anchor_positions, position) - 1
        return epochs[anchors[max(0, k)][1]]

    def following_epoch(position: int) -> Epoch | None:
        if not anchors:
            return fallback
        k = bisect.bisect_left(anchor_positions, position)
        return epochs[anchors[min(len(anchors) - 1, k)][1]]

    # ---- 第二遍：把语句填入历元 ----------------------------------------- #
    current_date = None
    for position, sentence in enumerate(sentences):
        stamp = _sentence_time(sentence)
        if stamp is not None:
            if sentence.type == "RMC":
                parsed_date = parse_date(sentence.get(8))
                if parsed_date is not None:
                    current_date = parsed_date
            key = (current_date.isoformat() if current_date else None, stamp)
            epoch = epochs.get(key)
            if epoch is None:
                continue
        elif sentence.type == "GSV":
            epoch = preceding_epoch(position)
        else:
            epoch = following_epoch(position)
        if epoch is None:
            continue

        epoch.sentence_types.add(sentence.type)
        _apply_sentence(epoch, sentence)

    # ---- 收尾：统计与可见卫星数 ----------------------------------------- #
    collected = []
    for epoch in epochs.values():
        if not epoch.sentence_types:
            continue
        # 丢弃既无时间又无位置/卫星的空壳历元（例如只有一条 V 状态的 RMC）
        if epoch.time is None and epoch.lat is None and not epoch.satellites:
            continue
        collected.append(epoch)
    result = ParseResult(epochs=collected, stats=stats)
    for epoch in result.epochs:
        if epoch.num_sats_view is None and epoch.satellites:
            epoch.num_sats_view = len(epoch.satellites)
    stats["epochs"] = len(result.epochs)
    stats["by_type"] = dict(stats["by_type"])
    stats["by_talker"] = dict(stats["by_talker"])
    return result


def _apply_sentence(epoch: Epoch, sentence: Sentence) -> None:
    kind = sentence.type

    if kind == "RMC":
        stamp = parse_time(sentence.get(0))
        if stamp and epoch.time is None:
            epoch.time, epoch.seconds_of_day = stamp
        status = sentence.get(1).strip().upper()
        if status:
            epoch.status = status
        lat = parse_coordinate(sentence.get(2), sentence.get(3))
        lon = parse_coordinate(sentence.get(4), sentence.get(5))
        if lat is not None:
            epoch.lat = lat
        if lon is not None:
            epoch.lon = lon
        speed = sentence.number(6)
        if speed is not None:
            # VTG 同时给出节与 km/h，能先到就先到；RMC 只补空缺
            if epoch.speed_knots is None:
                epoch.speed_knots = speed
            if epoch.speed_kmh is None:
                epoch.speed_kmh = speed * 1.852
        course = sentence.number(7)
        if course is not None:
            epoch.course = course
        parsed_date = parse_date(sentence.get(8))
        if parsed_date is not None:
            epoch.date = parsed_date
        mode = sentence.get(11).strip()
        if mode:
            epoch.mode_indicator = mode

    elif kind == "GGA":
        stamp = parse_time(sentence.get(0))
        if stamp and epoch.time is None:
            epoch.time, epoch.seconds_of_day = stamp
        lat = parse_coordinate(sentence.get(1), sentence.get(2))
        lon = parse_coordinate(sentence.get(3), sentence.get(4))
        if lat is not None:
            epoch.lat = lat
        if lon is not None:
            epoch.lon = lon
        quality = _parse_int(sentence.get(5))
        if quality is not None:
            epoch.fix_quality = quality
        used = _parse_int(sentence.get(6))
        if used is not None:
            epoch.num_sats_used = used
        hdop = sentence.number(7)
        if hdop is not None:
            epoch.hdop = hdop
        altitude = sentence.number(8)
        if altitude is not None:
            epoch.altitude = altitude
        separation = sentence.number(10)
        if separation is not None:
            epoch.geoid_separation = separation

    elif kind == "GNS":
        stamp = parse_time(sentence.get(0))
        if stamp and epoch.time is None:
            epoch.time, epoch.seconds_of_day = stamp
        lat = parse_coordinate(sentence.get(1), sentence.get(2))
        lon = parse_coordinate(sentence.get(3), sentence.get(4))
        if lat is not None:
            epoch.lat = lat
        if lon is not None:
            epoch.lon = lon
        modes = sentence.get(5).strip()
        if modes:
            epoch.gnss_modes = modes
        used = _parse_int(sentence.get(6))
        if used is not None:
            epoch.num_sats_used = used
        hdop = sentence.number(7)
        if hdop is not None:
            epoch.hdop = hdop
        altitude = sentence.number(8)
        if altitude is not None and epoch.altitude is None:
            epoch.altitude = altitude
        separation = sentence.number(9)
        if separation is not None and epoch.geoid_separation is None:
            epoch.geoid_separation = separation

    elif kind == "VTG":
        speed_knots = sentence.number(4)
        speed_kmh = sentence.number(6)
        if speed_kmh is not None:
            epoch.speed_kmh = speed_kmh
        elif speed_knots is not None:
            epoch.speed_kmh = speed_knots * 1.852
        if speed_knots is not None:
            epoch.speed_knots = speed_knots
        elif speed_kmh is not None:
            epoch.speed_knots = speed_kmh / 1.852
        course = sentence.number(0)
        if course is not None:
            epoch.course = course

    elif kind == "GSA":
        fix_type = _parse_int(sentence.get(1))
        if fix_type is not None:
            epoch.fix_type = fix_type
        pdop = sentence.number(14)
        if pdop is not None:
            epoch.pdop = pdop
        hdop = sentence.number(15)
        if hdop is not None and epoch.hdop is None:
            epoch.hdop = hdop
        vdop = sentence.number(16)
        if vdop is not None:
            epoch.vdop = vdop

    elif kind == "GSV":
        system = sentence.system
        fields = sentence.fields
        # 前三个字段：总条数、当前条数、可见卫星数
        index = 3
        while index + 3 < len(fields):
            prn = fields[index].strip()
            elevation = _parse_float(fields[index + 1])
            azimuth = _parse_float(fields[index + 2])
            cn0 = _parse_float(fields[index + 3])
            index += 4
            if not prn:
                continue
            key = (system, prn)
            satellite = Satellite(system=system, prn=prn, elevation=elevation, azimuth=azimuth, cn0=cn0)
            # 同一历元内重复播报的同一颗星，保留信息更完整的一条
            previous = epoch.satellites.get(key)
            if previous is None or _satellite_score(satellite) >= _satellite_score(previous):
                epoch.satellites[key] = satellite


def _satellite_score(satellite: Satellite) -> tuple[int, int]:
    """用于去重时挑选记录：有 cn0 优先，其次有仰角/方位角。"""
    return (
        1 if satellite.cn0 is not None else 0,
        1 if (satellite.elevation is not None and satellite.azimuth is not None) else 0,
    )


def parse_file(path: str, *, encoding: str = "ascii", strict_checksum: bool = True) -> ParseResult:
    """读取并解析 NMEA 文件。"""
    with open(path, "r", encoding=encoding, errors="replace", newline="") as handle:
        return parse_lines(handle, strict_checksum=strict_checksum)


# --------------------------------------------------------------------------- #
# 统计摘要
# --------------------------------------------------------------------------- #
def summarize(result: ParseResult) -> dict:
    """对解析结果做统计，返回可直接序列化为 JSON 的字典。"""
    epochs = [epoch for epoch in result.epochs if epoch.lat is not None and epoch.lon is not None]
    summary: dict = {
        "file": {
            "lines": result.stats.get("lines", 0),
            "sentences": result.stats.get("sentences", 0),
            "ignored": result.stats.get("ignored", 0),
            "checksumErrors": result.stats.get("checksum_errors", 0),
            "byType": result.stats.get("by_type", {}),
            "byTalker": result.stats.get("by_talker", {}),
        },
        "epochs": len(result.epochs),
        "fixEpochs": len(epochs),
    }

    moments = [epoch.datetime for epoch in result.epochs if epoch.datetime is not None]
    if moments:
        start, end = moments[0], moments[-1]
        duration = (end - start).total_seconds()
        summary["time"] = {
            "start": start.isoformat(timespec="milliseconds"),
            "end": end.isoformat(timespec="milliseconds"),
            "durationSeconds": round(duration, 3),
            "meanIntervalSeconds": round(duration / (len(moments) - 1), 3) if len(moments) > 1 else None,
        }
        intervals = [
            (moments[i] - moments[i - 1]).total_seconds() for i in range(1, len(moments))
        ]
        if intervals:
            summary["time"]["maxIntervalSeconds"] = round(max(intervals), 3)

    if epochs:
        distance = 0.0
        for previous, current in zip(epochs, epochs[1:]):
            distance += haversine(previous.lat, previous.lon, current.lat, current.lon)
        summary["track"] = {
            "distanceMeters": round(distance, 2),
            "start": {"lat": epochs[0].lat, "lon": epochs[0].lon},
            "end": {"lat": epochs[-1].lat, "lon": epochs[-1].lon},
            "bounds": {
                "minLat": min(e.lat for e in epochs),
                "maxLat": max(e.lat for e in epochs),
                "minLon": min(e.lon for e in epochs),
                "maxLon": max(e.lon for e in epochs),
            },
        }

    heights = [e.altitude for e in result.epochs if e.altitude is not None]
    if heights:
        summary["altitudeMeters"] = {
            "min": round(min(heights), 2),
            "max": round(max(heights), 2),
            "mean": round(sum(heights) / len(heights), 2),
        }

    speeds = [e.speed_kmh for e in result.epochs if e.speed_kmh is not None]
    if speeds:
        summary["speedKmh"] = {
            "min": round(min(speeds), 2),
            "max": round(max(speeds), 2),
            "mean": round(sum(speeds) / len(speeds), 2),
        }

    courses = [e.course for e in result.epochs if e.course is not None]
    if courses:
        summary["courseDeg"] = {"min": round(min(courses), 1), "max": round(max(courses), 1)}

    used = [e.num_sats_used for e in result.epochs if e.num_sats_used is not None]
    if used:
        summary["satsUsed"] = {"min": min(used), "max": max(used), "mean": round(sum(used) / len(used), 1)}

    visible_counts = [len(e.satellites) for e in result.epochs if e.satellites]
    if visible_counts:
        summary["satsVisible"] = {
            "min": min(visible_counts),
            "max": max(visible_counts),
            "mean": round(sum(visible_counts) / len(visible_counts), 1),
        }

    cn0_values = [sat.cn0 for e in result.epochs for sat in e.satellites.values() if sat.cn0 is not None]
    if cn0_values:
        summary["cn0"] = {
            "min": round(min(cn0_values), 1),
            "max": round(max(cn0_values), 1),
            "mean": round(sum(cn0_values) / len(cn0_values), 1),
            "samples": len(cn0_values),
        }

    systems: dict[str, set[str]] = {}
    for epoch in result.epochs:
        for satellite in epoch.satellites.values():
            systems.setdefault(satellite.system, set()).add(satellite.prn)
    if systems:
        summary["systems"] = {name: len(prns) for name, prns in sorted(systems.items())}

    quality = Counter(epoch.fix_label for epoch in result.epochs)
    if quality:
        summary["fixQuality"] = dict(quality)

    hdops = [e.hdop for e in result.epochs if e.hdop is not None]
    if hdops:
        summary["hdop"] = {"min": round(min(hdops), 2), "max": round(max(hdops), 2)}

    return summary
