# NMEA 分析平台 · 独立 Web 查看器

这是 NMEA 分析平台的 JavaScript 部分，可以单独运行，不依赖 Python、Flask、数据库或构建工具：

- 纯静态 `index.html` + `app.js` + `style.css`；
- Plotly 本地副本，离线可用；
- 浏览器端自己解析 NMEA 0183；
- 自带一个零依赖 Node.js 服务器：静态文件 + 地图瓦片代理 / 缓存。

## 快速开始

要求 Node.js 18+（建议 20+）。

```bash
cd web
npm start
```

也可以不敲命令：

- **Windows**：双击 [`start.cmd`](start.cmd)，会启动服务器并自动打开浏览器；
- **macOS / Linux**：执行 `./start.sh`。

然后打开终端里显示的地址，默认：

```text
http://127.0.0.1:8000/
```

不需要 `npm install`，也没有前端构建步骤。

示例数据已经放在本项目根目录：

```text
http://127.0.0.1:8000/?file=nmea.log
```

### 第一次使用（3 步）

1. 在终端进入 `web/`，运行 `npm start`；
2. 浏览器打开终端显示的地址；
3. 直接访问 `/?file=nmea.log` 看示例，或点「打开 NMEA 文件」选自己的日志。

停止服务器：在启动终端按 `Ctrl+C`。

常用启动参数：

```bash
npm start -- --port 9000       # 换端口
node server.mjs --open         # 启动并尝试打开浏览器
node server.mjs --host 0.0.0.0 --port 8000
```

页面默认不加载数据；自己的 `.log` / `.nmea` / `.txt` 放到 `web/` 根目录就能用 `?file=文件名` 访问，也可以直接在页面里选择本地文件。

## 功能

- 地图轨迹：起点 / 终点 / 当前位置，轨迹线宽、点大小、点形状可分别设置；
- 多数据：一次载入多份日志，按颜色区分，可隐藏 / 改色 / 移除；
- 统一绝对 UTC 时间轴与时间窗，播放速度由「步进」控制；
- 每条数据独立的星空图与仪表盘浮窗，可拖动、缩放、持久化；
- 图例样式 / 图例浮窗、多底图切换（ArcGIS / 高德 / Google / OSM）；
- 定位结果对比、水平误差基准；
- 卫星对比：按系统 / 频点拆分的搜星数、平均 CN0、单星 CN0，多条曲线；
- 轨迹点悬停卡片、切换此点、锁定标记、取消锁定；
- 距离测量浮窗；
- 所有窗口位置、样式和对比配置保存在浏览器 `localStorage`。

截图见 [`docs/screenshot-imagery.jpg`](docs/screenshot-imagery.jpg)、[`docs/screenshot-compare.jpg`](docs/screenshot-compare.jpg)。

## 数据文件

- 页面默认不加载数据；
- 把 `.log` / `.nmea` / `.txt` 放在本项目根目录（与 `index.html` 同级），即可用 `?file=文件名` 访问，或通过页面上的「打开 NMEA 文件」选择本地文件；
- 示例 `nmea.log` 是本项目独立副本，与仓库里的 Python 项目没有运行时关系。

## 地图瓦片

`server.mjs` 会把地图瓦片代理到 `/tiles/:source/:z/:x/:y` 并缓存到 `.cache/tiles/`，解决浏览器 CORS 和 ArcGIS 瓦片坐标顺序问题。

- ArcGIS / 高德默认直连；
- Google / OSM 在部分网络环境需要代理。Node 24+ 可以这样启动：

```bash
HTTPS_PROXY=http://127.0.0.1:1080 npm run start:proxy
```

Windows PowerShell：

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:1080"
npm run start:proxy
```

如果网络无法直连 Google / OSM，切换到 ArcGIS 影像或高德底图即可；瓦片失败只影响底图，不影响轨迹和图表。

## 可选的遮挡分割叠加

`sky_split.json` 是可选数据文件，不是运行依赖：

- 没有该文件时，星空图正常显示，只是不叠加直射带 / 边界 / 直射概率；
- 把一份符合格式的 `sky_split.json` 放在本项目根目录，页面启动时会读取；
- 该 JSON 可以由任意离线工具生成，本项目不调用 Python，也不假设它一定存在。

## 文件结构

```text
web/
├── index.html
├── app.js
├── style.css
├── server.mjs              # 零依赖静态服务器 + 瓦片代理
├── package.json
├── start.cmd               # Windows 双击启动
├── start.sh                # macOS / Linux 启动
├── nmea.log                # 示例日志
├── sky_split.json          # 可选的遮挡分割数据
├── vendor/plotly.min.js    # 本地 Plotly
└── docs/                   # README 截图
```

## 开发说明

- 无打包、无框架、无 npm 依赖；
- `server.mjs` 只负责静态文件与瓦片代理，不做 NMEA 解析；
- NMEA 解析、状态、Plotly 绘图和交互全部在 `app.js`；
- 地图瓦片缓存在 `.cache/tiles/`，可以随时删除。

## 常见问题

**页面能直接双击 `index.html` 打开吗？**

不能获得完整功能。`file://` 下浏览器会阻止页面 `fetch` 本地日志、`sky_split.json` 和地图瓦片，所以页面会提示改用本地服务器。

如果不想每次开终端：

- Windows 双击 [`start.cmd`](start.cmd)；
- macOS / Linux 执行 `./start.sh`。

它们会启动本项目的 `server.mjs`，并自动打开 `http://127.0.0.1:8000/`。

**端口被占用？**

```bash
npm start -- --port 9000
# 或
node server.mjs --port 9000
```

**页面能直接双击 `index.html` 打开吗？**

不要。`file://` 会阻止日志读取和地图瓦片；必须通过 `server.mjs`（或其它静态服务器）访问 `http://`。

**地图空白 / 底图不显示？**

ArcGIS、高德一般可直连；Google / OSM 在部分网络需要代理。Node 24+：

```bash
HTTPS_PROXY=http://127.0.0.1:1080 npm run start:proxy
```

瓦片失败只影响底图，轨迹、星空图、仪表盘和对比功能仍然可用。

**需要 `npm install` 吗？**

不需要。项目没有 npm 依赖；`npm start` 只是在执行 `node server.mjs`。
