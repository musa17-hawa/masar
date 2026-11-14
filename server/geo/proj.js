// Map projections Masar needs, written out by hand so the app has no dependencies.
//   EPSG:2056  CH1903+ / LV95  (swisstopo data)     — swisstopo approximate formulas (≈1 m)
//   EPSG:21781 CH1903 / LV03   (older Swiss data)
//   EPSG:326xx / 327xx / 258xx UTM zones (WGS84 / ETRS89)
//   EPSG:2039  Israeli Transverse Mercator (ITM), with the 7-parameter datum shift
// Every projection exposes toWgs(x, y) -> [lon, lat] and fromWgs(lon, lat) -> [x, y].

const RAD = Math.PI / 180;

const lv95 = {
  fromWgs(lon, lat) {
    const p = (lat * 3600 - 169028.66) / 10000;
    const l = (lon * 3600 - 26782.5) / 10000;
    const e = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3;
    const n = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3;
    return [e, n];
  },
  toWgs(e, n) {
    const y = (e - 2600000) / 1e6;
    const x = (n - 1200000) / 1e6;
    const l = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3;
    const p = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x ** 3;
    return [l * 100 / 36, p * 100 / 36];
  },
};

// Transverse Mercator (Snyder, "Map Projections: A Working Manual", eqs. 8-9 .. 8-25).
function transverseMercator({ a, invF, lat0, lon0, k0, fe, fn }) {
  const f = 1 / invF;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const M = (phi) => a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  const M0 = M(lat0 * RAD);
  return {
    fromWgs(lon, lat) {
      const phi = lat * RAD;
      const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
      const T = Math.tan(phi) ** 2;
      const C = ep2 * Math.cos(phi) ** 2;
      const A = (lon - lon0) * RAD * Math.cos(phi);
      const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120);
      const y = k0 * (M(phi) - M0 + N * Math.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24
        + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
      return [x + fe, y + fn];
    },
    toWgs(x, y) {
      const M1 = M0 + (y - fn) / k0;
      const mu = M1 / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));
      const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
      const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
        + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
      const C1 = ep2 * Math.cos(phi1) ** 2;
      const T1 = Math.tan(phi1) ** 2;
      const N1 = a / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2);
      const R1 = a * (1 - e2) / (1 - e2 * Math.sin(phi1) ** 2) ** 1.5;
      const D = (x - fe) / (N1 * k0);
      const lat = phi1 - (N1 * Math.tan(phi1) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24
        + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
      const lon = lon0 * RAD + (D - (1 + 2 * T1 + C1) * D ** 3 / 6
        + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / Math.cos(phi1);
      return [lon / RAD, lat / RAD];
    },
  };
}

// Helmert 7-parameter shift between two geodetic datums (position-vector convention, as in PROJ +towgs84).
function helmert(lon, lat, from, to, p, inverse) {
  const sgn = inverse ? -1 : 1;
  const [dx, dy, dz] = [p[0] * sgn, p[1] * sgn, p[2] * sgn];
  const sec = Math.PI / 648000;
  const [rx, ry, rz] = [p[3] * sec * sgn, p[4] * sec * sgn, p[5] * sec * sgn];
  const s = 1 + p[6] * 1e-6 * sgn;
  const e2a = (1 / from.invF) * (2 - 1 / from.invF);
  const phi = lat * RAD, lam = lon * RAD;
  const N = from.a / Math.sqrt(1 - e2a * Math.sin(phi) ** 2);
  const X = N * Math.cos(phi) * Math.cos(lam), Y = N * Math.cos(phi) * Math.sin(lam), Z = N * (1 - e2a) * Math.sin(phi);
  const X2 = dx + s * (X - rz * Y + ry * Z);
  const Y2 = dy + s * (rz * X + Y - rx * Z);
  const Z2 = dz + s * (-ry * X + rx * Y + Z);
  const e2b = (1 / to.invF) * (2 - 1 / to.invF);
  const pxy = Math.hypot(X2, Y2);
  let phi2 = Math.atan2(Z2, pxy * (1 - e2b));
  for (let i = 0; i < 6; i++) {
    const N2 = to.a / Math.sqrt(1 - e2b * Math.sin(phi2) ** 2);
    phi2 = Math.atan2(Z2 + e2b * N2 * Math.sin(phi2), pxy);
  }
  return [Math.atan2(Y2, X2) / RAD, phi2 / RAD];
}

const WGS84 = { a: 6378137, invF: 298.257223563 };
const GRS80 = { a: 6378137, invF: 298.257222101 };

function utm(zone, south) {
  return transverseMercator({ ...WGS84, lat0: 0, lon0: zone * 6 - 183, k0: 0.9996, fe: 500000, fn: south ? 10000000 : 0 });
}

const itmTm = transverseMercator({ ...GRS80, lat0: 31.7343936111111, lon0: 35.2045169444444, k0: 1.0000067, fe: 219529.584, fn: 626907.39 });
const ITM_TOWGS84 = [-24.0024, -17.1032, -17.8444, -0.33077, -1.85269, 1.66969, 5.4248];
const itm = {
  fromWgs(lon, lat) { const [l, p] = helmert(lon, lat, WGS84, GRS80, ITM_TOWGS84, true); return itmTm.fromWgs(l, p); },
  toWgs(x, y) { const [l, p] = itmTm.toWgs(x, y); return helmert(l, p, GRS80, WGS84, ITM_TOWGS84, false); },
};

export function getProjection(epsg) {
  epsg = Number(epsg);
  if (epsg === 2056) return { epsg, name: 'CH1903+ / LV95', ...lv95 };
  if (epsg === 21781) {
    return { epsg, name: 'CH1903 / LV03',
      fromWgs: (lon, lat) => { const [e, n] = lv95.fromWgs(lon, lat); return [e - 2e6, n - 1e6]; },
      toWgs: (e, n) => lv95.toWgs(e + 2e6, n + 1e6) };
  }
  if (epsg === 2039) return { epsg, name: 'Israel 1993 / Israeli TM Grid', ...itm };
  if (epsg >= 32601 && epsg <= 32660) return { epsg, name: `WGS 84 / UTM zone ${epsg - 32600}N`, ...utm(epsg - 32600, false) };
  if (epsg >= 32701 && epsg <= 32760) return { epsg, name: `WGS 84 / UTM zone ${epsg - 32700}S`, ...utm(epsg - 32700, true) };
  if (epsg >= 25828 && epsg <= 25838) return { epsg, name: `ETRS89 / UTM zone ${epsg - 25800}N`, ...utm(epsg - 25800, false) };
  return null;
}

// Guess the coordinate system from the numbers alone. Only unmistakable ranges are guessed.
export function guessEpsg(b) {
  if (!b) return null;
  if (b.minX > 2.45e6 && b.maxX < 2.85e6 && b.minY > 1.05e6 && b.maxY < 1.32e6) return 2056;
  if (b.minX > 1.0e5 && b.maxX < 3.0e5 && b.minY > 3.5e5 && b.maxY < 8.2e5) return 2039;
  return null;
}

export function utmEpsgFor(lon, lat) {
  const zone = Math.floor((lon + 180) / 6) + 1;
  return (lat >= 0 ? 32600 : 32700) + zone;
}

export const SUPPORTED_CRS = [
  { epsg: 2056, name: 'Switzerland — CH1903+ / LV95 (EPSG:2056)' },
  { epsg: 21781, name: 'Switzerland — CH1903 / LV03 (EPSG:21781)' },
  { epsg: 2039, name: 'Israel — ITM (EPSG:2039)' },
  { epsg: 0, name: 'UTM (WGS 84) — enter the EPSG code, e.g. 32632' },
];
