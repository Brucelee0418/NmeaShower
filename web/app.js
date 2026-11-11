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
// 每条轨迹固定 5 条 trace，按数据集序号 * 5 + 图层序号定位，
// 这样数据集的增删不会打乱已有 trace 的下标。
const LAYER_ORDER = ['line', 'track', 'start', 'end', 'current'];
const TRACES_PER_DATASET = LAYER_ORDER.length;

function traceIndexFor(ordinal, layer) {
  return ordinal * TRACES_PER_DATASET + LAYER_ORDER.indexOf(layer);
}

const MAP_LAYER_META = [
  { key: 'line', name: '轨迹线', type: 'line', min: 1, max: 8, step: 0.5, colorSource: 'dataset' },
  { key: 'track', name: '轨迹点', type: 'point', min: 2, max: 12, step: 0.5, colorSource: 'dataset' },
  { key: 'start', name: '起点', type: 'point', min: 6, max: 24, step: 1 },
  { key: 'end', name: '终点', type: 'point', min: 6, max: 24, step: 1 },
  { key: 'current', name: '当前位置', type: 'point', min: 6, max: 28, step: 1, colorSource: 'dataset' },
];

const DEFAULT_LAYER_STYLE = {
  line: { color: '#2563eb', size: 2, visible: true },
  track: { color: '#2563eb', size: 3.5, visible: true },
  start: { color: '#16a34a', size: 10, visible: true },
  end: { color: '#dc2626', size: 10, visible: true },
  current: { color: '#f59e0b', size: 15, visible: true },
};

const LAYER_STYLE_KEY = 'nmea.mapLayerStyle.v1';

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
};
const DEFAULT_COMPARE_METRICS = ['speed', 'sats'];

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
 * 解析器（与 Python 版 nmea_parser.py 行为一致）
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
    for (let i = 3; i + 3 < f.length; i += 4) {
      const prn = (f[i] || '').trim();
      if (!prn) continue;
      const satellite = {
        system,
        prn,
        elevation: parseNumber(f[i + 1]),
        azimuth: parseNumber(f[i + 2]),
        cn0: parseNumber(f[i + 3]),
      };
      const key = `${system}|${prn}`;
      const previous = epoch.satellites.get(key);
      if (!previous || satelliteScore(satellite) >= satelliteScore(previous)) {
        epoch.satellites.set(key, satellite);
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
  now: 0,             // 全局绝对时间（UTC 秒），所有视图的时间基准
  origin: 0,          // 轨道 0 点对应的绝对秒
  duration: 0,        // 全部数据集覆盖的时间跨度
  playing: false,
  rate: 1,            // 播放倍速
  playAnchorWall: 0,  // 播放起点的墙钟时间
  playAnchorTime: 0,  // 播放起点的数据时间
  rafHandle: null,
  mapSource: 'arcgis-imagery',
  view: null,          // 手动缩放/平移后的视野 { zoom, center }，重建地图时沿用
  mapReady: false,
  layerStyle: null,     // 轨迹线/点的图例样式，init 时从 localStorage 恢复
  datasetStyle: {},     // 按文件名记住的数据集颜色/显隐
  legendCollapsed: false,
  styleFrame: null,
  pendingStyleLayers: new Set(),
  pendingRender: false,
  split: null,          // sky_split.py 生成的遮挡分割（逐历元曲线 + 逐星概率）
  compare: { open: false, metrics: DEFAULT_COMPARE_METRICS.slice(), datasets: new Set(), align: 'relative' },
  compareReady: false,
  // 时间窗：全局相对秒。start/end 是「时间先后」上的两个标尺，窗口内即为活动区间
  window: { start: 0, end: 0 },
  windowFrame: null,
  timelineDrag: null,   // 轨道上的拖动状态：改标尺 / 平移窗口 / 定位当前时刻
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
    layout.mapbox.center = viewCenterFor(state.mapSource) || { ...state.view.center };
    layout.mapbox.zoom = Math.min(state.view.zoom, mapZoomLimit(state.mapSource));
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
    line: { color: dataset.color, width: style.size },
    visible: style.visible && dataset.visible,
    hoverinfo: 'skip',
    name: `${dataset.name} 轨迹线`,
  };
}

function mapPointTrace(lons, lats, layer, name, dataset, covered = true) {
  const style = layerStyle(layer);
  const followsDataset = layer === 'line' || layer === 'track' || layer === 'current';
  // 当前时刻落在该数据范围外时，不把「当前位置」钉在端点，否则看起来像真的走到了那里
  const inRange = layer !== 'current' || covered;
  return {
    type: 'scattermapbox',
    mode: 'markers',
    lon: lons,
    lat: lats,
    marker: {
      size: style.size,
      color: followsDataset ? dataset.color : style.color,
      opacity: layer === 'track' ? 0.95 : 1,
      line: layer === 'current' ? { color: '#ffffff', width: 1.5 } : undefined,
    },
    visible: style.visible && dataset.visible && inRange,
    hoverinfo: 'skip',
    name: `${dataset.name} ${name}`,
  };
}

/**
 * 每个数据集固定输出 5 条 trace（线 / 点 / 起点 / 终点 / 当前位置），
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
    return;
  }

  // 快路径：只挪动各数据集的「当前位置」
  const indices = [];
  const lons = [];
  const lats = [];
  const visible = [];
  const style = layerStyle('current');
  state.datasets.forEach((dataset, ordinal) => {
    indices.push(traceIndexFor(ordinal, 'current'));
    const epoch = dataset.epochs[dataset.index] || null;
    const [lat, lon] = epoch ? toDisplay(epoch.lat, epoch.lon) : [null, null];
    lons.push(lon !== null ? [lon] : []);
    lats.push(lat !== null ? [lat] : []);
    // 越界时隐藏当前位置点（与整量渲染保持一致）
    visible.push(style.visible && dataset.visible && datasetState(dataset) === 'ok');
  });
  if (!indices.length) return;
  Plotly.restyle('map', { lon: lons, lat: lats, visible }, indices);
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
      if (typeof value.visible === 'boolean') target.visible = value.visible;
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
  // 轨迹线 / 轨迹点 / 当前位置的颜色跟随数据集，预览用第一条数据的颜色
  const color = meta.colorSource === 'dataset'
    ? ((state.datasets[0] && state.datasets[0].color) || style.color)
    : style.color;
  if (meta.type === 'line') {
    return `--c:${color};--w:${Math.max(1, Math.min(6, style.size))}px`;
  }
  return `--c:${color};--s:${Math.max(5, Math.min(13, style.size))}px`;
}

function buildMapLegend() {
  buildDatasetLegend();
  buildLayerLegend();
  setLegendCollapsed(state.legendCollapsed);
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

/** 同名文件重新加载时沿用上次的颜色和显隐。 */
function datasetStyleFor(name, ordinal) {
  const saved = state.datasetStyle[name];
  const fallback = DATASET_PALETTE[ordinal % DATASET_PALETTE.length];
  const style = { color: fallback, visible: true };
  if (saved && typeof saved === 'object') {
    if (typeof saved.color === 'string' && /^#[0-9a-f]{6}$/i.test(saved.color)) style.color = saved.color;
    if (typeof saved.visible === 'boolean') style.visible = saved.visible;
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

function rememberDatasetStyle(dataset) {
  state.datasetStyle[dataset.name] = { color: dataset.color, visible: dataset.visible };
  saveDatasetStyle();
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
    return;
  }

  for (const dataset of state.datasets) {
    const row = document.createElement('div');
    row.className = 'dataset-row';
    row.dataset.id = dataset.id;
    row.classList.toggle('off', !dataset.visible);
    row.classList.toggle('focus', dataset.id === state.focusId);
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
    name.title = '点击高亮这条数据（顶部时刻与对比曲线「相对起点」以它为参照）';

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

    row.append(eye, color, name, count, remove, tools);
    dom.legendDatasets.appendChild(row);

    visible.addEventListener('change', () => {
      dataset.visible = visible.checked;
      rememberDatasetStyle(dataset);
      row.classList.toggle('off', !dataset.visible);
      renderMap(true);
      updateMapInfo();
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
      buildCompareChips();
      renderCompare();
    });
    name.addEventListener('click', () => setFocus(dataset.id));
    remove.addEventListener('click', () => removeDataset(dataset.id));
  }
  updateLegendWindowsButton();
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
  for (const meta of MAP_LAYER_META) {
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

    const preview = document.createElement('span');
    preview.className = `legend-preview ${meta.type}`;
    preview.style.cssText = layerPreviewStyle(meta, style);

    const range = document.createElement('label');
    range.className = 'legend-range';
    range.title = meta.type === 'line' ? '轨迹线宽度' : `${meta.name}大小`;
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
      name.title = '颜色跟随上方数据集';
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
}

function refreshLegendRow(layer) {
  if (!dom.legendRows) return;
  const meta = MAP_LAYER_META.find((item) => item.key === layer);
  const row = dom.legendRows.querySelector(`.legend-row[data-layer="${layer}"]`);
  if (!meta || !row) return;
  const style = layerStyle(layer);
  row.classList.toggle('off', !style.visible);
  if (meta.colorSource !== 'dataset') row.querySelector('.legend-color').value = style.color;
  row.querySelector('.legend-preview').style.cssText = layerPreviewStyle(meta, style);
  row.querySelector('.legend-range input').value = String(style.size);
  row.querySelector('.legend-value').textContent = formatLayerSize(style.size);
}

function setLegendCollapsed(collapsed) {
  state.legendCollapsed = collapsed;
  if (!dom.mapLegend) return;
  dom.mapLegend.classList.toggle('collapsed', collapsed);
  dom.legendToggle.textContent = collapsed ? '+' : '−';
  dom.legendToggle.title = collapsed ? '展开图例' : '收起图例';
  dom.legendToggle.setAttribute('aria-expanded', String(!collapsed));
}

function applyLayerStyle(layer) {
  if (!state.mapReady || !state.datasets.length) return;
  const style = layerStyle(layer);
  const indices = state.datasets.map((dataset, ordinal) => traceIndexFor(ordinal, layer));
  const visible = state.datasets.map((dataset) => style.visible && dataset.visible
    && (layer !== 'current' || datasetState(dataset) === 'ok'));

  if (layer === 'line') {
    Plotly.restyle('map', {
      visible,
      'line.width': style.size,
      'line.color': state.datasets.map((dataset) => dataset.color),
    }, indices);
    return;
  }
  if (layer === 'start' || layer === 'end') {
    Plotly.restyle('map', { visible, 'marker.size': style.size, 'marker.color': style.color }, indices);
    return;
  }
  Plotly.restyle('map', {
    visible,
    'marker.size': style.size,
    'marker.color': state.datasets.map((dataset) => dataset.color),
  }, indices);
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
 * sky_split.py 先生成 `web/sky_split.json`：每个历元两条边界曲线
 * （半宽随仰角变化）以及每颗卫星的直射概率。这里把它画成
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

  const rows = [
    ['UTC 时间', epoch.datetime ? epoch.datetime.replace('T', ' ') : '—', 'utc'],
    ['纬度', fmt(epoch.lat, 9)],
    ['经度', fmt(epoch.lon, 9)],
    ['海拔高 (MSL)', epoch.altitude === null ? '—' : `${fmt(epoch.altitude, 2)} m`],
    ['速度', epoch.speedKmh === null ? '—' : `${fmt(epoch.speedKmh, 2)} km/h`],
    ['航向', epoch.course === null ? '—' : `${fmt(epoch.course, 1)}° ${compassPoint(epoch.course)}`],
    ['卫星 解算/可见', `${epoch.numSatsUsed === null ? '—' : epoch.numSatsUsed} / ${epoch.numSatsView === null ? '—' : epoch.numSatsView}`
      + `（显示 ${visible}）`],
    ['HDOP / PDOP', `${fmt(epoch.hdop, 2)} / ${fmt(epoch.pdop, 2)}`],
    ['定位 / 椭球高', `${fixLabel} · ${ellipsoid === null ? '—' : `${fmt(ellipsoid, 2)} m`}`, 'wide'],
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
      const result = full
        ? Plotly.relayout(element, { 'xaxis.autorange': true })
        : Plotly.relayout(element, { 'xaxis.range': compareWindowRange() });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    }
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
  });
  if (!indices.length) return;
  try {
    const result = Plotly.restyle('map', { lon, lat }, indices);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (error) {
    // 地图尚未就绪时忽略
  }
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
}

/* ------------------------------------------------------------------ *
 * 播放控制（按真实时间推进，1× = 1 秒数据用 1 秒播放）
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
  const target = state.playAnchorTime + elapsed * state.rate;
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

function setRate(rate) {
  state.rate = rate;
  // 变速时重新锚定，避免已播放的时间被重复换算
  if (state.playing) {
    state.playAnchorWall = performance.now();
    state.playAnchorTime = state.now;
  }
  for (const button of dom.rateButtons) {
    button.classList.toggle('active', Number(button.dataset.rate) === rate);
  }
}

/** 按秒跳转：delta 为 +1 / -1，限制在时间窗内。 */
function stepTime(delta) {
  if (!state.datasets.length) return;
  stopPlayback();
  const rel = (state.now - state.origin) + delta;
  const clamped = Math.min(state.window.end, Math.max(state.window.start, rel));
  setGlobalTime(state.origin + clamped);
  requestRender();
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
      title: '叠加 sky_split.py 生成的直射带与非直射判定（需要 web/sky_split.json）',
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
function updateMapInfo() {
  if (!state.datasets.length) {
    dom.mapInfo.textContent = '';
    return;
  }
  const lines = state.datasets.slice(0, 4).map((dataset) => {
    const summary = dataset.summary;
    const duration = summary.duration === undefined ? '—' : `${summary.duration.toFixed(1)} s`;
    return `<span style="color:${dataset.color}">■</span> ${dataset.name}`
      + `：${summary.epochs} 历元 / ${duration} / ${summary.distance.toFixed(1)} m`
      + ` / 最大 ${summary.maxSpeedKmh.toFixed(2)} km/h`;
  });
  if (state.datasets.length > 4) lines.push(`…另有 ${state.datasets.length - 4} 条数据`);
  dom.mapInfo.innerHTML = lines.join('<br>');
}

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
  for (const button of dom.rateButtons) button.disabled = !enabled;
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
  buildDatasetLegend();
  // 必须走完整的 renderEpoch：切换后顶部标签 / 时间轴 / 地图当前位置都要跟着变，
  // 只重画局部会留下上一个数据集的历元信息。
  renderEpoch();
  // 对比曲线用「相对起点」对齐时，x 轴与光标以聚焦数据为参照，换焦点要重画
  if (state.compare.open) renderCompare();
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

  // trace 数量变了，且新轨迹可能扩大视野
  state.mapReady = false;
  state.view = null;
  rebuildTimeline();
  buildDatasetLegend();
  buildCompareChips();
  updateMapInfo();
  updateControlState();
  renderMap(true);
  renderEpoch();
  // 新数据默认把自己的星空图和仪表盘一并打开（可随时从图例或窗口 × 关闭）
  for (const kind of WINDOW_ORDER) openDatasetWindow(dataset, kind);
  renderCompare();

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
  if (state.focusId === id) {
    state.focusId = state.datasets.length ? state.datasets[0].id : null;
  }

  state.mapReady = false;
  state.view = null;
  buildCompareChips();

  if (!state.datasets.length) {
    stopPlayback();
    state.now = 0;
    state.origin = 0;
    state.duration = 0;
    state.datasets = [];
    state.focusId = null;
    state.view = null;
    buildDatasetLegend();
    updateMapInfo();
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
  updateMapInfo();
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

/** 读取 sky_split.py 生成的分割数据；没有该文件时静默降级为纯星空图。 */
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
  } catch (error) {
    // 忽略损坏的配置
  }
}

function saveCompareConfig() {
  try {
    localStorage.setItem(COMPARE_KEY, JSON.stringify({
      metrics: state.compare.metrics,
      align: state.compare.align,
    }));
  } catch (error) {
    // localStorage 不可用时忽略
  }
}

function compareValue(dataset, epoch, key) {
  if (key === 'speed') return epoch.speedKmh;
  if (key === 'course') return epoch.course;
  if (key === 'sats') return epoch.numSatsView === null ? (epoch.satellites.size || null) : epoch.numSatsView;
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

/** 全局绝对秒 → 对比曲线 x 坐标。 */
function compareX(seconds) {
  return Math.max(0, (seconds - state.origin) - compareFocusShift());
}

/** 时间窗在对比曲线 x 轴上的区间。 */
function compareWindowRange() {
  const shift = compareFocusShift();
  return [state.window.start - shift, state.window.end - shift];
}

/** 把数据集转换成对比曲线坐标（相对起点对齐时 x 从 0 开始）。 */
function compareSeries(dataset, key) {
  const offset = compareOffset(dataset);
  const x = [];
  const y = [];
  for (let i = 0; i < dataset.epochs.length; i += 1) {
    x.push(dataset.times[i] + offset);
    y.push(compareValue(dataset, dataset.epochs[i], key));
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

  const count = metrics.length;
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
        hovertemplate: `${dataset.name}　%{x:.1f} s<br>%{y:.2f} ${meta.unit}<extra></extra>`,
      });
    }
  });

  // 对比曲线只看时间窗内的区间（窗口为全时段时交给 Plotly 自适应）
  // 必须写在子图轴构建之后，否则会被 k=0 的 xaxis 定义覆盖。
  if (!windowIsFull()) {
    layout.xaxis = { ...(layout.xaxis || {}), range: compareWindowRange(), autorange: false };
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
      ['relative', '相对起点', '对比曲线：每条数据从自己的起点开始（跨日期也能比）。时间轴/时间窗本身始终是绝对 UTC。'],
      ['absolute', '绝对 UTC', '对比曲线：按真实 UTC 时间对齐（同一天多次采集适用）。时间轴/时间窗本身始终是绝对 UTC。'],
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
    for (const [key, meta] of Object.entries(COMPARE_METRICS)) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = `${meta.name}${meta.unit ? ` (${meta.unit})` : ''}`;
      chip.classList.toggle('off', !state.compare.metrics.includes(key));
      chip.addEventListener('click', () => {
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

/** 对比窗首次打开时避开右侧面板；用户拖过之后不再自动摆位。 */
function placeCompareWindow() {
  const element = dom.compareWindow;
  if (!element || element.dataset.placed === '1') return;
  const width = Math.min(620, window.innerWidth - 24);
  const height = Math.min(420, Math.max(240, window.innerHeight - 140));
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
  element.style.left = `${Math.max(12, window.innerWidth - width - 480)}px`;
  element.style.top = `${Math.max(60, window.innerHeight - height - 16)}px`;
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
  toast(align === 'absolute' ? '对比曲线改为绝对 UTC 对齐' : '对比曲线改为各自起点对齐');
}

function resetCompare() {
  state.compare.metrics = DEFAULT_COMPARE_METRICS.slice();
  state.compare.align = 'relative';
  state.compare.datasets = new Set(state.datasets.map((dataset) => dataset.id));
  saveCompareConfig();
  buildCompareChips();
  renderCompare();
  toast('对比配置已恢复默认');
}

/** 对比曲线上的点 → 全局时间 + 当前数据集，带动地图 / 星空图 / 仪表盘。 */
function bindCompareClick() {
  const element = document.getElementById('compare-plot');
  if (!element || typeof element.on !== 'function' || element.__compareClickBound) return;
  element.__compareClickBound = true;
  element.on('plotly_click', (event) => {
    const point = event.points && event.points[0];
    if (!point) return;
    const seconds = Number(point.x);
    if (!Number.isFinite(seconds)) return;
    stopPlayback();
    const datasetId = point.data && point.data.meta && point.data.meta.datasetId;
    const dataset = datasetId ? state.datasets.find((item) => item.id === datasetId) : null;
    // 相对起点对齐时 x 是数据集自身时间轴上的秒数，换算回绝对时间要加回它的起点；
    // 绝对 UTC 对齐时 x 已经是全局相对秒，直接用。
    const shift = dataset && state.compare.align === 'relative' ? datasetOffset(dataset) : 0;
    // 先定位时间再切数据集：顺序反了会先按旧时刻重画一帧，界面会闪一下旧数据
    setGlobalTime(state.origin + seconds + shift);
    if (datasetId) setFocus(datasetId);
    else renderEpoch();
  });
}

/** 可拖动的浮窗标题栏（对比曲线使用）。 */
function attachWindowDrag(windowElement, handle) {
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
  dom.rateButtons = Array.from(document.querySelectorAll('.rate'));
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
  dom.mapInfo = document.getElementById('map-info');
  dom.mapLegend = document.getElementById('map-legend');
  dom.legendRows = document.getElementById('legend-rows');
  dom.legendDatasets = document.getElementById('legend-datasets');
  dom.legendDivider = document.getElementById('legend-divider');
  dom.legendToggle = document.getElementById('legend-toggle');
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
}

function bindEvents() {
  attachTimelineInteractions();

  dom.fileInput.addEventListener('change', () => {
    handleFiles(dom.fileInput.files);
    // 清空 value，否则选同一批文件不会再触发 change
    dom.fileInput.value = '';
  });

  dom.mapStyle.addEventListener('change', () => {
    state.mapSource = dom.mapStyle.value;
    state.mapReady = false;
    // 直接改 raster layer 会撞上 mapbox 的 "Style is not done loading"，
    // 因此先拆掉地图容器，再在下一帧重建
    Plotly.purge('map');
    const holder = document.getElementById('map');
    holder.innerHTML = '';
    holder.__viewBound = false;  // purge 后需要重新绑定 relayout 监听
    requestAnimationFrame(() => requestAnimationFrame(() => renderMap(true)));
  });

  dom.btnPlay.addEventListener('click', togglePlayback);
  dom.btnBack.addEventListener('click', () => stepTime(-1));
  dom.btnFwd.addEventListener('click', () => stepTime(1));

  dom.legendToggle.addEventListener('click', () => {
    setLegendCollapsed(!state.legendCollapsed);
  });
  dom.legendReset.addEventListener('click', resetLayerStyle);

  // 一次打开 / 收起全部轨迹的星空图与仪表盘
  if (dom.legendWindows) {
    dom.legendWindows.addEventListener('click', () => {
      setAllWindows(openWindowCount() === 0);
    });
  }

  for (const button of dom.rateButtons) {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      setRate(Number(button.dataset.rate) || 1);
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
  if (dom.compareWindow) {
    attachWindowDrag(dom.compareWindow, dom.compareWindow.querySelector('.compare-head'));
    dom.compareWindow.addEventListener('pointerdown', () => bringToFront(dom.compareWindow));
  }

  document.addEventListener('keydown', (event) => {
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
      stepTime(1);
    } else if (event.code === 'ArrowLeft') {
      event.preventDefault();
      stepTime(-1);
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

  window.addEventListener('resize', () => resizePlots());
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
  loadCompareConfig();

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
      + '请运行 python serve.py 后访问 http://localhost:8000/ 。', true);
    return;
  }

  // 默认空页面，不自动加载任何数据；需要时用 ?file=xxx.log 指定一份
  const fileParam = params.get('file');
  if (fileParam) loadFileFromUrl(fileParam);
  loadSplitData();
  bindCompareClick();
}

document.addEventListener('DOMContentLoaded', init);
