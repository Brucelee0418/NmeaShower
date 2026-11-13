/* NMEA 分析平台前端
 * 纯浏览器端解析 NMEA 0183 文本，用 Plotly 渲染地图 / 星空图 / 仪表盘。
 */

'use strict';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */
const TALKER_SYSTEMS = {
  GP: 'GPS', GL: 'GLONASS', GA: 'Galileo', GB: 'BeiDou', BD: 'BeiDou',
  GQ: 'QZSS', GI: 'NavIC', GN: 'MULTI',
};

const SYSTEM_COLORS = {
  GPS: '#2563eb', GLONASS: '#dc2626', Galileo: '#d97706',
  BeiDou: '#7c3aed', QZSS: '#0d9488', NavIC: '#db2777', MULTI: '#64748b',
};

const SYSTEM_PREFIX = {
  GPS: 'G', GLONASS: 'R', Galileo: 'E', BeiDou: 'C',
  QZSS: 'J', NavIC: 'I', MULTI: 'M',
};

const FIX_QUALITY = {
  0: '无效', 1: '单点定位', 2: 'DGPS', 3: 'PPS',
  4: 'RTK 固定', 5: 'RTK 浮动', 6: '航位推算', 7: '手动', 8: '仿真',
};

const FIX_TYPE = { 1: '无定位', 2: '2D', 3: '3D' };

const CN0_SCALE = [
  [0.0, '#b91c1c'],
  [0.35, '#f59e0b'],
  [0.7, '#84cc16'],
  [1.0, '#15803d'],
];
const CN0_MIN = 10;
const CN0_MAX = 50;
const STEP_OPTIONS = [1, 5, 60, 300, 600];

const COMPASS_POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

const PLOT_CONFIG = {
  responsive: true,
  displaylogo: false,
  scrollZoom: true,
  modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d', 'toggleSpikelines'],
};

/**
 * 构造内联 mapbox style，把瓦片源直接写进 style。
 *
 * 不用 ``mapbox.layers`` 是因为 Plotly + mapbox 在 style 尚未加载完成时
 * 调 addLayer 会抛 "Style is not done loading"，底图就静默不显示；
 * 把 raster source/layer 嵌在 style 里从根本绕开了这个时序问题。
 */
function buildBaseStyle(source) {
  if (source === 'none' || !TILE_SOURCES[source]) return 'white-bg';
  if (state.baseStyle && state.baseStyle.source === source) return state.baseStyle.style;

  const maxZoom = TILE_MAX_ZOOM[source] || 19;
  const style = {
    version: 8,
    sources: {
      basemap: {
        type: 'raster',
        tiles: [`${location.origin}/tiles/${source}/{z}/{x}/{y}`],
        tileSize: 256,
        minzoom: 0,
        maxzoom: maxZoom,
      },
    },
    layers: [
      { id: 'nmea-bg', type: 'background', paint: { 'background-color': '#f8fafc' } },
      // 图层不设 maxzoom：给 overzoom 留空间，否则放大到瓦片极限时整层会被隐藏
      { id: 'nmea-basemap', type: 'raster', source: 'basemap', minzoom: 0 },
    ],
  };
  state.baseStyle = { source, style };
  return style;
}

const TILE_SOURCES = {
  'arcgis-imagery': '卫星影像',
  'gaode-satellite': '高德卫星',
  'gaode-street': '高德街道',
  'google-satellite': 'Google 卫星（Earth）',
  'google-street': 'Google 街道',
  'osm': 'OpenStreetMap',
  'none': '无底图',
};

// 各瓦片源实际可用的最大瓦片级别（超出后会返回空白）
const TILE_MAX_ZOOM = {
  'arcgis-imagery': 19,
  'gaode-satellite': 18,
  'gaode-street': 18,
  'google-satellite': 20,
  'google-street': 20,
  'osm': 19,
  'none': 19,
};

// Google 通过 gl=cn 返回大陆区域的 GCJ-02 瓦片（含卫星影像），
// 与高德一样需要先把 WGS84 轨迹纠偏，否则会偏移几百米。
const GCJ02_SOURCES = new Set([
  'gaode-street', 'gaode-satellite', 'google-street', 'google-satellite',
]);

/* ------------------------------------------------------------------ *
 * 地图图例 / 图层样式
 * ------------------------------------------------------------------ */
// 每条轨迹固定 6 条 trace，按数据集序号 * 6 + 图层序号定位，
// 这样数据集的增删不会打乱已有 trace 的下标。
const LAYER_ORDER = ['line', 'track', 'start', 'end', 'current', 'offset'];
const TRACES_PER_DATASET = LAYER_ORDER.length;

function traceIndexFor(ordinal, layer) {
  return ordinal * TRACES_PER_DATASET + LAYER_ORDER.indexOf(layer);
}

const MAP_LAYER_META = [
  { key: 'line', name: '轨迹线', type: 'line', min: 1, max: 8, step: 0.5, colorSource: 'dataset' },
  {
    key: 'track', name: '轨迹点', type: 'point', min: 2, max: 12, step: 0.5, colorSource: 'dataset',
    shapes: [
      { value: 'circle', label: '圆点' },
      { value: 'square', label: '方块' },
      { value: 'triangle', label: '三角' },
      { value: 'diamond', label: '菱形' },
      { value: 'star', label: '星形' },
      { value: 'cross', label: '十字' },
      { value: 'x', label: '叉号' },
    ],
  },
  { key: 'start', name: '起点', type: 'point', min: 6, max: 24, step: 1 },
  { key: 'end', name: '终点', type: 'point', min: 6, max: 24, step: 1 },
  { key: 'current', name: '当前位置', type: 'point', min: 6, max: 28, step: 1, colorSource: 'dataset' },
  // 只有选了水平误差基准才出现在图例里
  { key: 'offset', name: '基准连线', type: 'line', min: 1, max: 6, step: 0.5, colorSource: 'dataset' },
];

const DEFAULT_LAYER_STYLE = {
  line: { color: '#2563eb', size: 2, visible: true },
  track: { color: '#2563eb', size: 3.5, visible: true, shape: 'circle' },
  start: { color: '#16a34a', size: 10, visible: true },
  end: { color: '#dc2626', size: 10, visible: true },
  current: { color: '#f59e0b', size: 15, visible: true },
  offset: { color: '#64748b', size: 2.5, visible: true },
};

const TRACK_SHAPES = MAP_LAYER_META.find((meta) => meta.key === 'track').shapes;
const TRACK_SHAPE_VALUES = new Set(TRACK_SHAPES.map((shape) => shape.value));

const LAYER_STYLE_KEY = 'nmea.mapLayerStyle.v1';

const LEGEND_LAYOUT_KEY = 'nmea.legendLayout.v1';
const MEASURE_LAYOUT_KEY = 'nmea.measureLayout.v1';
const LEGEND_DISPLAY_ITEMS = [
  { key: 'datasets', label: '数据集' },
  { key: 'line', label: '轨迹线' },
  { key: 'track', label: '轨迹点' },
  { key: 'start', label: '起点' },
  { key: 'end', label: '终点' },
  { key: 'current', label: '当前位置' },
  { key: 'offset', label: '基准连线' },
];

/* ------------------------------------------------------------------ *
 * 多数据集
 * ------------------------------------------------------------------ */
// 数据集默认配色：按加入顺序分配，超出后循环
const DATASET_PALETTE = [
  '#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed',
  '#0891b2', '#db2777', '#65a30d', '#0d9488', '#9333ea',
];
const DATASET_STYLE_KEY = 'nmea.datasetStyle.v1';
const COMPARE_KEY = 'nmea.compareConfig.v1';

// 对比曲线指标：每个指标一张独立子图，避免量纲混在一根 y 轴上
const COMPARE_METRICS = {
  speed: { name: '速度', unit: 'km/h', digits: 2 },
  course: { name: '航向', unit: '°', digits: 1 },
  cn0: { name: '平均 cn0', unit: 'dB-Hz', digits: 1 },
  sats: { name: '卫星数', unit: '颗', digits: 0 },
  // 水平误差依赖图例里选定的基准，没有基准时该指标不可用
  error: { name: '水平误差', unit: 'm', digits: 2 },
};
const DEFAULT_COMPARE_METRICS = ['speed', 'sats'];
// 对比曲线默认按绝对 UTC 对齐（同一天多次采集、需要看真实时间关系时更直观）
const DEFAULT_COMPARE_ALIGN = 'absolute';
const COMPARE_MIN_WIDTH = 360;
const COMPARE_MIN_HEIGHT = 260;

// 卫星对比：按系统统计搜星数 / 平均 CN0，或对单颗卫星做多数据 CN0 对比
const SAT_KEY = 'nmea.satCompare.v1';
const SAT_METRICS = {
  counts: { name: '搜星数', unit: '颗', digits: 0 },
  cn0: { name: '平均 CN0', unit: 'dB-Hz', digits: 1 },
  one: { name: '单星 CN0', unit: 'dB-Hz', digits: 1 },
};
const SAT_SYSTEM_ORDER = ['GPS', 'BeiDou', 'GLONASS', 'Galileo', 'QZSS', 'NavIC', 'MULTI'];
// NMEA 4.10 GSV 的 signalId → 常见频点名称；未识别的保留原始编号
const SIGNAL_BANDS = {
  GPS: { 1: 'L1', 2: 'L1', 3: 'L2', 4: 'L2', 5: 'L5', 6: 'L1', 7: 'L2', 8: 'L5' },
  GLONASS: { 1: 'G1', 2: 'G1', 3: 'G2', 4: 'G2' },
  Galileo: { 1: 'E5a', 2: 'E5b', 3: 'E5', 4: 'E6', 5: 'E1', 6: 'E5', 7: 'E1', 8: 'E5' },
  BeiDou: {
    1: 'B1I', 2: 'B1Q', 3: 'B1C', 4: 'B2I', 5: 'B2a',
    6: 'B3I', 7: 'B3Q', 8: 'B2b',
  },
  QZSS: { 1: 'L1', 2: 'L1', 3: 'L2', 4: 'L5', 5: 'L6', 6: 'L1', 7: 'L2', 8: 'L5' },
  NavIC: { 1: 'L5', 2: 'S' },
};
const SAT_BAND_ORDER = [
  'L1', 'L2', 'L5', 'G1', 'G2', 'E1', 'E5a', 'E5b', 'E5', 'E6',
  'B1I', 'B1C', 'B1Q', 'B2I', 'B2a', 'B2b', 'B3I', 'B3Q', '默认',
];
const SAT_DATASET_DASH = ['solid', '2px,5px'];
const SAT_DEFAULT_WIDTH = 640;
const SAT_DEFAULT_HEIGHT = 500;
const SAT_MIN_WIDTH = 380;
const SAT_MIN_HEIGHT = 360;

/* ------------------------------------------------------------------ *
 * 星空图 / 仪表盘浮窗
 * ------------------------------------------------------------------ */
// 每条轨迹各有一套星空图和仪表盘，都是可拖动、可缩放的独立浮窗
const WINDOW_KINDS = {
  sky: { title: '星空图', width: 360, height: 330, minWidth: 260, minHeight: 190 },
  dash: { title: '仪表盘', width: 430, height: 360, minWidth: 300, minHeight: 220 },
};
const WINDOW_ORDER = ['sky', 'dash'];
const WINDOW_LAYOUT_KEY = 'nmea.windowLayout.v1';
const DEFAULT_SHOW_LABELS = true;
const DEFAULT_SHOW_SPLIT = true;

/* ------------------------------------------------------------------ *
 * WGS84 -> GCJ-02（高德/腾讯底图使用 GCJ-02，不纠偏会偏移几百米）
 * ------------------------------------------------------------------ */
const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

function outOfChina(lat, lon) {
  return !(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55);
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLon(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}

function wgs84ToGcj02(lat, lon) {
  if (outOfChina(lat, lon)) return [lat, lon];
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI);
  dLon = (dLon * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lat + dLat, lon + dLon];
}

/** 根据当前底图把 WGS84 坐标转成显示坐标。 */
function toDisplay(lat, lon) {
  if (lat === null || lon === null) return [null, null];
  return GCJ02_SOURCES.has(state.mapSource) ? wgs84ToGcj02(lat, lon) : [lat, lon];
}

/** GCJ-02 -> WGS84，用迭代逼近（正向变换没有解析逆）。 */
function gcj02ToWgs84(lat, lon) {
  if (outOfChina(lat, lon)) return [lat, lon];
  let wgsLat = lat;
  let wgsLon = lon;
  for (let i = 0; i < 3; i += 1) {
    const [gcjLat, gcjLon] = wgs84ToGcj02(wgsLat, wgsLon);
    wgsLat += lat - gcjLat;
    wgsLon += lon - gcjLon;
  }
  return [wgsLat, wgsLon];
}

/** 把保存下来的视野换算到当前底图的坐标系。 */
function viewCenterFor(source) {
  if (!state.view) return null;
  const targetGcj = GCJ02_SOURCES.has(source);
  const { center } = state.view;
  if (Boolean(state.view.gcj) === targetGcj) return { ...center };
  const [lat, lon] = targetGcj
    ? wgs84ToGcj02(center.lat, center.lon)
    : gcj02ToWgs84(center.lat, center.lon);
  return { lat, lon };
}

/* ------------------------------------------------------------------ *
 * 浏览器端 NMEA 解析器
 * ------------------------------------------------------------------ */
const SENTENCE_RE = /^\$([^*]*)(?:\*([0-9A-Fa-f]{2}))?$/;

function nmeaChecksum(body) {
  let value = 0;
  for (let i = 0; i < body.length; i += 1) value ^= body.charCodeAt(i) & 0xff;
  return value;
}

function parseNumber(value) {
  if (value === undefined || value === null || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseInteger(value) {
  const number = parseNumber(value);
  return number === null ? null : Math.trunc(number);
}

function parseCoordinate(value, hemisphere) {
  const raw = parseNumber(value);
  if (raw === null) return null;
  const degrees = Math.trunc(raw / 100);
  const minutes = raw - degrees * 100;
  let decimal = degrees + minutes / 60;
  if (hemisphere === 'S' || hemisphere === 'W') decimal = -decimal;
  return decimal;
}

function parseTime(value) {
  if (!value) return null;
  const text = value.trim();
  if (text.length < 6 || !/^\d{6}/.test(text)) return null;
  const hour = Number(text.slice(0, 2));
  const minute = Number(text.slice(2, 4));
  const seconds = Number(text.slice(4));
  if (!Number.isFinite(seconds) || hour > 23 || minute > 59 || seconds >= 61) return null;
  const label = `${text.slice(0, 2)}:${text.slice(2, 4)}:${seconds.toFixed(3).padStart(6, '0')}`;
  return { label, secondsOfDay: hour * 3600 + minute * 60 + seconds };
}

function parseDate(value) {
  if (!value || !/^\d{6}$/.test(value.trim())) return null;
  const text = value.trim();
  const day = Number(text.slice(0, 2));
  const month = Number(text.slice(2, 4));
  let year = Number(text.slice(4, 6));
  year += year < 80 ? 2000 : 1900;
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseSentence(line, lineNo) {
  const match = SENTENCE_RE.exec(line);
  if (!match) return null;
  const body = match[1];
  if (!body) return null;
  const parts = body.split(',');
  const address = parts[0].trim();
  if (address.length < 3) return null;
  const type = address.slice(-3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(type)) return null;
  let checksumOk = null;
  if (match[2] !== undefined) checksumOk = nmeaChecksum(body) === parseInt(match[2], 16);
  return {
    talker: address.slice(0, -3).toUpperCase(),
    type,
    fields: parts.slice(1),
    checksumOk,
    lineNo,
  };
}

function sentenceTime(sentence) {
  if (sentence.type === 'RMC' || sentence.type === 'GGA' || sentence.type === 'GNS') {
    return (sentence.fields[0] || '').trim() || null;
  }
  return null;
}

function systemOf(talker) {
  return TALKER_SYSTEMS[talker] || talker || 'UNKNOWN';
}

function createEpoch(date, time) {
  const parsed = time ? parseTime(time) : null;
  return {
    time: parsed ? parsed.label : null,
    date: date || null,
    datetime: parsed && date ? `${date}T${parsed.label}` : null,
    secondsOfDay: parsed ? parsed.secondsOfDay : null,
    lat: null,
    lon: null,
    altitude: null,
    geoidSeparation: null,
    speedKnots: null,
    speedKmh: null,
    course: null,
    fixQuality: null,
    fixType: null,
    status: null,
    numSatsUsed: null,
    numSatsView: null,
    hdop: null,
    pdop: null,
    vdop: null,
    satellites: new Map(),
    signals: new Map(),
    types: new Set(),
  };
}

function satelliteScore(satellite) {
  return (satellite.cn0 !== null ? 1 : 0) * 2 + (satellite.elevation !== null && satellite.azimuth !== null ? 1 : 0);
}

function applySentence(epoch, sentence) {
  const f = sentence.fields;
  const kind = sentence.type;

  if (kind === 'RMC') {
    epoch.status = (f[1] || '').trim().toUpperCase() || epoch.status;
    const lat = parseCoordinate(f[2], (f[3] || '').trim());
    const lon = parseCoordinate(f[4], (f[5] || '').trim());
    if (lat !== null) epoch.lat = lat;
    if (lon !== null) epoch.lon = lon;
    const knots = parseNumber(f[6]);
    if (knots !== null) {
      if (epoch.speedKnots === null) epoch.speedKnots = knots;
      if (epoch.speedKmh === null) epoch.speedKmh = knots * 1.852;
    }
    const course = parseNumber(f[7]);
    if (course !== null) epoch.course = course;
    const date = parseDate(f[8]);
    if (date) epoch.date = date;
  } else if (kind === 'GGA') {
    const lat = parseCoordinate(f[1], (f[2] || '').trim());
    const lon = parseCoordinate(f[3], (f[4] || '').trim());
    if (lat !== null) epoch.lat = lat;
    if (lon !== null) epoch.lon = lon;
    const quality = parseInteger(f[5]);
    if (quality !== null) epoch.fixQuality = quality;
    const used = parseInteger(f[6]);
    if (used !== null) epoch.numSatsUsed = used;
    const hdop = parseNumber(f[7]);
    if (hdop !== null) epoch.hdop = hdop;
    const altitude = parseNumber(f[8]);
    if (altitude !== null) epoch.altitude = altitude;
    const separation = parseNumber(f[10]);
    if (separation !== null) epoch.geoidSeparation = separation;
  } else if (kind === 'GNS') {
    const lat = parseCoordinate(f[1], (f[2] || '').trim());
    const lon = parseCoordinate(f[3], (f[4] || '').trim());
    if (lat !== null) epoch.lat = lat;
    if (lon !== null) epoch.lon = lon;
    const used = parseInteger(f[6]);
    if (used !== null) epoch.numSatsUsed = used;
    const hdop = parseNumber(f[7]);
    if (hdop !== null) epoch.hdop = hdop;
    const altitude = parseNumber(f[8]);
    if (altitude !== null && epoch.altitude === null) epoch.altitude = altitude;
    const separation = parseNumber(f[9]);
    if (separation !== null && epoch.geoidSeparation === null) epoch.geoidSeparation = separation;
  } else if (kind === 'VTG') {
    const knots = parseNumber(f[4]);
    const kmh = parseNumber(f[6]);
    if (kmh !== null) epoch.speedKmh = kmh;
    else if (knots !== null) epoch.speedKmh = knots * 1.852;
    if (knots !== null) epoch.speedKnots = knots;
    else if (kmh !== null) epoch.speedKnots = kmh / 1.852;
    const course = parseNumber(f[0]);
    if (course !== null) epoch.course = course;
  } else if (kind === 'GSA') {
    const fixType = parseInteger(f[1]);
    if (fixType !== null) epoch.fixType = fixType;
    const pdop = parseNumber(f[14]);
    if (pdop !== null) epoch.pdop = pdop;
    const hdop = parseNumber(f[15]);
    if (hdop !== null && epoch.hdop === null) epoch.hdop = hdop;
    const vdop = parseNumber(f[16]);
    if (vdop !== null) epoch.vdop = vdop;
  } else if (kind === 'GSV') {
    const system = systemOf(sentence.talker);
    // NMEA 4.10 在最后追加 signalId；老版本没有这一列
    const hasSignal = (f.length - 3) % 4 === 1;
    const signal = hasSignal ? (f[f.length - 1] || '').trim() : '';
    for (let i = 3; i + 3 < f.length; i += 4) {
      const prn = (f[i] || '').trim();
      if (!prn) continue;
      const satellite = {
        system,
        prn,
        signal,
        elevation: parseNumber(f[i + 1]),
        azimuth: parseNumber(f[i + 2]),
        cn0: parseNumber(f[i + 3]),
      };
      const key = `${system}|${prn}`;
      const previous = epoch.satellites.get(key);
      if (!previous || satelliteScore(satellite) >= satelliteScore(previous)) {
        epoch.satellites.set(key, satellite);
      }
      const signalKey = `${system}|${prn}|${signal || 'default'}`;
      const previousSignal = epoch.signals.get(signalKey);
      if (!previousSignal || satelliteScore(satellite) >= satelliteScore(previousSignal)) {
        epoch.signals.set(signalKey, satellite);
      }
    }
  }
}

function upperBound(sorted, value) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

function lowerBound(sorted, value) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * 解析整份 NMEA 文本。
 * 历元以 RMC/GGA/GNS 的 UTC 时间为锚点；GSV 归入之前最近的历元，
 * GSA/VTG/DTM 归入之后最近的历元。
 */
function parseNmea(text) {
  const stats = {
    lines: 0, sentences: 0, ignored: 0, checksumErrors: 0,
    byType: {}, byTalker: {},
  };
  const records = [];

  for (const raw of text.split(/\r?\n/)) {
    stats.lines += 1;
    const line = raw.trim();
    if (!line) { stats.ignored += 1; continue; }
    const sentence = parseSentence(line, stats.lines);
    if (!sentence) { stats.ignored += 1; continue; }
    if (sentence.checksumOk === false) {
      stats.checksumErrors += 1;
      stats.ignored += 1;
      continue;
    }
    stats.sentences += 1;
    stats.byType[sentence.type] = (stats.byType[sentence.type] || 0) + 1;
    stats.byTalker[sentence.talker] = (stats.byTalker[sentence.talker] || 0) + 1;
    records.push(sentence);
  }

  // 第一遍：时间锚点
  const anchors = [];
  let currentDate = null;
  for (let pos = 0; pos < records.length; pos += 1) {
    const sentence = records[pos];
    const stamp = sentenceTime(sentence);
    if (!stamp) continue;
    if (sentence.type === 'RMC') {
      const date = parseDate(sentence.fields[8]);
      if (date) currentDate = date;
    }
    const key = `${currentDate || ''}|${stamp}`;
    if (!anchors.length || anchors[anchors.length - 1].key !== key) {
      anchors.push({ pos, key, date: currentDate, time: stamp });
    }
  }

  const epochs = new Map();
  for (const anchor of anchors) {
    if (!epochs.has(anchor.key)) epochs.set(anchor.key, createEpoch(anchor.date, anchor.time));
  }
  const fallback = anchors.length ? null : createEpoch(null, null);
  const anchorPositions = anchors.map((anchor) => anchor.pos);

  const precedingEpoch = (pos) => {
    if (!anchors.length) return fallback;
    const k = upperBound(anchorPositions, pos) - 1;
    return epochs.get(anchors[Math.max(0, k)].key);
  };
  const followingEpoch = (pos) => {
    if (!anchors.length) return fallback;
    const k = lowerBound(anchorPositions, pos);
    return epochs.get(anchors[Math.min(anchors.length - 1, k)].key);
  };

  // 第二遍：填入历元
  currentDate = null;
  for (let pos = 0; pos < records.length; pos += 1) {
    const sentence = records[pos];
    const stamp = sentenceTime(sentence);
    let epoch = null;
    if (stamp) {
      if (sentence.type === 'RMC') {
        const date = parseDate(sentence.fields[8]);
        if (date) currentDate = date;
      }
      epoch = epochs.get(`${currentDate || ''}|${stamp}`) || null;
    } else if (sentence.type === 'GSV') {
      epoch = precedingEpoch(pos);
    } else {
      epoch = followingEpoch(pos);
    }
    if (!epoch) continue;
    epoch.types.add(sentence.type);
    applySentence(epoch, sentence);
  }

  const list = [];
  for (const epoch of epochs.values()) {
    if (!epoch.types.size) continue;
    if (epoch.time === null && epoch.lat === null && !epoch.satellites.size) continue;
    if (epoch.numSatsView === null && epoch.satellites.size) {
      epoch.numSatsView = epoch.satellites.size;
    }
    list.push(epoch);
  }

  stats.epochs = list.length;
  return { epochs: list, stats };
}

/* ------------------------------------------------------------------ *
 * 统计
 * ------------------------------------------------------------------ */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function summarize(epochs) {
  const located = epochs.filter((epoch) => epoch.lat !== null && epoch.lon !== null);
  const summary = {
    epochs: epochs.length,
    located: located.length,
    systems: {},
    maxSpeedKmh: 0,
    distance: 0,
  };

  for (const epoch of epochs) {
    summary.maxSpeedKmh = Math.max(summary.maxSpeedKmh, epoch.speedKmh || 0);
    for (const satellite of epoch.satellites.values()) {
      (summary.systems[satellite.system] = summary.systems[satellite.system] || new Set()).add(satellite.prn);
    }
  }
  for (const key of Object.keys(summary.systems)) {
    summary.systems[key] = summary.systems[key].size;
  }

  if (located.length) {
    summary.bounds = {
      minLat: Math.min(...located.map((e) => e.lat)),
      maxLat: Math.max(...located.map((e) => e.lat)),
      minLon: Math.min(...located.map((e) => e.lon)),
      maxLon: Math.max(...located.map((e) => e.lon)),
    };
    for (let i = 1; i < located.length; i += 1) {
      summary.distance += haversine(located[i - 1].lat, located[i - 1].lon, located[i].lat, located[i].lon);
    }
    summary.start = { lat: located[0].lat, lon: located[0].lon };
    summary.end = { lat: located[located.length - 1].lat, lon: located[located.length - 1].lon };
  }

  const first = epochs.find((epoch) => epoch.secondsOfDay !== null);
  const last = [...epochs].reverse().find((epoch) => epoch.secondsOfDay !== null);
  if (first && last) {
    summary.duration = last.secondsOfDay - first.secondsOfDay;
    summary.startTime = first.datetime;
    summary.endTime = last.datetime;
  }
  return summary;
}

/* ------------------------------------------------------------------ *
 * 全局状态
 * ------------------------------------------------------------------ */
const state = {
  datasets: [],       // 多条数据的集合，顺序即图例顺序
  datasetSeq: 0,
  focusId: null,      // 顶部时刻标签 / 对比曲线「相对起点」参照的数据集
  referenceId: null,  // 水平误差的基准数据集（图例里设置）
  referenceName: '',  // 基准文件名，用于重新载入同名文件时恢复选择
  now: 0,             // 全局绝对时间（UTC 秒），所有视图的时间基准
  origin: 0,          // 轨道 0 点对应的绝对秒
  duration: 0,        // 全部数据集覆盖的时间跨度
  playing: false,
  stepSeconds: 1,     // 播放速度 / 快进 / 后退步长（秒）
  playAnchorWall: 0,  // 播放起点的墙钟时间
  playAnchorTime: 0,  // 播放起点的数据时间
  rafHandle: null,
  mapSource: 'arcgis-imagery',
  view: null,          // 手动缩放/平移后的视野 { zoom, center }，重建地图时沿用
  mapReady: false,
  layerStyle: null,     // 轨迹线/点的图例样式，init 时从 localStorage 恢复
  datasetStyle: {},     // 按文件名记住的数据集颜色/显隐
  legend: {
    styleOpen: false,
    display: {
      visible: true,
      datasets: true,
      line: true,
      track: true,
      start: true,
      end: true,
      current: true,
      offset: true,
    },
    styleRect: null,
    legendPos: null,
  },
  legendFrame: null,
  styleFrame: null,
  pendingStyleLayers: new Set(),
  pendingRender: false,
  split: null,          // 可选 sky_split.json：遮挡分割（逐历元曲线 + 逐星概率）
  compare: {
    open: false,
    metrics: DEFAULT_COMPARE_METRICS.slice(),
    datasets: new Set(),
    align: DEFAULT_COMPARE_ALIGN,
    rect: null,   // 对比窗尺寸 { w, h }，拖动右下角缩放时写入
  },
  compareReady: false,
  sat: {
    open: false,
    metric: 'counts',
    systems: null,   // null = 当前数据里的全部系统
    bands: null,     // null = 当前数据里的全部频点
    datasets: null,  // null = 当前全部数据集
    satellite: null, // 单星模式：`系统|prn|signal`
    rect: null,      // 位置和尺寸 { x, y, w, h }
  },
  satReady: false,
  // 时间窗：全局相对秒。start/end 是「时间先后」上的两个标尺，窗口内即为活动区间
  window: { start: 0, end: 0 },
  windowFrame: null,
  timelineDrag: null,   // 轨道上的拖动状态：改标尺 / 平移窗口 / 定位当前时刻
  mapDrag: null,        // 拖动地图上的「当前位置」点：{ dataset, clientX, clientY, frame, ... }
  measure: { active: false, open: false, pos: null, points: [] },  // 地图距离测量：WGS84 顶点
  measureFrame: null,
  markerBaseFrame: null,     // 轨迹点 / 起点 / 终点覆盖层的重绘帧
  markerCurrentFrame: null,  // 当前位置覆盖层的重绘帧
  locks: [],                 // 锁定的轨迹点：{ id, key, datasetId, epochIndex, lat, lon, timeText }
  lockSeq: 0,
  lockFrame: null,
  trackHover: null,          // 当前悬停的轨迹点信息
  trackHoverTimer: null,
  windowLayout: {},     // 浮窗位置：{ 'sky:文件名': {x,y,w,h} }
  resizeObserver: null,
  resizeFrame: null,
  floatZ: 41,
};

/** 顶部时刻标签使用的数据集（星空图 / 仪表盘已经各自绑定到自己的数据集）。 */
function focusDataset() {
  if (!state.datasets.length) return null;
  return state.datasets.find((dataset) => dataset.id === state.focusId) || state.datasets[0];
}

function datasetOrdinal(dataset) {
  return state.datasets.indexOf(dataset);
}

/** 数据集在其自身时间轴上的当前历元。 */
function currentEpoch(dataset = focusDataset()) {
  if (!dataset) return null;
  return dataset.epochs[dataset.index] || dataset.epochs[0] || null;
}

const dom = {};

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */
function fmt(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

/** 文件名等外部文本拼进 innerHTML 前先转义。 */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function compassPoint(degrees) {
  if (degrees === null || degrees === undefined) return '';
  const normalized = ((degrees % 360) + 360) % 360;
  return COMPASS_POINTS[Math.round(normalized / 22.5) % 16];
}

function toast(message, isError = false) {  dom.toast.textContent = message;
  dom.toast.classList.toggle('error', isError);
  dom.toast.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { dom.toast.hidden = true; }, 4200);
}

/* ------------------------------------------------------------------ *
 * 地图
 * ------------------------------------------------------------------ */
/**
 * 地图缩放上限：等于该底图能提供的最大瓦片级别。
 * 超过这个级别，mapbox 会去请求不存在的瓦片，整张底图就变空白。
 */
function mapZoomLimit(source) {
  return Math.max(2, TILE_MAX_ZOOM[source] || 19);
}

/**
 * 把底图的瓦片上限写给 Mapbox GL：滚轮 / 双击到上限就停住，
 * 不会先放大过头再被 plotly_relayout 拉回来（那种回拉看起来像「缩小」）。
 */
function applyMapZoomCap() {
  const map = mapboxMap();
  if (!map || typeof map.setMaxZoom !== 'function') return false;
  const limit = mapZoomLimit(state.mapSource);
  if (map.getMaxZoom() !== limit) map.setMaxZoom(limit);
  return true;
}

function ensureMapZoomCap() {
  if (applyMapZoomCap()) return;
  requestAnimationFrame(() => {
    if (applyMapZoomCap()) return;
    setTimeout(applyMapZoomCap, 300);
  });
}

function mapLayout() {
  const layout = {
    margin: { l: 0, r: 0, t: 0, b: 0 },
    showlegend: false,
    paper_bgcolor: '#ffffff',
    mapbox: {
      style: buildBaseStyle(state.mapSource),
      center: { lon: 0, lat: 0 },
      zoom: 12,
    },
  };

  // 用户手动缩放/平移过（或切换底图时保留了视野）就以当前视野为准
  if (state.view) {
    const limit = mapZoomLimit(state.mapSource);
    // 换到上限更低的底图时把记录也收下来，避免再换回去时莫名放大
    if (state.view.zoom > limit) state.view.zoom = limit;
    layout.mapbox.center = viewCenterFor(state.mapSource) || { ...state.view.center };
    layout.mapbox.zoom = state.view.zoom;
    return layout;
  }

  const bounds = combinedBounds();
  if (!bounds) return layout;

  const [centerLat, centerLon] = toDisplay(
    (bounds.minLat + bounds.maxLat) / 2,
    (bounds.minLon + bounds.maxLon) / 2,
  );
  const latSpan = Math.max(bounds.maxLat - bounds.minLat, 1e-6);
  const lonSpan = Math.max(bounds.maxLon - bounds.minLon, 1e-6);
  const meters = Math.max(
    latSpan * 110574,
    lonSpan * 111320 * Math.cos((centerLat * Math.PI) / 180),
    5,
  );
  // source 的 maxzoom 限制了瓦片级别，地图 zoom 可以直接开到这一级。
  // 默认视图比上限低一级，保证滚轮一开始就能往上放大。
  const limit = mapZoomLimit(state.mapSource);
  const fitZoom = Math.log2((320 * 156543 * Math.cos((centerLat * Math.PI) / 180)) / meters);
  const zoom = Math.min(limit - 1, Math.max(2, fitZoom));

  layout.mapbox.center = { lon: centerLon, lat: centerLat };
  layout.mapbox.zoom = zoom;
  return layout;
}

function layerStyle(layer) {
  return (state.layerStyle || DEFAULT_LAYER_STYLE)[layer];
}

/** 所有可见数据集轨迹的合并包围盒；没有定位数据时返回 null。 */
function combinedBounds() {
  let bounds = null;
  for (const dataset of state.datasets) {
    if (!dataset.visible || !dataset.summary || !dataset.summary.bounds) continue;
    const box = dataset.summary.bounds;
    if (!bounds) {
      bounds = { ...box };
      continue;
    }
    bounds.minLat = Math.min(bounds.minLat, box.minLat);
    bounds.maxLat = Math.max(bounds.maxLat, box.maxLat);
    bounds.minLon = Math.min(bounds.minLon, box.minLon);
    bounds.maxLon = Math.max(bounds.maxLon, box.maxLon);
  }
  return bounds;
}

/**
 * 数据集里能画到地图上的点：坐标保持 WGS84（换底图时再统一纠偏），
 * 时间用数据集自身相对秒，便于按时间窗切片。
 */
function buildDatasetTrack(epochs, times) {
  const lat = [];
  const lon = [];
  const time = [];
  for (let i = 0; i < epochs.length; i += 1) {
    const epoch = epochs[i];
    if (epoch.lat === null || epoch.lon === null) continue;
    lat.push(epoch.lat);
    lon.push(epoch.lon);
    time.push(times[i]);
  }
  return { lat, lon, time };
}

/** 轨迹点的显示坐标（按当前底图做 GCJ-02 纠偏），按底图缓存一份。 */
function displayTrack(dataset) {
  const cached = dataset.displayTrack;
  if (cached && cached.source === state.mapSource) return cached;
  const track = dataset.track;
  const lat = new Array(track.lat.length);
  const lon = new Array(track.lon.length);
  for (let i = 0; i < track.lat.length; i += 1) {
    const [displayLat, displayLon] = toDisplay(track.lat[i], track.lon[i]);
    lat[i] = displayLat;
    lon[i] = displayLon;
  }
  dataset.displayTrack = { source: state.mapSource, lat, lon };
  return dataset.displayTrack;
}

/**
 * 轨迹点里落在当前时间窗内的下标区间 [first, last)。
 * 数据集的时间轴单调递增，用二分查找即可；窗口为全时段时直接返回全部。
 */
function windowSlice(dataset) {
  const times = dataset.track.time;
  const total = times.length;
  if (!total || state.duration <= 0) return [0, 0];
  if (windowIsFull()) return [0, total];

  const offset = datasetOffset(dataset);
  const start = state.window.start - offset;
  const end = state.window.end - offset;
  let low = 0;
  let high = total;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (times[mid] < start - 1e-6) low = mid + 1;
    else high = mid;
  }
  const first = low;
  low = first;
  high = total;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (times[mid] <= end + 1e-6) low = mid + 1;
    else high = mid;
  }
  return [first, low];
}

/** 当前时间窗内的轨迹（显示坐标）；全时段时直接复用缓存数组，不做拷贝。 */
function visibleTrack(dataset) {
  const display = displayTrack(dataset);
  const [first, last] = windowSlice(dataset);
  if (first === 0 && last === display.lat.length) return display;
  return { lat: display.lat.slice(first, last), lon: display.lon.slice(first, last) };
}

function mapLineTrace(lons, lats, dataset) {
  const style = layerStyle('line');
  return {
    type: 'scattermapbox',
    mode: 'lines',
    lon: lons,
    lat: lats,
    line: { color: dataset.color, width: datasetLineWidth(dataset) },
    visible: style.visible && dataset.visible,
    hoverinfo: 'skip',
    name: `${dataset.name} 轨迹线`,
  };
}

function mapPointTrace(lons, lats, layer, name, dataset, covered = true) {
  const style = layerStyle(layer);
  const followsDataset = layer === 'line' || layer === 'track' || layer === 'current';
  // 点标记统一由地图上的 canvas 覆盖层绘制（支持形状选择），
  // 这里保留隐藏 trace 占位，保证每个数据集的 trace 下标稳定。
  return {
    type: 'scattermapbox',
    mode: 'markers',
    lon: lons,
    lat: lats,
    marker: {
      size: style.size,
      color: followsDataset ? dataset.color : style.color,
      opacity: layer === 'track' ? 0.95 : 1,
    },
    visible: false,
    hoverinfo: 'skip',
    name: `${dataset.name} ${name}`,
  };
}

const MAX_OFFSET_SEGMENTS = 5000;

/** 没有基准 / 没有覆盖时的占位几何：两个重合点画不出可见线，但 trace 数据形状保持稳定。 */
function emptyOffsetGeometry(dataset) {
  const display = displayTrack(dataset);
  if (display.lat.length) {
    return {
      lon: [display.lon[0], display.lon[0], null],
      lat: [display.lat[0], display.lat[0], null],
    };
  }
  return { lon: [0, 0, null], lat: [0, 0, null] };
}

/**
 * 「基准连线」的几何：时间窗内每个（抽稀后的）历元，从轨迹位置连到基准在
 * 同一时刻的位置，直观看出水平偏移的方向和大小。窗口越窄抽稀越少。
 */
function offsetSegments(dataset) {
  const lon = [];
  const lat = [];
  const reference = referenceDataset();
  if (!reference || reference === dataset) return emptyOffsetGeometry(dataset);
  const track = dataset.track;
  if (!track.time.length) return emptyOffsetGeometry(dataset);

  const display = displayTrack(dataset);
  const offset = datasetOffset(dataset);
  const first = lowerBound(track.time, state.window.start - offset - 1e-6);
  const last = upperBound(track.time, state.window.end - offset + 1e-6);
  const count = last - first;
  if (count <= 0) return emptyOffsetGeometry(dataset);
  const stride = Math.max(1, Math.ceil(count / MAX_OFFSET_SEGMENTS));

  for (let i = first; i < last; i += stride) {
    const globalSeconds = offset + track.time[i];
    const position = referencePositionAt(reference, globalSeconds);
    if (!position) continue;
    const [refLat, refLon] = toDisplay(position.lat, position.lon);
    if (refLat === null || refLon === null) continue;
    lon.push(display.lon[i], refLon, null);
    lat.push(display.lat[i], refLat, null);
  }
  return lon.length ? { lon, lat } : emptyOffsetGeometry(dataset);
}

function mapOffsetTrace(dataset) {
  const style = layerStyle('offset');
  const geometry = offsetSegments(dataset);
  return {
    type: 'scattermapbox',
    mode: 'lines',
    lon: geometry.lon,
    lat: geometry.lat,
    line: { color: dataset.color, width: style.size },
    opacity: style.visible ? 0.9 : 0,
    connectgaps: false,
    // 图例里的显示 / 隐藏走 opacity，不改 visible：Plotly mapbox 对 trace
    // 可见性做 restyle 后再删除数据集会留下失效图层。没有基准时几何是重合点，
    // 画不出可见线。
    visible: dataset.visible,
    hoverinfo: 'skip',
    name: `${dataset.name} 基准连线`,
  };
}

/** 只刷新各数据集的「基准连线」几何，不重建整张地图（换基准时用）。 */
function refreshOffsetTraces() {
  if (!state.mapReady || !state.datasets.length) return;
  const indices = [];
  const lon = [];
  const lat = [];
  state.datasets.forEach((dataset, ordinal) => {
    const geometry = offsetSegments(dataset);
    indices.push(traceIndexFor(ordinal, 'offset'));
    lon.push(geometry.lon);
    lat.push(geometry.lat);
  });
  // 没有基准时几何是占位重合点，画不出可见线；这里不改 visible，
  // 避免 Plotly 重建 Mapbox 图层后，删除数据集时报 "layer does not exist"。
  const result = Plotly.restyle('map', { lon, lat }, indices);
  if (result && typeof result.catch === 'function') result.catch(() => {});
}

/**
 * 每个数据集固定输出 6 条 trace（线 / 点 / 起点 / 终点 / 当前位置 / 基准连线），
 * 隐藏的数据集只把 visible 置为 false，保证 trace 下标稳定。
 * 轨迹线与轨迹点只画当前时间窗内的那一段（按时间段显示）。
 */
function mapData() {
  const traces = [];
  for (const dataset of state.datasets) {
    const track = dataset.track;
    const visible = visibleTrack(dataset);
    const epoch = dataset.epochs[dataset.index] || null;
    const currentPoint = epoch ? toDisplay(epoch.lat, epoch.lon) : [null, null];

    const startPoint = track.lat.length ? toDisplay(track.lat[0], track.lon[0]) : [null, null];
    const endIndex = track.lat.length - 1;
    const endPoint = endIndex >= 0 ? toDisplay(track.lat[endIndex], track.lon[endIndex]) : [null, null];
    const currentLons = currentPoint[1] !== null ? [currentPoint[1]] : [];
    const currentLats = currentPoint[0] !== null ? [currentPoint[0]] : [];

    // 顺序必须与 LAYER_ORDER 一致
    const covered = datasetState(dataset) === 'ok';
    traces.push(mapLineTrace(visible.lon, visible.lat, dataset));
    traces.push(mapPointTrace(visible.lon, visible.lat, 'track', '轨迹点', dataset));
    traces.push(mapPointTrace(
      startPoint[1] !== null ? [startPoint[1]] : [],
      startPoint[0] !== null ? [startPoint[0]] : [],
      'start', '起点', dataset,
    ));
    traces.push(mapPointTrace(
      endPoint[1] !== null ? [endPoint[1]] : [],
      endPoint[0] !== null ? [endPoint[0]] : [],
      'end', '终点', dataset,
    ));
    traces.push(mapPointTrace(currentLons, currentLats, 'current', '当前位置', dataset, covered));
    traces.push(mapOffsetTrace(dataset));
  }
  if (!traces.length) {
    // 占位 trace：没有数据时也让 mapbox 正常初始化
    traces.push({
      type: 'scattermapbox', mode: 'markers', lon: [], lat: [], hoverinfo: 'skip',
    });
  }
  return traces;
}

function renderMap(full = false) {
  if (!state.mapReady || full) {
    const layout = mapLayout();
    Plotly.react('map', mapData(), layout, PLOT_CONFIG);
    state.mapReady = true;
    attachMapInteractions();
    ensureMeasureMapEvents();
    ensureMapZoomCap();
    ensureMarkerMapEvents();
    scheduleMarkerDraw();
    scheduleLockPosition();
    return;
  }

  // 快路径：时间变化只更新「当前位置」覆盖层
  scheduleMarkerCurrent();
}

/**
 * 记录用户在地图上滚轮缩放 / 拖拽平移后的视野，
 * 以便切换底图或重建地图时不会把镜头拉回初始位置。
 */
function attachMapInteractions() {
  const element = document.getElementById('map');
  if (!element || typeof element.on !== 'function' || element.__viewBound) return;
  element.__viewBound = true;
  // 防止 relayout 纠正缩放的递归调用：第一次修正期间忽略后续事件
  let clamping = false;
  element.on('plotly_relayout', () => {
    if (clamping) return;
    const layout = element._fullLayout;
    const mapbox = layout && layout.mapbox;
    if (!mapbox || typeof mapbox.zoom !== 'number' || !mapbox.center) return;

    // Plotly 不会把 maxzoom 传给 mapbox-gl，滚轮能一直放大到超出瓦片范围，
    // 超过后底图会变空白，所以这里主动把镜头收回可用级别
    const limit = mapZoomLimit(state.mapSource);
    const liveMap = mapboxMap();
    if (liveMap && liveMap.getMaxZoom() !== limit) liveMap.setMaxZoom(limit);
    const clamped = Math.min(mapbox.zoom, limit);
    state.view = {
      zoom: clamped,
      center: { lat: mapbox.center.lat, lon: mapbox.center.lon },
      gcj: GCJ02_SOURCES.has(state.mapSource),
    };
    if (clamped < mapbox.zoom - 1e-6) {
      clamping = true;
      const release = () => { clamping = false; };
      Plotly.relayout(element, 'mapbox.zoom', clamped).then(release, release);
    }
  });
}

/* ------------------------------------------------------------------ *
 * 拖动地图上的「当前位置」点来调整时间
 * ------------------------------------------------------------------ */
const MAP_POINT_HIT_RADIUS = 16;   // 命中当前位置点的像素半径
const MAP_POINT_APPLY_INTERVAL = 40; // 拖动时重绘的最小间隔（ms），避免 60fps 拖垮

/** Plotly mapbox 子图里的 Mapbox GL 实例（用于像素 ↔ 经纬度换算）。 */
function mapboxMap() {
  const element = document.getElementById('map');
  const mapbox = element && element._fullLayout && element._fullLayout.mapbox;
  return (mapbox && mapbox._subplot && mapbox._subplot.map) || null;
}

/** 指针是否落在某条轨迹的「当前位置」点上；返回最近的一条。 */
function currentMarkerAt(event) {
  if (!state.mapReady || !state.datasets.length) return null;
  if (!layerStyle('current').visible) return null;
  const map = mapboxMap();
  if (!map) return null;

  const rect = map.getContainer().getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  let best = null;
  for (const dataset of state.datasets) {
    if (!dataset.visible || datasetState(dataset) !== 'ok') continue;
    const epoch = dataset.epochs[dataset.index];
    if (!epoch || epoch.lat === null || epoch.lon === null) continue;
    const [lat, lon] = toDisplay(epoch.lat, epoch.lon);
    const point = map.project([lon, lat]);
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance <= MAP_POINT_HIT_RADIUS && (!best || distance < best.distance)) {
      best = { dataset, distance };
    }
  }
  return best;
}

/** 指针下方最近的轨迹点下标（track 下标，含自己的相对时间）。 */
function nearestTrackIndex(dataset, lng, lat) {
  const display = displayTrack(dataset);
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < display.lat.length; i += 1) {
    const dLat = display.lat[i] - lat;
    const dLon = (display.lon[i] - lng) * cosLat;
    const distance = dLat * dLat + dLon * dLon;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/** UTC 时刻文案；没有 UTC 基准时退回相对秒。 */
function mapClockText(absoluteSeconds, fallback) {
  const baseline = utcBaseline();
  if (baseline !== null && Number.isFinite(absoluteSeconds)) {
    return `${formatUtc(absoluteSeconds, utcDateStyle(baseline))} UTC`;
  }
  return String(fallback || '—');
}

function mapPointLabelHtml(dataset, clockText, hint) {
  return `<b>${escapeHtml(dataset.name)}</b>${clockText}${hint ? ` · ${hint}` : ''}`;
}

function showMapDragLabel(html, clientX, clientY) {
  const label = dom.mapDragLabel;
  if (!label) return;
  if (label.__html !== html) {
    label.innerHTML = html;
    label.__html = html;
  }
  label.hidden = false;
  positionMapDragLabel(clientX, clientY);
}

function positionMapDragLabel(clientX, clientY) {
  const label = dom.mapDragLabel;
  if (!label || label.hidden) return;
  const width = label.offsetWidth || 150;
  const height = label.offsetHeight || 22;
  const x = Math.min(window.innerWidth - width - 8, Math.max(8, clientX + 14));
  const y = Math.min(window.innerHeight - height - 8, Math.max(8, clientY - height - 12));
  label.style.left = `${x}px`;
  label.style.top = `${y}px`;
}

function hideMapDragLabel() {
  if (dom.mapDragLabel) dom.mapDragLabel.hidden = true;
}

function setMapCursor(cursor) {
  const map = mapboxMap();
  if (!map) return;
  const container = map.getContainer ? map.getContainer() : null;
  if (container) container.style.cursor = cursor;
  const canvas = map.getCanvas ? map.getCanvas() : null;
  if (canvas) canvas.style.cursor = cursor;
}

/** 把指针位置换算成拖动数据里最近的时间点，并更新时间窗 / 当前时刻。 */
function applyMapDrag() {
  const drag = state.mapDrag;
  if (!drag || !drag.moved) return;
  const { dataset, map } = drag;
  if (!state.datasets.includes(dataset)) return;
  const container = map.getContainer ? map.getContainer() : null;
  if (!container || !container.isConnected) return;

  const rect = container.getBoundingClientRect();
  const point = map.unproject([drag.clientX - rect.left, drag.clientY - rect.top]);
  const index = nearestTrackIndex(dataset, point.lng, point.lat);
  if (index < 0 || index === drag.lastIndex) return;
  const time = dataset.track.time[index];
  if (!Number.isFinite(time)) return;

  const globalRelative = datasetOffset(dataset) + time;
  // 拖到时间窗外的点时让窗口跟着平移，保证游标、轨迹切片与读数一致
  if (globalRelative < state.window.start - 1e-6 || globalRelative > state.window.end + 1e-6) {
    const width = state.window.end - state.window.start;
    const start = Math.max(0, Math.min(state.duration - width, globalRelative - width / 2));
    setWindow(start, start + width, { follow: false });
  }
  const clamped = Math.min(state.window.end, Math.max(state.window.start, globalRelative));
  setGlobalTime(state.origin + clamped);
  renderEpoch();

  drag.lastIndex = index;
  const absolute = state.origin + datasetOffset(dataset) + time;
  showMapDragLabel(
    mapPointLabelHtml(dataset, mapClockText(absolute, `${time.toFixed(1)} s`)),
    drag.clientX,
    drag.clientY,
  );
}

function scheduleMapDragApply() {
  const drag = state.mapDrag;
  if (!drag || drag.frame !== null) return;
  const wait = Math.max(0, MAP_POINT_APPLY_INTERVAL - (performance.now() - drag.lastApply));
  drag.frame = setTimeout(() => {
    drag.frame = null;
    if (!state.mapDrag) return;
    state.mapDrag.lastApply = performance.now();
    applyMapDrag();
  }, wait);
}

function beginMapPointDrag(event, hit) {
  const map = mapboxMap();
  if (!map) return;
  event.preventDefault();
  event.stopPropagation();
  stopPlayback();

  const epoch = hit.dataset.epochs[hit.dataset.index] || null;
  const captureElement = event.currentTarget;
  state.mapDrag = {
    dataset: hit.dataset,
    map,
    panEnabled: Boolean(map.dragPan && map.dragPan.isEnabled()),
    pointerId: event.pointerId,
    captureElement,
    startX: event.clientX,
    startY: event.clientY,
    clientX: event.clientX,
    clientY: event.clientY,
    moved: false,
    lastIndex: -1,
    lastApply: 0,
    frame: null,
  };
  if (state.mapDrag.panEnabled) map.dragPan.disable();
  setMapCursor('grabbing');
  showMapDragLabel(
    mapPointLabelHtml(hit.dataset, mapClockText(epoch ? epochStamp(epoch) : null, epoch ? epoch.time : '—')),
    event.clientX,
    event.clientY,
  );

  // 指针捕获：拖出浏览器窗口再松手时也能收到 pointerup，避免卡在拖动状态
  if (captureElement && captureElement.setPointerCapture) {
    try { captureElement.setPointerCapture(event.pointerId); } catch (error) { /* 忽略 */ }
  }

  window.addEventListener('pointermove', onMapPointDragMove);
  window.addEventListener('pointerup', onMapPointDragEnd);
  window.addEventListener('pointercancel', onMapPointDragEnd);
  window.addEventListener('blur', onMapPointDragEnd);
}

function onMapPointDragMove(event) {
  const drag = state.mapDrag;
  if (!drag) return;
  event.preventDefault();
  drag.clientX = event.clientX;
  drag.clientY = event.clientY;
  positionMapDragLabel(event.clientX, event.clientY);
  // 单击（几乎没动）不改时间，避免误触让时间跳到轨迹自交的另一个点
  if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3) {
    drag.moved = true;
  }
  if (drag.moved) scheduleMapDragApply();
}

function onMapPointDragEnd(event) {
  const drag = state.mapDrag;
  if (!drag) return;
  if (event && event.type === 'pointerup') {
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
  }
  if (drag.frame !== null) {
    clearTimeout(drag.frame);
    drag.frame = null;
  }
  // 松手位置可能还没被节流的那一帧处理到，补一次
  applyMapDrag();
  if (drag.panEnabled && drag.map.dragPan) drag.map.dragPan.enable();
  if (drag.captureElement && drag.captureElement.releasePointerCapture
      && drag.pointerId !== undefined) {
    try { drag.captureElement.releasePointerCapture(drag.pointerId); } catch (error) { /* 忽略 */ }
  }
  state.mapDrag = null;
  window.removeEventListener('pointermove', onMapPointDragMove);
  window.removeEventListener('pointerup', onMapPointDragEnd);
  window.removeEventListener('pointercancel', onMapPointDragEnd);
  window.removeEventListener('blur', onMapPointDragEnd);
  hideMapDragLabel();
  setMapCursor(mapIdleCursor());
}

/** 地图上的当前位置点：按下拖动改时间；悬停显示该点的时间。只需绑定一次。 */
function attachMapPointInteractions() {
  const element = document.getElementById('map');
  if (!element || element.__pointDragBound) return;
  element.__pointDragBound = true;

  // capture：先于 mapbox 的拖拽处理，命中当前位置点时不要平移地图
  element.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || state.mapDrag) return;
    hideTrackHover();
    const hit = currentMarkerAt(event);
    if (!hit) return;
    beginMapPointDrag(event, hit);
  }, true);

  element.addEventListener('pointermove', (event) => {
    if (state.mapDrag || event.buttons !== 0) {
      hideTrackHover();
      return;
    }
    const hit = currentMarkerAt(event);
    if (!hit) {
      hideMapDragLabel();
      setMapCursor(mapIdleCursor());
      updateTrackHover(event);
      return;
    }
    hideTrackHover();
    setMapCursor('grab');
    const epoch = hit.dataset.epochs[hit.dataset.index] || null;
    showMapDragLabel(
      mapPointLabelHtml(
        hit.dataset,
        mapClockText(epoch ? epochStamp(epoch) : null, epoch ? epoch.time : '—'),
        '拖动调整时间',
      ),
      event.clientX,
      event.clientY,
    );
  });

  element.addEventListener('pointerleave', () => {
    if (state.mapDrag) return;
    hideMapDragLabel();
    setMapCursor(mapIdleCursor());
    hideTrackHover(300);
  });
}

/* ------------------------------------------------------------------ *
 * 工具箱：地图距离测量
 * ------------------------------------------------------------------ */
const MEASURE_NS = 'http://www.w3.org/2000/svg';

/** 测量模式下的空闲光标：十字准星提示可以点选。 */
function mapIdleCursor() {
  return state.measure.active ? 'crosshair' : '';
}

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '—';
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
  if (meters >= 100) return `${meters.toFixed(1)} m`;
  return `${meters.toFixed(2)} m`;
}

/** 已选点之间的分段距离与总长（WGS84 上的球面距离）。 */
function measureSegments() {
  const points = state.measure.points;
  const segments = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const length = haversine(
      points[i - 1].lat, points[i - 1].lon,
      points[i].lat, points[i].lon,
    );
    segments.push({ length });
    total += length;
  }
  return { segments, total };
}

function updateMeasureReadout() {
  const points = state.measure.points;
  const { segments, total } = measureSegments();
  if (dom.measureReadout) {
    if (!points.length) {
      dom.measureReadout.textContent = state.measure.active
        ? '点击地图添加第一个点'
        : '在地图上点选两点或多点，测量各段与总距离';
    } else if (points.length === 1) {
      dom.measureReadout.textContent = '已选 1 个点，继续点第二个点';
    } else {
      const last = segments[segments.length - 1];
      dom.measureReadout.textContent = `${points.length} 个点 · 总长 ${formatDistance(total)}`
        + ` · 最后一段 ${formatDistance(last.length)}`;
    }
  }
  if (dom.measureUndo) dom.measureUndo.disabled = !points.length;
  if (dom.measureClear) dom.measureClear.disabled = !points.length;
  if (dom.measureDone) dom.measureDone.disabled = !state.measure.active;
  if (dom.btnMeasure) {
    dom.btnMeasure.classList.toggle('active', state.measure.open);
    dom.btnMeasure.setAttribute('aria-pressed', String(state.measure.open));
  }
}

/** 把测量点投影到地图容器像素，画成 SVG 折线 + 点 + 分段 / 总长标签。 */
function renderMeasureOverlay() {
  const svg = dom.measureOverlay;
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const map = mapboxMap();
  const points = state.measure.points;
  if (!map || !points.length) return;
  const mapRect = map.getContainer().getBoundingClientRect();
  const svgRect = svg.getBoundingClientRect();
  if (!svgRect.width || !svgRect.height) return;
  const dx = mapRect.left - svgRect.left;
  const dy = mapRect.top - svgRect.top;

  const projected = points.map((point) => {
    const [lat, lon] = toDisplay(point.lat, point.lon);
    const screen = map.project([lon, lat]);
    return { x: screen.x + dx, y: screen.y + dy };
  });

  const add = (tag, attrs) => {
    const node = document.createElementNS(MEASURE_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.appendChild(node);
    return node;
  };

  const { segments, total } = measureSegments();
  if (projected.length > 1) {
    add('polyline', {
      class: 'measure-line',
      points: projected.map((point) => `${point.x},${point.y}`).join(' '),
    });
    segments.forEach((segment, index) => {
      const a = projected[index];
      const b = projected[index + 1];
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const length = Math.hypot(vx, vy) || 1;
      // 标签放在线段中点的法线方向，避免压住折线
      const label = add('text', {
        class: 'measure-label',
        x: (a.x + b.x) / 2 + (-vy / length) * 9,
        y: (a.y + b.y) / 2 + (vx / length) * 9,
      });
      label.textContent = formatDistance(segment.length);
    });
  }

  projected.forEach((point) => add('circle', {
    class: 'measure-point', cx: point.x, cy: point.y, r: 4,
  }));

  if (projected.length > 1) {
    const last = projected[projected.length - 1];
    const label = add('text', {
      class: 'measure-label measure-total',
      x: last.x + 13,
      y: last.y - 12,
    });
    label.textContent = `总长 ${formatDistance(total)}`;
  }
}

function scheduleMeasureDraw() {
  if (state.measureFrame !== null) return;
  state.measureFrame = requestAnimationFrame(() => {
    state.measureFrame = null;
    renderMeasureOverlay();
  });
}

/** 把 Mapbox 地图的点击 / 视野变化接到测量工具上。 */
function attachMeasureMapEvents() {
  const map = mapboxMap();
  if (!map) return false;
  if (map.__measureBound) return true;
  map.__measureBound = true;
  map.on('click', onMeasureMapClick);
  map.on('move', scheduleMeasureDraw);
  map.on('resize', scheduleMeasureDraw);
  map.once('idle', scheduleMeasureDraw);
  // 测量时双击会连发两次 click，先关掉双击缩放，避免叠点和误缩放
  if (state.measure.active) map.doubleClickZoom.disable();
  scheduleMeasureDraw();
  return true;
}

/** 地图可能刚重建，Mapbox 实例晚一帧才可用时再补一次绑定。 */
function ensureMeasureMapEvents() {
  if (attachMeasureMapEvents()) return;
  requestAnimationFrame(() => {
    if (attachMeasureMapEvents()) return;
    setTimeout(() => attachMeasureMapEvents(), 300);
  });
}

function onMeasureMapClick(event) {
  if (!state.measure.active) return;
  const lat = event.lngLat.lat;
  const lon = event.lngLat.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  // 存 WGS84；高德 / Google 底图上的点击先做 GCJ-02 → WGS84
  const [wgsLat, wgsLon] = GCJ02_SOURCES.has(state.mapSource)
    ? gcj02ToWgs84(lat, lon)
    : [lat, lon];
  // 双击会连发两次 click，别在同一个位置叠两个点
  const last = state.measure.points[state.measure.points.length - 1];
  if (last && haversine(last.lat, last.lon, wgsLat, wgsLon) < 0.05) return;
  state.measure.points.push({ lat: wgsLat, lon: wgsLon });
  renderMeasureOverlay();
  updateMeasureReadout();
}

function setMeasuring(active) {
  if (active && !state.mapReady) {
    toast('请先加载 NMEA 文件，再在地图上测量距离', true);
    return;
  }
  state.measure.active = Boolean(active);
  const map = mapboxMap();
  if (map) {
    if (state.measure.active) map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
  }
  if (state.measure.active) {
    hideTrackHover();
    ensureMeasureMapEvents();
  }
  setMapCursor(state.measure.active ? 'crosshair' : mapIdleCursor());
  updateMeasureReadout();
}

function applyMeasureWindowPos() {
  const element = dom.measureWindow;
  if (!element || element.hidden) return;
  const rect = element.getBoundingClientRect();
  const width = rect.width || 232;
  const height = rect.height || 120;
  const pos = state.measure.pos;
  const left = Math.max(0, Math.min(pos ? pos.x : 12, window.innerWidth - width));
  const top = Math.max(0, Math.min(
    pos ? pos.y : window.innerHeight - height - 68,
    window.innerHeight - height,
  ));
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
  element.style.right = 'auto';
  element.style.bottom = 'auto';
}

function rememberMeasurePos() {
  if (!dom.measureWindow) return;
  const rect = dom.measureWindow.getBoundingClientRect();
  state.measure.pos = { x: Math.round(rect.left), y: Math.round(rect.top) };
  saveMeasurePos();
}

function setMeasureWindowOpen(open) {
  if (open && !state.mapReady) {
    toast('请先加载 NMEA 文件，再在地图上测距', true);
    return;
  }
  state.measure.open = Boolean(open);
  if (!dom.measureWindow) return;
  dom.measureWindow.hidden = !state.measure.open;
  if (state.measure.open) {
    applyMeasureWindowPos();
    setMeasuring(true);
    renderMeasureOverlay();
  } else {
    setMeasuring(false);
  }
  updateMeasureReadout();
}

function resetMeasurement() {
  if (state.measure.open) setMeasureWindowOpen(false);
  state.measure.points = [];
  state.measure.active = false;
  const map = mapboxMap();
  if (map) map.doubleClickZoom.enable();
  renderMeasureOverlay();
  updateMeasureReadout();
  setMapCursor('');
}

/* ------------------------------------------------------------------ *
 * 地图点标记：轨迹点 / 起点 / 终点 / 当前位置
 *
 * 轨迹点需要支持形状选择，而 Plotly + 内联 mapbox style 的 symbol 图层
 * 依赖 sprite，非 circle 的标记会静默不显示；这里改成在 canvas 覆盖层上
 * 自己画（起点 / 终点 / 当前位置也一起画，保证层级正确）。
 * 对应 Plotly trace 仍保留但设为隐藏，用来维持 trace 下标稳定。
 * ------------------------------------------------------------------ */
function markerShape(value) {
  return TRACK_SHAPE_VALUES.has(value) ? value : 'circle';
}

function prepareMarkerCanvas(canvas) {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  return { ctx, rect };
}

/** 往 Path2D 里追加一个标记形状，x/y 是覆盖层的 CSS 像素坐标。 */
function appendMarkerShape(path, shape, x, y, size) {
  const r = size / 2;
  switch (shape) {
    case 'square':
      path.rect(x - r, y - r, size, size);
      break;
    case 'triangle':
      path.moveTo(x, y - r);
      path.lineTo(x + r * 0.95, y + r * 0.82);
      path.lineTo(x - r * 0.95, y + r * 0.82);
      path.closePath();
      break;
    case 'diamond':
      path.moveTo(x, y - r);
      path.lineTo(x + r, y);
      path.lineTo(x, y + r);
      path.lineTo(x - r, y);
      path.closePath();
      break;
    case 'star': {
      const inner = r * 0.45;
      for (let i = 0; i < 10; i += 1) {
        const radius = i % 2 === 0 ? r : inner;
        const angle = -Math.PI / 2 + (i * Math.PI) / 5;
        const px = x + Math.cos(angle) * radius;
        const py = y + Math.sin(angle) * radius;
        if (i === 0) path.moveTo(px, py);
        else path.lineTo(px, py);
      }
      path.closePath();
      break;
    }
    case 'cross':
      path.rect(x - r, y - r * 0.3, size, r * 0.6);
      path.rect(x - r * 0.3, y - r, r * 0.6, size);
      break;
    case 'x': {
      const half = r * 0.82;
      const thick = r * 0.28;
      for (const angle of [Math.PI / 4, -Math.PI / 4]) {
        const ux = Math.cos(angle);
        const uy = Math.sin(angle);
        const vx = -uy;
        const vy = ux;
        const ax = x + ux * half;
        const ay = y + uy * half;
        const bx = x - ux * half;
        const by = y - uy * half;
        path.moveTo(ax + vx * thick, ay + vy * thick);
        path.lineTo(ax - vx * thick, ay - vy * thick);
        path.lineTo(bx - vx * thick, by - vy * thick);
        path.lineTo(bx + vx * thick, by + vy * thick);
        path.closePath();
      }
      break;
    }
    default:
      path.moveTo(x + r, y);
      path.arc(x, y, r, 0, Math.PI * 2);
      path.closePath();
      break;
  }
}

/** 与测量覆盖层一样，把地图容器坐标换算到覆盖层坐标。 */
function markerOverlayOffset(canvas, rect) {
  const map = mapboxMap();
  if (!map) return null;
  const mapRect = map.getContainer().getBoundingClientRect();
  return {
    map,
    dx: mapRect.left - rect.left,
    dy: mapRect.top - rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function renderMarkerBase() {
  const prepared = prepareMarkerCanvas(dom.markerBaseOverlay);
  if (!prepared) return;
  const { ctx, rect } = prepared;
  const info = markerOverlayOffset(dom.markerBaseOverlay, rect);
  if (!info) return;
  const { map, dx, dy, width, height } = info;

  const trackStyle = layerStyle('track');
  const startStyle = layerStyle('start');
  const endStyle = layerStyle('end');

  if (trackStyle.visible) {
    for (const dataset of state.datasets) {
      if (!dataset.visible) continue;
      const track = visibleTrack(dataset);
      if (!track.lat.length) continue;
      const size = datasetPointSize(dataset);
      const shape = datasetPointShape(dataset);
      const radius = size / 2;
      const path = new Path2D();
      for (let i = 0; i < track.lat.length; i += 1) {
        const point = map.project([track.lon[i], track.lat[i]]);
        const x = point.x + dx;
        const y = point.y + dy;
        if (x < -radius || x > width + radius || y < -radius || y > height + radius) continue;
        appendMarkerShape(path, shape, x, y, size);
      }
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = dataset.color;
      ctx.fill(path);
      ctx.globalAlpha = 1;
    }
  }

  // 起点 / 终点画在轨迹点上面
  ctx.globalAlpha = 1;
  for (const dataset of state.datasets) {
    if (!dataset.visible) continue;
    const display = displayTrack(dataset);
    if (!display.lat.length) continue;
    if (startStyle.visible) {
      const point = map.project([display.lon[0], display.lat[0]]);
      ctx.beginPath();
      ctx.arc(point.x + dx, point.y + dy, startStyle.size / 2, 0, Math.PI * 2);
      ctx.fillStyle = startStyle.color;
      ctx.fill();
    }
    if (endStyle.visible) {
      const last = display.lat.length - 1;
      const point = map.project([display.lon[last], display.lat[last]]);
      ctx.beginPath();
      ctx.arc(point.x + dx, point.y + dy, endStyle.size / 2, 0, Math.PI * 2);
      ctx.fillStyle = endStyle.color;
      ctx.fill();
    }
  }
}

function renderMarkerCurrent() {
  const prepared = prepareMarkerCanvas(dom.markerCurrentOverlay);
  if (!prepared) return;
  const { ctx, rect } = prepared;
  const info = markerOverlayOffset(dom.markerCurrentOverlay, rect);
  if (!info) return;
  const { map, dx, dy } = info;
  const style = layerStyle('current');
  if (!style.visible) return;

  for (const dataset of state.datasets) {
    if (!dataset.visible) continue;
    if (datasetState(dataset) !== 'ok') continue;
    const epoch = dataset.epochs[dataset.index];
    if (!epoch || epoch.lat === null || epoch.lon === null) continue;
    const [lat, lon] = toDisplay(epoch.lat, epoch.lon);
    if (lat === null || lon === null) continue;
    const point = map.project([lon, lat]);
    ctx.beginPath();
    ctx.arc(point.x + dx, point.y + dy, style.size / 2, 0, Math.PI * 2);
    ctx.fillStyle = dataset.color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }
}

function scheduleMarkerBase() {
  if (state.markerBaseFrame !== null) return;
  state.markerBaseFrame = requestAnimationFrame(() => {
    state.markerBaseFrame = null;
    renderMarkerBase();
  });
}

function scheduleMarkerCurrent() {
  if (state.markerCurrentFrame !== null) return;
  state.markerCurrentFrame = requestAnimationFrame(() => {
    state.markerCurrentFrame = null;
    renderMarkerCurrent();
  });
}

function scheduleMarkerDraw() {
  scheduleMarkerBase();
  scheduleMarkerCurrent();
}

function attachMarkerMapEvents() {
  const map = mapboxMap();
  if (!map) return false;
  if (map.__markerBound) return true;
  map.__markerBound = true;
  const onViewChange = () => {
    scheduleMarkerDraw();
    scheduleLockPosition();
  };
  map.on('move', () => {
    hideTrackHover();
    onViewChange();
  });
  map.on('resize', onViewChange);
  map.once('idle', onViewChange);
  // Plotly 的 Mapbox 子图默认不带双击缩放，这里恢复地图的常规行为；测距时仍关闭
  if (state.measure.active) map.doubleClickZoom.disable();
  else map.doubleClickZoom.enable();
  onViewChange();
  return true;
}

function ensureMarkerMapEvents() {
  if (attachMarkerMapEvents()) return;
  requestAnimationFrame(() => {
    if (attachMarkerMapEvents()) return;
    setTimeout(attachMarkerMapEvents, 300);
  });
}

/* ------------------------------------------------------------------ *
 * 轨迹点悬停卡片 / 锁定标记
 *
 * 悬停普通轨迹点时显示 名称 / 时间 / 水平误差 / 锁定按钮；锁定后卡片
 * 固定在该点上，随地图平移缩放重新投影；工具栏「锁定标记」一键锁定
 * 当前位置（聚焦数据集的当前历元）。
 * ------------------------------------------------------------------ */
function lockKeyFor(info) {
  return `${info.dataset.id}:${info.epochIndex}`;
}

function lockInfoFor(dataset, epochIndex) {
  if (!dataset) return null;
  const epoch = dataset.epochs[epochIndex];
  if (!epoch || epoch.lat === null || epoch.lon === null) return null;
  const stamp = epochStamp(epoch);
  const timeText = stamp !== null
    ? mapClockText(stamp, epoch.time || '—')
    : (epoch.time || '—');
  return {
    dataset,
    epochIndex,
    lat: epoch.lat,
    lon: epoch.lon,
    timeText,
    key: `${dataset.id}:${epochIndex}`,
  };
}

function lockErrorText(info) {
  const reference = referenceDataset();
  if (!reference) return null;
  if (reference === info.dataset) return '基准';
  const error = datasetHorizontalError(info.dataset, info.epochIndex);
  return error === null ? '基准无覆盖' : `${fmt(error, 2)} m`;
}

/** 悬停卡片上的「切换此点」：把当前时刻切到该轨迹点。 */
function switchToTrackPoint(info) {
  if (!info) return;
  const seconds = datasetOffset(info.dataset) + info.dataset.times[info.epochIndex];
  if (!Number.isFinite(seconds)) return;
  seekTo(seconds, { followWindow: false });
}

function addLockRow(card, label, value) {
  const row = document.createElement('div');
  row.className = 'map-lock-row';
  const key = document.createElement('span');
  key.textContent = label;
  const text = document.createElement('b');
  text.textContent = value;
  row.append(key, text);
  card.appendChild(row);
}

function buildLockCard(card, info, locked, onAction) {
  card.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'map-lock-head';
  const dot = document.createElement('span');
  dot.className = 'map-lock-dot';
  dot.style.background = info.dataset.color;
  const name = document.createElement('span');
  name.className = 'map-lock-name';
  name.textContent = info.dataset.name;
  name.title = info.dataset.name;
  head.append(dot, name);
  if (locked) {
    const tag = document.createElement('span');
    tag.className = 'map-lock-tag';
    tag.textContent = '已锁定';
    head.appendChild(tag);
  }
  card.appendChild(head);

  addLockRow(card, '时间', info.timeText);
  const errorText = lockErrorText(info);
  if (errorText !== null) addLockRow(card, '误差', errorText);

  const actions = document.createElement('div');
  actions.className = 'map-lock-actions';
  if (!locked) {
    const switchButton = document.createElement('button');
    switchButton.type = 'button';
    switchButton.className = 'map-lock-action';
    switchButton.textContent = '切换此点';
    switchButton.title = '把当前时刻切换到该轨迹点';
    switchButton.addEventListener('click', (event) => {
      event.stopPropagation();
      switchToTrackPoint(info);
    });
    actions.appendChild(switchButton);
  }
  const action = document.createElement('button');
  action.type = 'button';
  action.className = locked ? 'map-lock-action' : 'map-lock-action primary';
  action.textContent = locked ? '取消' : '锁定';
  action.title = locked ? '取消锁定' : '锁定这个轨迹点';
  action.addEventListener('click', (event) => {
    event.stopPropagation();
    onAction();
  });
  actions.appendChild(action);
  card.appendChild(actions);
}

function positionLockItem(item, lat, lon, map, dx, dy, width) {
  const [displayLat, displayLon] = toDisplay(lat, lon);
  if (displayLat === null || displayLon === null) {
    item.hidden = true;
    return;
  }
  const point = map.project([displayLon, displayLat]);
  const x = point.x + dx;
  const y = point.y + dy;
  item.hidden = false;
  item.style.left = `${x}px`;
  item.style.top = `${y}px`;
  item.classList.toggle('below', y < 104);
  const half = 112;
  let shift = 0;
  if (x < half) shift = half - x;
  else if (x > width - half) shift = (width - half) - x;
  item.style.setProperty('--shift', `${Math.round(shift)}px`);
}

function lockOverlayOffset() {
  const map = mapboxMap();
  const layer = dom.mapLockLayer;
  if (!map || !layer) return null;
  const mapRect = map.getContainer().getBoundingClientRect();
  const layerRect = layer.getBoundingClientRect();
  if (layerRect.width < 1 || layerRect.height < 1) return null;
  return {
    map,
    dx: mapRect.left - layerRect.left,
    dy: mapRect.top - layerRect.top,
    width: layerRect.width,
  };
}

function positionLockCards() {
  if (!dom.mapLockList) return;
  const offset = lockOverlayOffset();
  if (!offset) {
    for (const item of dom.mapLockList.children) item.hidden = true;
    if (dom.mapTrackHover) dom.mapTrackHover.hidden = true;
    return;
  }
  for (const item of dom.mapLockList.children) {
    const lock = state.locks.find((entry) => entry.id === item.dataset.lock);
    const dataset = lock ? state.datasets.find((entry) => entry.id === lock.datasetId) : null;
    if (!lock || !dataset || !dataset.visible) {
      item.hidden = true;
      continue;
    }
    positionLockItem(item, lock.lat, lock.lon, offset.map, offset.dx, offset.dy, offset.width);
  }
  if (state.trackHover && dom.mapTrackHover && !dom.mapTrackHover.hidden) {
    const info = state.trackHover;
    if (info.dataset.visible) {
      positionLockItem(dom.mapTrackHover, info.lat, info.lon, offset.map, offset.dx, offset.dy, offset.width);
    } else {
      dom.mapTrackHover.hidden = true;
    }
  }
}

function scheduleLockPosition() {
  if (state.lockFrame !== null) return;
  state.lockFrame = requestAnimationFrame(() => {
    state.lockFrame = null;
    positionLockCards();
  });
}

function updateLockButton() {
  if (!dom.btnUnlock) return;
  const count = state.locks.length;
  dom.btnUnlock.disabled = count === 0;
  dom.btnUnlock.title = count
    ? `取消全部 ${count} 个锁定标记`
    : '当前没有锁定标记';
}

function renderLockCards() {
  if (!dom.mapLockList) return;
  dom.mapLockList.innerHTML = '';
  for (const lock of state.locks) {
    const dataset = state.datasets.find((entry) => entry.id === lock.datasetId);
    if (!dataset) continue;
    const info = lockInfoFor(dataset, lock.epochIndex);
    if (!info) continue;
    const item = document.createElement('div');
    item.className = 'map-lock-item locked';
    item.dataset.lock = lock.id;
    const pin = document.createElement('span');
    pin.className = 'map-lock-pin';
    pin.style.background = dataset.color;
    const card = document.createElement('div');
    card.className = 'map-lock-card';
    buildLockCard(card, info, true, () => removeLock(lock.id));
    item.append(pin, card);
    dom.mapLockList.appendChild(item);
  }
  updateLockButton();
  positionLockCards();
}

function addLock(info) {
  if (!info) return false;
  if (state.locks.some((lock) => lock.key === info.key)) return false;
  state.locks.push({
    id: `lock-${++state.lockSeq}`,
    key: info.key,
    datasetId: info.dataset.id,
    epochIndex: info.epochIndex,
    lat: info.lat,
    lon: info.lon,
  });
  renderLockCards();
  return true;
}

function removeLock(id) {
  const index = state.locks.findIndex((lock) => lock.id === id);
  if (index < 0) return;
  state.locks.splice(index, 1);
  renderLockCards();
}

function clearLocks() {
  if (!state.locks.length) return;
  state.locks = [];
  hideTrackHover();
  renderLockCards();
  toast('已取消全部锁定标记');
}

/** 轨迹点下标 → 历元下标（轨迹数组只保留有定位的历元）。 */
function epochIndexForTrack(dataset, trackIndex) {
  const time = dataset.track.time[trackIndex];
  if (!Number.isFinite(time)) return -1;
  const index = lowerBound(dataset.times, time);
  if (index < dataset.times.length && Math.abs(dataset.times[index] - time) <= 1e-4) return index;
  if (index > 0 && Math.abs(dataset.times[index - 1] - time) <= 1e-4) return index - 1;
  return -1;
}

function trackPointAt(event) {
  if (!state.mapReady || state.measure.active || state.mapDrag) return null;
  if (!layerStyle('track').visible) return null;
  const map = mapboxMap();
  if (!map) return null;
  const rect = map.getContainer().getBoundingClientRect();
  const px = event.clientX - rect.left;
  const py = event.clientY - rect.top;
  let best = null;
  for (const dataset of state.datasets) {
    if (!dataset.visible) continue;
    const display = displayTrack(dataset);
    const [first, last] = windowSlice(dataset);
    if (last <= first) continue;
    const radius = Math.max(8, datasetPointSize(dataset) / 2 + 3);
    const radius2 = radius * radius;
    for (let i = first; i < last; i += 1) {
      const point = map.project([display.lon[i], display.lat[i]]);
      const dx = point.x - px;
      const dy = point.y - py;
      const distance2 = dx * dx + dy * dy;
      if (distance2 > radius2) continue;
      if (best && distance2 >= best.distance2) continue;
      const epochIndex = epochIndexForTrack(dataset, i);
      if (epochIndex < 0) continue;
      best = { dataset, epochIndex, distance2 };
    }
  }
  return best;
}

function showTrackHover(info) {
  if (!info || !dom.mapTrackHover) return;
  clearTimeout(state.trackHoverTimer);
  state.trackHoverTimer = null;
  if (state.locks.some((lock) => lock.key === info.key)) {
    hideTrackHover();
    return;
  }
  state.trackHover = info;
  const pin = dom.mapTrackHover.querySelector('.map-lock-pin');
  if (pin) pin.style.background = info.dataset.color;
  const card = dom.mapTrackHover.querySelector('.map-lock-card');
  if (card) {
    buildLockCard(card, info, false, () => {
      addLock(info);
      hideTrackHover();
    });
  }
  dom.mapTrackHover.hidden = false;
  positionLockCards();
}

function hideTrackHover(delay = 0) {
  clearTimeout(state.trackHoverTimer);
  state.trackHoverTimer = null;
  const hide = () => {
    state.trackHover = null;
    if (dom.mapTrackHover) dom.mapTrackHover.hidden = true;
  };
  if (delay > 0) {
    state.trackHoverTimer = setTimeout(hide, delay);
  } else {
    hide();
  }
}

function updateTrackHover(event) {
  if (state.measure.active || state.mapDrag) {
    hideTrackHover();
    return;
  }
  const hit = trackPointAt(event);
  if (!hit) {
    hideTrackHover(220);
    return;
  }
  if (state.locks.some((lock) => lock.key === `${hit.dataset.id}:${hit.epochIndex}`)) {
    hideTrackHover();
    return;
  }
  const info = lockInfoFor(hit.dataset, hit.epochIndex);
  if (!info) {
    hideTrackHover();
    return;
  }
  if (state.trackHover && state.trackHover.key === info.key) {
    clearTimeout(state.trackHoverTimer);
    state.trackHoverTimer = null;
    return;
  }
  showTrackHover(info);
}

/* ------------------------------------------------------------------ *
 * 地图图例 / 样式面板
 * ------------------------------------------------------------------ */
function cloneDefaultLayerStyle() {
  const styles = {};
  for (const meta of MAP_LAYER_META) {
    styles[meta.key] = { ...DEFAULT_LAYER_STYLE[meta.key] };
  }
  return styles;
}

function loadLayerStyle() {
  const styles = cloneDefaultLayerStyle();
  try {
    const saved = JSON.parse(localStorage.getItem(LAYER_STYLE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return styles;
    for (const meta of MAP_LAYER_META) {
      const value = saved[meta.key];
      if (!value || typeof value !== 'object') continue;
      const target = styles[meta.key];
      if (typeof value.color === 'string' && /^#[0-9a-f]{6}$/i.test(value.color)) {
        target.color = value.color;
      }
      const size = Number(value.size);
      if (Number.isFinite(size)) target.size = Math.min(meta.max, Math.max(meta.min, size));
      // 旧版「基准连线」默认 1.5 px 太细，升级后统一换成新默认
      if (meta.key === 'offset' && target.size === 1.5) {
        target.size = DEFAULT_LAYER_STYLE.offset.size;
      }
      if (typeof value.visible === 'boolean') target.visible = value.visible;
      if (Array.isArray(meta.shapes) && typeof value.shape === 'string'
        && meta.shapes.some((shape) => shape.value === value.shape)) {
        target.shape = value.shape;
      }
    }
  } catch (error) {
    // 本地设置损坏或 localStorage 不可用时退回默认样式
  }
  return styles;
}

function saveLayerStyle() {
  try {
    localStorage.setItem(LAYER_STYLE_KEY, JSON.stringify(state.layerStyle));
  } catch (error) {
    // 隐私模式等场景下 localStorage 可能不可用，忽略即可
  }
}

function formatLayerSize(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function layerPreviewStyle(meta, style) {
  // 轨迹线 / 轨迹点 / 当前位置的颜色跟随数据集，预览用第一条数据的颜色；
  // 「基准连线」的颜色跟随对比轨迹，预览用当前聚焦的对比数据（没有则取第一条非基准）
  let color;
  if (meta.key === 'offset') {
    const reference = referenceDataset();
    const focus = focusDataset();
    const comparison = focus && focus !== reference
      ? focus
      : state.datasets.find((dataset) => dataset !== reference);
    color = (comparison && comparison.color) || style.color;
  } else {
    color = meta.colorSource === 'dataset'
      ? ((state.datasets[0] && state.datasets[0].color) || style.color)
      : style.color;
  }
  if (meta.type === 'line') {
    return `--c:${color};--w:${Math.max(1, Math.min(6, style.size))}px`;
  }
  return `--c:${color};--s:${Math.max(5, Math.min(13, style.size))}px`;
}

function buildMapLegend() {
  buildDatasetLegend();
  buildLayerLegend();
  buildLegendDisplayOptions();
  renderLegendWindow();
  applyLegendWindowVisibility();
}

/* ------------------------------------------------------------------ *
 * 图例样式 / 图例浮窗
 * ------------------------------------------------------------------ */
function legendClamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function applyLegendStyleRect() {
  const element = dom.legendStyleWindow;
  if (!element) return;
  const saved = state.legend.styleRect;
  const width = legendClamp(saved ? saved.w : 320, 280, window.innerWidth - 16);
  const height = legendClamp(
    saved ? saved.h : Math.min(540, Math.max(260, window.innerHeight - 130)),
    240, window.innerHeight - 16,
  );
  const x = legendClamp(saved ? saved.x : Math.min(300, window.innerWidth - width - 8), 0, window.innerWidth - width);
  const y = legendClamp(saved ? saved.y : 116, 0, window.innerHeight - height);
  element.style.left = `${x}px`;
  element.style.top = `${y}px`;
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
  element.style.right = 'auto';
  element.style.bottom = 'auto';
}

function applyLegendWindowPos() {
  const element = dom.legendWindow;
  if (!element || element.hidden) return;
  const rect = element.getBoundingClientRect();
  const width = rect.width || 236;
  const height = rect.height || 120;
  const pos = state.legend.legendPos;
  element.style.left = `${legendClamp(pos ? pos.x : 12, 0, window.innerWidth - width)}px`;
  element.style.top = `${legendClamp(pos ? pos.y : 116, 0, window.innerHeight - height)}px`;
  element.style.right = 'auto';
  element.style.bottom = 'auto';
}

function applyLegendWindowVisibility() {
  const visible = Boolean(state.legend.display.visible);
  if (dom.legendWindow) dom.legendWindow.hidden = !visible;
  if (dom.legendDisplayVisible) dom.legendDisplayVisible.checked = visible;
  if (visible) {
    applyLegendWindowPos();
    renderLegendWindow();
  }
}

function setLegendStyleOpen(open) {
  state.legend.styleOpen = Boolean(open);
  if (!dom.legendStyleWindow || !dom.btnLegend) return;
  dom.legendStyleWindow.hidden = !state.legend.styleOpen;
  dom.btnLegend.setAttribute('aria-pressed', String(state.legend.styleOpen));
  if (state.legend.styleOpen) {
    applyLegendStyleRect();
    renderLegendWindow();
  }
}

function rememberLegendStyleRect() {
  if (!dom.legendStyleWindow) return;
  const rect = dom.legendStyleWindow.getBoundingClientRect();
  state.legend.styleRect = {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
  };
  saveLegendConfig();
}

function rememberLegendPos() {
  if (!dom.legendWindow) return;
  const rect = dom.legendWindow.getBoundingClientRect();
  state.legend.legendPos = { x: Math.round(rect.left), y: Math.round(rect.top) };
  saveLegendConfig();
}

function attachLegendStyleResize() {
  const element = dom.legendStyleWindow;
  const handle = element && element.querySelector('.float-resize');
  if (!handle || handle.__resizeBound) return;
  handle.__resizeBound = true;
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = element.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = rect.width;
    const startHeight = rect.height;

    const onMove = (moveEvent) => {
      const width = legendClamp(startWidth + moveEvent.clientX - startX, 280, window.innerWidth - rect.left - 4);
      const height = legendClamp(startHeight + moveEvent.clientY - startY, 240, window.innerHeight - rect.top - 4);
      element.style.width = `${width}px`;
      element.style.height = `${height}px`;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      rememberLegendStyleRect();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

function buildLegendDisplayOptions() {
  if (!dom.legendDisplayOptions) return;
  dom.legendDisplayOptions.innerHTML = '';
  for (const item of LEGEND_DISPLAY_ITEMS) {
    const label = document.createElement('label');
    label.className = 'legend-option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(state.legend.display[item.key]);
    input.addEventListener('change', () => {
      state.legend.display[item.key] = input.checked;
      saveLegendConfig();
      renderLegendWindow();
    });
    label.append(input, document.createTextNode(item.label));
    dom.legendDisplayOptions.appendChild(label);
  }
  if (dom.legendDisplayVisible) {
    dom.legendDisplayVisible.checked = Boolean(state.legend.display.visible);
  }
}

function drawLegendPoint(canvas, dataset) {
  const cssSize = 20;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssSize * dpr);
  canvas.height = Math.round(cssSize * dpr);
  canvas.style.width = `${cssSize}px`;
  canvas.style.height = `${cssSize}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssSize, cssSize);
  const size = Math.min(16, Math.max(6, datasetPointSize(dataset)));
  const path = new Path2D();
  appendMarkerShape(path, datasetPointShape(dataset), cssSize / 2, cssSize / 2, size);
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = dataset.color;
  ctx.fill(path);
}

function renderLegendWindow() {
  const root = dom.legendDisplay;
  if (!root) return;
  root.innerHTML = '';
  if (!state.datasets.length) {
    const empty = document.createElement('div');
    empty.className = 'legend-display-empty';
    empty.textContent = '未加载数据';
    root.appendChild(empty);
    return;
  }

  const display = state.legend.display;
  let rows = 0;
  if (display.datasets) {
    const group = document.createElement('div');
    group.className = 'legend-display-group';
    for (const dataset of state.datasets) {
      const row = document.createElement('div');
      row.className = 'legend-display-item';
      row.classList.toggle('off', !dataset.visible);
      const swatch = document.createElement('span');
      swatch.className = 'legend-display-swatch';
      swatch.style.background = dataset.color;
      const name = document.createElement('span');
      name.className = 'legend-display-name';
      name.textContent = dataset.name;
      name.title = dataset.name;
      row.append(swatch, name);
      if (display.line) {
        const line = document.createElement('span');
        line.className = 'legend-display-line';
        line.style.cssText = `--c:${dataset.color};--w:${datasetLineWidth(dataset)}px`;
        row.appendChild(line);
      }
      if (display.track) {
        const point = document.createElement('canvas');
        point.className = 'legend-display-point';
        row.appendChild(point);
        drawLegendPoint(point, dataset);
      }
      group.appendChild(row);
      rows += 1;
    }
    root.appendChild(group);
  }

  const common = [];
  const startStyle = layerStyle('start');
  const endStyle = layerStyle('end');
  const currentStyle = layerStyle('current');
  if (display.start) {
    common.push({
      label: '起点',
      preview: (() => {
        const dot = document.createElement('span');
        dot.className = 'legend-display-dot';
        dot.style.cssText = `--c:${startStyle.color};--s:${startStyle.size}px`;
        return dot;
      })(),
    });
  }
  if (display.end) {
    common.push({
      label: '终点',
      preview: (() => {
        const dot = document.createElement('span');
        dot.className = 'legend-display-dot';
        dot.style.cssText = `--c:${endStyle.color};--s:${endStyle.size}px`;
        return dot;
      })(),
    });
  }
  if (display.current) {
    const focus = focusDataset();
    common.push({
      label: '当前位置',
      preview: (() => {
        const dot = document.createElement('span');
        dot.className = 'legend-display-dot current';
        dot.style.cssText = `--c:${focus ? focus.color : '#f59e0b'};--s:${currentStyle.size}px`;
        return dot;
      })(),
    });
  }
  if (display.offset && referenceDataset()) {
    const reference = referenceDataset();
    const focus = focusDataset();
    const comparison = focus && focus !== reference
      ? focus
      : state.datasets.find((dataset) => dataset !== reference);
    common.push({
      label: '基准连线',
      preview: (() => {
        const line = document.createElement('span');
        line.className = 'legend-display-line';
        line.style.cssText = `--c:${comparison ? comparison.color : '#64748b'};`
          + `--w:${layerStyle('offset').size}px`;
        return line;
      })(),
    });
  }
  if (common.length) {
    const group = document.createElement('div');
    group.className = 'legend-display-group';
    for (const item of common) {
      const row = document.createElement('div');
      row.className = 'legend-display-item';
      const name = document.createElement('span');
      name.className = 'legend-display-name';
      name.textContent = item.label;
      row.append(item.preview, name);
      group.appendChild(row);
      rows += 1;
    }
    root.appendChild(group);
  }

  if (!rows) {
    const empty = document.createElement('div');
    empty.className = 'legend-display-empty';
    empty.textContent = '图例内容为空';
    root.appendChild(empty);
  }
}

function scheduleLegendWindow() {
  if (state.legendFrame !== null) return;
  state.legendFrame = requestAnimationFrame(() => {
    state.legendFrame = null;
    renderLegendWindow();
  });
}

function clampLegendWindows() {
  if (state.legend.styleOpen) applyLegendStyleRect();
  if (state.legend.display.visible) {
    applyLegendWindowPos();
  }
}

/* ---------------- 数据集图例 ---------------- */
function loadDatasetStyle() {
  try {
    const saved = JSON.parse(localStorage.getItem(DATASET_STYLE_KEY) || 'null');
    if (saved && typeof saved === 'object') return saved;
  } catch (error) {
    // 本地设置损坏时用默认配色
  }
  return {};
}

function saveDatasetStyle() {
  try {
    localStorage.setItem(DATASET_STYLE_KEY, JSON.stringify(state.datasetStyle));
  } catch (error) {
    // localStorage 不可用时忽略
  }
}

/** 同名文件重新加载时沿用上次的颜色、显隐和每条数据的线 / 点样式。 */
function datasetStyleFor(name, ordinal) {
  const saved = state.datasetStyle[name];
  const fallback = DATASET_PALETTE[ordinal % DATASET_PALETTE.length];
  const lineStyle = state.layerStyle ? state.layerStyle.line : DEFAULT_LAYER_STYLE.line;
  const trackStyle = state.layerStyle ? state.layerStyle.track : DEFAULT_LAYER_STYLE.track;
  const style = {
    color: fallback,
    visible: true,
    lineWidth: lineStyle.size,
    pointSize: trackStyle.size,
    pointShape: markerShape(trackStyle.shape),
  };
  if (saved && typeof saved === 'object') {
    if (typeof saved.color === 'string' && /^#[0-9a-f]{6}$/i.test(saved.color)) style.color = saved.color;
    if (typeof saved.visible === 'boolean') style.visible = saved.visible;
    const lineWidth = Number(saved.lineWidth);
    if (Number.isFinite(lineWidth)) style.lineWidth = Math.min(8, Math.max(1, lineWidth));
    const pointSize = Number(saved.pointSize);
    if (Number.isFinite(pointSize)) style.pointSize = Math.min(12, Math.max(2, pointSize));
    if (typeof saved.pointShape === 'string' && TRACK_SHAPE_VALUES.has(saved.pointShape)) {
      style.pointShape = saved.pointShape;
    }
  }
  // 同时存在的数据集不能同色（比如两份同名的日志）
  const used = new Set(state.datasets.map((dataset) => dataset.color));
  if (used.has(style.color)) {
    for (let step = 0; step < DATASET_PALETTE.length; step += 1) {
      const candidate = DATASET_PALETTE[(ordinal + step) % DATASET_PALETTE.length];
      if (!used.has(candidate)) {
        style.color = candidate;
        break;
      }
    }
  }
  return style;
}

function datasetLineWidth(dataset) {
  const value = Number(dataset.lineWidth);
  return Number.isFinite(value) ? Math.min(8, Math.max(1, value)) : DEFAULT_LAYER_STYLE.line.size;
}

function datasetPointSize(dataset) {
  const value = Number(dataset.pointSize);
  return Number.isFinite(value) ? Math.min(12, Math.max(2, value)) : DEFAULT_LAYER_STYLE.track.size;
}

function datasetPointShape(dataset) {
  return markerShape(dataset.pointShape || DEFAULT_LAYER_STYLE.track.shape);
}

function rememberDatasetStyle(dataset) {
  state.datasetStyle[dataset.name] = {
    color: dataset.color,
    visible: dataset.visible,
    lineWidth: datasetLineWidth(dataset),
    pointSize: datasetPointSize(dataset),
    pointShape: datasetPointShape(dataset),
  };
  saveDatasetStyle();
  scheduleLegendWindow();
}

/** 只更新一条轨迹的线宽，不重建整张地图（拖动线宽滑杆时用）。 */
function applyDatasetLineStyle(dataset) {
  if (!state.mapReady) return;
  const ordinal = datasetOrdinal(dataset);
  if (ordinal < 0) return;
  const style = layerStyle('line');
  const result = Plotly.restyle('map', {
    visible: style.visible && dataset.visible,
    'line.width': datasetLineWidth(dataset),
  }, [traceIndexFor(ordinal, 'line')]);
  if (result && typeof result.catch === 'function') result.catch(() => {});
}

function buildDatasetLegend() {
  if (!dom.legendDatasets) return;
  dom.legendDatasets.innerHTML = '';
  if (!state.datasets.length) {
    const empty = document.createElement('div');
    empty.className = 'dataset-empty';
    empty.textContent = '拖入一个或多个 NMEA 文件以开始对比';
    dom.legendDatasets.appendChild(empty);
    updateLegendWindowsButton();
    scheduleLegendWindow();
    return;
  }

  for (const dataset of state.datasets) {
    const row = document.createElement('div');
    row.className = 'dataset-row';
    row.dataset.id = dataset.id;
    row.classList.toggle('off', !dataset.visible);
    row.classList.toggle('focus', dataset.id === state.focusId);
    row.classList.toggle('reference', dataset.id === state.referenceId);
    row.title = `${dataset.name} · ${dataset.epochs.length} 个历元`;

    const eye = document.createElement('label');
    eye.className = 'dataset-eye';
    eye.title = '显示 / 隐藏这条轨迹';
    const visible = document.createElement('input');
    visible.type = 'checkbox';
    visible.checked = dataset.visible;
    eye.appendChild(visible);

    const color = document.createElement('input');
    color.type = 'color';
    color.className = 'dataset-color';
    color.value = dataset.color;
    color.title = '轨迹颜色';

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'dataset-name';
    name.textContent = dataset.name;
    name.title = '点击高亮这条数据；双击把时间窗对齐到这条数据的时段';

    const count = document.createElement('span');
    count.className = 'dataset-count';
    count.textContent = `${dataset.epochs.length}`;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'dataset-remove';
    remove.textContent = '×';
    remove.title = '移除这条数据';

    // 每条轨迹各自的星空图 / 仪表盘开关（浮窗）
    const tools = document.createElement('div');
    tools.className = 'dataset-tools';
    for (const kind of WINDOW_ORDER) {
      const open = Boolean(dataset.windows && dataset.windows[kind]);
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'win-toggle';
      toggle.dataset.kind = kind;
      toggle.textContent = WINDOW_KINDS[kind].title;
      toggle.classList.toggle('on', open);
      toggle.setAttribute('aria-pressed', String(open));
      toggle.title = `${open ? '关闭' : '打开'} ${dataset.name} 的${WINDOW_KINDS[kind].title}`;
      toggle.addEventListener('click', () => toggleDatasetWindow(dataset, kind));
      tools.appendChild(toggle);
    }

    // 水平误差基准（单选）：其他轨迹按同一时刻与它位置的直线距离对比
    const base = document.createElement('button');
    base.type = 'button';
    base.className = 'win-toggle base-toggle';
    base.textContent = '基准';
    const isReference = dataset.id === state.referenceId;
    base.classList.toggle('on', isReference);
    base.setAttribute('aria-pressed', String(isReference));
    base.title = isReference
      ? '取消基准（水平误差 = 同一时刻与基准位置的水平距离）'
      : '设为水平误差的基准';
    base.addEventListener('click', () => toggleReference(dataset));
    tools.appendChild(base);

    // 每条轨迹自己的线宽 / 点大小 / 点形状
    const styleRow = document.createElement('div');
    styleRow.className = 'dataset-style';

    const lineWrap = document.createElement('label');
    lineWrap.className = 'ds-style';
    lineWrap.title = '轨迹线宽度（本条数据）';
    const lineLabel = document.createElement('span');
    lineLabel.textContent = '线';
    const lineInput = document.createElement('input');
    lineInput.type = 'range';
    lineInput.min = '1';
    lineInput.max = '8';
    lineInput.step = '0.5';
    lineInput.value = String(datasetLineWidth(dataset));
    const lineValue = document.createElement('b');
    lineValue.textContent = formatLayerSize(datasetLineWidth(dataset));
    lineWrap.append(lineLabel, lineInput, lineValue);

    const pointWrap = document.createElement('label');
    pointWrap.className = 'ds-style';
    pointWrap.title = '轨迹点大小（本条数据）';
    const pointLabel = document.createElement('span');
    pointLabel.textContent = '点';
    const pointInput = document.createElement('input');
    pointInput.type = 'range';
    pointInput.min = '2';
    pointInput.max = '12';
    pointInput.step = '0.5';
    pointInput.value = String(datasetPointSize(dataset));
    const pointValue = document.createElement('b');
    pointValue.textContent = formatLayerSize(datasetPointSize(dataset));
    pointWrap.append(pointLabel, pointInput, pointValue);

    const shapeSelect = document.createElement('select');
    shapeSelect.className = 'dataset-shape';
    shapeSelect.title = '轨迹点形状（本条数据）';
    for (const item of TRACK_SHAPES) {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      shapeSelect.appendChild(option);
    }
    shapeSelect.value = datasetPointShape(dataset);

    styleRow.append(lineWrap, pointWrap, shapeSelect);

    row.append(eye, color, name, count, remove, tools, styleRow);
    dom.legendDatasets.appendChild(row);

    // 双击条目（不含勾选 / 颜色 / 按钮 / 样式控件）：时间窗对齐到这条数据自己的起止
    row.addEventListener('dblclick', (event) => {
      if (event.target.closest('input, label, select, .dataset-remove, .win-toggle, .dataset-style')) return;
      event.preventDefault();
      alignWindowToDataset(dataset);
    });

    visible.addEventListener('change', () => {
      dataset.visible = visible.checked;
      rememberDatasetStyle(dataset);
      row.classList.toggle('off', !dataset.visible);
      renderMap(true);
      hideTrackHover();
      scheduleLockPosition();
      buildCompareChips();
      renderCompare();
    });
    color.addEventListener('input', () => {
      dataset.color = color.value;
      rememberDatasetStyle(dataset);
      refreshWindowChrome(dataset);
      // 图层预览里的轨迹线/点颜色跟随数据集，也要一起刷新
      for (const meta of MAP_LAYER_META) {
        if (meta.colorSource === 'dataset') refreshLegendRow(meta.key);
      }
      state.mapReady = false;
      renderMap(true);
      hideTrackHover();
      renderLockCards();
      buildCompareChips();
      renderCompare();
      if (state.sat.open) {
        buildSatelliteChips();
        renderSatellite();
      }
    });
    lineInput.addEventListener('input', () => {
      dataset.lineWidth = Number(lineInput.value);
      lineValue.textContent = formatLayerSize(datasetLineWidth(dataset));
      rememberDatasetStyle(dataset);
      applyDatasetLineStyle(dataset);
    });
    pointInput.addEventListener('input', () => {
      dataset.pointSize = Number(pointInput.value);
      pointValue.textContent = formatLayerSize(datasetPointSize(dataset));
      rememberDatasetStyle(dataset);
      scheduleMarkerBase();
    });
    shapeSelect.addEventListener('change', () => {
      dataset.pointShape = markerShape(shapeSelect.value);
      rememberDatasetStyle(dataset);
      scheduleMarkerBase();
    });
    name.addEventListener('click', () => setFocus(dataset.id));
    remove.addEventListener('click', () => removeDataset(dataset.id));
  }
  updateLegendWindowsButton();
  scheduleLegendWindow();
}

/** 数据集换色时，同步浮窗标题色点、指南针指针与仪表盘配色。 */
function refreshWindowChrome(dataset) {
  if (!dataset.windows) return;
  for (const kind of WINDOW_ORDER) {
    const win = dataset.windows[kind];
    if (!win) continue;
    const dot = win.el.querySelector('.win-dot');
    if (dot) dot.style.background = dataset.color;
    if (win.compass) {
      const north = win.compass.needle.firstElementChild;
      if (north) north.setAttribute('fill', dataset.color);
    }
    if (kind === 'dash') renderDashWindow(win);
  }
}

/* ---------------- 图层样式（大小 / 起点终点颜色） ---------------- */
function buildLayerLegend() {
  if (!dom.legendRows) return;
  dom.legendRows.innerHTML = '';
  const hasReference = Boolean(referenceDataset());
  for (const meta of MAP_LAYER_META) {
    // 「基准连线」只有在选了基准之后才有意义
    if (meta.key === 'offset' && !hasReference) continue;
    const style = layerStyle(meta.key);
    const row = document.createElement('div');
    row.className = 'legend-row';
    row.dataset.layer = meta.key;
    row.classList.toggle('off', !style.visible);

    const eye = document.createElement('label');
    eye.className = 'legend-eye';
    eye.title = `显示 / 隐藏${meta.name}`;
    const visible = document.createElement('input');
    visible.type = 'checkbox';
    visible.checked = style.visible;
    eye.appendChild(visible);

    const color = document.createElement('input');
    color.type = 'color';
    color.className = 'legend-color';
    color.value = style.color;
    color.title = `${meta.name}颜色`;

    const name = document.createElement('span');
    name.className = 'legend-name';
    name.textContent = meta.name;

    // 轨迹线 / 轨迹点的宽度、大小、形状在每条数据的图例行里单独设置，
    // 这里只保留一个总开关，避免和下面的「每条数据单独」控件重复。
    if (meta.key === 'line' || meta.key === 'track') {
      row.classList.add('per-dataset');
      const hint = document.createElement('span');
      hint.className = 'legend-hint';
      hint.textContent = '每条数据单独';
      row.append(eye, name, hint);
      dom.legendRows.appendChild(row);
      visible.addEventListener('change', () => {
        setLayerStyle(meta.key, { visible: visible.checked });
      });
      continue;
    }

    const preview = document.createElement('span');
    preview.className = `legend-preview ${meta.type}`;
    preview.style.cssText = layerPreviewStyle(meta, style);

    const range = document.createElement('label');
    range.className = 'legend-range';
    range.title = meta.key === 'offset'
      ? '基准连线宽度'
      : meta.type === 'line' ? '轨迹线宽度' : `${meta.name}大小`;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(meta.min);
    slider.max = String(meta.max);
    slider.step = String(meta.step);
    slider.value = String(style.size);
    const value = document.createElement('span');
    value.className = 'legend-value';
    value.textContent = formatLayerSize(style.size);
    range.append(slider, value);

    if (meta.colorSource === 'dataset') {
      // 颜色跟随数据集图例，这里不放颜色控件（避免多占一列把名字挤没）
      row.classList.add('follows-dataset');
      name.title = meta.key === 'offset'
        ? '颜色跟随各条对比轨迹；预览显示当前聚焦的对比数据'
        : '颜色跟随上方数据集';
    }

    row.append(eye, name, preview, range);
    if (meta.colorSource !== 'dataset') row.insertBefore(color, name);
    dom.legendRows.appendChild(row);

    visible.addEventListener('change', () => {
      setLayerStyle(meta.key, { visible: visible.checked });
    });
    if (meta.colorSource !== 'dataset') {
      color.addEventListener('input', () => {
        setLayerStyle(meta.key, { color: color.value });
      });
    }
    slider.addEventListener('input', () => {
      setLayerStyle(meta.key, { size: Number(slider.value) });
    });
  }
  scheduleLegendWindow();
}

function refreshLegendRow(layer) {
  if (!dom.legendRows) return;
  const meta = MAP_LAYER_META.find((item) => item.key === layer);
  const row = dom.legendRows.querySelector(`.legend-row[data-layer="${layer}"]`);
  if (!meta || !row) return;
  const style = layerStyle(layer);
  row.classList.toggle('off', !style.visible);
  if (meta.key === 'line' || meta.key === 'track') return;
  if (meta.colorSource !== 'dataset') row.querySelector('.legend-color').value = style.color;
  row.querySelector('.legend-preview').style.cssText = layerPreviewStyle(meta, style);
  row.querySelector('.legend-range input').value = String(style.size);
  row.querySelector('.legend-value').textContent = formatLayerSize(style.size);
}

function applyLayerStyle(layer) {
  if (!state.mapReady || !state.datasets.length) return;
  const style = layerStyle(layer);
  // 轨迹点 / 起点 / 终点 / 当前位置由 canvas 覆盖层绘制，Plotly trace 始终隐藏
  if (layer === 'track') {
    if (!style.visible) hideTrackHover();
    scheduleMarkerBase();
    scheduleLegendWindow();
    return;
  }
  if (layer === 'start' || layer === 'end' || layer === 'current') {
    scheduleMarkerDraw();
    scheduleLegendWindow();
    return;
  }
  const indices = state.datasets.map((dataset, ordinal) => traceIndexFor(ordinal, layer));
  const visible = state.datasets.map((dataset) => style.visible && dataset.visible);

  if (layer === 'offset') {
    // 用 opacity 控制显示 / 隐藏，保持 layer 存在（见 mapOffsetTrace 的说明）
    Plotly.restyle('map', {
      opacity: state.datasets.map((dataset) => (style.visible && dataset.visible ? 0.9 : 0)),
      'line.width': style.size,
      'line.color': state.datasets.map((dataset) => dataset.color),
    }, indices);
    scheduleLegendWindow();
    return;
  }
  if (layer === 'line') {
    Plotly.restyle('map', {
      visible,
      'line.width': state.datasets.map((dataset) => datasetLineWidth(dataset)),
      'line.color': state.datasets.map((dataset) => dataset.color),
    }, indices);
  }
  scheduleLegendWindow();
}

function scheduleLayerStyle(layer) {
  state.pendingStyleLayers.add(layer);
  if (state.styleFrame !== null) return;
  state.styleFrame = requestAnimationFrame(() => {
    state.styleFrame = null;
    const layers = [...state.pendingStyleLayers];
    state.pendingStyleLayers.clear();
    for (const key of layers) applyLayerStyle(key);
  });
}

function setLayerStyle(layer, patch) {
  if (!state.layerStyle) state.layerStyle = cloneDefaultLayerStyle();
  Object.assign(state.layerStyle[layer], patch);
  saveLayerStyle();
  refreshLegendRow(layer);
  scheduleLayerStyle(layer);
}

function resetLayerStyle() {
  state.layerStyle = cloneDefaultLayerStyle();
  saveLayerStyle();
  buildLayerLegend();
  for (const meta of MAP_LAYER_META) applyLayerStyle(meta.key);
  toast('地图图层样式已恢复默认');
}

/* ------------------------------------------------------------------ *
 * 星空图
 * ------------------------------------------------------------------ */
/**
 * 可选的 `sky_split.json`：每个历元两条边界曲线（半宽随仰角变化）以及
 * 每颗卫星的直射概率。它不是页面运行的必要文件；存在时把星空图叠加成
 *  - 直射带填充（青色扇形）
 *  - 东 / 西两条边界曲线（实线 = 当前历元，虚线 = 全程估计）
 *  - 判为非直射卫星的红色圆环
 */
function splitAvailable(dataset) {
  const split = state.split;
  if (!split || !dataset || dataset.showSplit === false) return false;
  if (!split.epochs || !split.epochs.length) return false;
  if (!split.knots || !split.orientation || !split.global) return false;
  if (split.epochCount !== dataset.epochs.length) return false;
  const epoch = dataset.epochs[dataset.index];
  const saved = split.epochTimes && split.epochTimes[dataset.index];
  return !epoch || !saved || !epoch.time || saved === epoch.time;
}

function splitCurves(dataset) {
  const split = state.split;
  if (!split || !dataset) return null;
  return split.epochs[dataset.index] || null;
}

/** 极坐标下“扇形”多边形的顶点：两条边界 + 地平线弧。 */
function bandPolygon(center, west, east, knots) {
  const normalize = (value) => ((value % 360) + 360) % 360;
  const theta = [];
  const r = [];
  for (let i = 0; i < knots.length; i += 1) {
    theta.push(normalize(center - west[i]));
    r.push(90 - knots[i]);
  }
  for (let i = knots.length - 1; i >= 0; i -= 1) {
    theta.push(normalize(center + east[i]));
    r.push(90 - knots[i]);
  }
  const start = normalize(center + east[0]);
  let end = normalize(center - west[0]);
  if (end > start) end -= 360;
  for (let i = 1; i < 24; i += 1) {
    theta.push(normalize(start + ((end - start) * i) / 24));
    r.push(90);
  }
  return { theta, r };
}

function splitTraces(dataset) {
  if (!splitAvailable(dataset)) return [];
  const curves = splitCurves(dataset);
  if (!curves) return [];
  const { centerAzimuth, halfWidth } = state.split.orientation;
  const knots = state.split.knots;
  const polygon = bandPolygon(centerAzimuth, curves.west, curves.east, knots);
  const global = state.split.global;
  const radius = knots.map((value) => 90 - value);
  const boundaryTheta = (values, sign) => values.map((value) => (
    ((centerAzimuth + sign * value) % 360 + 360) % 360));

  return [
    {
      type: 'scatterpolar',
      mode: 'lines',
      fill: 'toself',
      fillcolor: 'rgba(13, 148, 136, 0.10)',
      line: { width: 0 },
      r: polygon.r,
      theta: polygon.theta,
      hoverinfo: 'skip',
      name: '直射带',
    },
    {
      type: 'scatterpolar',
      mode: 'lines',
      r: radius,
      theta: boundaryTheta(curves.west, -1),
      line: { color: '#0f766e', width: 2 },
      hoverinfo: 'skip',
      name: '西边界',
    },
    {
      type: 'scatterpolar',
      mode: 'lines',
      r: radius,
      theta: boundaryTheta(curves.east, 1),
      line: { color: '#0f766e', width: 2 },
      hoverinfo: 'skip',
      name: '东边界',
    },
    {
      type: 'scatterpolar',
      mode: 'lines',
      r: radius,
      theta: boundaryTheta(global.west, -1),
      line: { color: '#94a3b8', width: 1, dash: 'dot' },
      hoverinfo: 'skip',
      name: '全程西边界',
    },
    {
      type: 'scatterpolar',
      mode: 'lines',
      r: radius,
      theta: boundaryTheta(global.east, 1),
      line: { color: '#94a3b8', width: 1, dash: 'dot' },
      hoverinfo: 'skip',
      name: '全程东边界',
    },
    {
      type: 'scatterpolar',
      mode: 'lines',
      r: [0, 90],
      theta: [centerAzimuth, centerAzimuth],
      line: { color: '#0f766e', width: 1, dash: 'dash' },
      hoverinfo: 'skip',
      name: `朝向 ${centerAzimuth.toFixed(1)}°`,
    },
  ];
}

function skyLayout(hasSatellites = true, message = null) {
  return {
    margin: { l: 46, r: 34, t: 16, b: 22 },
    paper_bgcolor: '#ffffff',
    plot_bgcolor: '#ffffff',
    showlegend: false,
    // 越界 / 该历元没有 GSV 语句时给一句说明，避免误以为是渲染失败
    annotations: message
      ? [{
        text: message,
        xref: 'paper',
        yref: 'paper',
        x: 0.5,
        y: 0.5,
        showarrow: false,
        font: { size: 11, color: '#b45309' },
      }]
      : (hasSatellites ? [] : [{
        text: '该历元无 GSV 数据',
        xref: 'paper',
        yref: 'paper',
        x: 0.5,
        y: 0.5,
        showarrow: false,
        font: { size: 11, color: '#94a3b8' },
      }]),
    polar: {
      bgcolor: '#ffffff',
      angularaxis: {
        direction: 'clockwise',
        rotation: 90,
        tickvals: [0, 45, 90, 135, 180, 225, 270, 315],
        ticktext: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'],
        tickfont: { size: 9, color: '#475569' },
        gridcolor: '#e2e8f0',
        linecolor: '#cbd5e1',
      },
      radialaxis: {
        range: [0, 90],
        tickvals: [0, 45, 90],
        ticktext: ['90°', '45°', '0°'],
        tickfont: { size: 8, color: '#94a3b8' },
        angle: 22.5,
        gridcolor: '#e2e8f0',
        linecolor: '#cbd5e1',
        showticklabels: true,
      },
    },
  };
}

function skyData(dataset) {
  const epoch = currentEpoch(dataset);
  // 星座过滤 / 卫星标注都是「每条轨迹自己一套」，互相不影响
  const systems = dataset.activeSystems || new Set();
  const satellites = epoch
    ? [...epoch.satellites.values()].filter(
      (satellite) => satellite.elevation !== null
        && satellite.azimuth !== null
        && systems.has(satellite.system),
    )
    : [];

  const withSignal = satellites.filter((satellite) => satellite.cn0 !== null && satellite.cn0 > 0);
  const withoutSignal = satellites.filter((satellite) => satellite.cn0 === null || satellite.cn0 <= 0);

  // 分割概率（没有对应历元的数据时全为 undefined）
  const curves = splitAvailable(dataset) ? splitCurves(dataset) : null;
  const probabilityOf = (satellite) => (
    curves && curves.p ? curves.p[`${satellite.system}|${satellite.prn}`] : undefined
  );
  const probabilityText = (satellite) => {
    const value = probabilityOf(satellite);
    return value === undefined ? '—' : value.toFixed(2);
  };

  const label = (satellite) => `${SYSTEM_PREFIX[satellite.system] || ''}${satellite.prn}`;
  const mode = dataset.showLabels === false ? 'markers' : 'markers+text';

  // 按方位把标签推到圆点外侧，避免密集时标签互相遮盖
  const textPosition = (satellite) => {
    const azimuth = ((satellite.azimuth % 360) + 360) % 360;
    if (azimuth >= 315 || azimuth < 45) return 'top center';
    if (azimuth < 135) return 'middle right';
    if (azimuth < 225) return 'bottom center';
    return 'middle left';
  };

  const signalTrace = {
    type: 'scatterpolar',
    mode,
    r: withSignal.map((satellite) => 90 - satellite.elevation),
    theta: withSignal.map((satellite) => satellite.azimuth),
    text: withSignal.map(label),
    customdata: withSignal.map((satellite) => [
      satellite.system,
      satellite.elevation,
      satellite.azimuth,
      satellite.cn0,
      probabilityText(satellite),
    ]),
    textposition: withSignal.map(textPosition),
    textfont: { size: 8, color: '#334155', family: 'system-ui, sans-serif' },
    marker: {
      symbol: 'circle',
      size: withSignal.map((satellite) => 8 + Math.min(1, Math.max(0, (satellite.cn0 - CN0_MIN) / (CN0_MAX - CN0_MIN))) * 8),
      color: withSignal.map((satellite) => satellite.cn0),
      colorscale: CN0_SCALE,
      cmin: CN0_MIN,
      cmax: CN0_MAX,
      colorbar: {
        title: { text: 'cn0', side: 'right', font: { size: 9, color: '#64748b' } },
        thickness: 7,
        len: 0.62,
        outlinewidth: 0,
        tickfont: { size: 8, color: '#64748b' },
      },
      line: {
        color: withSignal.map((satellite) => SYSTEM_COLORS[satellite.system] || '#94a3b8'),
        width: 1.4,
      },
    },
    hovertemplate:
      '%{text} · %{customdata[0]}<br>'
      + '仰角 %{customdata[1]:.1f}°　方位 %{customdata[2]:.1f}°<br>'
      + 'cn0 %{customdata[3]:.1f} dB-Hz<br>'
      + 'p(直射) %{customdata[4]}<extra></extra>',
    name: '有信号',
  };

  const noSignalTrace = {
    type: 'scatterpolar',
    mode,
    r: withoutSignal.map((satellite) => 90 - satellite.elevation),
    theta: withoutSignal.map((satellite) => satellite.azimuth),
    text: withoutSignal.map(label),
    customdata: withoutSignal.map((satellite) => [
      satellite.system,
      satellite.elevation,
      satellite.azimuth,
      probabilityText(satellite),
    ]),
    textposition: withoutSignal.map(textPosition),
    textfont: { size: 8, color: '#64748b', family: 'system-ui, sans-serif' },
    marker: {
      symbol: 'triangle-up',
      size: 10,
      color: '#000000',
      line: { color: '#94a3b8', width: 0.6 },
    },
    hovertemplate:
      '%{text} · %{customdata[0]}<br>'
      + '仰角 %{customdata[1]:.1f}°　方位 %{customdata[2]:.1f}°<br>'
      + '无载噪比（cn0 = 0）　p(直射) %{customdata[3]}<extra></extra>',
    name: '无信号',
  };

  // 有信号但被判为非直射的卫星加一圈红环（最需要人工复核的那一类）
  const nlos = curves
    ? withSignal.filter((satellite) => {
      const value = probabilityOf(satellite);
      return value !== undefined && value < 0.5;
    })
    : [];
  const nlosTrace = {
    type: 'scatterpolar',
    mode: 'markers',
    r: nlos.map((satellite) => 90 - satellite.elevation),
    theta: nlos.map((satellite) => satellite.azimuth),
    text: nlos.map(label),
    customdata: nlos.map(probabilityText),
    marker: {
      symbol: 'circle-open',
      size: 17,
      color: 'rgba(220, 38, 38, 0)',
      line: { color: '#dc2626', width: 1.4 },
    },
    hovertemplate: '%{text}　判为非直射（p=%{customdata}）<extra></extra>',
    name: '非直射',
  };

  return [signalTrace, noSignalTrace, nlosTrace];
}

/** 把某条轨迹的星空图画进它自己的浮窗。 */
function renderSkyWindow(win) {
  const dataset = win && win.dataset;
  const element = win && win.plotEl;
  if (!element) return;
  const emptyTrace = [{
    type: 'scatterpolar', mode: 'markers', r: [], theta: [], hoverinfo: 'skip', name: '无数据',
  }];

  if (!dataset) {
    Plotly.react(element, emptyTrace, skyLayout(false), PLOT_CONFIG);
    win.ready = true;
    return;
  }

  // 当前时刻超出该数据范围时不画端点帧的星图，用说明代替，避免误读
  const status = datasetState(dataset);
  if (status !== 'ok') {
    const where = status === 'before' ? '早于起点' : '晚于末尾';
    // 保留一条空 trace，否则 Plotly 会退回默认直角坐标轴，极坐标网格消失
    Plotly.react(
      element,
      emptyTrace,
      skyLayout(false, `当前时刻${where}<br>覆盖 ${datasetRangeText(dataset)}`),
      PLOT_CONFIG,
    );
    win.ready = true;
    return;
  }

  const satellites = skyData(dataset);
  const hasSatellites = satellites.some((trace) => trace.r && trace.r.length > 0);
  let overlay = [];
  try {
    overlay = splitTraces(dataset);
  } catch (error) {
    overlay = [];  // 叠加数据异常时退回纯星空图，不影响主功能
  }
  Plotly.react(element, [...overlay, ...satellites], skyLayout(hasSatellites), PLOT_CONFIG);
  win.ready = true;
}

/** 重新画所有已打开的星空图（例如遮挡分割数据延后加载完成）。 */
function renderSkyWindows() {
  for (const dataset of state.datasets) {
    const win = dataset.windows && dataset.windows.sky;
    if (win) renderSkyWindow(win);
  }
}

/* ------------------------------------------------------------------ *
 * 仪表盘（每条轨迹一套，各自画在自己的浮窗里）
 * ------------------------------------------------------------------ */
/** 在浮窗里建指南针 SVG；指针颜色跟随该轨迹的配色。 */
function buildCompass(win) {
  const holder = win && win.compassEl;
  if (!holder) return;
  holder.innerHTML = '';

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 200 200');
  svg.setAttribute('class', 'compass');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '航向指南针');
  holder.appendChild(svg);

  const add = (tag, attrs, parent = svg) => {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    parent.appendChild(node);
    return node;
  };

  add('circle', { class: 'compass-face', cx: 100, cy: 100, r: 96 });
  add('circle', { class: 'compass-ring', cx: 100, cy: 100, r: 96 });
  add('circle', { class: 'compass-ring', cx: 100, cy: 100, r: 84 });

  const ticks = add('g', {});
  for (let degree = 0; degree < 360; degree += 10) {
    const major = degree % 30 === 0;
    const radians = ((degree - 90) * Math.PI) / 180;
    add('line', {
      class: major ? 'compass-tick major' : 'compass-tick',
      x1: 100 + Math.cos(radians) * (major ? 79 : 84),
      y1: 100 + Math.sin(radians) * (major ? 79 : 84),
      x2: 100 + Math.cos(radians) * 91,
      y2: 100 + Math.sin(radians) * 91,
    }, ticks);
  }

  const needle = add('g', { class: 'compass-needle' });
  add('polygon', {
    points: '100,36 107,100 93,100',
    fill: (win.dataset && win.dataset.color) || '#0d9488',
    stroke: '#ffffff',
    'stroke-width': 1,
  }, needle);
  add('polygon', {
    points: '100,164 107,100 93,100',
    fill: '#cbd5e1',
    stroke: '#ffffff',
    'stroke-width': 1,
  }, needle);

  for (const [label, x, y, modifier] of [
    ['N', 100, 28, ' north'],
    ['E', 172, 100, ''],
    ['S', 100, 172, ''],
    ['W', 28, 100, ''],
  ]) {
    const node = add('text', {
      class: `compass-cardinal${modifier}`,
      x,
      y,
    });
    node.textContent = label;
  }

  add('circle', { class: 'compass-badge', cx: 100, cy: 100, r: 30 });
  const value = add('text', { class: 'compass-value', x: 100, y: 96 });
  value.textContent = '—';
  const point = add('text', { class: 'compass-point', x: 100, y: 115 });
  point.textContent = '';

  win.compass = { needle, value, point };
  win.angle = 0;
}

function updateCompass(win, course) {
  const compass = win && win.compass;
  if (!compass) return;
  if (course === null || !Number.isFinite(course)) {
    compass.value.textContent = '—';
    compass.point.textContent = '无数据';
    compass.needle.style.opacity = '0.25';
    compass.needle.style.transform = 'rotate(0deg)';
    win.angle = 0;
    return;
  }

  const heading = ((course % 360) + 360) % 360;
  compass.needle.style.opacity = '1';
  compass.value.textContent = `${heading.toFixed(1)}°`;
  compass.point.textContent = compassPoint(heading);

  // 选择最短旋转方向，避免 359° -> 0° 时反向转一整圈
  const current = ((win.angle % 360) + 360) % 360;
  win.angle += ((heading - current + 540) % 360) - 180;
  compass.needle.style.transform = `rotate(${win.angle}deg)`;
}

/** 把某条轨迹的仪表盘（速度表 + 指南针 + 读数）画进它自己的浮窗。 */
function renderDashWindow(win) {
  const dataset = win && win.dataset;
  const element = win && win.plotEl;
  if (!dataset || !element) return;

  // 越界时不能拿端点历元当“当前值”，表盘置为无数据态
  const status = datasetState(dataset);
  const inRange = status === 'ok';
  const epoch = inRange ? currentEpoch(dataset) : null;

  const speed = epoch && epoch.speedKmh !== null ? epoch.speedKmh : 0;
  const maxSpeed = Math.max(10, Math.ceil((dataset.summary.maxSpeedKmh || 0) / 5) * 5);
  const accent = dataset.color || '#2563eb';

  const speedFigure = {
    data: [{
      type: 'indicator',
      mode: 'gauge+number',
      value: speed,
      number: { valueformat: '.2f', font: { size: 22, color: inRange ? '#0f172a' : '#94a3b8' } },
      gauge: {
        axis: { range: [0, maxSpeed], showticklabels: false, ticks: '' },
        bar: { color: inRange ? accent : '#cbd5e1', thickness: 0.5 },
        bgcolor: '#f1f5f9',
        borderwidth: 0,
        steps: [{ range: [0, maxSpeed], color: '#e2e8f0' }],
      },
    }],
    layout: { margin: { l: 24, r: 24, t: 10, b: 8 }, paper_bgcolor: 'rgba(0,0,0,0)' },
  };

  if (win.courseEl) {
    if (!inRange) {
      win.courseEl.textContent = status === 'before' ? '航向 · 早于数据起点' : '航向 · 晚于数据末尾';
    } else {
      win.courseEl.textContent = epoch.course === null
        ? '航向 · 无数据'
        : `航向 · ${compassPoint(epoch.course)}`;
    }
  }

  Plotly.react(element, speedFigure.data, speedFigure.layout, PLOT_CONFIG);
  win.ready = true;
  updateCompass(win, inRange ? epoch.course : null);
  renderReadouts(win, status, epoch);
}

function renderReadouts(win, status, epoch) {
  const holder = win && win.readoutsEl;
  if (!holder) return;
  const dataset = win.dataset;

  if (!epoch) {
    // 越界：明确说明是哪一段没有数据，而不是默默停在端点帧的读数上
    const where = status === 'before' ? '早于该数据起点' : '晚于该数据末尾';
    const local = datasetLocalTime(dataset, state.now);
    holder.innerHTML = `<div class="readout out-of-range">`
      + `<span class="label">${escapeHtml(dataset.name)}</span>`
      + `<span class="value">当前时刻 ${fmt(local, 1)} s ${where}`
      + `（覆盖 ${datasetRangeText(dataset)}），无对应历元</span></div>`;
    return;
  }

  const systems = dataset.activeSystems || new Set();
  const visible = [...epoch.satellites.values()].filter((s) => systems.has(s.system)).length;
  const ellipsoid = epoch.altitude === null
    ? null
    : epoch.altitude + (epoch.geoidSeparation || 0);

  const fixLabel = epoch.fixType !== null
    ? (FIX_TYPE[epoch.fixType] || `类型 ${epoch.fixType}`)
    : (epoch.fixQuality !== null ? (FIX_QUALITY[epoch.fixQuality] || `质量 ${epoch.fixQuality}`) : '—');

  // 水平误差：同一时刻与图例里选定的基准位置之间的距离（基准自己显示为「基准」）
  const reference = referenceDataset();
  let errorText = '未选基准';
  if (reference) {
    if (reference === dataset) {
      errorText = '基准';
    } else {
      const error = datasetHorizontalError(dataset, dataset.index);
      errorText = error === null ? '基准无覆盖' : `${fmt(error, 2)} m`;
    }
  }

  const rows = [
    ['UTC 时间', epoch.datetime ? epoch.datetime.replace('T', ' ') : '—', 'utc'],
    ['纬度', fmt(epoch.lat, 9)],
    ['经度', fmt(epoch.lon, 9)],
    ['海拔高 (MSL)', epoch.altitude === null ? '—' : `${fmt(epoch.altitude, 2)} m`],
    ['速度', epoch.speedKmh === null ? '—' : `${fmt(epoch.speedKmh, 2)} km/h`],
    ['航向', epoch.course === null ? '—' : `${fmt(epoch.course, 1)}° ${compassPoint(epoch.course)}`],
    ['卫星 解算/可见', `${epoch.numSatsUsed === null ? '—' : epoch.numSatsUsed} / ${epoch.numSatsView === null ? '—' : epoch.numSatsView}`
      + `（显示 ${visible}）`],
    ['水平误差', errorText],
    ['HDOP / PDOP', `${fmt(epoch.hdop, 2)} / ${fmt(epoch.pdop, 2)}`],
    ['定位 / 椭球高', `${fixLabel} · ${ellipsoid === null ? '—' : `${fmt(ellipsoid, 2)} m`}`],
  ];

  holder.innerHTML = rows.map(([label, value, modifier]) => (
    `<div class="readout${modifier ? ` ${modifier}` : ''}"><span class="label">${label}</span>`
    + `<span class="value" title="${escapeHtml(value)}">${value}</span></div>`
  )).join('');
}

/* ------------------------------------------------------------------ *
 * 时间轴
 * ------------------------------------------------------------------ */
/**
 * 把历元的 UTC 时间换算成相对起点的秒数，供进度条与播放使用。
 * 无时间戳的历元沿用前一个历元 +1 s；跨零点时补一天，保证单调递增。
 */
/** 历元的绝对 UTC 秒（含日期）；日期/时间缺失时返回 null。 */
function epochStamp(epoch) {
  if (!epoch.date || epoch.secondsOfDay === null || epoch.secondsOfDay === undefined) return null;
  const [year, month, day] = epoch.date.split('-').map(Number);
  if (!year || !month || !day) return null;
  return Date.UTC(year, month - 1, day) / 1000 + epoch.secondsOfDay;
}

/**
 * 把历元的 UTC 时间换算成：
 *  - times：相对本数据集首历元的秒数（用于数据集内部定位）
 *  - base：首历元的绝对 UTC 秒，全无时间戳时为 null
 * 无时间戳的历元沿用前一个历元 +1 s；跨零点时补一天，保证单调递增。
 */
function buildTimeAxis(epochs) {
  const times = [];
  let offset = 0;
  let previous = null;
  let base = null;
  for (const epoch of epochs) {
    let stamp = epochStamp(epoch);
    if (stamp !== null) {
      stamp += offset;
      if (previous !== null && stamp < previous - 43200) {
        offset += 86400;
        stamp += 86400;
      }
      previous = stamp;
      if (base === null) base = stamp;
    }
    times.push(stamp === null
      ? (times.length ? times[times.length - 1] + 1 : 0)
      : stamp - base);
  }
  return { times, base };
}

/** 在某个数据集的相对时间轴上找出最接近 seconds 的历元下标。 */
function indexAtTime(times, seconds) {
  if (!times.length) return 0;
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (times[mid] < seconds) low = mid + 1;
    else high = mid;
  }
  if (low > 0 && Math.abs(times[low - 1] - seconds) <= Math.abs(times[low] - seconds)) {
    return low - 1;
  }
  return low;
}

/**
 * 数据集自身时间轴 0 点相对全局时间轴 0 点（origin）的位置。
 * 全局时间轴始终按绝对 UTC 合并，因此这里与对比曲线的对齐方式无关。
 */
function datasetOffset(dataset) {
  if (dataset.base === null || dataset.base === undefined) return 0;
  return dataset.base - state.origin;
}

/** 全局绝对 UTC 秒 → 数据集自身时间轴上的秒数。 */
function datasetLocalTime(dataset, seconds) {
  return (seconds - state.origin) - datasetOffset(dataset);
}

function datasetIndexAt(dataset, seconds) {
  return indexAtTime(dataset.times, datasetLocalTime(dataset, seconds));
}

/** 数据集是否覆盖给定全局时间（基于 datasetState，避免两份逻辑漂移）。 */
function datasetCovers(dataset, seconds) {
  return datasetState(dataset, seconds) === 'ok';
}

/**
 * 数据在全局时刻上的覆盖状态：
 *  - ok     当前时刻有采样，可以取到历元
 *  - before 早于第一条历元
 *  - after  晚于最后一条历元
 *  - empty  没有任何历元
 * 越界时不能把端点历元当作“当前值”显示，否则读数会停留在一个不对应的时间点上。
 */
function datasetState(dataset, seconds = state.now) {
  if (!dataset || !dataset.times.length) return 'empty';
  const local = datasetLocalTime(dataset, seconds);
  if (local < dataset.times[0] - 1e-6) return 'before';
  if (local > dataset.times[dataset.times.length - 1] + 1e-6) return 'after';
  return 'ok';
}

/** 数据自身的时间跨度文本，如「0.0–426.5 s」。 */
function datasetRangeText(dataset) {
  if (!dataset || !dataset.times.length) return '无数据';
  const last = dataset.times[dataset.times.length - 1];
  return `${dataset.times[0].toFixed(1)}–${last.toFixed(1)} s`;
}

function syncDatasetIndices() {
  for (const dataset of state.datasets) dataset.index = datasetIndexAt(dataset, state.now);
}

/**
 * 根据全部数据集重建全局时间轴。
 * 时间轴始终按绝对 UTC 合并：origin = 最早的时间戳，duration = 最晚的结束时刻，
 * 与对比曲线的「相对起点 / 绝对 UTC」对齐方式无关。
 */
function rebuildTimeline() {
  const previous = { ...state.window, duration: state.duration, origin: state.origin };

  const bases = state.datasets
    .map((dataset) => dataset.base)
    .filter((base) => base !== null && base !== undefined);
  state.origin = bases.length ? Math.min(...bases) : 0;

  let end = 0;
  for (const dataset of state.datasets) {
    const offset = datasetOffset(dataset);
    const last = dataset.times.length ? dataset.times[dataset.times.length - 1] : 0;
    end = Math.max(end, offset + last);
  }
  state.duration = Math.max(0, end);

  if (dom.timeTotal) dom.timeTotal.textContent = `共 ${formatDuration(state.duration)}`;

  // 时间域变了（装载 / 移除数据），按比例保留用户选的窗口
  normalizeWindow(previous);

  state.now = Math.min(state.origin + state.duration, Math.max(state.origin, state.now));
  syncDatasetIndices();
  // 让轨道读数、轨迹裁剪与对比曲线跟上新的时间域
  applyWindow();
  clampNowIntoWindow();
}

/* ------------------------------------------------------------------ *
 * 进度条 × 时间窗（同一条轨道）
 * ------------------------------------------------------------------ */
/** 窗口最小宽度：至少 1 s，且不超过总时长的 1%（短日志也不会卡死）。 */
function minWindowWidth() {
  if (state.duration <= 0) return 0;
  return Math.min(state.duration, Math.max(0.5, Math.min(5, state.duration * 0.01)));
}

/** 窗口是否等于全时段。 */
function windowIsFull() {
  const { start, end } = state.window;
  return start <= 1e-6 && end >= state.duration - 1e-6;
}

/** 设置窗口（单位：全局相对秒），会夹到 [0, duration] 并保证最小宽度。
 *  follow = false 时只刷新几何、不立即重算视图（拖动中使用，避免每帧重绘图表）。 */
function setWindow(start, end, options = {}) {
  const { silent = false, follow = true } = options;
  const duration = state.duration;
  if (duration <= 0) {
    state.window = { start: 0, end: 0 };
    updateWindowBar();
    return;
  }
  const minWidth = minWindowWidth();
  let left = Math.max(0, Math.min(duration - minWidth, start));
  let right = Math.min(duration, Math.max(left + minWidth, end));
  if (right - left < minWidth) left = Math.max(0, right - minWidth);
  state.window = { start: left, end: right };
  updateWindowBar();
  if (silent) return;
  if (!follow) {
    scheduleWindowApply();
    return;
  }
  applyWindow();
  // 当前时刻被窗口排在外面时贴到最近的边界，否则游标与读数会指向两个时间点
  clampNowIntoWindow();
}

/** 把当前时刻夹回时间窗内；真的越界时才重绘。 */
function clampNowIntoWindow() {
  if (state.duration <= 0) return;
  const rel = state.now - state.origin;
  const target = Math.min(state.window.end, Math.max(state.window.start, rel));
  if (Math.abs(target - rel) < 1e-6) return;
  setGlobalTime(state.origin + target);
  renderEpoch();
}

/**
 * 时间域变化后重建窗口：
 *  - 原来就是全时段 → 仍是全时段；
 *  - 否则按 origin 的平移量整体平移（时间轴是绝对 UTC，窗口选的是同一段真实时间），
 *    再夹到新的时间范围内。不能按比例缩放，否则加一份更早的数据窗口会被拉长。
 */
function normalizeWindow(previous) {
  if (state.duration <= 0) {
    state.window = { start: 0, end: 0 };
    updateWindowBar();
    return;
  }
  const prevDuration = previous && previous.duration ? previous.duration : 0;
  const wasFull = prevDuration <= 0
    || (previous.start <= 1e-6 && previous.end >= prevDuration - 1e-6);
  if (wasFull) {
    state.window = { start: 0, end: state.duration };
    updateWindowBar();
    return;
  }
  const prevOrigin = previous && previous.origin !== undefined ? previous.origin : state.origin;
  const shift = prevOrigin - state.origin;
  setWindow(previous.start + shift, previous.end + shift, { silent: true });
}

function windowPercent(seconds) {
  if (state.duration <= 0) return 0;
  return (Math.max(0, Math.min(state.duration, seconds)) / state.duration) * 100;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 时间轴是否有可用的 UTC 基准：至少有一份数据带时间戳。 */
function utcBaseline() {
  return state.datasets.some((dataset) => dataset.base !== null && dataset.base !== undefined)
    ? state.origin
    : null;
}

/** 时间轴跨度跨天 / 跨年时，UTC 文案需要补上日期。 */
function utcDateStyle(baseline) {
  if (baseline === null || state.duration <= 0) return 'none';
  const start = new Date(baseline * 1000);
  const end = new Date((baseline + state.duration) * 1000);
  if (start.getUTCFullYear() !== end.getUTCFullYear()) return 'year';
  if (start.getUTCMonth() !== end.getUTCMonth() || start.getUTCDate() !== end.getUTCDate()) return 'month';
  return 'none';
}

/** 绝对 UTC 秒 → 「HH:MM:SS.d」；跨天补「MM-DD」，跨年补「YYYY-MM-DD」。 */
function formatUtc(seconds, style = 'none') {
  const date = new Date(seconds * 1000);
  const clock = `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`
    + `.${Math.floor(date.getUTCMilliseconds() / 100)}`;
  if (style === 'year') {
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${clock}`;
  }
  if (style === 'month') {
    return `${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${clock}`;
  }
  return clock;
}

/**
 * UTC 时刻 → 「本地壁钟与 UTC 相同」的时间戳（ms）。
 *
 * Plotly 的日期轴按浏览器本地时区渲染，直接传绝对时间戳会显示成本地时间；
 * 这里把 UTC 年月日时分秒装进本地 Date，刻度与 hover 就显示 UTC 时钟。
 * 无夏令时的时区（如中国）完全精确；有 DST 的时区在切换日可能有 1 小时偏差。
 */
function utcWallClockMs(epochSeconds) {
  const utc = new Date(epochSeconds * 1000);
  return new Date(
    utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate(),
    utc.getUTCHours(), utc.getUTCMinutes(), utc.getUTCSeconds(),
    utc.getUTCMilliseconds(),
  ).getTime();
}

/** 时长文案：多天的绝对时间轴不再用几十万秒表示总长。 */
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0.0 s';
  if (seconds < 90) return `${seconds.toFixed(1)} s`;
  if (seconds < 5400) return `${(seconds / 60).toFixed(1)} 分钟`;
  if (seconds < 129600) return `${(seconds / 3600).toFixed(1)} 小时`;
  return `${(seconds / 86400).toFixed(1)} 天`;
}

/** 刷新轨道上的窗口几何、读数、标尺语义，以及游标与窗内进度。 */
function updateWindowBar() {
  if (!dom.timelineSpan) return;
  const duration = state.duration;
  const { start, end } = state.window;

  if (duration <= 0) {
    dom.timelineSpan.style.left = '0%';
    dom.timelineSpan.style.width = '100%';
    dom.timelineReadout.textContent = '无数据';
    dom.timelineReadout.title = '';
    dom.timelineReset.disabled = true;
    dom.timelineLeft.disabled = true;
    dom.timelineRight.disabled = true;
    dom.timelineLeft.setAttribute('aria-valuenow', '0');
    dom.timelineRight.setAttribute('aria-valuenow', '0');
    dom.timelineCursor.classList.add('hidden');
    dom.timelineProgress.style.width = '0%';
    if (dom.timeTotal) dom.timeTotal.title = '';
    return;
  }

  const baseline = utcBaseline();
  const style = utcDateStyle(baseline);
  const utc = (relative) => formatUtc(baseline + relative, style);
  // aria 的数值在有 UTC 基准时直接用绝对时间，与读出的时刻一致
  const zero = baseline === null ? 0 : baseline;

  dom.timelineSpan.style.left = `${windowPercent(start)}%`;
  dom.timelineSpan.style.width = `${windowPercent(end) - windowPercent(start)}%`;

  dom.timelineLeft.disabled = false;
  dom.timelineRight.disabled = false;
  dom.timelineLeft.setAttribute('aria-valuemin', zero.toFixed(1));
  dom.timelineLeft.setAttribute('aria-valuemax', (zero + duration).toFixed(1));
  dom.timelineLeft.setAttribute('aria-valuenow', (zero + start).toFixed(1));
  dom.timelineRight.setAttribute('aria-valuemin', zero.toFixed(1));
  dom.timelineRight.setAttribute('aria-valuemax', (zero + duration).toFixed(1));
  dom.timelineRight.setAttribute('aria-valuenow', (zero + end).toFixed(1));

  const full = windowIsFull();
  if (baseline === null) {
    dom.timelineLeft.setAttribute('aria-valuetext', `开始 ${start.toFixed(1)} 秒`);
    dom.timelineRight.setAttribute('aria-valuetext', `结束 ${end.toFixed(1)} 秒`);
    dom.timelineLeft.title = '拖动调整开始时间（←/→ 微调 1 s，Shift 为 10 s）';
    dom.timelineRight.title = '拖动调整结束时间（←/→ 微调 1 s，Shift 为 10 s）';
    dom.timelineReadout.textContent = full
      ? `全时段 0.0–${duration.toFixed(1)} s`
      : `窗口 ${start.toFixed(1)}–${end.toFixed(1)} s · 窗宽 ${(end - start).toFixed(1)} s`;
    dom.timelineReadout.title = '数据没有 UTC 时间戳，时间轴按相对秒显示';
    if (dom.timeTotal) dom.timeTotal.title = '';
  } else {
    dom.timelineLeft.setAttribute('aria-valuetext', `开始 ${utc(start)} UTC`);
    dom.timelineRight.setAttribute('aria-valuetext', `结束 ${utc(end)} UTC`);
    dom.timelineLeft.title = `开始 ${utc(start)} UTC（拖动调整；←/→ 微调 1 s，Shift 为 10 s）`;
    dom.timelineRight.title = `结束 ${utc(end)} UTC（拖动调整；←/→ 微调 1 s，Shift 为 10 s）`;
    dom.timelineReadout.textContent = full
      ? `全时段 ${utc(0)}–${utc(duration)} UTC`
      : `窗口 ${utc(start)}–${utc(end)} UTC · 窗宽 ${(end - start).toFixed(1)} s`;
    dom.timelineReadout.title = `数据时段 ${utc(0)}–${utc(duration)} UTC（共 ${formatDuration(duration)}）`;
    if (dom.timeTotal) dom.timeTotal.title = `数据时段 ${utc(0)}–${utc(duration)} UTC`;
  }
  dom.timelineReset.disabled = full;
  updateTimelineCursor();
}

/** 当前时刻游标在轨道上的位置，以及窗口内已播放进度。 */
function updateTimelineCursor() {
  if (!dom.timelineCursor) return;
  const duration = state.duration;
  if (duration <= 0) {
    dom.timelineCursor.classList.add('hidden');
    dom.timelineProgress.style.width = '0%';
    return;
  }
  const baseline = utcBaseline();
  const style = utcDateStyle(baseline);
  const zero = baseline === null ? 0 : baseline;
  dom.timelineCursor.classList.remove('hidden');
  const seconds = Math.max(0, Math.min(duration, state.now - state.origin));
  dom.timelineCursor.style.left = `${windowPercent(seconds)}%`;
  dom.timelineCursor.setAttribute('aria-valuemin', zero.toFixed(1));
  dom.timelineCursor.setAttribute('aria-valuemax', (zero + duration).toFixed(1));
  dom.timelineCursor.setAttribute('aria-valuenow', (zero + seconds).toFixed(1));
  if (baseline === null) {
    dom.timelineCursor.setAttribute('aria-valuetext', `当前 ${seconds.toFixed(1)} 秒`);
    dom.timelineCursor.title = '拖动定位当前时刻（点击轨道任意位置也可定位）';
  } else {
    const clock = formatUtc(baseline + seconds, style);
    dom.timelineCursor.setAttribute('aria-valuetext', `当前 ${clock} UTC`);
    dom.timelineCursor.title = `当前 ${clock} UTC（拖动定位；点击轨道任意位置也可定位）`;
  }

  // 进度条：窗口内从起点画到当前时刻（越界时贴边，窗口极窄时退化为 0 / 1）
  const { start, end } = state.window;
  const width = end - start;
  const ratio = width > 1e-6 ? (seconds - start) / width : (seconds >= end ? 1 : 0);
  dom.timelineProgress.style.width = `${Math.min(1, Math.max(0, ratio)) * 100}%`;
}

/**
 * 把窗口应用到各视图：
 *  - 当前时刻与播放范围收缩到窗口内
 *  - 对比曲线 x 轴限定在窗口
 *  - 地图上的轨迹线与轨迹点裁剪到窗口内
 */
function applyWindow() {
  const { start, end } = state.window;
  const full = windowIsFull();

  // 播放中窗口被拖到当前时刻之前，立即停住，避免时间跑到窗口外还在跑
  if (state.playing) {
    const rel = state.now - state.origin;
    if (rel < start - 1e-6 || rel > end + 1e-6) stopPlayback();
  }

  syncTrackWindow();

  if (state.compare.open && state.compareReady) {
    const element = document.getElementById('compare-plot');
    if (element) {
      const layout = {};
      state.compare.metrics.forEach((key, k) => {
        const suffix = k === 0 ? '' : String(k + 1);
        if (full) {
          layout[`xaxis${suffix}.autorange`] = true;
        } else {
          layout[`xaxis${suffix}.range`] = compareWindowRange().slice();
          layout[`xaxis${suffix}.autorange`] = false;
        }
      });
      const result = Plotly.relayout(element, layout);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    }
  }

  if (state.sat.open && state.satReady && dom.satPlot) {
    const layout = full
      ? { 'xaxis.autorange': true }
      : { 'xaxis.range': satelliteWindowRange(), 'xaxis.autorange': false };
    const result = Plotly.relayout(dom.satPlot, layout);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  }
}

function scheduleWindowApply() {
  if (state.windowFrame !== null) return;
  state.windowFrame = requestAnimationFrame(() => {
    state.windowFrame = null;
    applyWindow();
  });
}

/**
 * 时间窗变化后，把每条轨迹的「线」和「点」换成窗口内的那一段。
 * 拖动时由 scheduleWindowApply 按帧节流，不会每像素重绘。
 */
function syncTrackWindow() {
  if (!state.mapReady || !state.datasets.length) return;
  hideTrackHover();
  const indices = [];
  const lon = [];
  const lat = [];
  state.datasets.forEach((dataset, ordinal) => {
    const visible = visibleTrack(dataset);
    for (const layer of ['line', 'track']) {
      indices.push(traceIndexFor(ordinal, layer));
      lon.push(visible.lon);
      lat.push(visible.lat);
    }
    // 基准连线也只在时间窗内画，窗口变化时一起重算
    const offset = offsetSegments(dataset);
    indices.push(traceIndexFor(ordinal, 'offset'));
    lon.push(offset.lon);
    lat.push(offset.lat);
  });
  if (!indices.length) return;
  try {
    const result = Plotly.restyle('map', { lon, lat }, indices);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (error) {
    // 地图尚未就绪时忽略
  }
  // 轨迹点 / 起点 / 终点由覆盖层绘制，窗口变化后要重画轨迹点
  scheduleMarkerBase();
}

/**
 * 一条轨道上的全部拖动：
 *  - 左 / 右标尺改起止时间
 *  - 中间整体平移（保持窗宽）
 *  - 橙色游标定位当前时刻（进度条原本的拖动定位）
 *  - 拖动空白轨道也定位当前时刻；落在窗口外时窗口先跟过去
 * 另有方向键微调标尺。
 */
function attachTimelineInteractions() {
  const track = dom.timelineTrack;
  if (!track || track.__timelineBound) return;
  track.__timelineBound = true;

  const secondsAt = (clientX) => {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return 0;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * state.duration;
  };

  const begin = (event, mode, options = {}) => {
    if (!state.datasets.length || state.duration <= 0) return;
    event.preventDefault();
    stopPlayback();
    const grabTime = secondsAt(event.clientX);
    state.timelineDrag = {
      mode,
      pointerId: event.pointerId,
      grabTime,
      origin: { ...state.window },
      startX: event.clientX,
      moved: false,   // 窗口中间：没拖动就是「点一下定位」，拖动才是整体平移
    };
    if (options.jump) {
      // 点在窗口外的空白轨道：窗口整体跟到点击处（保持窗宽、居中），当前时刻随后落在这里
      seekTo(grabTime, { followWindow: true });
    }
    if (typeof track.setPointerCapture === 'function') {
      try { track.setPointerCapture(event.pointerId); } catch (error) { /* 忽略 */ }
    }
    track.classList.add('dragging');
  };

  track.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    const handle = event.target.closest('.timeline-handle');
    if (handle) {
      begin(event, handle.classList.contains('left') ? 'left' : 'right');
    } else if (event.target.closest('.timeline-cursor')) {
      begin(event, 'seek');
    } else if (event.target.closest('.timeline-span')) {
      begin(event, 'move');
    } else {
      begin(event, 'seek', { jump: true });
    }
  });

  track.addEventListener('pointermove', (event) => {
    const drag = state.timelineDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const time = secondsAt(event.clientX);
    const minWidth = minWindowWidth();

    if (drag.mode === 'left') {
      const right = drag.origin.end;
      setWindow(Math.min(time, right - minWidth), right, { follow: false });
    } else if (drag.mode === 'right') {
      const left = drag.origin.start;
      setWindow(left, Math.max(time, left + minWidth), { follow: false });
    } else if (drag.mode === 'move') {
      // 先走 3 px 阈值，避免「点一下定位」被当成平移
      if (!drag.moved) {
        if (Math.abs(event.clientX - drag.startX) < 3) return;
        drag.moved = true;
      }
      // 整体平移：保持窗宽，两端都不越出 [0, duration]
      const width = drag.origin.end - drag.origin.start;
      let start = drag.origin.start + (time - drag.grabTime);
      start = Math.max(0, Math.min(state.duration - width, start));
      setWindow(start, start + width, { follow: false });
    } else {
      // 定位当前时刻：只移动游标，夹在窗口内（窗口由标尺 / 平移单独调整）
      seekTo(time);
    }
  });

  const end = (event) => {
    const drag = state.timelineDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    state.timelineDrag = null;
    track.classList.remove('dragging');
    if (typeof track.releasePointerCapture === 'function') {
      try { track.releasePointerCapture(event.pointerId); } catch (error) { /* 忽略 */ }
    }
    if (drag.mode === 'seek' || (drag.mode === 'move' && !drag.moved)) {
      // 点一下（游标 / 窗口内 / 窗口外）：定位到该时刻，再把读数与地图对齐到最近历元
      if (drag.mode === 'move') seekTo(drag.grabTime);
      renderEpoch();
      return;
    }
    applyWindow();
    // 当前时刻被窗口排在外面时对齐到最近的窗口边界，
    // 否则游标（已限定在窗口内）与仪表盘读数会指向两个时间点
    clampNowIntoWindow();
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);

  // 方向键微调：←/→ 1 s，Shift + ←/→ 10 s
  const nudge = (which) => (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = (event.shiftKey ? 10 : 1) * (event.key === 'ArrowLeft' ? -1 : 1);
    const { start, end } = state.window;
    setWindow(which === 'left' ? start + step : start, which === 'right' ? end + step : end);
  };
  dom.timelineLeft.addEventListener('keydown', nudge('left'));
  dom.timelineRight.addEventListener('keydown', nudge('right'));

  dom.timelineReset.addEventListener('click', () => {
    setWindow(0, state.duration);
    toast('时间窗已恢复全时段');
  });

  // 5 / 10 / 20 分钟预设：以当前时刻为中心取固定窗宽
  for (const button of dom.timelinePresets) {
    button.addEventListener('click', () => applyWindowMinutes(Number(button.dataset.minutes)));
  }
}

/**
 * 时间窗预设：以当前时刻为中心，把窗口设为 minutes 分钟。
 * 窗口整体贴边（数据不够长）时退化为全时段，并提示实际数据时长。
 */
function applyWindowMinutes(minutes) {
  if (!state.datasets.length || state.duration <= 0) return;
  const seconds = minutes * 60;
  if (state.duration <= seconds + 1e-6) {
    setWindow(0, state.duration);
    toast(`数据时长只有 ${(state.duration / 60).toFixed(1)} 分钟，已显示全时段`);
    return;
  }
  const current = Math.min(state.duration, Math.max(0, state.now - state.origin));
  let start = current - seconds / 2;
  let end = current + seconds / 2;
  // 贴边时整体平移而不是压缩窗口，保证窗宽就是选中的分钟数
  if (start < 0) {
    start = 0;
    end = seconds;
  } else if (end > state.duration) {
    end = state.duration;
    start = state.duration - seconds;
  }
  setWindow(start, end);
  const baseline = utcBaseline();
  if (baseline === null) {
    toast(`时间窗已设为 ${minutes} 分钟（以当前时刻为中心）`);
    return;
  }
  const style = utcDateStyle(baseline);
  toast(`时间窗已设为 ${minutes} 分钟（${formatUtc(baseline + state.window.start, style)}–`
    + `${formatUtc(baseline + state.window.end, style)} UTC）`);
}

/**
 * 双击图例条目：把时间窗的起止对齐到这条数据自己的时段。
 * 时间窗坐标是「全局相对秒」（绝对 UTC 合并后的时间轴），
 * 所以数据集起止要加上 datasetOffset(dataset) 再换算。
 */
function alignWindowToDataset(dataset) {
  if (!dataset || !dataset.times || !dataset.times.length || state.duration <= 0) return;
  const offset = datasetOffset(dataset);
  const start = offset + dataset.times[0];
  const end = offset + dataset.times[dataset.times.length - 1];
  if (!(end > start)) {
    toast(`${dataset.name} 没有可用的时间跨度，无法对齐时间窗。`, true);
    return;
  }

  state.focusId = dataset.id;
  updateDatasetLegendFocus();
  setWindow(start, end);
  renderEpoch();

  const baseline = utcBaseline();
  const style = utcDateStyle(baseline);
  const range = baseline === null
    ? `${start.toFixed(1)}–${end.toFixed(1)} s`
    : `${formatUtc(baseline + start, style)}–${formatUtc(baseline + end, style)} UTC`;
  toast(`时间窗已对齐到 ${dataset.name}：${range}（${formatDuration(end - start)}）`);
}

/** 把全局时间设为绝对 UTC 秒（会夹到有效范围内）。 */
function setGlobalTime(seconds) {
  state.now = Math.min(state.origin + state.duration, Math.max(state.origin, seconds));
  syncDatasetIndices();
}

/** 把轨道游标与读数刷新到当前历元（有 UTC 时间戳时显示 UTC 时刻）。 */
function updateTimeline() {
  const seconds = Math.max(0, state.now - state.origin);
  const snapped = Math.round(seconds * 10) / 10;
  const baseline = utcBaseline();
  if (baseline === null) {
    dom.timeNow.textContent = `${snapped.toFixed(1)} s`;
    dom.timeNow.title = '';
  } else {
    const clock = formatUtc(baseline + seconds, utcDateStyle(baseline));
    dom.timeNow.textContent = clock;
    dom.timeNow.title = `当前时刻（UTC）：${clock}`;
  }
  updateTimelineCursor();
}

/* ------------------------------------------------------------------ *
 * 渲染调度
 * ------------------------------------------------------------------ */
function renderEpoch() {
  if (!state.datasets.length) return;
  syncDatasetIndices();
  updateTimeline();
  updateEpochLabel();
  renderMap(false);
  renderAllWindows();
  updateDatasetLegendFocus();
  renderCompareCursor();
  renderSatelliteCursor();
}

/** 顶部当前时刻标签：显示聚焦数据集（点击图例里的文件名可切换）。 */
function updateEpochLabel() {
  const dataset = focusDataset();
  if (!dataset) {
    dom.epochLabel.classList.remove('warn');
    dom.epochLabel.textContent = '未加载数据';
    return;
  }

  const epoch = currentEpoch(dataset);
  // 始终带上文件名：现在可以同时加载多份数据，顶部需要能看出当前是哪一份
  const status = datasetState(dataset);
  dom.epochLabel.classList.toggle('warn', status !== 'ok');
  if (status === 'ok') {
    dom.epochLabel.textContent = `${epoch ? (epoch.time || '--:--:--') : '--:--:--'} · `
      + `${dataset.index + 1}/${dataset.epochs.length} · ${dataset.name}`;
  } else {
    const where = status === 'before' ? '早于起点' : '超出末尾';
    dom.epochLabel.textContent = `--:--:-- · ${dataset.name} · ${where} ${datasetRangeText(dataset)}`;
  }
}

/** 把所有已打开的星空图 / 仪表盘刷到当前时刻。 */
function renderAllWindows() {
  for (const dataset of state.datasets) {
    if (!dataset.windows) continue;
    for (const kind of WINDOW_ORDER) {
      const win = dataset.windows[kind];
      if (win) renderWindow(win);
    }
  }
}

function requestRender() {
  if (state.pendingRender) return;
  state.pendingRender = true;
  requestAnimationFrame(() => {
    state.pendingRender = false;
    renderEpoch();
  });
}

function resizePlots() {
  if (state.mapReady) Plotly.Plots.resize('map');
  for (const dataset of state.datasets) {
    if (!dataset.windows) continue;
    for (const kind of WINDOW_ORDER) {
      const win = dataset.windows[kind];
      if (win) resizeWindowPlots(win);
    }
  }
  if (state.compareReady) Plotly.Plots.resize('compare-plot');
  if (state.satReady) {
    Plotly.Plots.resize('sat-plot');
    syncSatelliteLegendMargin();
  }
}

/* ------------------------------------------------------------------ *
 * 播放控制（按「步进」速度推进，1s = 1 秒数据用 1 秒播放）
 * ------------------------------------------------------------------ */
function stopPlayback() {
  state.playing = false;
  if (state.rafHandle !== null) {
    cancelAnimationFrame(state.rafHandle);
    state.rafHandle = null;
  }
  dom.btnPlay.textContent = '▶ 播放';
}

function playbackFrame(now) {
  if (!state.playing) return;
  const elapsed = (now - state.playAnchorWall) / 1000;
  const target = state.playAnchorTime + elapsed * state.stepSeconds;
  // 播放上限是时间窗右标尺，而不是全局末尾
  const limit = state.origin + state.window.end;

  if (target >= limit - 1e-6) {
    setGlobalTime(limit);
    renderEpoch();
    stopPlayback();
    return;
  }

  const before = state.datasets.map((dataset) => dataset.index).join(',');
  setGlobalTime(target);
  const after = state.datasets.map((dataset) => dataset.index).join(',');
  if (before !== after) renderEpoch();
  else updateTimeline();
  state.rafHandle = requestAnimationFrame(playbackFrame);
}

function togglePlayback() {
  if (!state.datasets.length) return;
  if (state.playing) {
    stopPlayback();
    return;
  }
  // 当前时刻不在窗口内（或已到窗口末尾）时，从窗口起点开始播
  const rel = state.now - state.origin;
  if (rel < state.window.start - 1e-6 || rel >= state.window.end - 1e-6) {
    setGlobalTime(state.origin + state.window.start);
    renderEpoch();
  }
  state.playing = true;
  state.playAnchorWall = performance.now();
  state.playAnchorTime = state.now;
  dom.btnPlay.textContent = '⏸ 暂停';
  state.rafHandle = requestAnimationFrame(playbackFrame);
}

/** 按秒跳转：delta 为秒数（正负），限制在时间窗内。 */
function stepTime(delta) {
  if (!state.datasets.length) return;
  stopPlayback();
  const rel = (state.now - state.origin) + delta;
  const clamped = Math.min(state.window.end, Math.max(state.window.start, rel));
  setGlobalTime(state.origin + clamped);
  requestRender();
}

function stepLabel(seconds) {
  if (seconds >= 60) return `${seconds / 60}min`;
  return `${seconds}s`;
}

/** 设置播放速度 / 快进 / 后退步长，并同步按钮文字与下拉框。 */
function setStepSeconds(seconds) {
  const value = STEP_OPTIONS.includes(Number(seconds)) ? Number(seconds) : 1;
  state.stepSeconds = value;
  // 播放中变速时重新锚定，避免已播放的时间被重复换算
  if (state.playing) {
    state.playAnchorWall = performance.now();
    state.playAnchorTime = state.now;
  }
  const label = stepLabel(value);
  if (dom.stepSize) {
    dom.stepSize.value = String(value);
    dom.stepSize.title = `播放速度 / 快进 / 后退步长：${label}`;
  }
  if (dom.btnBack) {
    dom.btnBack.textContent = `◀ ${label}`;
    dom.btnBack.title = `按当前步长后退（←）：${label}`;
  }
  if (dom.btnFwd) {
    dom.btnFwd.textContent = `${label} ▶`;
    dom.btnFwd.title = `按当前步长前进（→）：${label}`;
  }
}

/**
 * 定位当前时刻（进度条 × 时间窗共用的唯一入口）。
 * 默认夹在时间窗内；followWindow = true 时，时刻落在窗口外会把窗口整体挪过去
 * （保持窗宽、居中），用于「点击轨道任意位置跳到该时刻」。
 */
function seekTo(seconds, options = {}) {
  if (!state.datasets.length || state.duration <= 0) return;
  const { followWindow = false } = options;
  stopPlayback();
  const time = Math.max(0, Math.min(state.duration, seconds));
  if (followWindow && (time < state.window.start - 1e-6 || time > state.window.end + 1e-6)) {
    const width = state.window.end - state.window.start;
    const start = Math.max(0, Math.min(state.duration - width, time - width / 2));
    setWindow(start, start + width, { follow: false });
  }
  const clamped = Math.min(state.window.end, Math.max(state.window.start, time));
  setGlobalTime(state.origin + clamped);
  updateTimeline();
  requestRender();
}

/* ------------------------------------------------------------------ *
 * 星空图浮窗里的星座过滤 / 显示开关
 * ------------------------------------------------------------------ */
/** 每条轨迹的星空图有自己的一套过滤状态，互不影响。 */
function buildWindowChips(win) {
  const holder = win && win.chipsEl;
  if (!holder) return;
  const dataset = win.dataset;
  holder.innerHTML = '';

  const systems = (dataset.summary && dataset.summary.systems) || {};
  const names = Object.keys(systems).sort(
    (a, b) => (systems[b] - systems[a]) || a.localeCompare(b),
  );
  for (const name of names) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.system = name;
    chip.title = `显示 / 隐藏 ${name} 卫星`;
    chip.innerHTML = `<span class="swatch" style="background:${SYSTEM_COLORS[name] || '#94a3b8'}"></span>`
      + `${escapeHtml(name)} <b>${systems[name]}</b>`;
    chip.classList.toggle('off', !dataset.activeSystems.has(name));
    chip.addEventListener('click', () => {
      if (dataset.activeSystems.has(name)) dataset.activeSystems.delete(name);
      else dataset.activeSystems.add(name);
      chip.classList.toggle('off', !dataset.activeSystems.has(name));
      renderSkyWindow(win);
    });
    holder.appendChild(chip);
  }

  const options = [
    {
      label: '标注',
      title: '在星空图上显示卫星编号',
      active: () => dataset.showLabels !== false,
      toggle: () => { dataset.showLabels = dataset.showLabels === false; },
    },
    {
      label: '遮挡分割',
      title: '叠加可选的 sky_split.json 直射带与非直射判定',
      active: () => dataset.showSplit !== false,
      toggle: () => { dataset.showSplit = dataset.showSplit === false; },
    },
  ];
  for (const option of options) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip win-option';
    chip.textContent = option.label;
    chip.title = option.title;
    chip.classList.toggle('off', !option.active());
    chip.classList.toggle('on', option.active());
    chip.addEventListener('click', () => {
      option.toggle();
      chip.classList.toggle('off', !option.active());
      chip.classList.toggle('on', option.active());
      renderSkyWindow(win);
    });
    holder.appendChild(chip);
  }
}

/* ------------------------------------------------------------------ *
 * 数据装载
 * ------------------------------------------------------------------ */

/* ---------------- 数据集增删与切换 ---------------- */
function updateControlState() {
  const enabled = state.datasets.length > 0;
  const trackable = enabled && state.duration > 0;
  if (dom.timelineTrack) dom.timelineTrack.classList.toggle('is-empty', !trackable);
  dom.timelineCursor.disabled = !trackable;
  dom.timelineLeft.disabled = !trackable;
  dom.timelineRight.disabled = !trackable;
  for (const button of dom.timelinePresets) button.disabled = !trackable;
  dom.btnPlay.disabled = !enabled;
  dom.btnBack.disabled = !enabled;
  dom.btnFwd.disabled = !enabled;
  if (dom.stepSize) dom.stepSize.disabled = !enabled;
}

/** 只切换图例行的 focus 高亮，不重建整个图例（避免丢失滑块状态）。 */
function updateDatasetLegendFocus() {
  if (!dom.legendDatasets) return;
  for (const row of dom.legendDatasets.querySelectorAll('.dataset-row')) {
    row.classList.toggle('focus', row.dataset.id === state.focusId);
  }
}

/** 切换顶部时刻标签 / 对比曲线参照的数据集（星空图与仪表盘各自绑定，不受影响）。 */
function setFocus(id) {
  if (!state.datasets.some((dataset) => dataset.id === id)) return;
  state.focusId = id;
  // 只换高亮，不重建图例行：双击图例条目时第二下仍要落在同一个元素上
  updateDatasetLegendFocus();
  // 「基准连线」的图例预览跟随聚焦的对比数据
  refreshLegendRow('offset');
  // 必须走完整的 renderEpoch：切换后顶部标签 / 时间轴 / 地图当前位置都要跟着变，
  // 只重画局部会留下上一个数据集的历元信息。
  renderEpoch();
  // 相对起点对齐时 x 轴与光标以聚焦数据为参照，换焦点必须重画；
  // 绝对 UTC 对齐时坐标不变，保留用户对曲线的缩放。
  if (state.compare.open && state.compare.align === 'relative') renderCompare();
  scheduleLegendWindow();
}

/** 把一份 NMEA 文本添加为一条数据集。 */
function addDataset(text, name) {
  const started = performance.now();
  const parsed = parseNmea(text);
  const elapsed = performance.now() - started;

  if (!parsed.epochs.length) {
    toast(`${name}：未能解析出历元，已跳过。`, true);
    return null;
  }

  const axis = buildTimeAxis(parsed.epochs);
  const ordinal = state.datasets.length;
  const style = datasetStyleFor(name, ordinal);
  const summary = summarize(parsed.epochs);
  const dataset = {
    id: `ds-${++state.datasetSeq}`,
    name,
    color: style.color,
    visible: style.visible,
    lineWidth: style.lineWidth,
    pointSize: style.pointSize,
    pointShape: style.pointShape,
    epochs: parsed.epochs,
    stats: parsed.stats,
    summary,
    times: axis.times,
    base: axis.base,
    index: 0,
    // 地图用：有经纬度的轨迹点（WGS84 + 相对秒），时间窗裁剪基于它
    track: buildDatasetTrack(parsed.epochs, axis.times),
    // 每条轨迹各有一套星空图和仪表盘；过滤 / 显示状态也各自独立
    windows: { sky: null, dash: null },
    activeSystems: new Set(Object.keys(summary.systems)),
    showLabels: DEFAULT_SHOW_LABELS,
    showSplit: DEFAULT_SHOW_SPLIT,
  };

  const first = state.datasets.length === 0;
  state.datasets.push(dataset);
  state.compare.datasets.add(dataset.id);
  if (first) state.focusId = dataset.id;
  // 上次会话选过基准：同名文件重新载入时恢复
  if (!referenceDataset() && state.referenceName && dataset.name === state.referenceName) {
    state.referenceId = dataset.id;
    renderLockCards();
  }

  // trace 数量变了，且新轨迹可能扩大视野
  state.mapReady = false;
  state.view = null;
  rebuildTimeline();
  buildDatasetLegend();
  buildLayerLegend();
  buildCompareChips();
  updateControlState();
  renderMap(true);
  renderEpoch();
  // 新数据默认把自己的星空图和仪表盘一并打开（可随时从图例或窗口 × 关闭）
  for (const kind of WINDOW_ORDER) openDatasetWindow(dataset, kind);
  renderCompare();
  if (state.sat.open) {
    buildSatelliteChips();
    renderSatellite();
  }

  toast(`已加载 ${name}：${dataset.epochs.length} 个历元，解析 ${elapsed.toFixed(0)} ms`);
  if (dataset.stats.checksumErrors) {
    toast(`已加载 ${name}（${dataset.epochs.length} 个历元），`
      + `但有 ${dataset.stats.checksumErrors} 条语句校验和错误，已跳过。`, true);
  }
  return dataset;
}

function removeDataset(id) {
  const index = state.datasets.findIndex((dataset) => dataset.id === id);
  if (index < 0) return;
  const removed = state.datasets[index];
  // 先关掉这条轨迹自己的浮窗；位置仍然保留，重新载入时会回到原处
  for (const kind of WINDOW_ORDER) closeDatasetWindow(removed, kind, { remember: false });
  state.datasets.splice(index, 1);
  state.compare.datasets.delete(id);
  if (state.locks.some((lock) => lock.datasetId === id)) {
    state.locks = state.locks.filter((lock) => lock.datasetId !== id);
    renderLockCards();
  }
  hideTrackHover();
  if (state.focusId === id) {
    state.focusId = state.datasets.length ? state.datasets[0].id : null;
  }
  // 基准被删除：一起清掉基准选择与水平误差曲线
  if (state.referenceId === id) {
    state.referenceId = null;
    state.referenceName = '';
    if (state.compare.metrics.includes('error')) {
      state.compare.metrics = state.compare.metrics.filter((key) => key !== 'error');
    }
    saveCompareConfig();
  }
  renderLockCards();
  state.mapReady = false;
  state.view = null;
  buildCompareChips();
  if (state.sat.open) {
    buildSatelliteChips();
    renderSatellite();
  }

  if (!state.datasets.length) {
    stopPlayback();
    state.now = 0;
    state.origin = 0;
    state.duration = 0;
    state.datasets = [];
    state.focusId = null;
    state.referenceId = null;
    state.view = null;
    resetMeasurement();
    state.locks = [];
    renderLockCards();
    buildDatasetLegend();
    buildLayerLegend();
    updateControlState();
    dom.epochLabel.textContent = '未加载数据';
    dom.epochLabel.classList.remove('warn');
    dom.timeNow.textContent = '0.0 s';
    dom.timeNow.title = '';
    dom.timeTotal.textContent = '共 0.0 s';
    dom.timeTotal.title = '';
    state.window = { start: 0, end: 0 };
    updateWindowBar();
    renderMap(true);
    renderCompare();
    return;
  }

  rebuildTimeline();
  buildDatasetLegend();
  buildLayerLegend();
  renderMap(true);
  renderEpoch();
  renderCompare();
  toast(`已移除 ${removed.name}`);
}

/* ---------------- 文件读取 ---------------- */
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error(`读取 ${file.name} 失败`));
    reader.readAsText(file, 'utf-8');
  });
}

/** 逐个读取并加载；支持一次拖入多个文件。 */
async function handleFiles(fileList) {
  const files = Array.from(fileList || []).filter((file) => (
    /\.(log|nmea|txt)$/i.test(file.name) || file.type === 'text/plain'
  ));
  if (!files.length) {
    toast('没有可读取的 NMEA 文件（.log / .nmea / .txt）。', true);
    return;
  }
  for (const file of files) {
    try {
      const text = await readFile(file);
      addDataset(text, file.name);
    } catch (error) {
      toast(`读取 ${file.name} 失败：${error.message}`, true);
    }
  }
}

/**
 * 默认不自动加载任何数据；只有 URL 带 ?file=xxx.log 时才打开根目录下的这一份，
 * 例如 http://localhost:8000/?file=nmea.log 。
 * 只接受简单文件名（不允许带路径），避免越出仓库根目录。
 */
async function loadFileFromUrl(name) {
  const file = String(name || '').trim();
  if (!/^[^/\\]+\.(log|nmea|txt)$/i.test(file)) {
    toast(`文件名不合法：${file || '（空）'}；只支持根目录下的 .log / .nmea / .txt 文件。`, true);
    return;
  }
  try {
    const response = await fetch(`/${encodeURIComponent(file)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    addDataset(text, file);
  } catch (error) {
    toast(`无法读取 ${file}（${error.message}）；请确认文件在仓库根目录，`
      + '或点击「打开 NMEA 文件」选择文件。', true);
  }
}

/** 读取可选的 sky_split.json；没有该文件时静默降级为纯星空图。 */
async function loadSplitData() {
  try {
    const response = await fetch('/sky_split.json', { cache: 'no-store' });
    if (!response.ok) return;
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.epochs)) return;
    state.split = payload;
    if (state.datasets.length) renderSkyWindows();
  } catch (error) {
    // 没有分割文件或格式不对时保持原样
  }
}

/* ------------------------------------------------------------------ *
 * 星空图 / 仪表盘浮窗（每条轨迹一套）
 * ------------------------------------------------------------------ */
const SKY_WINDOW_HINT = '圆点 = 有载噪比（红→黄→绿随 cn0 升高）；黑色三角 = 无载噪比；'
  + '红圈 = 判为非直射（p < 0.5）；青色区域 = 直射带';
const DASH_WINDOW_HINT = '速度表 / 航向指南针 / 当前历元读数';

function loadWindowLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(WINDOW_LAYOUT_KEY) || 'null');
    if (saved && typeof saved === 'object') return saved;
  } catch (error) {
    // 设置损坏时忽略
  }
  return {};
}

function saveWindowLayout() {
  try {
    localStorage.setItem(WINDOW_LAYOUT_KEY, JSON.stringify(state.windowLayout));
  } catch (error) {
    // localStorage 不可用时忽略
  }
}

/** 图例样式 / 图例浮窗的位置、尺寸和显示内容。 */
function loadLegendConfig() {
  const config = {
    display: {
      visible: true,
      datasets: true,
      line: true,
      track: true,
      start: true,
      end: true,
      current: true,
      offset: true,
    },
    styleRect: null,
    legendPos: null,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(LEGEND_LAYOUT_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return config;
    if (saved.display && typeof saved.display === 'object') {
      for (const key of Object.keys(config.display)) {
        if (typeof saved.display[key] === 'boolean') config.display[key] = saved.display[key];
      }
    }
    const style = saved.styleRect;
    if (style && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(Number(style[key])))) {
      config.styleRect = {
        x: Number(style.x), y: Number(style.y), w: Number(style.w), h: Number(style.h),
      };
    }
    const pos = saved.legendPos;
    if (pos && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y))) {
      config.legendPos = { x: Number(pos.x), y: Number(pos.y) };
    }
  } catch (error) {
    // 设置损坏时用默认值
  }
  return config;
}

function saveLegendConfig() {
  try {
    localStorage.setItem(LEGEND_LAYOUT_KEY, JSON.stringify({
      display: state.legend.display,
      styleRect: state.legend.styleRect,
      legendPos: state.legend.legendPos,
    }));
  } catch (error) {
    // localStorage 不可用时忽略
  }
}

function loadMeasurePos() {
  try {
    const saved = JSON.parse(localStorage.getItem(MEASURE_LAYOUT_KEY) || 'null');
    if (saved && Number.isFinite(Number(saved.x)) && Number.isFinite(Number(saved.y))) {
      return { x: Number(saved.x), y: Number(saved.y) };
    }
  } catch (error) {
    // 设置损坏时用默认位置
  }
  return null;
}

function saveMeasurePos() {
  try {
    localStorage.setItem(MEASURE_LAYOUT_KEY, JSON.stringify(state.measure.pos || {}));
  } catch (error) {
    // localStorage 不可用时忽略
  }
}

function bringToFront(element) {
  if (!element) return;
  state.floatZ += 1;
  element.style.zIndex = String(state.floatZ);
}

/** 浮窗位置按「窗口类型 + 文件名」记住，同一个文件重新载入时回到原处。 */
function windowLayoutKey(win) {
  return `${win.kind}:${win.dataset.name}`;
}

function rememberWindowLayout(win) {
  if (!win || !win.el || !win.el.isConnected) return;
  const rect = win.el.getBoundingClientRect();
  state.windowLayout[windowLayoutKey(win)] = {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
  };
  saveWindowLayout();
}

function openWindowCount() {
  let count = 0;
  for (const dataset of state.datasets) {
    if (!dataset.windows) continue;
    for (const kind of WINDOW_ORDER) {
      if (dataset.windows[kind]) count += 1;
    }
  }
  return count;
}

/** 播放控制条底部的位置：新浮窗默认从这里往下排，不盖住顶栏。 */
function transportBottom() {
  const transport = document.querySelector('.transport');
  const bar = document.querySelector('.topbar');
  const bottom = transport
    ? transport.getBoundingClientRect().bottom
    : (bar ? bar.getBoundingClientRect().bottom : 0);
  return Math.round(bottom) + 10;
}

/**
 * 新窗口的默认位置：
 *  - 每条轨迹占一列（右对齐），星空图在上、仪表盘在下，互不遮挡；
 *  - 超过两列后在原列上略微错开，避免把地图完全盖住。
 */
function defaultWindowSpot(dataset, kind) {
  const meta = WINDOW_KINDS[kind];
  const ordinal = Math.max(0, state.datasets.indexOf(dataset));
  const column = ordinal % 2;
  const overflowRow = Math.floor(ordinal / 2);
  const top = transportBottom() + overflowRow * 26;
  const gap = 8;
  const columnWidth = Math.max(WINDOW_KINDS.sky.width, WINDOW_KINDS.dash.width) + 16;
  const columnLeft = window.innerWidth - 16 - columnWidth * (column + 1) + 16;
  const x = Math.max(8, columnLeft + (columnWidth - 16 - meta.width));
  // 一整列（星空图 + 仪表盘）放得下就上下堆叠；屏幕太矮时改为左右并排
  const stacked = top + WINDOW_KINDS.sky.height + gap + WINDOW_KINDS.dash.height
    <= window.innerHeight - 8;
  if (!stacked) {
    const beside = Math.max(8, x - WINDOW_KINDS.dash.width - 12);
    return { x: kind === 'dash' ? beside : x, y: top };
  }
  return { x, y: top + (kind === 'dash' ? WINDOW_KINDS.sky.height + gap : 0) };
}

function placeWindow(win) {
  const meta = WINDOW_KINDS[win.kind];
  const saved = state.windowLayout[windowLayoutKey(win)];
  const top = transportBottom();
  const maxWidth = Math.max(meta.minWidth, window.innerWidth - 8);
  const maxHeight = Math.max(meta.minHeight, window.innerHeight - top - 8);
  const width = Math.round(Math.max(
    meta.minWidth,
    Math.min(saved && saved.w ? saved.w : meta.width, maxWidth),
  ));
  const height = Math.round(Math.max(
    meta.minHeight,
    Math.min(saved && saved.h ? saved.h : meta.height, maxHeight),
  ));
  const spot = defaultWindowSpot(win.dataset, win.kind);
  const x = saved && Number.isFinite(saved.x) ? saved.x : spot.x;
  const y = saved && Number.isFinite(saved.y) ? saved.y : spot.y;
  win.el.style.width = `${width}px`;
  win.el.style.height = `${height}px`;
  win.el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`;
  win.el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`;
}

/** 建一个浮窗骨架：标题栏（轨迹色点 + 名称 + 关闭）× 内容 × 缩放手柄。 */
function buildWindow(dataset, kind) {
  const meta = WINDOW_KINDS[kind];
  const el = document.createElement('section');
  el.className = `panel float-window ${kind}-window`;
  el.dataset.kind = kind;
  el.dataset.datasetId = dataset.id;

  const name = escapeHtml(dataset.name);
  const hint = kind === 'sky' ? SKY_WINDOW_HINT : DASH_WINDOW_HINT;
  el.innerHTML = `
    <div class="panel-head">
      <span class="win-dot" style="background:${dataset.color}"></span>
      <h2 class="win-title" title="${name} · ${escapeHtml(hint)}">${meta.title} · <span class="win-name">${name}</span></h2>
      <div class="head-tools">
        <button class="win-close" type="button" title="关闭${meta.title}（之后可从图例重新打开）">×</button>
      </div>
    </div>
    ${kind === 'sky' ? `
      <div class="chips-bar"><div class="chips win-chips"></div></div>
      <div class="plot win-plot" data-role="plot"></div>
    ` : `
      <div class="dash-grid">
        <div class="gauge-cell">
          <div class="gauge-title">速度 · km/h</div>
          <div class="gauge win-speed" data-role="plot"></div>
        </div>
        <div class="gauge-cell">
          <div class="gauge-title" data-role="course">航向</div>
          <div class="gauge compass-gauge" data-role="compass"></div>
        </div>
        <div class="readouts win-readouts" data-role="readouts"></div>
      </div>
    `}
    <div class="float-resize" title="拖动调整大小"></div>
  `;

  const win = {
    kind,
    dataset,
    el,
    plots: [],
    ready: false,
    chipsEl: el.querySelector('.win-chips'),
    plotEl: el.querySelector('[data-role="plot"]'),
    courseEl: el.querySelector('[data-role="course"]'),
    compassEl: el.querySelector('[data-role="compass"]'),
    readoutsEl: el.querySelector('[data-role="readouts"]'),
    compass: null,
    angle: 0,
  };
  if (win.plotEl) win.plots.push(win.plotEl);

  el.querySelector('.win-close').addEventListener('click', (event) => {
    event.stopPropagation();
    closeDatasetWindow(dataset, kind);
  });

  if (kind === 'sky') {
    buildWindowChips(win);
  } else {
    buildCompass(win);
  }
  return win;
}

function observePlot(element) {
  if (state.resizeObserver && element) {
    try { state.resizeObserver.observe(element); } catch (error) { /* 忽略 */ }
  }
}

function unobservePlot(element) {
  if (state.resizeObserver && element) {
    try { state.resizeObserver.unobserve(element); } catch (error) { /* 忽略 */ }
  }
}

/** 为某条轨迹打开一个浮窗（已经打开时只把它提到最前）。 */
function openDatasetWindow(dataset, kind) {
  if (!dataset || !WINDOW_KINDS[kind]) return null;
  if (!dataset.windows) dataset.windows = { sky: null, dash: null };
  if (dataset.windows[kind]) {
    bringToFront(dataset.windows[kind].el);
    return dataset.windows[kind];
  }

  const win = buildWindow(dataset, kind);
  placeWindow(win);
  dataset.windows[kind] = win;
  document.body.appendChild(win.el);

  attachDatasetWindowDrag(win);
  attachDatasetWindowResize(win);
  bringToFront(win.el);
  renderWindow(win);
  observePlot(win.plotEl);
  updateWindowToggles();

  // 布局稳定后再量一次尺寸，避免 Plotly 按 append 前的容器宽度绘制
  requestAnimationFrame(() => {
    resizeWindowPlots(win);
    requestAnimationFrame(() => resizeWindowPlots(win));
  });
  return win;
}

/** 关闭浮窗并释放 Plotly 实例；remember=false 时不覆盖已保存的位置。 */
function closeDatasetWindow(dataset, kind, options = {}) {
  const { remember = true } = options;
  const win = dataset && dataset.windows && dataset.windows[kind];
  if (!win) return;
  if (remember) rememberWindowLayout(win);

  win.el.remove();
  dataset.windows[kind] = null;
  updateWindowToggles();

  // Plotly.react 的收尾是异步链：立刻 purge 会让仍在跑的链读到已清空的 _fullLayout
  // 而报 "_redrawFromAutoMarginCount" 错误。先把 DOM 摘掉，等这一轮结束再释放实例。
  const plots = win.plots;
  win.plots = [];
  setTimeout(() => {
    for (const plot of plots) {
      unobservePlot(plot);
      try { Plotly.purge(plot); } catch (error) { /* 元素已移除时忽略 */ }
    }
  }, 0);
}

function toggleDatasetWindow(dataset, kind) {
  if (!dataset || !WINDOW_KINDS[kind]) return;
  if (dataset.windows && dataset.windows[kind]) closeDatasetWindow(dataset, kind);
  else openDatasetWindow(dataset, kind);
}

/** 批量打开 / 关闭全部轨迹的全部浮窗。 */
function setAllWindows(open) {
  if (!state.datasets.length) return;
  for (const dataset of state.datasets) {
    for (const kind of WINDOW_ORDER) {
      if (open) openDatasetWindow(dataset, kind);
      else closeDatasetWindow(dataset, kind);
    }
  }
}

function renderWindow(win) {
  if (!win || !win.el || !win.el.isConnected) return;
  if (win.kind === 'sky') renderSkyWindow(win);
  else renderDashWindow(win);
}

function resizeWindowPlots(win) {
  if (!win) return;
  for (const plot of win.plots) {
    try {
      Plotly.Plots.resize(plot);
    } catch (error) {
      // 窗口已关闭或 Plotly 还没画过时忽略
    }
  }
}

/** 图例行里的「星空图 / 仪表盘」按钮状态 + 图例头部的批量开关。 */
function updateWindowToggles() {
  if (dom.legendDatasets) {
    for (const row of dom.legendDatasets.querySelectorAll('.dataset-row')) {
      const dataset = state.datasets.find((item) => item.id === row.dataset.id);
      if (!dataset) continue;
      for (const kind of WINDOW_ORDER) {
        const button = row.querySelector(`.win-toggle[data-kind="${kind}"]`);
        if (!button) continue;
        const open = Boolean(dataset.windows && dataset.windows[kind]);
        button.classList.toggle('on', open);
        button.setAttribute('aria-pressed', String(open));
        button.title = `${open ? '关闭' : '打开'} ${dataset.name} 的${WINDOW_KINDS[kind].title}`;
      }
    }
  }
  updateLegendWindowsButton();
}

function updateLegendWindowsButton() {
  const button = dom.legendWindows;
  if (!button) return;
  const total = state.datasets.length * WINDOW_ORDER.length;
  const open = openWindowCount();
  button.disabled = !state.datasets.length;
  button.textContent = open > 0 ? '收起窗口' : '展开窗口';
  button.title = state.datasets.length
    ? `${open > 0 ? '关闭全部' : '打开全部'}星空图与仪表盘（共 ${total} 个）`
    : '加载数据后可打开星空图与仪表盘';
}

/** 拖动标题栏移动浮窗；松开时记住位置。 */
function attachDatasetWindowDrag(win) {
  const head = win.el.querySelector('.panel-head');
  if (!head) return;
  head.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button, input, select, label')) return;
    event.preventDefault();
    const rect = win.el.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;

    const onMove = (moveEvent) => {
      // 夹在视口内，避免把窗口拖出屏幕后看不到、也拖不回来
      const maxX = Math.max(0, window.innerWidth - rect.width);
      const maxY = Math.max(0, window.innerHeight - rect.height);
      win.el.style.left = `${Math.min(maxX, Math.max(0, moveEvent.clientX - offsetX))}px`;
      win.el.style.top = `${Math.min(maxY, Math.max(0, moveEvent.clientY - offsetY))}px`;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      rememberWindowLayout(win);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    bringToFront(win.el);
  });
}

/** 拖右下角缩放浮窗；松开时记住尺寸并让 Plotly 重新量一次。 */
function attachDatasetWindowResize(win) {
  const handle = win.el.querySelector('.float-resize');
  if (!handle) return;
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const meta = WINDOW_KINDS[win.kind];
    const rect = win.el.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = rect.width;
    const startHeight = rect.height;

    const onMove = (moveEvent) => {
      const width = Math.max(meta.minWidth, Math.min(
        window.innerWidth - rect.left - 4,
        startWidth + moveEvent.clientX - startX,
      ));
      const height = Math.max(meta.minHeight, Math.min(
        window.innerHeight - rect.top - 4,
        startHeight + moveEvent.clientY - startY,
      ));
      win.el.style.width = `${width}px`;
      win.el.style.height = `${height}px`;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      rememberWindowLayout(win);
      resizeWindowPlots(win);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    bringToFront(win.el);
  });
}

/* ------------------------------------------------------------------ *
 * 对比曲线
 * ------------------------------------------------------------------ */
function loadCompareConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(COMPARE_KEY) || 'null');
    if (saved && Array.isArray(saved.metrics)) {
      const metrics = saved.metrics.filter((key) => COMPARE_METRICS[key]);
      if (metrics.length) state.compare.metrics = metrics;
    }
    if (saved && (saved.align === 'absolute' || saved.align === 'relative')) {
      state.compare.align = saved.align;
    }
    const rect = saved && saved.rect;
    if (rect && Number.isFinite(rect.w) && Number.isFinite(rect.h)) {
      state.compare.rect = {
        w: Math.max(COMPARE_MIN_WIDTH, rect.w),
        h: Math.max(COMPARE_MIN_HEIGHT, rect.h),
      };
    }
    if (saved && typeof saved.reference === 'string') {
      state.referenceName = saved.reference;
    }
  } catch (error) {
    // 忽略损坏的配置
  }
}

function saveCompareConfig() {
  try {
    localStorage.setItem(COMPARE_KEY, JSON.stringify({
      metrics: state.compare.metrics,
      align: state.compare.align,
      rect: state.compare.rect,
      reference: state.referenceName,
    }));
  } catch (error) {
    // localStorage 不可用时忽略
  }
}

function loadSatelliteConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAT_KEY) || 'null');
    if (saved && SAT_METRICS[saved.metric]) state.sat.metric = saved.metric;
    if (saved && Array.isArray(saved.systems)) state.sat.systems = saved.systems.slice();
    if (saved && Array.isArray(saved.bands)) state.sat.bands = saved.bands.slice();
    if (saved && Array.isArray(saved.datasets)) state.sat.datasets = saved.datasets.slice();
    if (saved && typeof saved.satellite === 'string') state.sat.satellite = saved.satellite;
    if (saved && saved.rect
        && Number.isFinite(Number(saved.rect.x))
        && Number.isFinite(Number(saved.rect.y))) {
      state.sat.rect = { x: Number(saved.rect.x), y: Number(saved.rect.y) };
      if (Number.isFinite(Number(saved.rect.w)) && Number.isFinite(Number(saved.rect.h))) {
        state.sat.rect.w = Number(saved.rect.w);
        state.sat.rect.h = Number(saved.rect.h);
      }
    }
  } catch (error) {
    // 配置损坏时用默认值
  }
}

function saveSatelliteConfig() {
  try {
    localStorage.setItem(SAT_KEY, JSON.stringify({
      metric: state.sat.metric,
      systems: state.sat.systems,
      bands: state.sat.bands,
      datasets: state.sat.datasets,
      satellite: state.sat.satellite,
      rect: state.sat.rect,
    }));
  } catch (error) {
    // localStorage 不可用时忽略
  }
}

/* ---------------- 水平误差基准（图例里选一条数据） ---------------- */
/** 当前水平误差的基准数据集。 */
function referenceDataset() {
  if (!state.referenceId) return null;
  return state.datasets.find((dataset) => dataset.id === state.referenceId) || null;
}

/** 基准在给定全局相对时刻的位置（线性插值；超出覆盖范围返回 null）。 */
function referencePositionAt(reference, globalSeconds) {
  const times = reference.times;
  if (!times.length) return null;
  const local = globalSeconds - datasetOffset(reference);
  if (local < times[0] - 1e-6 || local > times[times.length - 1] + 1e-6) return null;

  const positionOf = (epoch) => (
    epoch && epoch.lat !== null && epoch.lon !== null
      ? { lat: epoch.lat, lon: epoch.lon }
      : null
  );

  const next = lowerBound(times, local);
  if (next <= 0) return positionOf(reference.epochs[0]);
  if (next >= times.length) return positionOf(reference.epochs[times.length - 1]);

  const start = positionOf(reference.epochs[next - 1]);
  const end = positionOf(reference.epochs[next]);
  if (start && end) {
    const span = times[next] - times[next - 1];
    const ratio = span > 1e-9 ? (local - times[next - 1]) / span : 0;
    return {
      lat: start.lat + (end.lat - start.lat) * ratio,
      lon: start.lon + (end.lon - start.lon) * ratio,
    };
  }
  return start || end;
}

/** 某条轨迹第 index 个历元相对基准的水平误差（米）；没有基准 / 基准不覆盖时返回 null。 */
function datasetHorizontalError(dataset, index) {
  const reference = referenceDataset();
  if (!reference || !dataset || reference === dataset) return null;
  const epoch = dataset.epochs[index];
  if (!epoch || epoch.lat === null || epoch.lon === null) return null;
  if (!Number.isFinite(dataset.times[index])) return null;
  const globalSeconds = datasetOffset(dataset) + dataset.times[index];
  const position = referencePositionAt(reference, globalSeconds);
  if (!position) return null;
  return haversine(epoch.lat, epoch.lon, position.lat, position.lon);
}

/** 图例里切换基准：同一时间只能有一条数据当基准，再点一次取消。 */
function toggleReference(dataset) {
  if (!dataset) return;
  const active = state.referenceId === dataset.id;
  state.referenceId = active ? null : dataset.id;
  state.referenceName = active ? '' : dataset.name;

  if (!state.referenceId && state.compare.metrics.includes('error')) {
    state.compare.metrics = state.compare.metrics.filter((key) => key !== 'error');
    toast('已取消基准，水平误差曲线一并移除');
  } else {
    toast(active ? '已取消水平误差基准' : `水平误差基准：${dataset.name}`);
  }

  saveCompareConfig();
  buildDatasetLegend();
  buildLayerLegend();
  buildCompareChips();
  refreshOffsetTraces();
  updateEpochLabel();
  renderAllWindows();
  updateDatasetLegendFocus();
  renderCompareCursor();
  if (state.compare.open) renderCompare();
  hideTrackHover();
  renderLockCards();
  scheduleLegendWindow();
}

function compareValue(dataset, epoch, key, index = -1) {
  if (key === 'speed') return epoch.speedKmh;
  if (key === 'course') return epoch.course;
  if (key === 'sats') return epoch.numSatsView === null ? (epoch.satellites.size || null) : epoch.numSatsView;
  if (key === 'error') return index >= 0 ? datasetHorizontalError(dataset, index) : null;
  if (key === 'cn0') {
    let sum = 0;
    let count = 0;
    for (const satellite of epoch.satellites.values()) {
      if (satellite.cn0 !== null && satellite.cn0 > 0) {
        sum += satellite.cn0;
        count += 1;
      }
    }
    return count ? sum / count : null;
  }
  return null;
}

/**
 * 对比曲线 x 轴的偏移：
 *  - 相对起点对齐：每条数据从自身 0 秒开始（跨日期也能比）
 *  - 绝对 UTC 对齐：跟随全局时间轴（时间轴本身就是绝对 UTC）
 */
function compareOffset(dataset) {
  return state.compare.align === 'absolute' ? datasetOffset(dataset) : 0;
}

/** 相对起点对齐时，对比曲线的 x 轴与光标以当前聚焦数据的起点为参照。 */
function compareFocusShift() {
  if (state.compare.align === 'absolute') return 0;
  const focus = focusDataset();
  return focus ? datasetOffset(focus) : 0;
}

/**
 * 对比曲线 x 轴数值：
 *  - 绝对 UTC 对齐（有 UTC 基准）：返回日期轴用的 UTC 壁钟毫秒数，刻度/hover 显示 UTC；
 *  - 相对起点对齐 / 数据没有时间戳：仍然用相对秒。
 */
function compareAxisValue(relativeSeconds) {
  if (state.compare.align !== 'absolute') return relativeSeconds;
  const baseline = utcBaseline();
  if (baseline === null) return relativeSeconds;
  return utcWallClockMs(baseline + relativeSeconds);
}

/**
 * 日期轴的 range 端点 → 轴上的「UTC 壁钟毫秒」。
 * Plotly 会把日期轴的 range 存成 'YYYY-MM-DD HH:MM:SS.sss' 字符串（按本地时区解析会偏时区），
 * 这里按 UTC 解析后再转回壁钟毫秒，缩放按钮反复点击才不会漂移。
 */
function compareAxisMs(value) {
  if (typeof value === 'number') return value;
  const text = String(value || '').trim();
  if (!text) return NaN;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? utcWallClockMs(parsed / 1000) : NaN;
}

/** 全局绝对秒 → 对比曲线 x 坐标。 */
function compareX(seconds) {
  const relative = Math.max(0, (seconds - state.origin) - compareFocusShift());
  return compareAxisValue(relative);
}

/** 时间窗在对比曲线 x 轴上的区间。 */
function compareWindowRange() {
  const shift = compareFocusShift();
  return [
    compareAxisValue(state.window.start - shift),
    compareAxisValue(state.window.end - shift),
  ];
}

/** 把数据集转换成对比曲线坐标（相对起点对齐时 x 从 0 开始）。 */
function compareSeries(dataset, key) {
  const offset = compareOffset(dataset);
  const x = [];
  const y = [];
  for (let i = 0; i < dataset.epochs.length; i += 1) {
    x.push(compareAxisValue(dataset.times[i] + offset));
    y.push(compareValue(dataset, dataset.epochs[i], key, i));
  }
  return { x, y };
}

function cursorShape(seconds) {
  return {
    type: 'line',
    x0: seconds,
    x1: seconds,
    y0: 0,
    y1: 1,
    yref: 'paper',
    line: { color: '#f59e0b', width: 1.2, dash: 'dot' },
  };
}

function compareFigure(metrics, datasets) {
  const data = [];
  const layout = {
    margin: { l: 54, r: 16, t: 8, b: 26 },
    paper_bgcolor: '#ffffff',
    plot_bgcolor: '#ffffff',
    showlegend: true,
    legend: {
      orientation: 'h', y: 1.04, x: 0, font: { size: 9, color: '#475569' }, bgcolor: 'rgba(0,0,0,0)',
    },
    hovermode: 'x unified',
    dragmode: 'pan',
    shapes: [cursorShape(compareX(state.now))],
  };

  const absoluteDateAxis = state.compare.align === 'absolute' && utcBaseline() !== null;
  const dateStyle = absoluteDateAxis ? utcDateStyle(utcBaseline()) : 'none';

  const count = metrics.length;
  const suffixList = metrics.map((key, index) => (index === 0 ? '' : String(index + 1)));
  metrics.forEach((key, k) => {
    const meta = COMPARE_METRICS[key];
    const suffix = k === 0 ? '' : String(k + 1);
    const yName = `y${suffix}`;
    layout[`yaxis${suffix}`] = {
      domain: [1 - (k + 1) / count + 0.05, 1 - k / count - 0.015],
      title: { text: `${meta.name}${meta.unit ? ` (${meta.unit})` : ''}`, font: { size: 9, color: '#64748b' } },
      tickfont: { size: 8, color: '#64748b' },
      gridcolor: '#eef2f7',
      zeroline: false,
    };
    layout[`xaxis${suffix}`] = {
      domain: [0, 1],
      anchor: yName,
      showticklabels: k === count - 1,
      tickfont: { size: 8, color: '#64748b' },
      gridcolor: '#eef2f7',
      zeroline: false,
    };
    if (k > 0) layout[`xaxis${suffix}`].matches = 'x';

    for (const dataset of datasets) {
      const series = compareSeries(dataset, key);
      data.push({
        type: 'scatter',
        mode: 'lines',
        x: series.x,
        y: series.y,
        xaxis: k === 0 ? 'x' : `x${k + 1}`,
        yaxis: yName,
        name: dataset.name,
        meta: { datasetId: dataset.id, metric: key },
        // 图例只在第一个子图生成，否则同名数据集会重复出现
        showlegend: k === 0,
        line: { color: dataset.color, width: 1.6 },
        connectgaps: false,
        hovertemplate: absoluteDateAxis
          ? `${dataset.name}　%{y:.2f} ${meta.unit}<extra></extra>`
          : `${dataset.name}　%{x:.1f} s<br>%{y:.2f} ${meta.unit}<extra></extra>`,
      });
    }
  });

  // 对比曲线只看时间窗内的区间（窗口为全时段时交给 Plotly 自适应）
  // 必须写在子图轴构建之后，否则会被 k=0 的 xaxis 定义覆盖。
  // 每个子图的 x 轴都写上区间：matches 同步在首次绘制时不一定生效。
  if (!windowIsFull()) {
    const range = compareWindowRange();
    for (const suffix of suffixList) {
      layout[`xaxis${suffix}`] = {
        ...(layout[`xaxis${suffix}`] || {}),
        range: range.slice(),
        autorange: false,
      };
    }
  }

  // 绝对 UTC 对齐：x 轴用日期刻度，刻度/hover 都显示 UTC 时钟而不是几十万秒
  if (absoluteDateAxis) {
    for (const suffix of suffixList) {
      layout[`xaxis${suffix}`] = {
        ...(layout[`xaxis${suffix}`] || {}),
        type: 'date',
        hoverformat: dateStyle === 'year'
          ? '%Y-%m-%d %H:%M:%S'
          : (dateStyle === 'month' ? '%m-%d %H:%M:%S' : '%H:%M:%S'),
        tickformatstops: [
          { dtickrange: [null, 1000], value: '%H:%M:%S.%L' },
          { dtickrange: [1000, 60000], value: '%H:%M:%S' },
          { dtickrange: [60000, 3600000], value: '%H:%M' },
          { dtickrange: [3600000, 86400000], value: '%m-%d %H:%M' },
          { dtickrange: [86400000, 31536000000], value: '%m-%d' },
          { dtickrange: [31536000000, null], value: '%Y-%m' },
        ],
      };
    }
  } else {
    // 从日期轴切回相对秒时要把日期格式显式清掉，否则 Plotly.react 会沿用旧配置
    for (const suffix of suffixList) {
      layout[`xaxis${suffix}`] = {
        ...(layout[`xaxis${suffix}`] || {}),
        type: 'linear',
        hoverformat: '',
        tickformatstops: [],
      };
    }
  }

  return { data, layout };
}

function compareEmptyLayout(message) {
  return {
    margin: { l: 20, r: 20, t: 20, b: 20 },
    paper_bgcolor: '#ffffff',
    plot_bgcolor: '#ffffff',
    xaxis: { visible: false },
    yaxis: { visible: false },
    annotations: [{
      text: message,
      xref: 'paper', yref: 'paper', x: 0.5, y: 0.5,
      showarrow: false, font: { size: 11, color: '#94a3b8' },
    }],
  };
}

function renderCompare() {
  if (!state.compare.open || !dom.comparePlot) return;
  const metrics = state.compare.metrics.filter((key) => COMPARE_METRICS[key]);
  const datasets = state.datasets.filter((dataset) => state.compare.datasets.has(dataset.id));

  if (!state.datasets.length) {
    Plotly.react('compare-plot', [], compareEmptyLayout('拖入 NMEA 文件后可对比多条数据'), PLOT_CONFIG);
  } else if (!metrics.length) {
    Plotly.react('compare-plot', [], compareEmptyLayout('至少选择一项指标'), PLOT_CONFIG);
  } else if (!datasets.length) {
    Plotly.react('compare-plot', [], compareEmptyLayout('至少选择一条数据'), PLOT_CONFIG);
  } else {
    const figure = compareFigure(metrics, datasets);
    Plotly.react('compare-plot', figure.data, figure.layout, PLOT_CONFIG);
  }
  state.compareReady = true;
  bindCompareClick();
  renderCompareCursor();
}

function renderCompareCursor() {
  if (!state.compare.open || !state.compareReady || !state.datasets.length) return;
  const element = document.getElementById('compare-plot');
  if (!element) return;
  const result = Plotly.relayout(element, { shapes: [cursorShape(compareX(state.now))] });
  if (result && typeof result.catch === 'function') result.catch(() => {});
}

function buildCompareChips() {
  if (dom.compareAlign) {
    dom.compareAlign.innerHTML = '';
    for (const [value, label, hint] of [
      ['relative', '相对起点', '定位结果对比：每条数据从自己的起点开始（跨日期也能比）。时间轴/时间窗本身始终是绝对 UTC。'],
      ['absolute', '绝对 UTC', '定位结果对比：按真实 UTC 时间对齐（同一天多次采集适用）。时间轴/时间窗本身始终是绝对 UTC。'],
    ]) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = label;
      chip.title = hint;
      chip.classList.toggle('off', state.compare.align !== value);
      chip.addEventListener('click', () => setAlign(value));
      dom.compareAlign.appendChild(chip);
    }
  }

  if (dom.compareMetrics) {
    dom.compareMetrics.innerHTML = '';
    const hasReference = Boolean(referenceDataset());
    for (const [key, meta] of Object.entries(COMPARE_METRICS)) {
      const needsReference = key === 'error';
      const unavailable = needsReference && !hasReference;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = `${meta.name}${meta.unit ? ` (${meta.unit})` : ''}`;
      chip.classList.toggle('off', unavailable || !state.compare.metrics.includes(key));
      chip.title = unavailable
        ? '先在图例里选择一条数据作为基准'
        : (needsReference ? '同一时刻与本轨迹位置的水平距离，相对图例里选定的基准' : meta.name);
      chip.addEventListener('click', () => {
        if (unavailable) {
          toast('先在图例里选择一条数据作为基准', true);
          return;
        }
        const active = state.compare.metrics.includes(key);
        if (active && state.compare.metrics.length === 1) {
          toast('至少保留一项对比指标。', true);
          return;
        }
        state.compare.metrics = active
          ? state.compare.metrics.filter((item) => item !== key)
          : [...state.compare.metrics, key];
        saveCompareConfig();
        buildCompareChips();
        renderCompare();
      });
      dom.compareMetrics.appendChild(chip);
    }
  }

  if (dom.compareDatasets) {
    dom.compareDatasets.innerHTML = '';
    if (!state.datasets.length) {
      const empty = document.createElement('span');
      empty.className = 'compare-empty';
      empty.textContent = '暂无数据';
      dom.compareDatasets.appendChild(empty);
    }
    for (const dataset of state.datasets) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.innerHTML = `<span class="swatch" style="background:${dataset.color}"></span>${dataset.name}`;
      chip.classList.toggle('off', !state.compare.datasets.has(dataset.id));
      chip.addEventListener('click', () => {
        if (state.compare.datasets.has(dataset.id)) state.compare.datasets.delete(dataset.id);
        else state.compare.datasets.add(dataset.id);
        buildCompareChips();
        renderCompare();
      });
      dom.compareDatasets.appendChild(chip);
    }
  }
}

/** 对比窗首次打开时摆到地图左侧（图例右边）；用户拖过 / 缩放过后不再自动摆位。 */
function placeCompareWindow() {
  const element = dom.compareWindow;
  if (!element || element.dataset.placed === '1') return;
  const saved = state.compare.rect || {};
  const maxWidth = Math.max(COMPARE_MIN_WIDTH, window.innerWidth - 24);
  const maxHeight = Math.max(COMPARE_MIN_HEIGHT, window.innerHeight - 100);
  const width = Math.min(maxWidth, Math.max(COMPARE_MIN_WIDTH, saved.w || 620));
  const height = Math.min(maxHeight, Math.max(COMPARE_MIN_HEIGHT, saved.h || 420));
  // 上方留出顶栏 / 控制条，左边避开地图图例，下方留出继续放大的空间
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, 320));
  const top = Math.min(
    Math.max(60, transportBottom() + 8),
    Math.max(60, window.innerHeight - height - 80),
  );
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
  element.style.right = 'auto';
  element.style.bottom = 'auto';
  element.dataset.placed = '1';
}

function setCompareOpen(open) {
  state.compare.open = open;
  if (dom.compareWindow) dom.compareWindow.hidden = !open;
  if (dom.btnCompare) dom.btnCompare.setAttribute('aria-pressed', String(open));
  if (open) {
    placeCompareWindow();
    if (state.sat.open && !state.sat.rect) placeSatelliteWindow();
    buildCompareChips();
    renderCompare();
    // 浮窗（星空图 / 仪表盘）默认是 41+，对比曲线打开时要压在最上面
    if (dom.compareWindow) bringToFront(dom.compareWindow);
  }
}

/** 切换对比曲线的对齐方式；全局时间轴始终是绝对 UTC，不受这里影响。 */
function setAlign(align) {
  if (state.compare.align === align) return;
  state.compare.align = align;
  saveCompareConfig();
  buildCompareChips();
  renderCompare();
  toast(align === 'absolute' ? '定位结果对比改为绝对 UTC 对齐' : '定位结果对比改为各自起点对齐');
}

function resetCompare() {
  state.compare.metrics = DEFAULT_COMPARE_METRICS.slice();
  state.compare.align = DEFAULT_COMPARE_ALIGN;
  state.compare.datasets = new Set(state.datasets.map((dataset) => dataset.id));
  saveCompareConfig();
  buildCompareChips();
  renderCompare();
  toast('对比配置已恢复默认（绝对 UTC 对齐）');
}

function rememberCompareRect() {
  if (!dom.compareWindow) return;
  const rect = dom.compareWindow.getBoundingClientRect();
  state.compare.rect = { w: Math.round(rect.width), h: Math.round(rect.height) };
  saveCompareConfig();
}

/** 拖右下角缩放对比窗；尺寸写入 localStorage，图表由 ResizeObserver 重排。 */
function attachCompareResize() {
  const element = dom.compareWindow;
  const handle = element && element.querySelector('.float-resize');
  if (!handle || handle.__resizeBound) return;
  handle.__resizeBound = true;

  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = element.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = rect.width;
    const startHeight = rect.height;

    const onMove = (moveEvent) => {
      const width = Math.max(COMPARE_MIN_WIDTH, Math.min(
        window.innerWidth - rect.left - 4,
        startWidth + moveEvent.clientX - startX,
      ));
      const height = Math.max(COMPARE_MIN_HEIGHT, Math.min(
        window.innerHeight - rect.top - 4,
        startHeight + moveEvent.clientY - startY,
      ));
      element.style.width = `${width}px`;
      element.style.height = `${height}px`;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      rememberCompareRect();
      if (state.compareReady) {
        try { Plotly.Plots.resize('compare-plot'); } catch (error) { /* 忽略 */ }
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

/**
 * 对比曲线缩放：x 轴按比例收放，各子图的 x 轴通过 matches 一起跟随。
 * 滚轮缩放由 Plotly 的 scrollZoom 负责，这里的按钮走同一套 x 轴范围。
 */
function compareZoom(factor) {
  if (!state.compare.open) return;
  const element = document.getElementById('compare-plot');
  const axis = element && element._fullLayout && element._fullLayout.xaxis;
  if (!axis || !axis.range) return;
  const left = compareAxisMs(axis.range[0]);
  const right = compareAxisMs(axis.range[1]);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return;
  const center = (left + right) / 2;
  // 日期轴的单位是毫秒，线性轴是秒；最小可视跨度分别取 1 s
  const minimumHalf = axis.type === 'date' ? 500 : 0.25;
  const half = Math.max(minimumHalf, ((right - left) / 2) * factor);
  const result = Plotly.relayout(element, { 'xaxis.range': [center - half, center + half] });
  if (result && typeof result.catch === 'function') result.catch(() => {});
}

/** 对比曲线缩放复位：x 轴回到时间窗区间（全时段时自适应），各 y 轴重新自适应。 */
function resetCompareZoom() {
  if (!state.compare.open) return;
  const element = document.getElementById('compare-plot');
  if (!element) return;
  const full = windowIsFull();
  const range = full ? null : compareWindowRange();
  const layout = {};
  state.compare.metrics.forEach((key, k) => {
    const suffix = k === 0 ? '' : String(k + 1);
    if (full) {
      layout[`xaxis${suffix}.autorange`] = true;
    } else {
      layout[`xaxis${suffix}.range`] = range.slice();
      layout[`xaxis${suffix}.autorange`] = false;
    }
    layout[`yaxis${suffix}.autorange`] = true;
  });
  const result = Plotly.relayout(element, layout);
  if (result && typeof result.catch === 'function') result.catch(() => {});
}

/** 对比曲线上的点 → 全局时间 + 当前数据集，带动地图 / 星空图 / 仪表盘。 */
function bindCompareClick() {
  const element = document.getElementById('compare-plot');
  if (!element || typeof element.on !== 'function' || element.__compareClickBound) return;
  element.__compareClickBound = true;
  // 双击图表：等 Plotly 内置的 reset 落定后，再按当前时间窗复位缩放
  element.on('plotly_doubleclick', () => setTimeout(resetCompareZoom, 0));
  element.on('plotly_click', (event) => {
    const point = event.points && event.points[0];
    if (!point) return;
    const datasetId = point.data && point.data.meta && point.data.meta.datasetId;
    const dataset = datasetId ? state.datasets.find((item) => item.id === datasetId) : null;
    // 绝对 UTC 对齐时 x 轴是日期轴，point.x 是格式化后的日期，不能直接当秒用；
    // 按点下标回到数据集自己的时间轴最稳（相对起点对齐也适用）。
    const index = Number(point.pointNumber);
    let relative = null;
    if (dataset && Number.isInteger(index) && Number.isFinite(dataset.times[index])) {
      relative = datasetOffset(dataset) + dataset.times[index];
    } else if (state.compare.align === 'relative' && Number.isFinite(Number(point.x))) {
      relative = Number(point.x);
    }
    if (relative === null) return;
    // 图表被平移/缩放后可能点到时间窗外的点：让时间窗跟过去，保持游标与读数一致
    seekTo(relative, { followWindow: true });
    if (datasetId) setFocus(datasetId);
    else renderEpoch();
  });
}

/* ------------------------------------------------------------------ *
 * 卫星对比
 *
 * 直接使用 NMEA 里解析出的 GSV/GSA 卫星：既可以按系统对比搜星数 /
 * 平均 CN0，也可以固定一颗卫星对比多份数据的 CN0。x 轴始终跟随
 * 全局绝对 UTC 时间窗。
 * ------------------------------------------------------------------ */
function satelliteSystemList() {
  const present = new Set();
  for (const dataset of state.datasets) {
    for (const system of Object.keys((dataset.summary && dataset.summary.systems) || {})) {
      present.add(system);
    }
  }
  return [...present].sort((a, b) => {
    const ai = SAT_SYSTEM_ORDER.indexOf(a);
    const bi = SAT_SYSTEM_ORDER.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.localeCompare(b);
  });
}

function satelliteSelectedSystems() {
  const present = satelliteSystemList();
  if (state.sat.systems === null) return new Set(present);
  return new Set(state.sat.systems.filter((system) => present.includes(system)));
}

/** 卫星信号频点：NMEA 4.10 的 signalId 映射为 L1/L5/B1I 等，没有 signalId 时归为「默认」。 */
function satelliteBandOf(satellite) {
  const signal = satellite && satellite.signal ? String(satellite.signal) : '';
  if (!signal) return '默认';
  const map = SIGNAL_BANDS[satellite.system];
  const numeric = Number(signal);
  const key = Number.isFinite(numeric) ? String(numeric) : signal;
  return (map && map[key]) || `频点 ${signal}`;
}

/** 在系统基色上做明暗变化，让同系统的不同频点也能区分。 */
function mixHexColor(hex, amount) {
  const value = String(hex || '').replace('#', '');
  const full = value.length === 3 ? value.split('').map((char) => char + char).join('') : value;
  const number = Number.parseInt(full, 16);
  if (!Number.isFinite(number)) return hex;
  const target = amount >= 0 ? 255 : 0;
  const weight = Math.min(1, Math.abs(amount));
  const channel = (shift) => {
    const base = (number >> shift) & 255;
    return Math.round(base + (target - base) * weight);
  };
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

function satelliteCurveColor(system, band, bands) {
  const base = SYSTEM_COLORS[system] || '#64748b';
  const index = Math.max(0, bands.indexOf(band));
  const adjustments = [0, 0.24, -0.18, 0.4, -0.32, 0.52];
  return mixHexColor(base, adjustments[index % adjustments.length]);
}

/** 数据集只用实线 / 点线；数据更多时加粗，避免回到虚线。 */
function satelliteDatasetStyle(index) {
  const dotted = index % SAT_DATASET_DASH.length === 1;
  return {
    dash: SAT_DATASET_DASH[index % SAT_DATASET_DASH.length],
    width: (dotted ? 2 : 1.5) + Math.floor(index / SAT_DATASET_DASH.length) * 0.7,
  };
}

function satelliteLegendLayout(dataCount, plotWidth, plotHeight) {
  const perRow = plotWidth >= 900 ? 3 : 2;
  const rows = Math.max(1, Math.ceil(dataCount / perRow));
  const desired = 14 + rows * 18;
  const maxTop = Math.max(28, plotHeight - 140 - 28);
  return {
    marginTop: Math.min(desired, maxTop),
    desired,
    rows,
    perRow,
  };
}

function syncSatelliteLegendMargin() {
  if (!state.sat.open || !state.satReady || !dom.satPlot || !dom.satPlot._fullLayout) return;
  const element = dom.satPlot;
  const legendLayout = satelliteLegendLayout(
    element.data.length,
    element.clientWidth,
    element.clientHeight,
  );
  if (Math.abs((element._fullLayout.margin.t || 0) - legendLayout.marginTop) < 0.5) return;
  try {
    const result = Plotly.relayout(element, { 'margin.t': legendLayout.marginTop });
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (error) {
    // 浮窗正在关闭 / 重排时忽略
  }
}

/** 图例置顶后保证实际绘图区不被压扁；必要时自动把卫星窗口拉高。 */
function ensureSatellitePlotHeight() {
  if (!state.sat.open || !state.satReady || !dom.satWindow || !dom.satPlot) return;
  const layout = dom.satPlot._fullLayout;
  if (!layout || !layout._size) return;
  const minPlotHeight = 200;
  if (layout._size.h >= minPlotHeight) return;

  const rect = dom.satWindow.getBoundingClientRect();
  const maxHeight = Math.max(SAT_MIN_HEIGHT, window.innerHeight - 20);
  const nextHeight = Math.min(rect.height + (minPlotHeight - layout._size.h) + 32, maxHeight);
  if (nextHeight <= rect.height + 2) return;

  const nextTop = Math.max(4, Math.min(rect.top, window.innerHeight - nextHeight - 4));
  dom.satWindow.style.height = `${nextHeight}px`;
  dom.satWindow.style.top = `${nextTop}px`;
  try {
    Plotly.Plots.resize('sat-plot');
  } catch (error) {
    // 窗口正在关闭时忽略
  }
  syncSatelliteLegendMargin();
  rememberSatelliteRect();
}

function satelliteSignalKey(satellite) {
  return `${satellite.system}|${satellite.prn}|${satellite.signal || 'default'}`;
}

/** 同一历元下优先用带 signalId 的 GSV；老数据回退到 satellites。 */
function satelliteSignalEntries(epoch) {
  if (!epoch) return [];
  if (epoch.signals && epoch.signals.size) return [...epoch.signals.values()];
  return [...epoch.satellites.values()];
}

function satelliteBandList() {
  const present = new Set();
  for (const dataset of state.datasets) {
    for (const epoch of dataset.epochs) {
      for (const satellite of satelliteSignalEntries(epoch)) {
        present.add(satelliteBandOf(satellite));
      }
    }
  }
  return [...present].sort((a, b) => {
    const ai = SAT_BAND_ORDER.indexOf(a);
    const bi = SAT_BAND_ORDER.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.localeCompare(b);
  });
}

function satelliteSelectedBands() {
  const present = satelliteBandList();
  if (state.sat.bands === null) return new Set(present);
  return new Set(state.sat.bands.filter((band) => present.includes(band)));
}

function satelliteSelectedDatasets() {
  if (state.sat.datasets === null) return new Set(state.datasets.map((dataset) => dataset.id));
  const present = new Set(state.datasets.map((dataset) => dataset.id));
  return new Set(state.sat.datasets.filter((id) => present.has(id)));
}

function satelliteAxisValue(relativeSeconds) {
  const baseline = utcBaseline();
  if (baseline === null) return relativeSeconds;
  return utcWallClockMs(baseline + relativeSeconds);
}

function satelliteX(seconds) {
  return satelliteAxisValue(Math.max(0, seconds - state.origin));
}

function satelliteWindowRange() {
  return [
    satelliteAxisValue(state.window.start),
    satelliteAxisValue(state.window.end),
  ];
}

function satelliteBandSeries(dataset, system, band, metric) {
  const x = [];
  const y = [];
  const t = [];
  let present = false;
  const offset = datasetOffset(dataset);
  for (let i = 0; i < dataset.epochs.length; i += 1) {
    if (!Number.isFinite(dataset.times[i])) continue;
    const epoch = dataset.epochs[i];
    let count = 0;
    let sum = 0;
    let cn0Count = 0;
    if (epoch) {
      // 同一颗卫星在一个频点上可能有多个 signalId，按 prn 去重，CN0 取最好值
      const perPrn = new Map();
      for (const satellite of satelliteSignalEntries(epoch)) {
        if (satellite.system !== system || satelliteBandOf(satellite) !== band) continue;
        present = true;
        const previous = perPrn.get(satellite.prn);
        if (!previous || (satellite.cn0 || 0) > (previous.cn0 || 0)) {
          perPrn.set(satellite.prn, satellite);
        }
      }
      count = perPrn.size;
      for (const satellite of perPrn.values()) {
        if (satellite.cn0 !== null && satellite.cn0 > 0) {
          sum += satellite.cn0;
          cn0Count += 1;
        }
      }
    }
    const relative = offset + dataset.times[i];
    x.push(satelliteAxisValue(relative));
    y.push(metric === 'counts' ? count : (cn0Count ? sum / cn0Count : null));
    t.push(relative);
  }
  return { x, y, t, present };
}

function satelliteSingleSeries(dataset, key) {
  const x = [];
  const y = [];
  const t = [];
  const offset = datasetOffset(dataset);
  const parts = splitSatelliteKey(key);
  for (let i = 0; i < dataset.epochs.length; i += 1) {
    if (!Number.isFinite(dataset.times[i])) continue;
    const epoch = dataset.epochs[i];
    let satellite = null;
    if (epoch) {
      if (epoch.signals && epoch.signals.size) satellite = epoch.signals.get(key);
      else if (parts && parts.signal === 'default') {
        satellite = epoch.satellites.get(`${parts.system}|${parts.prn}`);
      }
    }
    const relative = offset + dataset.times[i];
    x.push(satelliteAxisValue(relative));
    y.push(satellite && satellite.cn0 !== null && satellite.cn0 > 0 ? satellite.cn0 : null);
    t.push(relative);
  }
  return { x, y, t };
}

function splitSatelliteKey(key) {
  const parts = String(key || '').split('|');
  if (parts.length < 2) return null;
  return {
    system: parts[0],
    prn: parts[1],
    signal: parts.slice(2).join('|') || 'default',
  };
}

/** 单星下拉：按选中的系统 / 频点筛选，信号级去重。 */
function satelliteOptionList(systems, bands) {
  const entries = new Map();
  const selectedIds = satelliteSelectedDatasets();
  for (const dataset of state.datasets) {
    if (!selectedIds.has(dataset.id)) continue;
    for (const epoch of dataset.epochs) {
      for (const satellite of satelliteSignalEntries(epoch)) {
        if (!systems.has(satellite.system)) continue;
        const band = satelliteBandOf(satellite);
        if (!bands.has(band)) continue;
        const key = satelliteSignalKey(satellite);
        let entry = entries.get(key);
        if (!entry) {
          entry = {
            key,
            system: satellite.system,
            prn: satellite.prn,
            band,
            cn0Count: 0,
          };
          entries.set(key, entry);
        }
        if (satellite.cn0 !== null && satellite.cn0 > 0) entry.cn0Count += 1;
      }
    }
  }
  const systemOrder = (system) => {
    const index = SAT_SYSTEM_ORDER.indexOf(system);
    return index < 0 ? 99 : index;
  };
  const bandOrder = (band) => {
    const index = SAT_BAND_ORDER.indexOf(band);
    return index < 0 ? 99 : index;
  };
  return [...entries.values()].sort((a, b) => systemOrder(a.system) - systemOrder(b.system)
    || bandOrder(a.band) - bandOrder(b.band)
    || (Number(a.prn) || 0) - (Number(b.prn) || 0)
    || String(a.prn).localeCompare(String(b.prn)));
}

function buildSatelliteChips() {
  if (dom.satMetrics) {
    dom.satMetrics.innerHTML = '';
    for (const [key, meta] of Object.entries(SAT_METRICS)) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = meta.name;
      chip.title = meta.name;
      chip.classList.toggle('off', state.sat.metric !== key);
      chip.addEventListener('click', () => {
        if (state.sat.metric === key) return;
        state.sat.metric = key;
        saveSatelliteConfig();
        buildSatelliteChips();
        renderSatellite();
      });
      dom.satMetrics.appendChild(chip);
    }
  }

  if (dom.satSystems) {
    dom.satSystems.innerHTML = '';
    const systems = satelliteSystemList();
    if (!systems.length) {
      const empty = document.createElement('span');
      empty.className = 'compare-empty';
      empty.textContent = '暂无卫星数据';
      dom.satSystems.appendChild(empty);
    }
    const selected = satelliteSelectedSystems();
    for (const system of systems) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = SYSTEM_COLORS[system] || '#94a3b8';
      chip.append(swatch, document.createTextNode(system));
      chip.classList.toggle('off', !selected.has(system));
      chip.addEventListener('click', () => {
        const current = satelliteSelectedSystems();
        if (current.has(system)) current.delete(system);
        else current.add(system);
        state.sat.systems = [...current];
        saveSatelliteConfig();
        buildSatelliteChips();
        renderSatellite();
      });
      dom.satSystems.appendChild(chip);
    }
  }

  if (dom.satBands) {
    dom.satBands.innerHTML = '';
    const bands = satelliteBandList();
    if (!bands.length) {
      const empty = document.createElement('span');
      empty.className = 'compare-empty';
      empty.textContent = '暂无频点';
      dom.satBands.appendChild(empty);
    }
    const selected = satelliteSelectedBands();
    for (const band of bands) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = band;
      chip.title = `卫星信号频点 ${band}`;
      chip.classList.toggle('off', !selected.has(band));
      chip.addEventListener('click', () => {
        const current = satelliteSelectedBands();
        if (current.has(band)) current.delete(band);
        else current.add(band);
        state.sat.bands = [...current];
        saveSatelliteConfig();
        buildSatelliteChips();
        renderSatellite();
      });
      dom.satBands.appendChild(chip);
    }
  }

  if (dom.satDatasets) {
    dom.satDatasets.innerHTML = '';
    if (!state.datasets.length) {
      const empty = document.createElement('span');
      empty.className = 'compare-empty';
      empty.textContent = '暂无数据';
      dom.satDatasets.appendChild(empty);
    }
    const selected = satelliteSelectedDatasets();
    for (const dataset of state.datasets) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = dataset.color;
      chip.append(swatch, document.createTextNode(dataset.name));
      chip.classList.toggle('off', !selected.has(dataset.id));
      chip.addEventListener('click', () => {
        const current = satelliteSelectedDatasets();
        if (current.has(dataset.id)) current.delete(dataset.id);
        else current.add(dataset.id);
        state.sat.datasets = [...current];
        saveSatelliteConfig();
        buildSatelliteChips();
        renderSatellite();
      });
      dom.satDatasets.appendChild(chip);
    }
  }

  if (dom.satSatelliteRow) dom.satSatelliteRow.hidden = state.sat.metric !== 'one';
  if (dom.satSatellite && state.sat.metric === 'one') {
    const selectedSystems = satelliteSelectedSystems();
    const selectedBands = satelliteSelectedBands();
    const options = satelliteOptionList(selectedSystems, selectedBands);
    let current = state.sat.satellite;
    if (!options.some((option) => option.key === current)) {
      const preferred = options.find((option) => option.cn0Count > 0) || options[0];
      current = preferred ? preferred.key : null;
      state.sat.satellite = current;
      saveSatelliteConfig();
    }
    dom.satSatellite.innerHTML = '';
    if (!options.length) {
      const option = document.createElement('option');
      option.textContent = '无卫星数据';
      option.value = '';
      dom.satSatellite.appendChild(option);
      dom.satSatellite.disabled = true;
    } else {
      dom.satSatellite.disabled = false;
      for (const item of options) {
        const option = document.createElement('option');
        option.value = item.key;
        option.textContent = `${SYSTEM_PREFIX[item.system] || ''}${item.prn} · ${item.system} · ${item.band}`;
        option.selected = item.key === current;
        dom.satSatellite.appendChild(option);
      }
    }
  }
}

function satelliteFigure(metric, datasets, systems, bands) {
  const data = [];
  const meta = SAT_METRICS[metric];
  if (metric === 'one') {
    const parts = splitSatelliteKey(state.sat.satellite);
    if (!parts) return { data, layout: compareEmptyLayout('选择一颗卫星') };
    const band = satelliteBandOf({
      system: parts.system,
      signal: parts.signal === 'default' ? '' : parts.signal,
    });
    for (const dataset of datasets) {
      const series = satelliteSingleSeries(dataset, state.sat.satellite);
      if (!series.y.some((value) => value !== null)) continue;
      data.push({
        type: 'scatter',
        mode: 'lines',
        x: series.x,
        y: series.y,
        customdata: series.t,
        name: `${dataset.name} · ${parts.system} · ${band}`,
        meta: { datasetId: dataset.id, system: parts.system, band, metric },
        line: { color: dataset.color, width: 1.6, dash: 'solid' },
        connectgaps: false,
        hovertemplate: `${escapeHtml(dataset.name)} · ${parts.system} · ${band}<br>%{y:.1f} dB-Hz<extra></extra>`,
      });
    }
  } else {
    for (let datasetIndex = 0; datasetIndex < datasets.length; datasetIndex += 1) {
      const dataset = datasets[datasetIndex];
      const datasetStyle = satelliteDatasetStyle(datasetIndex);
      for (const system of systems) {
        if (!dataset.summary || !(system in dataset.summary.systems)) continue;
        for (let bandIndex = 0; bandIndex < bands.length; bandIndex += 1) {
          const band = bands[bandIndex];
          const series = satelliteBandSeries(dataset, system, band, metric);
          if (!series.present) continue;
          if (!series.y.some((value) => value !== null)) continue;
          const style = datasets.length > 1
            ? datasetStyle
            : {
              dash: bandIndex % 2 === 0 ? 'solid' : SAT_DATASET_DASH[1],
              width: bandIndex % 2 === 0 ? 1.5 : 2,
            };
          data.push({
            type: 'scatter',
            mode: 'lines',
            x: series.x,
            y: series.y,
            customdata: series.t,
            name: `${dataset.name} · ${system} · ${band}`,
            meta: { datasetId: dataset.id, system, band, metric },
            line: {
              color: satelliteCurveColor(system, band, bands),
              width: style.width,
              dash: style.dash,
              shape: metric === 'counts' ? 'hv' : 'linear',
            },
            connectgaps: false,
            hovertemplate: metric === 'counts'
              ? `${escapeHtml(dataset.name)} · ${system} · ${band}<br>%{y:.0f} 颗<extra></extra>`
              : `${escapeHtml(dataset.name)} · ${system} · ${band}<br>%{y:.1f} dB-Hz<extra></extra>`,
          });
        }
      }
    }
  }

  const baseline = utcBaseline();
  const dateAxis = baseline !== null;
  const dateStyle = dateAxis ? utcDateStyle(baseline) : 'none';
  const plotWidth = (dom.satPlot && dom.satPlot.clientWidth) || 640;
  const plotHeight = (dom.satPlot && dom.satPlot.clientHeight) || 340;
  const legendLayout = satelliteLegendLayout(data.length, plotWidth, plotHeight);
  const layout = {
    margin: { l: 54, r: 16, t: legendLayout.marginTop, b: 28 },
    paper_bgcolor: '#ffffff',
    plot_bgcolor: '#ffffff',
    showlegend: true,
    legend: {
      orientation: 'h',
      y: 1.02,
      x: 0,
      xanchor: 'left',
      yanchor: 'bottom',
      font: { size: data.length > 18 ? 7 : 8, color: '#475569' },
      bgcolor: 'rgba(0,0,0,0)',
      entrywidth: 150,
      entrywidthmode: 'pixels',
    },
    hovermode: 'x unified',
    dragmode: 'pan',
    shapes: [cursorShape(satelliteX(state.now))],
    xaxis: {
      tickfont: { size: 8, color: '#64748b' },
      gridcolor: '#eef2f7',
      zeroline: false,
    },
    yaxis: {
      title: {
        text: `${meta.name}${meta.unit ? ` (${meta.unit})` : ''}`,
        font: { size: 9, color: '#64748b' },
      },
      rangemode: metric === 'counts' ? 'tozero' : 'normal',
      tickfont: { size: 8, color: '#64748b' },
      gridcolor: '#eef2f7',
      zeroline: false,
    },
  };

  if (!windowIsFull()) {
    layout.xaxis.range = satelliteWindowRange();
    layout.xaxis.autorange = false;
  }
  if (dateAxis) {
    layout.xaxis.type = 'date';
    layout.xaxis.hoverformat = dateStyle === 'year'
      ? '%Y-%m-%d %H:%M:%S'
      : (dateStyle === 'month' ? '%m-%d %H:%M:%S' : '%H:%M:%S');
    layout.xaxis.tickformatstops = [
      { dtickrange: [null, 1000], value: '%H:%M:%S.%L' },
      { dtickrange: [1000, 60000], value: '%H:%M:%S' },
      { dtickrange: [60000, 3600000], value: '%H:%M' },
      { dtickrange: [3600000, null], value: '%m-%d %H:%M' },
    ];
    if (layout.xaxis.range) {
      layout.xaxis.range = layout.xaxis.range.map((value) => new Date(value).toISOString());
    }
  }
  return { data, layout };
}

function renderSatellite() {
  if (!state.sat.open || !dom.satPlot) return;
  const systems = [...satelliteSelectedSystems()];
  const bands = [...satelliteSelectedBands()];
  const selectedIds = satelliteSelectedDatasets();
  const datasets = state.datasets.filter((dataset) => selectedIds.has(dataset.id));
  let figure = null;

  if (!state.datasets.length) {
    figure = { data: [], layout: compareEmptyLayout('拖入 NMEA 文件后可对比卫星') };
  } else if (!datasets.length) {
    figure = { data: [], layout: compareEmptyLayout('至少选择一条数据') };
  } else if (!systems.length) {
    figure = { data: [], layout: compareEmptyLayout('至少选择一个卫星系统') };
  } else if (!bands.length) {
    figure = { data: [], layout: compareEmptyLayout('至少选择一个频点') };
  } else if (state.sat.metric === 'one' && !state.sat.satellite) {
    figure = { data: [], layout: compareEmptyLayout('选择一颗卫星') };
  } else {
    figure = satelliteFigure(state.sat.metric, datasets, systems, bands);
    if (!figure.data.length) {
      figure = { data: [], layout: compareEmptyLayout('当前选择没有可对比的卫星数据') };
    }
  }

  Plotly.react(dom.satPlot, figure.data, figure.layout, PLOT_CONFIG);
  state.satReady = true;
  bindSatelliteClick();
  window.requestAnimationFrame(() => ensureSatellitePlotHeight());
}

function renderSatelliteCursor() {
  if (!state.sat.open || !state.satReady || !dom.satPlot || !dom.satPlot._fullLayout) return;
  try {
    const result = Plotly.relayout(dom.satPlot, { shapes: [cursorShape(satelliteX(state.now))] });
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (error) {
    // 图表尚未准备好时忽略
  }
}

/** 点击卫星对比曲线上的点：切当前时刻并聚焦对应数据（联动地图 / 仪表盘 / 时间轴）。 */
function bindSatelliteClick() {
  const element = dom.satPlot;
  if (!element || typeof element.on !== 'function' || element.__satClickBound) return;
  element.__satClickBound = true;
  element.on('plotly_click', (event) => {
    const point = event.points && event.points[0];
    if (!point) return;
    const datasetId = point.data && point.data.meta && point.data.meta.datasetId;
    const seconds = Number(point.customdata);
    if (!Number.isFinite(seconds)) return;
    seekTo(seconds, { followWindow: true });
    if (datasetId) setFocus(datasetId);
    else renderEpoch();
  });
}

function placeSatelliteWindow() {
  const element = dom.satWindow;
  if (!element) return;
  const saved = state.sat.rect;
  const maxWidth = Math.max(SAT_MIN_WIDTH, window.innerWidth - 24);
  const maxHeight = Math.max(SAT_MIN_HEIGHT, window.innerHeight - 100);
  const width = Math.min(maxWidth, Math.max(SAT_MIN_WIDTH, (saved && saved.w) || SAT_DEFAULT_WIDTH));
  const height = Math.min(maxHeight, Math.max(SAT_MIN_HEIGHT, (saved && saved.h) || SAT_DEFAULT_HEIGHT));
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
  if (saved) {
    const left = Math.max(0, Math.min(window.innerWidth - width, saved.x));
    const top = Math.max(0, Math.min(window.innerHeight - height, saved.y));
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.right = 'auto';
    element.style.bottom = 'auto';
  } else {
    // 定位结果对比打开时优先并排放到它右侧，否则避开左侧图例停在地图上方
    let left = null;
    let top = null;
    const compareVisible = dom.compareWindow && !dom.compareWindow.hidden;
    if (compareVisible) {
      const compareRect = dom.compareWindow.getBoundingClientRect();
      const rightLeft = window.innerWidth - width - 16;
      if (rightLeft >= compareRect.right + 4) {
        left = rightLeft;
        top = Math.max(60, Math.min(compareRect.top, window.innerHeight - height - 16));
      }
    }
    if (left === null) {
      left = Math.max(12, Math.min(window.innerWidth - width - 12, 320));
      top = Math.min(
        Math.max(60, transportBottom() + 8),
        Math.max(60, window.innerHeight - height - 16),
      );
    }
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.right = 'auto';
    element.style.bottom = 'auto';
  }
}

function rememberSatelliteRect() {
  if (!dom.satWindow) return;
  const rect = dom.satWindow.getBoundingClientRect();
  state.sat.rect = {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
  };
  saveSatelliteConfig();
}

/** 拖右下角调整卫星对比窗口大小；尺寸写入 localStorage。 */
function attachSatelliteResize() {
  const element = dom.satWindow;
  const handle = element && element.querySelector('.float-resize');
  if (!handle || handle.__resizeBound) return;
  handle.__resizeBound = true;
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = element.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = rect.width;
    const startHeight = rect.height;

    const onMove = (moveEvent) => {
      const width = Math.max(SAT_MIN_WIDTH, Math.min(
        window.innerWidth - rect.left - 4,
        startWidth + moveEvent.clientX - startX,
      ));
      const height = Math.max(SAT_MIN_HEIGHT, Math.min(
        window.innerHeight - rect.top - 4,
        startHeight + moveEvent.clientY - startY,
      ));
      element.style.width = `${width}px`;
      element.style.height = `${height}px`;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      rememberSatelliteRect();
      if (state.satReady) {
        try { Plotly.Plots.resize('sat-plot'); } catch (error) { /* 忽略 */ }
        syncSatelliteLegendMargin();
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

function setSatelliteOpen(open) {
  state.sat.open = Boolean(open);
  if (dom.satWindow) dom.satWindow.hidden = !state.sat.open;
  if (dom.btnSat) dom.btnSat.setAttribute('aria-pressed', String(state.sat.open));
  if (!state.sat.open) return;
  placeSatelliteWindow();
  buildSatelliteChips();
  renderSatellite();
  if (dom.satWindow) bringToFront(dom.satWindow);
}

function resetSatelliteConfig() {
  state.sat.metric = 'counts';
  state.sat.systems = null;
  state.sat.bands = null;
  state.sat.datasets = null;
  state.sat.satellite = null;
  state.sat.rect = null;
  try {
    localStorage.removeItem(SAT_KEY);
  } catch (error) {
    // localStorage 不可用时忽略
  }
  placeSatelliteWindow();
  buildSatelliteChips();
  renderSatellite();
  toast('卫星对比配置已重置');
}


/** 可拖动的浮窗标题栏（对比曲线使用）。 */
function attachWindowDrag(windowElement, handle, onEnd) {
  if (!windowElement || !handle || handle.__dragBound) return;
  handle.__dragBound = true;
  handle.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button, input, select, label')) return;
    event.preventDefault();
    const rect = windowElement.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    windowElement.style.left = `${rect.left}px`;
    windowElement.style.top = `${rect.top}px`;
    windowElement.style.right = 'auto';
    windowElement.style.bottom = 'auto';

    const onMove = (moveEvent) => {
      const maxX = Math.max(0, window.innerWidth - rect.width);
      const maxY = Math.max(0, window.innerHeight - rect.height);
      const x = Math.min(maxX, Math.max(0, moveEvent.clientX - offsetX));
      const y = Math.min(maxY, Math.max(0, moveEvent.clientY - offsetY));
      windowElement.style.left = `${x}px`;
      windowElement.style.top = `${y}px`;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (typeof onEnd === 'function') onEnd();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */
function cacheDom() {
  dom.toast = document.getElementById('toast');
  dom.btnPlay = document.getElementById('btn-play');
  dom.btnBack = document.getElementById('btn-back');
  dom.btnFwd = document.getElementById('btn-fwd');
  dom.stepSize = document.getElementById('step-size');
  dom.timeNow = document.getElementById('time-now');
  dom.timeTotal = document.getElementById('time-total');
  dom.timelineTrack = document.getElementById('timeline-track');
  dom.timelineSpan = document.getElementById('timeline-span');
  dom.timelineProgress = document.getElementById('timeline-progress');
  dom.timelineLeft = document.getElementById('timeline-left');
  dom.timelineRight = document.getElementById('timeline-right');
  dom.timelineCursor = document.getElementById('timeline-cursor');
  dom.timelineReadout = document.getElementById('timeline-readout');
  dom.timelineReset = document.getElementById('timeline-reset');
  dom.timelinePresets = Array.from(document.querySelectorAll('.preset[data-minutes]'));
  dom.epochLabel = document.getElementById('epoch-label');
  dom.mapDragLabel = document.getElementById('map-drag-label');
  dom.markerBaseOverlay = document.getElementById('marker-base-overlay');
  dom.markerCurrentOverlay = document.getElementById('marker-current-overlay');
  dom.mapLockLayer = document.getElementById('map-lock-layer');
  dom.mapLockList = document.getElementById('map-lock-list');
  dom.mapTrackHover = document.getElementById('map-track-hover');
  dom.measureOverlay = document.getElementById('measure-overlay');
  dom.btnMeasure = document.getElementById('btn-measure');
  dom.measureWindow = document.getElementById('measure-window');
  dom.measureWindowHead = document.getElementById('measure-window-head');
  dom.measureClose = document.getElementById('measure-close');
  dom.measureReadout = document.getElementById('measure-readout');
  dom.measureUndo = document.getElementById('measure-undo');
  dom.measureClear = document.getElementById('measure-clear');
  dom.measureDone = document.getElementById('measure-done');
  dom.btnUnlock = document.getElementById('btn-unlock');
  dom.btnLegend = document.getElementById('btn-legend');
  dom.legendStyleWindow = document.getElementById('legend-style-window');
  dom.legendStyleHead = document.getElementById('legend-style-head');
  dom.legendStyleClose = document.getElementById('legend-style-close');
  dom.legendWindow = document.getElementById('legend-window');
  dom.legendWindowHead = document.getElementById('legend-window-head');
  dom.legendWindowClose = document.getElementById('legend-window-close');
  dom.legendDisplay = document.getElementById('legend-display');
  dom.legendDisplayVisible = document.getElementById('legend-display-visible');
  dom.legendDisplayOptions = document.getElementById('legend-display-options');
  dom.legendRows = document.getElementById('legend-rows');
  dom.legendDatasets = document.getElementById('legend-datasets');
  dom.legendDivider = document.getElementById('legend-divider');
  dom.legendReset = document.getElementById('legend-reset');
  dom.legendWindows = document.getElementById('legend-windows');
  dom.fileInput = document.getElementById('file-input');
  dom.mapStyle = document.getElementById('map-style');
  dom.btnCompare = document.getElementById('btn-compare');
  dom.compareWindow = document.getElementById('compare-window');
  dom.compareMetrics = document.getElementById('compare-metrics');
  dom.compareAlign = document.getElementById('compare-align');
  dom.compareDatasets = document.getElementById('compare-datasets');
  dom.compareReset = document.getElementById('compare-reset');
  dom.compareClose = document.getElementById('compare-close');
  dom.comparePlot = document.getElementById('compare-plot');
  dom.compareZoomIn = document.getElementById('compare-zoom-in');
  dom.compareZoomOut = document.getElementById('compare-zoom-out');
  dom.compareZoomReset = document.getElementById('compare-zoom-reset');
  dom.btnSat = document.getElementById('btn-sat');
  dom.satWindow = document.getElementById('sat-window');
  dom.satHead = document.getElementById('sat-head');
  dom.satMetrics = document.getElementById('sat-metrics');
  dom.satSystems = document.getElementById('sat-systems');
  dom.satBands = document.getElementById('sat-bands');
  dom.satDatasets = document.getElementById('sat-datasets');
  dom.satSatelliteRow = document.getElementById('sat-satellite-row');
  dom.satSatellite = document.getElementById('sat-satellite');
  dom.satPlot = document.getElementById('sat-plot');
  dom.satReset = document.getElementById('sat-reset');
  dom.satClose = document.getElementById('sat-close');
}

function bindEvents() {
  attachTimelineInteractions();
  attachMapPointInteractions();

  dom.fileInput.addEventListener('change', () => {
    handleFiles(dom.fileInput.files);
    // 清空 value，否则选同一批文件不会再触发 change
    dom.fileInput.value = '';
  });

  dom.mapStyle.addEventListener('change', () => {
    state.mapSource = dom.mapStyle.value;
    state.mapReady = false;
    hideTrackHover();
    // 直接改 raster layer 会撞上 mapbox 的 "Style is not done loading"，
    // 因此先拆掉地图容器，再在下一帧重建
    Plotly.purge('map');
    const holder = document.getElementById('map');
    holder.innerHTML = '';
    holder.__viewBound = false;  // purge 后需要重新绑定 relayout 监听
    requestAnimationFrame(() => requestAnimationFrame(() => renderMap(true)));
  });

  dom.btnPlay.addEventListener('click', togglePlayback);
  dom.btnBack.addEventListener('click', () => stepTime(-state.stepSeconds));
  dom.btnFwd.addEventListener('click', () => stepTime(state.stepSeconds));
  if (dom.stepSize) {
    dom.stepSize.addEventListener('change', () => setStepSeconds(dom.stepSize.value));
  }
  setStepSeconds(state.stepSeconds);

  dom.legendReset.addEventListener('click', resetLayerStyle);

  // 图例样式 / 图例浮窗
  if (dom.btnLegend) {
    dom.btnLegend.addEventListener('click', () => setLegendStyleOpen(!state.legend.styleOpen));
  }
  if (dom.legendStyleClose) {
    dom.legendStyleClose.addEventListener('click', () => setLegendStyleOpen(false));
  }
  if (dom.legendWindowClose) {
    dom.legendWindowClose.addEventListener('click', () => {
      state.legend.display.visible = false;
      saveLegendConfig();
      applyLegendWindowVisibility();
    });
  }
  if (dom.legendDisplayVisible) {
    dom.legendDisplayVisible.addEventListener('change', () => {
      state.legend.display.visible = dom.legendDisplayVisible.checked;
      saveLegendConfig();
      applyLegendWindowVisibility();
    });
  }
  if (dom.legendStyleWindow) {
    attachWindowDrag(dom.legendStyleWindow, dom.legendStyleHead, rememberLegendStyleRect);
    attachLegendStyleResize();
  }
  if (dom.legendWindow) {
    attachWindowDrag(dom.legendWindow, dom.legendWindowHead, rememberLegendPos);
  }

  // 一次打开 / 收起全部轨迹的星空图与仪表盘
  if (dom.legendWindows) {
    dom.legendWindows.addEventListener('click', () => {
      setAllWindows(openWindowCount() === 0);
    });
  }

  // 对比曲线浮窗
  if (dom.btnCompare) {
    dom.btnCompare.addEventListener('click', () => setCompareOpen(!state.compare.open));
  }
  if (dom.compareClose) {
    dom.compareClose.addEventListener('click', () => setCompareOpen(false));
  }
  if (dom.compareReset) {
    dom.compareReset.addEventListener('click', resetCompare);
  }
  if (dom.compareZoomIn) {
    dom.compareZoomIn.addEventListener('click', () => compareZoom(0.7));
  }
  if (dom.compareZoomOut) {
    dom.compareZoomOut.addEventListener('click', () => compareZoom(1.45));
  }
  if (dom.compareZoomReset) {
    dom.compareZoomReset.addEventListener('click', resetCompareZoom);
  }
  if (dom.compareWindow) {
    attachWindowDrag(dom.compareWindow, dom.compareWindow.querySelector('.compare-head'));
    attachCompareResize();
    dom.compareWindow.addEventListener('pointerdown', () => bringToFront(dom.compareWindow));
  }

  // 卫星对比浮窗
  if (dom.btnSat) {
    dom.btnSat.addEventListener('click', () => setSatelliteOpen(!state.sat.open));
  }
  if (dom.satClose) {
    dom.satClose.addEventListener('click', () => setSatelliteOpen(false));
  }
  if (dom.satReset) {
    dom.satReset.addEventListener('click', resetSatelliteConfig);
  }
  if (dom.satSatellite) {
    dom.satSatellite.addEventListener('change', () => {
      state.sat.satellite = dom.satSatellite.value || null;
      saveSatelliteConfig();
      renderSatellite();
    });
  }
  if (dom.satWindow) {
    attachWindowDrag(dom.satWindow, dom.satHead, rememberSatelliteRect);
    attachSatelliteResize();
    dom.satWindow.addEventListener('pointerdown', () => bringToFront(dom.satWindow));
  }

  // 测距浮窗 / 锁定标记
  if (dom.btnMeasure) {
    dom.btnMeasure.addEventListener('click', () => setMeasureWindowOpen(!state.measure.open));
  }
  if (dom.measureClose) {
    dom.measureClose.addEventListener('click', () => setMeasureWindowOpen(false));
  }
  if (dom.measureUndo) {
    dom.measureUndo.addEventListener('click', () => {
      state.measure.points.pop();
      renderMeasureOverlay();
      updateMeasureReadout();
    });
  }
  if (dom.measureClear) {
    dom.measureClear.addEventListener('click', () => {
      state.measure.points = [];
      renderMeasureOverlay();
      updateMeasureReadout();
    });
  }
  if (dom.measureDone) {
    dom.measureDone.addEventListener('click', () => setMeasureWindowOpen(false));
  }
  if (dom.measureWindow) {
    attachWindowDrag(dom.measureWindow, dom.measureWindowHead, rememberMeasurePos);
  }
  if (dom.btnUnlock) {
    dom.btnUnlock.addEventListener('click', clearLocks);
  }
  if (dom.mapTrackHover) {
    dom.mapTrackHover.addEventListener('pointerenter', () => {
      clearTimeout(state.trackHoverTimer);
      state.trackHoverTimer = null;
    });
    dom.mapTrackHover.addEventListener('pointerleave', () => hideTrackHover(150));
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.measure.open) {
      setMeasureWindowOpen(false);
      return;
    }
    if (event.key === 'Escape' && state.measure.active) {
      setMeasuring(false);
      return;
    }
    if (event.key === 'Escape' && state.sat.open) {
      setSatelliteOpen(false);
      return;
    }
    if (event.key === 'Escape' && state.compare.open) {
      setCompareOpen(false);
      return;
    }
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    // 时间窗标尺的 ←/→ 已经处理过（微调窗口边界），不要再顺带跳当前时刻
    if (event.defaultPrevented) return;
    if (event.code === 'Space') {
      event.preventDefault();
      togglePlayback();
    } else if (event.code === 'ArrowRight') {
      event.preventDefault();
      stepTime(state.stepSeconds);
    } else if (event.code === 'ArrowLeft') {
      event.preventDefault();
      stepTime(-state.stepSeconds);
    }
  });

  const dropZone = document.body;
  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropZone.classList.add('dragging');
  });
  dropZone.addEventListener('dragleave', (event) => {
    // 子元素之间的 dragleave 不取消提示
    if (event.relatedTarget && dropZone.contains(event.relatedTarget)) return;
    dropZone.classList.remove('dragging');
  });
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragging');
    handleFiles(event.dataTransfer && event.dataTransfer.files);
  });

  window.addEventListener('resize', () => {
    resizePlots();
    applyMeasureWindowPos();
    if (state.sat.open) placeSatelliteWindow();
    scheduleMeasureDraw();
    scheduleMarkerDraw();
    scheduleLockPosition();
    clampLegendWindows();
  });
  setupResizeObserver();

  window.addEventListener('error', (event) => {
    if (event.message) toast(`页面脚本错误：${event.message}`, true);
  });
}

/** 监听容器尺寸变化：地图 / 对比曲线固定，浮窗在打开时单独登记。 */
function setupResizeObserver() {
  if (typeof ResizeObserver === 'undefined') return;
  state.resizeObserver = new ResizeObserver(() => {
    if (state.resizeFrame !== null) return;
    state.resizeFrame = requestAnimationFrame(() => {
      state.resizeFrame = null;
      resizePlots();
    });
  });
  for (const id of ['map', 'compare-plot']) {
    const element = document.getElementById(id);
    if (!element) continue;
    try { state.resizeObserver.observe(element); } catch (error) { /* 忽略 */ }
  }
}

function init() {
  cacheDom();
  bindEvents();

  // 图例样式在首次渲染地图前恢复，保证初始 trace 就用用户的配色
  state.datasetStyle = loadDatasetStyle();
  state.layerStyle = loadLayerStyle();
  state.windowLayout = loadWindowLayout();
  state.legend = { ...state.legend, ...loadLegendConfig(), styleOpen: false };
  state.measure.pos = loadMeasurePos();
  loadCompareConfig();
  loadSatelliteConfig();

  updateLockButton();
  buildMapLegend();
  buildCompareChips();
  updateControlState();
  updateWindowBar();
  updateLegendWindowsButton();

  // 支持 ?base=gaode-street 这类链接直接指定底图
  const params = new URLSearchParams(location.search);
  const requested = params.get('base');
  if (requested && TILE_SOURCES[requested]) {
    state.mapSource = requested;
    dom.mapStyle.value = requested;
  }

  if (location.protocol === 'file:') {
    toast('当前以 file:// 打开，浏览器会阻止读取本地文件与地图瓦片；'
      + '请用 npm start 启动本项目自带的服务器（Windows 可双击 start.cmd）后访问终端里显示的地址。', true);
    return;
  }

  // 默认空页面，不自动加载任何数据；需要时用 ?file=xxx.log 指定一份
  const fileParam = params.get('file');
  if (fileParam) loadFileFromUrl(fileParam);
  loadSplitData();
  bindCompareClick();
}

document.addEventListener('DOMContentLoaded', init);
