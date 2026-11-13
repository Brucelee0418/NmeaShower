# NMEA 分析平台 · Python 离线工具

这是 NMEA 分析平台的 Python 侧，完全独立于仓库里的 `web/` 前端项目：

- **task1**：零依赖 NMEA 0183 解析库 + 命令行分析，导出 CSV / JSON；
- **task3**：无监督天空遮挡分割、抖动 / 旋转实验、报告插图。

Python 侧不提供页面，也不依赖 JavaScript；浏览器查看器在另一个项目中，两边只通过可选的 JSON 数据文件衔接。

## 快速开始

```bash
cd python

# 1. 命令行分析（只用标准库）
python analyze_nmea.py nmea.log

# 2. 安装 task3 依赖
pip install -r requirements.txt

# 3. 单元测试（解析测试只需标准库；分割测试需要 numpy / scikit-learn）
python -m unittest discover -s tests -v

# 4. 天空遮挡分割
python sky_split.py --print
```

示例数据是 `python/nmea.log`（428 个历元，约 426 秒，多星座 GNSS）。

## task1：解析与命令行分析

```bash
python analyze_nmea.py nmea.log
```

输出示例（摘要）：

```text
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

### 导出数据

```bash
# 历元级 CSV：时间、经纬度、海拔、椭球高、速度、航向、DOP、星数
python analyze_nmea.py nmea.log --csv out/epochs.csv

# 卫星级 CSV：每个历元每颗星的仰角 / 方位角 / cn0
python analyze_nmea.py nmea.log --sky-csv out/sky.csv

# 完整 JSON（含卫星明细）与统计摘要
python analyze_nmea.py nmea.log --json out/nmea.json --summary-json out/summary.json
```

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

支持的语句：`RMC`、`GGA`、`GNS`、`VTG`、`GSA`、`GSV`、`DTM`（DTM 仅识别统计）。  
通过 talker 前缀识别星座：`GP` GPS、`GL` GLONASS、`GA` Galileo、`GB/BD` BeiDou、`GQ` QZSS、`GN` 多系统。

处理规则：

- 逐句校验 NMEA 校验和，默认丢弃校验失败语句（`--no-strict-checksum` 可保留）；
- 历元以 `RMC` / `GGA` / `GNS` 的 UTC 时间为锚点；`GSV` 归入之前最近的历元，`GSA` / `VTG` 归入之后最近的历元；
- 同一历元重复播报的同一颗卫星按信息完整度去重，优先保留有 cn0 的记录；
- 经纬度按 `ddmm.mmmm` 解析，南纬 / 西经取负；海拔高为 MSL，椭球高 = MSL + 大地水准面差距。

## task3：天空遮挡分割

完整报告见 [`sky_split.md`](sky_split.md)。

```bash
python sky_split.py --print        # 分析 nmea.log，打印关键指标
python sky_split.py --window 5     # 只跑 5 s 时间窗
python sky_split.py --rot-step 10  # 旋转增强步长
```

算法流程：

1. 整体朝向扫描：按方位带最大化两类间方差；
2. 强星 PCA：估计直射带半宽；
3. GMM：对 `cn0 / 跟踪率` 特征做直射 / 非直射软聚类；
4. 双边界曲线：按仰角带拟合直射带东 / 西边界；
5. 时间窗抖动与旋转增强实验。

输出：

| 路径 | 内容 |
| --- | --- |
| `out/sky_split/summary.json` | 朝向、PCA、曲线、分类、抖动、旋转、校验等指标 |
| `out/sky_split/satellites.csv` | 每颗星的方位 / 仰角 / 强度 / 跟踪率 / p(直射) / 标签 |
| `out/sky_split/labels.csv` | 每条观测的窗口特征、p(直射)、硬标签 |
| `out/sky_split/curves.csv` | 两条边界曲线 |
| `out/sky_split/feature_ablation.json` | 特征消融表 |
| `out/sky_split.json` | 可选的逐历元曲线 / 逐星概率导出，供任意可视化查看器读取 |

重新生成报告插图：

```bash
python make_sky_report.py
python make_sky_report.py --only 5
```

插图写入 `docs/sky/`；报告正文是仓库里已有的 `sky_split.md`。

## 目录

```text
python/
├── nmea_parser.py          # 零依赖解析库
├── analyze_nmea.py         # CLI：摘要 / CSV / JSON
├── sky_split.py            # 遮挡分割算法 + CLI
├── make_sky_report.py      # 生成报告插图
├── sky_split.md            # task3 报告
├── nmea.log                # 示例数据
├── requirements.txt
├── tests/                  # 单元测试
├── docs/sky/               # 报告插图
└── out/                    # 运行产物（gitignore）
```

## 依赖

- `analyze_nmea.py` / `nmea_parser.py`：Python 3.10+ 标准库，无第三方依赖；
- `sky_split.py`：`numpy`、`scikit-learn`；
- 报告插图：`matplotlib`。

```bash
pip install -r requirements.txt
```

## 与前端的关系

本目录不包含 HTTP 服务，也不会调用 `web/`。`sky_split.py` 只导出 `out/sky_split.json`；如果希望独立查看器显示遮挡叠加，需要手动把该文件放到查看器的数据目录。前端项目有自己独立的 Node 启动方式和示例数据。
