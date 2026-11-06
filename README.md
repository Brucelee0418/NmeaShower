# NMEA 分析工具

对 GNSS 接收机记录的 NMEA 0183 日志做解析、统计与可视化。包含两部分：

- **task1** — Python 解析库 + 命令行分析脚本，输出时间、经纬度、高度、速度、航向、卫星信息，可导出 CSV / JSON。
- **task2** — HTML + JavaScript + Plotly 的展示分析平台：左侧地图轨迹，右上星空图，右下仪表盘。

仓库自带的示例数据是 `nmea.log`（多星座 GNSS 日志，428 个历元，约 426 秒）。

![卫星影像底图](docs/screenshot-imagery.jpg)

![高德街道底图（GCJ-02 纠偏后）](docs/screenshot-gaode.jpg)

## 目录

```
analyze_nmea.py      命令行分析脚本（task1）
nmea_parser.py       NMEA 0183 解析库（仅标准库）
tests/               解析库单元测试
serve.py             本地服务器：静态文件 + 地图瓦片代理
web/index.html       展示平台页面
web/app.js           前端解析与绘图逻辑
web/style.css        样式
web/vendor/          Plotly（本地副本，离线可用）
docs/                README 截图
nmea.log             示例日志
```

## task1：命令行分析

```bash
python analyze_nmea.py nmea.log
```

输出示例（摘要）：

```
语句行数      : 13908
有效语句      : 13895
语句类型      : GSV×10203, GSA×1547, VTG×429, DTM×429, RMC×429, GNS×429, GGA×429
起始时刻 (UTC): 2026-11-06T14:50:09.550
观测时长      : 426.450 s
历元数        : 428 (有效定位 428)
轨迹长度      : 199.3 m
海拔高        : 14.40 ~ 91.30 m (均值 49.68)
可见卫星      : 38 ~ 54 (均值 44.2)
星座分布      : BeiDou 22 颗, GLONASS 9 颗, GPS 13 颗, Galileo 10 颗, QZSS 2 颗
```

导出数据：

```bash
# 历元级 CSV：时间、经纬度、海拔、椭球高、速度、航向、DOP、星数
python analyze_nmea.py nmea.log --csv out/epochs.csv

# 卫星级 CSV：每个历元每颗星的仰角/方位角/cn0
python analyze_nmea.py nmea.log --sky-csv out/sky.csv

# 完整 JSON（含卫星明细）与统计摘要
python analyze_nmea.py nmea.log --json out/nmea.json --summary-json out/summary.json
```

只依赖 Python 3.10+ 标准库，无需安装第三方包。

### 解析库用法

```python
from nmea_parser import parse_file, summarize

result = parse_file("nmea.log")
epoch = result.epochs[0]
print(epoch.datetime_iso, epoch.lat, epoch.lon, epoch.altitude, epoch.speed_kmh)
print(epoch.course, epoch.num_sats_used, epoch.hdop, epoch.fix_label)
for satellite in epoch.satellite_list():
    print(satellite.system, satellite.prn, satellite.elevation, satellite.azimuth, satellite.cn0)

print(summarize(result))
```

支持的语句：`RMC`、`GGA`、`GNS`、`VTG`、`GSA`、`GSV`、`DTM`（DTM 仅做识别统计）。
通过 talker 前缀识别星座：`GP` GPS、`GL` GLONASS、`GA` Galileo、`GB/BD` BeiDou、`GQ` QZSS、`GN` 多系统。

处理规则：

- 逐句校验 NMEA 校验和，默认丢弃校验失败的语句（`--no-strict-checksum` 可保留）。
- 历元以 `RMC`/`GGA`/`GNS` 的 UTC 时间为锚点；`GSV` 归入其之前最近的历元，`GSA`/`VTG` 归入其之后最近的历元。
- 同一历元内重复播报的同一颗卫星按信息完整度去重（优先保留有 cn0 的记录）。
- 经纬度按 `ddmm.mmmm` 解析，南纬/西经取负；海拔高为 MSL，椭球高 = MSL + 大地水准面差距。

### 测试

```bash
python -m unittest discover -s tests -v
```

## task2：展示平台

```bash
python serve.py            # 打开 http://localhost:8000/
python serve.py --open     # 顺便拉起浏览器
python serve.py --port 9000
```

页面布局：

- **左侧地图**：轨迹画成点线（每个历元一个点），起点（绿）、终点（红）、当前位置（橙）。底图可在顶栏切换。
- **右上星空图**：卫星按方位角（0°=北，顺时针）与仰角（圆心=天顶）投影到极坐标。
  - 圆点 = 有载噪比，颜色从红（低）经黄到绿（高），见右侧 cn0 色标；点的大小也随 cn0 变化。
  - 黑色三角 = 无载噪比（cn0 为 0 或缺失）。
  - 点外圈颜色区分星座，顶部 chips 可按星座过滤。
- **右下仪表盘**：速度、航向两块表 + 时间/经纬度/海拔/速度/航向/星数/DOP/定位质量读数。
- 顶部控制条：播放/暂停、`◀ 1s` / `1s ▶` 前后跳 1 秒、`1×` / `2×` 倍速，以及以**秒**为单位的时间进度条（`0.0 s` ~ 总时长）。
- 播放按真实时间推进：1× 表示 1 秒数据用 1 秒播放，2× 为两倍速；到末尾自动停止。
- 页面每帧同步地图、星空图与仪表盘。

交互：

- 点击「打开 NMEA 文件」或直接把 `.log` / `.nmea` / `.txt` 文件拖进页面。
- 顶栏「底图」切换卫星影像 / 高德街道 / 高德卫星 / OSM / 无底图。
- 空格键播放/暂停，`←` `→` 后退/前进 1 秒。
- 链接参数 `?base=gaode-street` 可指定默认底图。

### 底图与坐标系

| 底图 | 坐标系 | 处理 |
| --- | --- | --- |
| 卫星影像（ArcGIS World Imagery） | WGS84 | 直接使用 |
| 高德街道 / 高德卫星 | GCJ-02 | 前端做 WGS84 → GCJ-02 纠偏，否则会偏移约 400 m |
| OpenStreetMap | WGS84 | 直接使用 |

地图瓦片通过 `serve.py` 的 `/tiles/{source}/{z}/{x}/{y}` 代理获取（同时解决 CORS 与 ArcGIS 的 `{z}/{y}/{x}` 顺序问题），并缓存在 `.cache/tiles`。因此页面必须经由 `serve.py` 打开，直接用 `file://` 无法加载数据与底图。

`web/app.js` 内含一份与 `nmea_parser.py` 行为一致的解析实现，所以浏览器端不需要 Python 也能解析日志文件（只有瓦片代理依赖 `serve.py`）。

## 已知限制

- Plotly 3 对 `mapbox` 系列 trace 给出弃用提示（建议迁移到 `map` + MapLibre）。当前实现仍使用 `scattermapbox`，功能正常；浏览器控制台会出现一条弃用警告，以及 Plotly 内部在底图 style 加载期触发的一条 `Style is not done loading`，均不影响渲染。
- ArcGIS World Imagery 在 20 级及以上无瓦片，高德瓦片最高 18 级，因此地图缩放上限按底图分别限制。
- OSM 瓦片在本机网络下不可达（超时），列为选项目前可能加载失败；ArcGIS 已停用 World_Street_Map / World_Topo_Map 的瓦片返回，故未采用。
