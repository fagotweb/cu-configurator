// build-json.js — сборка финального JSON
const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, 'compressors.json');
const OUTPUT = path.join(__dirname, 'compressors_final.json');

// ============================================================
// КОЭФФИЦИЕНТЫ (при To=+7, Tк=+50)
// ============================================================
const K = {
    k_min: 0.693,
    k_max: 1.544
};

const NQ = {
    RCVH22: { NQ_min: 0.368, NQ_max: 0.356 },
    RCVH25: { NQ_min: 0.363, NQ_max: 0.352 },
    RCVH35: { NQ_min: 0.324, NQ_max: 0.315 },
    RCVH46: { NQ_min: 0.314, NQ_max: 0.305 },
    RCVH55: { NQ_min: 0.312, NQ_max: 0.303 },
    RCVH68: { NQ_min: 0.309, NQ_max: 0.299 },
    RCVH86: { NQ_min: 0.301, NQ_max: 0.292 },
    RCVH116: { NQ_min: 0.297, NQ_max: 0.288 },
    RCVH170: { NQ_min: 0.293, NQ_max: 0.284 }
};

// ============================================================
// ВЕНТИЛЯТОРЫ
// curve: [flow м³/ч, pressure Па, current А]
// ============================================================
const FANS = {
    YWF6D500: {
        model: 'YWF(K)6D500-Z',
        connection: 'звезда',
        noise: 67,
        curve: [
            [2140, 80, 0.72], [2751, 70, 0.72], [3519, 60, 0.71],
            [3903, 49, 0.71], [4219, 41, 0.71], [4582, 30, 0.70],
            [4870, 20, 0.69], [5087, 10, 0.69], [5319, 0, 0.69]
        ]
    },
    YWF6D550: {
        model: 'YWF(K)6D550-Z',
        connection: 'звезда',
        noise: 67,
        curve: [
            [1979, 120, 0.90], [2273, 111, 0.89], [2432, 100, 0.90],
            [2665, 90, 0.89], [3077, 81, 0.87], [3947, 70, 0.87],
            [4227, 61, 0.86], [4691, 50, 0.86], [5057, 40, 0.87],
            [5399, 30, 0.87], [5685, 20, 0.86], [5894, 11, 0.86],
            [6169, 0, 0.86]
        ]
    },
    YWF6D600: {
        model: 'YWF(K)6D600-Z',
        connection: 'звезда',
        noise: 70,
        curve: [
            [1954, 160, 1.41], [2515, 139, 1.39], [2963, 120, 1.38],
            [3806, 99, 1.36], [5346, 79, 1.37], [6046, 60, 1.34],
            [6870, 40, 1.34], [7558, 20, 1.33], [8064, 0, 1.33]
        ]
    },
    YWF6D630: {
        model: 'YWF(K)6D630-Z',
        connection: 'звезда',
        noise: 75,
        curve: [
            [3971, 100, 1.51], [4215, 90, 1.50], [6137, 80, 1.52],
            [6816, 72, 1.53], [7439, 61, 1.53], [7981, 49, 1.53],
            [8282, 41, 1.52], [9068, 20, 1.52], [9592, 0, 1.50]
        ]
    },
    YWF6D710: {
        model: 'YWF(K)6D710-ZF-S7I',
        modes: {
            triangle: {
                connection: 'треугольник',
                noise: 79,
                curve: [
                    [8720, 120, 2.39], [10964, 100, 2.38], [12248, 80, 2.35],
                    [13439, 60, 2.34], [14572, 39, 2.30], [15448, 20, 2.27],
                    [15924, 0, 2.24]
                ]
            },
            star: {
                connection: 'звезда',
                noise: 73,
                curve: [
                    [4780, 90, 1.33], [6822, 80, 1.23], [9260, 60, 1.21],
                    [11283, 41, 1.20], [12419, 20, 1.17], [13400, 1, 1.13]
                ]
            }
        }
    },
    YWF6D800: {
        model: 'YWF(K)6D800-ZF-S7I',
        modes: {
            triangle: {
                connection: 'треугольник',
                noise: 80,
                curve: [
                    [6718, 175, 3.75], [8636, 148, 3.63], [13270, 119, 3.66],
                    [14902, 100, 3.66], [15471, 90, 3.63], [17490, 60, 3.61],
                    [18060, 50, 3.58], [19063, 31, 3.52], [20491, 0, 3.47]
                ]
            },
            star: {
                connection: 'звезда',
                noise: 74,
                curve: [
                    [5244, 110, 1.93], [6498, 100, 1.89], [7191, 89, 1.81],
                    [10792, 75, 1.86], [12326, 60, 1.83], [13704, 44, 1.79],
                    [14806, 30, 1.75], [15952, 15, 1.72], [16878, 0, 1.66]
                ]
            }
        }
    }
};

// ============================================================
// КАРТЫ КОНДЕНСАТОРОВ
// Q = f(V, ΔT), кВт. V — скорость воздуха, ΔT — температурный напор
// ============================================================
const CONDENSER_MAPS = {
    'SC-1400': {
        V_grid: [1, 1.5, 2, 2.5, 3],
        dT_grid: [10, 15, 20, 25],
        Q: [
            [5.8, 8.8, 11.7, 14.8],
            [8, 12.2, 16.6, 20.8],
            [9.9, 15.2, 20.9, 26.1],
            [11.7, 18.4, 24.7, 31.0],
            [13.2, 21.0, 27.1, 32.3]
        ]
    },
    'SC-1800A': {
        V_grid: [1, 1.5, 2, 2.5, 3],
        dT_grid: [10, 15, 20, 25],
        Q: [
            [11.74, 20.09, 27.62, 35.02],
            [18.23, 28.54, 39.71, 50.38],
            [23.03, 37.18, 50.82, 64.59],
            [27.38, 44.69, 61.08, 77.78],
            [31.32, 51.72, 70.81, 90.18]
        ]
    },
    'SC-2000A': {
        V_grid: [1, 1.5, 2, 2.5, 3],
        dT_grid: [10, 15, 20, 25],
        Q: [
            [22.7, 34.95, 46.97, 59.06],
            [32.7, 50.21, 67.52, 85.0],
            [41.98, 64.14, 86.37, 108.94],
            [50.4, 77.03, 103.81, 131.04],
            [58.23, 88.87, 120.06, 151.56]
        ]
    }
};


// ============================================================
// КОРПУСА
// front_area — площадь фронта, м²
// drop_curve: [velocity м/с, dP Па]
// ============================================================
const CASINGS = {
  'SC-1400': {
    front_area: 0.60,
    drop_curve: [[1.0, 9.31], [1.5, 14.66], [2.0, 22.32], [2.5, 29.79], [3.0, 35.73]],
    fan_options: [
      { fan: 'YWF6D500', qty: 1 },
      { fan: 'YWF6D550', qty: 1 },
      { fan: 'YWF6D600', qty: 1 }
    ]
  },
  'SC-1800A': {
    front_area: 1.30,
    drop_curve: [[1.0, 18.7], [1.5, 29.7], [2.0, 46.1], [2.5, 59.7], [3.0, 74.1]],
    fan_options: [
      { fan: 'YWF6D500', qty: 2 },
      { fan: 'YWF6D550', qty: 2 },
      { fan: 'YWF6D600', qty: 2 },
      { fan: 'YWF6D630', qty: 2 }
    ]
  },
  'SC-2000A': {
    front_area: 2.12,
    drop_curve: [[1.0, 8.7], [1.5, 29.7], [2.0, 46.0], [2.5, 59.7], [3.0, 74.0]],
    fan_options: [
      { fan: 'YWF6D630', qty: 2 },
      { fan: 'YWF6D710', qty: 2, mode: 'triangle' },
      { fan: 'YWF6D710', qty: 2, mode: 'star' }
    ]
  },
  '2×SC-1800A': {
    front_area: 2.60,
    drop_curve: [[1.0, 18.7], [1.5, 29.7], [2.0, 46.1], [2.5, 59.7], [3.0, 74.1]],
    fan_options: [
      { fan: 'YWF6D710', qty: 2, mode: 'triangle' },
      { fan: 'YWF6D710', qty: 2, mode: 'star' },
      { fan: 'YWF6D800', qty: 2, mode: 'triangle' },
      { fan: 'YWF6D800', qty: 2, mode: 'star' }
    ]
  }
};

// ============================================================
// КОНФИГУРАЦИИ
// ============================================================
const CONFIGS = [
    { id: 'SC-1400 / RCVH22', casing: 'SC-1400', inv: 'RCVH22', oo: null, maxQ_15K: 21.0, maxQ_20K: 28.3 },
    { id: 'SC-1400 / RCVH25', casing: 'SC-1400', inv: 'RCVH25', oo: null, maxQ_15K: 21.0, maxQ_20K: 28.3 },
    { id: 'SC-1400 / RCVH35', casing: 'SC-1400', inv: 'RCVH35', oo: null, maxQ_15K: 21.0, maxQ_20K: 28.3 },
    { id: 'SC-1400 / RCVH46', casing: 'SC-1400', inv: 'RCVH46', oo: null, maxQ_15K: 21.0, maxQ_20K: 28.3 },
    { id: 'SC-1400 / RCVH55', casing: 'SC-1400', inv: 'RCVH55', oo: null, maxQ_15K: 21.0, maxQ_20K: 28.3 },
    { id: 'SC-1800A / RCVH68', casing: 'SC-1800A', inv: 'RCVH68', oo: null, maxQ_15K: 51.7, maxQ_20K: 70.8 },
    { id: 'SC-1800A / RCVH86', casing: 'SC-1800A', inv: 'RCVH86', oo: null, maxQ_15K: 51.7, maxQ_20K: 70.8 },
    { id: 'SC-1800A / RCVH68+RCH54', casing: 'SC-1800A', inv: 'RCVH68', oo: 'RCH54', maxQ_15K: 51.7, maxQ_20K: 70.8 },
    { id: 'SC-1800A / RCVH68+RCH58', casing: 'SC-1800A', inv: 'RCVH68', oo: 'RCH58', maxQ_15K: 51.7, maxQ_20K: 70.8 },
    { id: 'SC-2000A / RCVH116', casing: 'SC-2000A', inv: 'RCVH116', oo: null, maxQ_15K: 88.9, maxQ_20K: 120.1 },
    { id: 'SC-2000A / RCVH170', casing: 'SC-2000A', inv: 'RCVH170', oo: null, maxQ_15K: 88.9, maxQ_20K: 120.1 },
    { id: 'SC-2000A / RCVH86+RCH74', casing: 'SC-2000A', inv: 'RCVH86', oo: 'RCH74', maxQ_15K: 88.9, maxQ_20K: 120.1 },
    { id: 'SC-2000A / RCVH116+RCH94', casing: 'SC-2000A', inv: 'RCVH116', oo: 'RCH94', maxQ_15K: 88.9, maxQ_20K: 120.1 },
    { id: '2×SC-1800A / RCVH170+RCH145', casing: '2×SC-1800A', inv: 'RCVH170', oo: 'RCH145', maxQ_15K: 103.4, maxQ_20K: 141.6 },
    { id: '2×SC-1800A / RCVH170+RCH128', casing: '2×SC-1800A', inv: 'RCVH170', oo: 'RCH128', maxQ_15K: 103.4, maxQ_20K: 141.6 }
];

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ
// ============================================================
function shortName(rawName) {
    if (rawName.includes('/')) return rawName.split('/')[0];
    const m = rawName.match(/^(RCH\d+)/);
    return m ? m[1] : rawName;
}

function getGrids(block) {
    const Tk_grid = Object.keys(block)
        .filter(k => k.startsWith('cond_'))
        .map(k => parseInt(k.slice(5)))
        .sort((a, b) => a - b);

    const firstBlock = block['cond_' + Tk_grid[0]];
    const To_grid = Object.keys(firstBlock)
        .filter(k => k.startsWith('evap_'))
        .map(k => parseInt(k.slice(5)))
        .sort((a, b) => a - b);

    return { Tk_grid, To_grid };
}

function toMatrix(block, Tk_grid, To_grid) {
    return Tk_grid.map(tk => {
        const row = block['cond_' + tk];
        if (!row) return To_grid.map(() => null);
        return To_grid.map(to => {
            const v = row['evap_' + to];
            return v === undefined ? null : v;
        });
    });
}

// ============================================================
// СБОРКА
// ============================================================
const raw = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
const inverters = {};
const onoff = {};

for (const [rawName, data] of Object.entries(raw)) {
    const name = shortName(rawName);
    const { Tk_grid, To_grid } = getGrids(data.cooling_capacity);
    const Q = toMatrix(data.cooling_capacity, Tk_grid, To_grid);
    const N = toMatrix(data.power_consumption, Tk_grid, To_grid);

    if (name.startsWith('RCVH')) {
        const nq = NQ[name] || { NQ_min: 0.30, NQ_max: 0.30 };
        inverters[name] = {
            To_grid, Tk_grid,
            k_min: K.k_min, k_max: K.k_max,
            NQ_min: nq.NQ_min, NQ_max: nq.NQ_max,
            Q, N
        };
    } else if (name.startsWith('RCH')) {
        onoff[name] = { To_grid, Tk_grid, Q, N };
    }
}

const result = {
    meta: {
        refrigerant: 'R410A',
        SH: 8, SC: 4,
        note: 'Q и N в кВт. Массивы [Tk][To]. Коэффициенты при To=+7, Tк=+50.'
    },
    inverters,
    onoff,
    fans: FANS,
    casings: CASINGS,
    condenser_maps: CONDENSER_MAPS,
    configs: CONFIGS
};

fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2), 'utf8');

console.log('✓ compressors_final.json создан');
console.log('  Инверторов: ' + Object.keys(inverters).length);
console.log('  On/off:     ' + Object.keys(onoff).length);
console.log('  Вентиляторов: ' + Object.keys(FANS).length);
console.log('  Корпусов:   ' + Object.keys(CASINGS).length);
console.log('  Конфигураций: ' + CONFIGS.length);