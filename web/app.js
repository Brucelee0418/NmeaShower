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
      { id: 'nmea-basemap', type: 'raster', source: 'basemap', minzoom: 0, maxzoom: maxZoom },
    ],
  };
  state.baseStyle = { source, style };
  return style;
}

const TILE_SOURCES = {
  'arcgis-imagery': '卫星影像',
  'gaode-satellite': '高德卫星',
  'gaode-street': '高德街道',
  'osm': 'OpenStreetMap',
  'none': '无底图',
};

// 各瓦片源实际可用的最大瓦片级别（超出后会返回空白）
const TILE_MAX_ZOOM = {
  'arcgis-imagery': 19,
  'gaode-satellite': 18,
  'gaode-street': 18,
  'osm': 19,
  'none': 19,
};

const GCJ02_SOURCES = new Set(['gaode-street', 'gaode-satellite']);

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
  epochs: [],
  stats: {},
  summary: null,
  sourceName: '',
  index: 0,
  playing: false,
  timer: null,
  speed: 2,
  activeSystems: new Set(),
  showLabels: true,
  mapSource: 'arcgis-imagery',
  mapReady: false,
  skyReady: false,
  gaugeReady: false,
  maxSpeedKmh: 10,
  pendingRender: false,
};

const dom = {};

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */
function fmt(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
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
  const bounds = state.summary && state.summary.bounds;
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
  const maxTileZoom = TILE_MAX_ZOOM[state.mapSource] || 19;
  const fitZoom = Math.log2((320 * 156543 * Math.cos((centerLat * Math.PI) / 180)) / meters);
  // 声明的是 256px 瓦片，mapbox 在 zoom=z 时会取 z+1 级瓦片，
  // 所以地图 zoom 要比瓦片级别的上限小一档，否则一个请求都发不出去
  const zoom = Math.min(maxTileZoom - 1, Math.max(2, fitZoom));

  layout.mapbox.center = { lon: centerLon, lat: centerLat };
  layout.mapbox.zoom = zoom;
  return layout;
}

function mapData(currentIndex) {
  const located = state.epochs.filter((epoch) => epoch.lat !== null && epoch.lon !== null);
  const projected = located.map((epoch) => toDisplay(epoch.lat, epoch.lon));
  const lats = projected.map((pair) => pair[0]);
  const lons = projected.map((pair) => pair[1]);
  const current = state.epochs[currentIndex];
  const currentPoint = current ? toDisplay(current.lat, current.lon) : [null, null];

  if (!lons.length) {
    return ['轨迹', '起点', '终点', '当前位置'].map((name) => ({
      type: 'scattermapbox',
      mode: 'markers',
      lon: [],
      lat: [],
      hoverinfo: 'skip',
      name,
    }));
  }

  const traces = [
    {
      type: 'scattermapbox',
      mode: 'lines',
      lon: lons,
      lat: lats,
      line: { width: 3, color: '#2563eb' },
      hoverinfo: 'skip',
      name: '轨迹',
    },
    {
      type: 'scattermapbox',
      mode: 'markers',
      lon: lons.length ? [lons[0]] : [],
      lat: lats.length ? [lats[0]] : [],
      marker: { size: 10, color: '#16a34a' },
      hoverinfo: 'skip',
      name: '起点',
    },
    {
      type: 'scattermapbox',
      mode: 'markers',
      lon: lons.length ? [lons[lons.length - 1]] : [],
      lat: lats.length ? [lats[lats.length - 1]] : [],
      marker: { size: 10, color: '#dc2626' },
      hoverinfo: 'skip',
      name: '终点',
    },
    {
      type: 'scattermapbox',
      mode: 'markers',
      lon: currentPoint[1] !== null ? [currentPoint[1]] : [],
      lat: currentPoint[0] !== null ? [currentPoint[0]] : [],
      marker: { size: 15, color: '#f59e0b', opacity: 0.95 },
      hoverinfo: 'skip',
      name: '当前位置',
    },
  ];
  return traces;
}

function renderMap(full = false) {
  if (!state.mapReady || full) {
    const layout = mapLayout();
    Plotly.react('map', mapData(state.index), layout, PLOT_CONFIG);
    state.mapReady = true;
    return;
  }
  const current = state.epochs[state.index];
  const [currentLat, currentLon] = current ? toDisplay(current.lat, current.lon) : [null, null];
  const lon = currentLon !== null ? [currentLon] : [];
  const lat = currentLat !== null ? [currentLat] : [];
  Plotly.restyle('map', { lon: [lon], lat: [lat] }, [3]);
}

/* ------------------------------------------------------------------ *
 * 星空图
 * ------------------------------------------------------------------ */
function skyLayout() {
  return {
    margin: { l: 46, r: 34, t: 16, b: 22 },
    paper_bgcolor: '#ffffff',
    plot_bgcolor: '#ffffff',
    showlegend: false,
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

function skyData(epoch) {
  const satellites = epoch
    ? [...epoch.satellites.values()].filter(
      (satellite) => satellite.elevation !== null
        && satellite.azimuth !== null
        && state.activeSystems.has(satellite.system),
    )
    : [];

  const withSignal = satellites.filter((satellite) => satellite.cn0 !== null && satellite.cn0 > 0);
  const withoutSignal = satellites.filter((satellite) => satellite.cn0 === null || satellite.cn0 <= 0);

  const label = (satellite) => `${SYSTEM_PREFIX[satellite.system] || ''}${satellite.prn}`;
  const mode = state.showLabels ? 'markers+text' : 'markers';

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
      + 'cn0 %{customdata[3]:.1f} dB-Hz<extra></extra>',
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
      + '无载噪比（cn0 = 0）<extra></extra>',
    name: '无信号',
  };

  return [signalTrace, noSignalTrace];
}

function renderSky() {
  const epoch = state.epochs[state.index];
  Plotly.react('sky', skyData(epoch), skyLayout(), PLOT_CONFIG);
  state.skyReady = true;
}

/* ------------------------------------------------------------------ *
 * 仪表盘
 * ------------------------------------------------------------------ */
function renderGauges() {
  const epoch = state.epochs[state.index];
  if (!epoch) return;

  const speed = epoch.speedKmh === null ? 0 : epoch.speedKmh;
  const course = epoch.course === null ? 0 : epoch.course;
  const maxSpeed = Math.max(10, Math.ceil(state.maxSpeedKmh / 5) * 5);

  const speedFigure = {
    data: [{
      type: 'indicator',
      mode: 'gauge+number',
      value: speed,
      number: { valueformat: '.2f', font: { size: 22, color: '#0f172a' } },
      gauge: {
        axis: { range: [0, maxSpeed], showticklabels: false, ticks: '' },
        bar: { color: '#2563eb', thickness: 0.5 },
        bgcolor: '#f1f5f9',
        borderwidth: 0,
        steps: [{ range: [0, maxSpeed], color: '#e2e8f0' }],
      },
    }],
    layout: { margin: { l: 24, r: 24, t: 10, b: 8 }, paper_bgcolor: 'rgba(0,0,0,0)' },
  };

  const courseFigure = {
    data: [{
      type: 'indicator',
      mode: 'gauge+number',
      value: course,
      number: {
        suffix: '°',
        valueformat: '.1f',
        font: { size: 22, color: epoch.course === null ? '#94a3b8' : '#0f172a' },
      },
      gauge: {
        axis: {
          range: [0, 360],
          tickvals: [0, 90, 180, 270],
          ticktext: ['N', 'E', 'S', 'W'],
          tickwidth: 1,
          tickfont: { size: 9 },
        },
        bar: { color: epoch.course === null ? '#cbd5e1' : '#0d9488', thickness: 0.5 },
        bgcolor: '#f1f5f9',
        borderwidth: 0,
        steps: [{ range: [0, 360], color: '#e2e8f0' }],
      },
    }],
    layout: { margin: { l: 24, r: 24, t: 10, b: 8 }, paper_bgcolor: 'rgba(0,0,0,0)' },
  };

  dom.courseTitle.textContent = epoch.course === null
    ? '航向 · 无数据'
    : `航向 · ${compassPoint(epoch.course)}`;

  Plotly.react('gauge-speed', speedFigure.data, speedFigure.layout, PLOT_CONFIG);
  Plotly.react('gauge-course', courseFigure.data, courseFigure.layout, PLOT_CONFIG);
  state.gaugeReady = true;
}

function renderReadouts() {
  const epoch = state.epochs[state.index];
  if (!epoch) return;

  const visible = [...epoch.satellites.values()].filter((s) => state.activeSystems.has(s.system)).length;
  const ellipsoid = epoch.altitude === null
    ? null
    : epoch.altitude + (epoch.geoidSeparation || 0);

  const fixLabel = epoch.fixType !== null
    ? (FIX_TYPE[epoch.fixType] || `类型 ${epoch.fixType}`)
    : (epoch.fixQuality !== null ? (FIX_QUALITY[epoch.fixQuality] || `质量 ${epoch.fixQuality}`) : '—');

  const rows = [
    ['UTC 时间', epoch.datetime ? epoch.datetime.replace('T', ' ') : '—'],
    ['纬度', fmt(epoch.lat, 9)],
    ['经度', fmt(epoch.lon, 9)],
    ['海拔高 (MSL)', epoch.altitude === null ? '—' : `${fmt(epoch.altitude, 2)} m`],
    ['速度', epoch.speedKmh === null ? '—' : `${fmt(epoch.speedKmh, 2)} km/h`],
    ['航向', epoch.course === null ? '—' : `${fmt(epoch.course, 1)}° ${compassPoint(epoch.course)}`],
    ['卫星 解算/可见', `${epoch.numSatsUsed === null ? '—' : epoch.numSatsUsed} / ${epoch.numSatsView === null ? '—' : epoch.numSatsView}`
      + `（显示 ${visible}）`],
    ['HDOP / PDOP', `${fmt(epoch.hdop, 2)} / ${fmt(epoch.pdop, 2)}`],
    ['定位 / 椭球高', `${fixLabel} · ${ellipsoid === null ? '—' : `${fmt(ellipsoid, 2)} m`}`],
  ];

  dom.readouts.innerHTML = rows.map(([label, value]) => (
    `<div class="readout"><span class="label">${label}</span>`
    + `<span class="value" title="${String(value).replace(/"/g, '&quot;')}">${value}</span></div>`
  )).join('');
}

/* ------------------------------------------------------------------ *
 * 渲染调度
 * ------------------------------------------------------------------ */
function renderEpoch() {
  if (!state.epochs.length) return;
  const epoch = state.epochs[state.index];

  dom.slider.value = String(state.index);
  dom.epochLabel.textContent = `${epoch.time || '--:--:--'} · ${state.index + 1}/${state.epochs.length}`;

  renderMap(false);
  renderSky();
  renderGauges();
  renderReadouts();
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
  if (state.skyReady) Plotly.Plots.resize('sky');
  if (state.gaugeReady) {
    Plotly.Plots.resize('gauge-speed');
    Plotly.Plots.resize('gauge-course');
  }
}

/* ------------------------------------------------------------------ *
 * 播放控制
 * ------------------------------------------------------------------ */
function stopPlayback() {
  state.playing = false;
  clearTimeout(state.timer);
  state.timer = null;
  dom.btnPlay.textContent = '▶ 播放';
}

function playbackTick() {
  if (!state.playing) return;
  const next = state.index + state.speed;
  if (next >= state.epochs.length - 1) {
    state.index = state.epochs.length - 1;
    renderEpoch();
    stopPlayback();
    return;
  }
  state.index = next;
  renderEpoch();
  state.timer = setTimeout(playbackTick, 140);
}

function togglePlayback() {
  if (!state.epochs.length) return;
  if (state.playing) {
    stopPlayback();
    return;
  }
  if (state.index >= state.epochs.length - 1) {
    state.index = 0;
    renderEpoch();
  }
  state.playing = true;
  dom.btnPlay.textContent = '⏸ 暂停';
  state.timer = setTimeout(playbackTick, 60);
}

/* ------------------------------------------------------------------ *
 * 系统过滤
 * ------------------------------------------------------------------ */
function buildSystemChips(systems) {
  dom.systemFilter.innerHTML = '';
  const names = Object.keys(systems).sort(
    (a, b) => (systems[b] - systems[a]) || a.localeCompare(b),
  );
  for (const name of names) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.system = name;
    chip.innerHTML = `<span class="swatch" style="background:${SYSTEM_COLORS[name] || '#94a3b8'}"></span>`
      + `${name} <b>${systems[name]}</b>`;
    chip.addEventListener('click', () => {
      if (state.activeSystems.has(name)) {
        state.activeSystems.delete(name);
        chip.classList.add('off');
      } else {
        state.activeSystems.add(name);
        chip.classList.remove('off');
      }
      renderSky();
    });
    dom.systemFilter.appendChild(chip);
  }
}

/* ------------------------------------------------------------------ *
 * 数据装载
 * ------------------------------------------------------------------ */
function updateMapInfo() {
  const summary = state.summary;
  if (!summary || !summary.bounds) {
    dom.mapInfo.textContent = '';
    return;
  }
  const duration = summary.duration === undefined ? '—' : `${summary.duration.toFixed(1)} s`;
  dom.mapInfo.innerHTML = [
    `文件：${state.sourceName}`,
    `历元：${summary.epochs}（有效定位 ${summary.located}）　时长：${duration}`,
    `轨迹长度：${summary.distance.toFixed(1)} m　最大速度：${summary.maxSpeedKmh.toFixed(2)} km/h`,
  ].join('<br>');
}

function loadText(text, name) {
  const started = performance.now();
  const parsed = parseNmea(text);
  const elapsed = performance.now() - started;

  if (!parsed.epochs.length) {
    toast('未能从文件中解析出历元，请确认是标准 NMEA 日志。', true);
    return;
  }

  stopPlayback();
  state.epochs = parsed.epochs;
  state.stats = parsed.stats;
  state.summary = summarize(parsed.epochs);
  state.sourceName = name;
  state.index = 0;
  state.maxSpeedKmh = state.summary.maxSpeedKmh;

  const systems = state.summary.systems || {};
  state.activeSystems = new Set(Object.keys(systems));
  buildSystemChips(systems);

  dom.slider.max = String(state.epochs.length - 1);
  dom.slider.value = '0';
  dom.slider.disabled = false;
  dom.btnPlay.disabled = false;

  updateMapInfo();
  renderMap(true);
  renderEpoch();

  toast(`已加载 ${name}：${state.epochs.length} 个历元，解析 ${elapsed.toFixed(0)} ms`);
  if (state.stats.checksumErrors) {
    toast(`已加载 ${name}（${state.epochs.length} 个历元），但有 ${state.stats.checksumErrors} 条语句校验和错误，已跳过。`, true);
  }
}

async function loadDefaultFile() {
  try {
    const response = await fetch('/nmea.log', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    loadText(text, 'nmea.log');
  } catch (error) {
    toast('无法自动读取 nmea.log，请点击「打开 NMEA 文件」选择文件；'
      + '或先运行 python serve.py 启动本地服务。', true);
  }
}

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */
function cacheDom() {
  dom.toast = document.getElementById('toast');
  dom.slider = document.getElementById('slider');
  dom.btnPlay = document.getElementById('btn-play');
  dom.epochLabel = document.getElementById('epoch-label');
  dom.mapInfo = document.getElementById('map-info');
  dom.systemFilter = document.getElementById('system-filter');
  dom.readouts = document.getElementById('readouts');
  dom.courseTitle = document.getElementById('course-title');
  dom.fileInput = document.getElementById('file-input');
  dom.mapStyle = document.getElementById('map-style');
  dom.speed = document.getElementById('speed');
  dom.showLabels = document.getElementById('show-labels');
}

function bindEvents() {
  dom.fileInput.addEventListener('change', () => {
    const file = dom.fileInput.files && dom.fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => loadText(String(reader.result), file.name);
    reader.onerror = () => toast('读取文件失败。', true);
    reader.readAsText(file, 'utf-8');
  });

  dom.mapStyle.addEventListener('change', () => {
    state.mapSource = dom.mapStyle.value;
    state.mapReady = false;
    // 直接改 raster layer 会撞上 mapbox 的 "Style is not done loading"，
    // 因此先拆掉地图容器，再在下一帧重建
    Plotly.purge('map');
    document.getElementById('map').innerHTML = '';
    requestAnimationFrame(() => requestAnimationFrame(() => renderMap(true)));
  });

  dom.btnPlay.addEventListener('click', togglePlayback);

  dom.slider.addEventListener('input', () => {
    stopPlayback();
    state.index = Number(dom.slider.value);
    requestRender();
  });

  dom.speed.addEventListener('change', () => {
    state.speed = Number(dom.speed.value) || 1;
  });

  dom.showLabels.addEventListener('change', () => {
    state.showLabels = dom.showLabels.checked;
    renderSky();
  });

  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.code === 'Space') {
      event.preventDefault();
      togglePlayback();
    } else if (event.code === 'ArrowRight') {
      event.preventDefault();
      stopPlayback();
      state.index = Math.min(state.epochs.length - 1, state.index + 1);
      requestRender();
    } else if (event.code === 'ArrowLeft') {
      event.preventDefault();
      stopPlayback();
      state.index = Math.max(0, state.index - 1);
      requestRender();
    }
  });

  const dropZone = document.body;
  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropZone.classList.add('dragging');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragging');
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => loadText(String(reader.result), file.name);
    reader.readAsText(file, 'utf-8');
  });

  window.addEventListener('resize', () => resizePlots());

  if (typeof ResizeObserver !== 'undefined') {
    let scheduled = false;
    const observer = new ResizeObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        resizePlots();
      });
    });
    ['map', 'sky', 'gauge-speed', 'gauge-course'].forEach((id) => {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    });
  }

  window.addEventListener('error', (event) => {
    if (event.message) toast(`页面脚本错误：${event.message}`, true);
  });
}

function init() {
  cacheDom();
  bindEvents();

  // 支持 ?base=gaode-street 这类链接直接指定底图
  const params = new URLSearchParams(location.search);
  const requested = params.get('base');
  if (requested && TILE_SOURCES[requested]) {
    state.mapSource = requested;
    dom.mapStyle.value = requested;
  }

  if (location.protocol === 'file:') {
    toast('当前以 file:// 打开，浏览器会阻止读取 nmea.log。'
      + '请运行 python serve.py 后访问 http://localhost:8000/ 。', true);
    return;
  }
  loadDefaultFile();
}

document.addEventListener('DOMContentLoaded', init);
