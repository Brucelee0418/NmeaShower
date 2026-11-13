# NMEA 分析平台

NMEA 0183 日志的解析、统计、机器学习与可视化工具集。仓库现在拆成两个**互不依赖**的项目：

![NMEA Web Viewer](docs/screenshot-imagery.jpg)

| 目录 | 技术栈 | 运行方式 | 负责 |
|---|---|---|---|
| [`python/`](python/) | Python 3.10+ | CLI / 脚本 | NMEA 解析库、命令行分析、天空遮挡分割、报告插图 |
| [`web/`](web/) | 原生 JavaScript + Plotly | Node.js 静态服务器 | 浏览器端解析、地图 / 图表 / 全部交互 |

两边没有运行时的代码调用关系：

- Python 不启动网页服务器，也不读写前端源码；
- 前端不调用 Python，不依赖 Python 生成文件才能启动；
- 唯一的可选衔接是 `sky_split.json`：Python 可以导出，前端可以读取，但两边都可以在没有对方的情况下工作。

## 快速开始

### Python 离线分析

```bash
cd python
python analyze_nmea.py nmea.log

pip install -r requirements.txt
python -m unittest discover -s tests -v
python sky_split.py --print
```

详见 [`python/README.md`](python/README.md)。

### Web 查看器

要求 Node.js 18+，无需安装依赖、无需构建：

```bash
cd web
npm start
```

打开终端显示的地址，默认 `http://127.0.0.1:8000/`。

示例数据：`http://127.0.0.1:8000/?file=nmea.log`。

详见 [`web/README.md`](web/README.md)。

## 目录

```text
.
├── python/                 # Python 离线工具项目
│   ├── nmea_parser.py
│   ├── analyze_nmea.py
│   ├── sky_split.py
│   ├── make_sky_report.py
│   ├── tests/
│   ├── docs/sky/
│   ├── nmea.log
│   ├── requirements.txt
│   └── README.md
├── web/                    # 独立 JavaScript 查看器项目
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── server.mjs
│   ├── package.json
│   ├── nmea.log
│   ├── sky_split.json      # 可选演示数据
│   ├── vendor/
│   ├── docs/
│   └── README.md
├── docs/                   # 仓库级截图
├── task*.md                # 任务记录
└── README.md
```

## 两边如何衔接

不需要衔接也能各自运行。需要把遮挡分割结果给前端看时：

```bash
cd python
python sky_split.py --print
# 产物：python/out/sky_split.json
```

把 `python/out/sky_split.json` 复制为 `web/sky_split.json`（或前端项目根目录同名文件）即可；前端没有该文件时会自动降级为普通星空图，不影响其他功能。

这条链路是**文件级、可选的**，不是运行时依赖。

## 验证

```bash
# Python
cd python
python -m unittest discover -s tests -v

# Web（另开终端）
cd web
npm start
```

Web 自带示例日志，启动后即可打开页面；地图底图需要网络，瓦片由 `web/server.mjs` 代理。
