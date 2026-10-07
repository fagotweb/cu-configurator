// app.js — v5

let DATA = null;
const state = { selections: {} };

const ALT_CONFIGS = [
    'SC-1800A / RCVH68+RCH54',
    '2×SC-1800A / RCVH170+RCH145'
];

const BASE_FANS = {
    'SC-1400': { fan: 'YWF6D600', qty: 1 },
    'SC-1800A': { fan: 'YWF6D630', qty: 2 },
    'SC-2000A': { fan: 'YWF6D710', qty: 2, mode: 'triangle' },
    '2×SC-1800A': { fan: 'YWF6D800', qty: 2, mode: 'triangle' }
};

function getMapKey(casing) {
    if (casing === '2×SC-1800A') return { key: 'SC-1800A', mult: 2 };
    return { key: casing, mult: 1 };
}

// ============================================================
// ЗАГРУЗКА
// ============================================================
async function loadData() {
    const res = await fetch('compressors_final.json');
    if (!res.ok) throw new Error('Не удалось загрузить compressors_final.json');
    DATA = await res.json();
    buildReferenceTables();
}

// ============================================================
// ИНТЕРПОЛЯЦИЯ
// ============================================================
function findInterval(grid, value) {
    if (value <= grid[0]) return { i: 0, t: 0 };
    if (value >= grid[grid.length - 1]) return { i: grid.length - 2, t: 1 };
    for (let i = 0; i < grid.length - 1; i++) {
        if (value >= grid[i] && value <= grid[i + 1]) {
            return { i, t: (value - grid[i]) / (grid[i + 1] - grid[i]) };
        }
    }
    return { i: 0, t: 0 };
}

function bilinear(matrix, To_grid, Tk_grid, To, Tk) {
    const { i: iTo, t: tTo } = findInterval(To_grid, To);
    const { i: iTk, t: tTk } = findInterval(Tk_grid, Tk);
    const q00 = matrix[iTk][iTo];
    const q01 = matrix[iTk][iTo + 1];
    const q10 = matrix[iTk + 1][iTo];
    const q11 = matrix[iTk + 1][iTo + 1];
    if (q00 == null || q01 == null || q10 == null || q11 == null) return null;
    return q00 * (1 - tTo) * (1 - tTk)
        + q01 * tTo * (1 - tTk)
        + q10 * (1 - tTo) * tTk
        + q11 * tTo * tTk;
}

function interp1D(points, x) {
    const n = points.length;
    if (x <= points[0].x) {
        if (n >= 2) {
            const k = (points[1].y - points[0].y) / (points[1].x - points[0].x);
            return points[0].y + k * (x - points[0].x);
        }
        return points[0].y;
    }
    if (x >= points[n - 1].x) {
        if (n >= 2) {
            const k = (points[n - 1].y - points[n - 2].y) / (points[n - 1].x - points[n - 2].x);
            return points[n - 1].y + k * (x - points[n - 1].x);
        }
        return points[n - 1].y;
    }
    for (let i = 0; i < n - 1; i++) {
        if (x >= points[i].x && x <= points[i + 1].x) {
            const t = (x - points[i].x) / (points[i + 1].x - points[i].x);
            return points[i].y + (points[i + 1].y - points[i].y) * t;
        }
    }
    return points[n - 1].y;
}

// ============================================================
// ВЕНТИЛЯТОРЫ
// ============================================================
function getFanCurve(fan, mode) {
    if (fan.modes) return fan.modes[mode || 'triangle'].curve;
    return fan.curve;
}

function getFanNoise(fan, mode) {
    if (fan.modes) return fan.modes[mode || 'triangle'].noise;
    return fan.noise;
}

function findOperatingPoint(fanCurve, casing, fanConfig) {
    const area = casing.front_area;
    const qty = fanConfig.qty;
    const dropCurve = casing.drop_curve.map(([v, dp]) => ({ x: v, y: dp }));
    const fanPts = fanCurve.map(([f, p]) => ({ x: f, y: p }));

    let bestV = 2.5, bestDiff = Infinity;
    for (let V = 0.5; V <= 6.0; V += 0.05) {
        const flowPerFan = (V * area * 3600) / qty;
        const fanPressure = interp1D(fanPts, flowPerFan);
        const resistance = interp1D(dropCurve, V);
        const diff = Math.abs(fanPressure - resistance);
        if (diff < bestDiff) { bestDiff = diff; bestV = V; }
    }

    const V = bestV;
    const flowPerFan = (V * area * 3600) / qty;
    const totalFlow = flowPerFan * qty;
    const pressure = interp1D(dropCurve, V);
    const currentPts = fanCurve.map(([f, p, i]) => ({ x: f, y: i }));
    const current = interp1D(currentPts, flowPerFan);
    const power = (pressure * (flowPerFan / 3600)) / 0.35;

    return { speed: V, flowTotal: totalFlow, pressure, current, power, qty };
}

// ============================================================
// КОНДЕНСАТОР
// ============================================================
function getCondenserMaxQ(casing, dT, V) {
    const { key, mult } = getMapKey(casing);
    const map = DATA.condenser_maps[key];
    if (!map) return 0;

    const dT_grid = map.dT_grid;
    const V_grid = map.V_grid;
    const dT_clamp = Math.max(dT_grid[0], Math.min(dT_grid[dT_grid.length - 1], dT));
    const { i: iDT, t: tDT } = findInterval(dT_grid, dT_clamp);

    function qAtColumn(colIdx) {
        const pts = V_grid.map((v, i) => ({ x: v, y: map.Q[i][colIdx] }));
        return interp1D(pts, V);
    }

    return mult * (qAtColumn(iDT) + (qAtColumn(iDT + 1) - qAtColumn(iDT)) * tDT);
}

// ============================================================
// АНАЛИЗ ПАРЫ (конфигурация + вентилятор)
// ============================================================
function analyzeConfigFan(cfg, fanIdx, T_nar, To, Q_req) {
    const inv = DATA.inverters[cfg.inv];
    const casing = DATA.casings[cfg.casing];
    const fanOpt = casing.fan_options[fanIdx];
    const fan = DATA.fans[fanOpt.fan];
    const curve = getFanCurve(fan, fanOpt.mode);
    const op = findOperatingPoint(curve, casing, { qty: fanOpt.qty });
    const V = op.speed;

    // Ищем минимальный рабочий ΔT = точку максимума Q
    let best = null;
    for (let dT = 10; dT <= 25.001; dT += 0.5) {
        const Tk = T_nar + dT;
        const Q50 = bilinear(inv.Q, inv.To_grid, inv.Tk_grid, To, Tk);
        const N50 = bilinear(inv.N, inv.To_grid, inv.Tk_grid, To, Tk);
        if (Q50 == null) continue;

        const Qmax_inv = Q50 * inv.k_max;
        const Nmax_inv = Qmax_inv * inv.NQ_max;
        const Qmin_inv = Q50 * inv.k_min;

        let Q_onoff = 0, N_onoff = 0;
        if (cfg.oo) {
            const oo = DATA.onoff[cfg.oo];
            Q_onoff = bilinear(oo.Q, oo.To_grid, oo.Tk_grid, To, Tk) || 0;
            N_onoff = bilinear(oo.N, oo.To_grid, oo.Tk_grid, To, Tk) || 0;
        }

        const Qmax_sys = Qmax_inv + Q_onoff;
        const Q_cond_at_max = Qmax_sys + Nmax_inv + N_onoff;
        const Q_cond_cap = getCondenserMaxQ(cfg.casing, dT, V);

        if (Q_cond_at_max <= Q_cond_cap) {
            best = {
                dT, Tk, Q50,
                Qmax_inv, Qmin_inv, Nmax_inv,
                Q_onoff, N_onoff,
                Qmax_sys,
                Qmin_sys: Qmin_inv
            };
            break;
        }
    }

    if (!best) return null;

    // Рабочий режим для конкретной Q_req
    let N = null, freq = null, Q_cond = null;
    let onoff_needed = Q_req > best.Qmax_inv;
    let passes = false;

    if (Q_req >= best.Qmin_sys && Q_req <= best.Qmax_sys) {
        const Nmin_inv = best.Qmin_inv * inv.NQ_min;
        const Nmax_inv2 = best.Qmax_inv * inv.NQ_max;
        if (Q_req <= best.Qmax_inv) {
            N = Nmin_inv + (Nmax_inv2 - Nmin_inv) *
                (Q_req - best.Qmin_inv) / (best.Qmax_inv - best.Qmin_inv);
            freq = 35 + (Q_req - best.Qmin_inv) / (best.Qmax_inv - best.Qmin_inv) * 40;
        } else {
            const Q_inv = Math.max(best.Qmin_inv, Q_req - best.Q_onoff);
            const N_inv = Nmin_inv + (Nmax_inv2 - Nmin_inv) *
                (Q_inv - best.Qmin_inv) / (best.Qmax_inv - best.Qmin_inv);
            N = N_inv + best.N_onoff;
            freq = 35 + (Q_inv - best.Qmin_inv) / (best.Qmax_inv - best.Qmin_inv) * 40;
        }
        Q_cond = Q_req + N;
        passes = true;
    }

    return {
        id: cfg.id,
        casing: cfg.casing,
        inv: cfg.inv,
        oo: cfg.oo,
        fanIdx, fanOpt, V, op,
        Qmin: best.Qmin_sys,
        Qmax: best.Qmax_sys,
        dT_max: best.dT,
        Tk_max: best.Tk,
        N, freq, Q_cond,
        onoff_needed,
        passes
    };
}

// ============================================================
// ПОДБОР
// ============================================================
function selectConfigs(T_nar, To, Q_req) {
    const results = [];

    for (const cfg of DATA.configs) {
        const casing = DATA.casings[cfg.casing];
        const baseRef = BASE_FANS[cfg.casing];
        const baseIdx = casing.fan_options.findIndex(o =>
            o.fan === baseRef.fan && o.qty === baseRef.qty &&
            (o.mode || null) === (baseRef.mode || null)
        );
        if (baseIdx < 0) continue;

        const analysis = analyzeConfigFan(cfg, baseIdx, T_nar, To, Q_req);
        if (!analysis || !analysis.passes) continue;

        results.push(analysis);
    }

    results.sort((a, b) => a.Qmax - b.Qmax);
    return results;
}

// ============================================================
// ЛОГИКА ЦВЕТА
// ============================================================
function getRowClass(r, passesByCond) {
    if (!passesByCond || !r.passes) return 'fail';
    if (r.oo && !r.onoff_needed) return 'fail';
    if (r.freq >= 45 && r.freq <= 65) return 'ok';
    return 'warn';
}

// ============================================================
// ВАЛИДАЦИЯ
// ============================================================
function validate() {
    const fields = [
        { id: 'tnar', min: 5, max: 47, label: 'Допустимо от +5 до +47 °C' },
        { id: 'to', min: 2, max: 10, label: 'Допустимо от +2 до +10 °C' },
        { id: 'qreq', min: 5, max: 101, label: 'Допустимо от 5 до 101 кВт' }
    ];
    let ok = true;
    for (const f of fields) {
        const el = document.getElementById(f.id);
        const err = document.getElementById('err-' + f.id);
        const val = parseFloat(el.value);
        if (isNaN(val) || val < f.min || val > f.max) {
            el.classList.add('invalid');
            err.textContent = f.label;
            ok = false;
        } else {
            el.classList.remove('invalid');
            err.textContent = '';
        }
    }
    return ok;
}

// ============================================================
// UI
// ============================================================
let LAST_RESULTS = [];

function run() {
    if (!DATA) return;
    if (!validate()) return;

    const T_nar = parseFloat(document.getElementById('tnar').value);
    const To = parseFloat(document.getElementById('to').value);
    const Q_req = parseFloat(document.getElementById('qreq').value);

    const res = selectConfigs(T_nar, To, Q_req);
    LAST_RESULTS = res;
    renderResults(res, T_nar, To, Q_req);
}

function cssId(s) { return s.replace(/[^a-z0-9]/gi, '_'); }

function renderResults(res, T_nar, To, Q_req) {
    const out = document.getElementById('out');
    if (!res.length) {
        out.innerHTML = `<div class="empty">
      Ничего не найдено для Q=${Q_req} кВт при To=${To}°C, Тнар=${T_nar}°C.<br>
      Попробуйте изменить параметры.
    </div>`;
        return;
    }

    let html = `<div class="summary">
    <span>Найдено вариантов: <b>${res.length}</b> · Тнар=${T_nar}°C · To=${To}°C · Q=${Q_req} кВт</span>
    <button class="btn-export" onclick="exportCSV(${T_nar}, ${To}, ${Q_req})">Скачать CSV</button>
  </div>`;

    html += `<table><thead><tr>
    <th>Конфигурация</th>
    <th>Q мин, кВт</th>
    <th>Q макс, кВт</th>
    <th>Частота, Гц</th>
    <th>N, кВт</th>
    <th>Q конд, кВт</th>
    <th>ΔT макс, K</th>
    <th>Tк макс, °C</th>
    <th style="min-width:280px">Вентилятор</th>
  </tr></thead><tbody>`;

    for (const r of res) {
        const casing = DATA.casings[r.casing];
        const selIdx = state.selections[r.id] ?? r.fanIdx;

        const options = casing.fan_options.map((opt, idx) => {
            const fan = DATA.fans[opt.fan];
            const modeLabel = opt.mode ? ` (${opt.mode === 'triangle' ? 'Δ' : 'Y'})` : '';
            const label = `${opt.qty}×${fan.model}${modeLabel}`;
            return `<option value="${idx}" ${idx === selIdx ? 'selected' : ''}>${label}</option>`;
        }).join('');

        const freqStr = `${Math.round(r.freq)}`;
        const cls = getRowClass(r, true);

        html += `<tr class="${cls}" id="row-${cssId(r.id)}">
      <td>${r.id}</td>
      <td class="cell-Qmin">${r.Qmin.toFixed(2)}</td>
      <td class="cell-Qmax">${r.Qmax.toFixed(2)}</td>
      <td class="cell-freq">${freqStr}</td>
      <td class="cell-N">${r.N.toFixed(2)}</td>
      <td class="cell-Qcond">${r.Q_cond.toFixed(2)}</td>
      <td class="cell-dT">${r.dT_max.toFixed(1)}</td>
      <td class="cell-Tk">${r.Tk_max.toFixed(1)}</td>
      <td>
        <select class="fan-select" onchange="changeFan('${r.id}', this.value)">
          ${options}
        </select>
        <div class="fan-info" id="fan-info-${cssId(r.id)}"></div>
      </td>
    </tr>`;
    }

    html += '</tbody></table>';
    out.innerHTML = html;

    for (const r of res) updateFanInfo(r);
}

function changeFan(cfgId, val) {
    state.selections[cfgId] = parseInt(val);
    const r = LAST_RESULTS.find(x => x.id === cfgId);
    if (r) updateFanInfo(r);
}

function updateFanInfo(r) {
    const cfg = DATA.configs.find(c => c.id === r.id);
    if (!cfg) return;
    const casing = DATA.casings[cfg.casing];
    const selIdx = state.selections[r.id] ?? r.fanIdx;
    const fanOpt = casing.fan_options[selIdx];
    if (!fanOpt) return;

    const T_nar = parseFloat(document.getElementById('tnar').value);
    const To = parseFloat(document.getElementById('to').value);
    const Q_req = parseFloat(document.getElementById('qreq').value);

    const analysis = analyzeConfigFan(cfg, selIdx, T_nar, To, Q_req);
    const fan = DATA.fans[fanOpt.fan];

    const row = document.getElementById('row-' + cssId(r.id));
    const el = document.getElementById('fan-info-' + cssId(r.id));
    if (!el || !row) return;

    if (!analysis) {
        el.innerHTML = `<span style="color:#dc2626">Не проходит по конденсатору</span>`;
        el.style.cssText = 'font-size:11px;color:#6b7280;margin-top:4px;text-align:left;';
        row.className = 'fail';
        return;
    }

    const op = analysis.op;
    const baseInfo = `V=${op.speed.toFixed(2)} м/с · Q=${Math.round(op.flowTotal)} м³/ч · ` +
        `ΔP=${Math.round(op.pressure)} Па · I=${op.current.toFixed(2)} А · ` +
        `Шум ${getFanNoise(fan, fanOpt.mode)} дБ(А)`;

    if (!analysis.passes) {
        el.innerHTML = baseInfo + `<br><span style="color:#dc2626">` +
            `Q=${Q_req} вне диапазона ${analysis.Qmin.toFixed(1)}…${analysis.Qmax.toFixed(1)} кВт</span>`;
        el.style.cssText = 'font-size:11px;color:#6b7280;margin-top:4px;text-align:left;';
        row.className = 'fail';

        // Обновляем Q мин/макс (они всегда актуальны для текущего вентилятора)
        row.querySelector('.cell-Qmin').textContent = analysis.Qmin.toFixed(2);
        row.querySelector('.cell-Qmax').textContent = analysis.Qmax.toFixed(2);
        // Остальные — прочерк
        row.querySelector('.cell-N').textContent = '—';
        row.querySelector('.cell-Qcond').textContent = '—';
        row.querySelector('.cell-dT').textContent = '—';
        row.querySelector('.cell-Tk').textContent = '—';
        row.querySelector('.cell-freq').textContent = '—';
        return;
    }

    el.innerHTML = baseInfo;
    el.style.cssText = 'font-size:11px;color:#6b7280;margin-top:4px;text-align:left;';

    // Обновляем ячейки
    row.querySelector('.cell-Qmin').textContent = analysis.Qmin.toFixed(2);
    row.querySelector('.cell-Qmax').textContent = analysis.Qmax.toFixed(2);
    row.querySelector('.cell-N').textContent = analysis.N.toFixed(2);
    row.querySelector('.cell-Qcond').textContent = analysis.Q_cond.toFixed(2);
    row.querySelector('.cell-dT').textContent = analysis.dT_max.toFixed(1);
    row.querySelector('.cell-Tk').textContent = analysis.Tk_max.toFixed(1);

    row.querySelector('.cell-freq').textContent = `${Math.round(analysis.freq)}`;

    row.className = getRowClass({ ...analysis, oo: cfg.oo }, true);
}

// ============================================================
// СПРАВОЧНИКИ
// ============================================================
function buildReferenceTables() {
    // Фиксированные условия справочника
    const To_ref = 7;
    const Tnar_ref = 35;
    const dT_ref = 15;
    const Tk_ref = Tnar_ref + dT_ref;   // = 50

    let h = `<p class="ref-conditions">
    Все значения — при ΔT = 15 K · To = +7 °C · Тнар = +35 °C (Tк = +50 °C).
    Вентиляторы в справочнике не учтены.
  </p>`;

    h += `<table><thead><tr>
    <th>Конфигурация</th>
    <th>Q мин, кВт</th>
    <th>Q макс, кВт</th>
    <th>N макс, кВт</th>
    <th>Q конд макс, кВт</th>
  </tr></thead><tbody>`;

    for (const c of DATA.configs) {
        const inv = DATA.inverters[c.inv];
        const Q50 = bilinear(inv.Q, inv.To_grid, inv.Tk_grid, To_ref, Tk_ref);
        const N50 = bilinear(inv.N, inv.To_grid, inv.Tk_grid, To_ref, Tk_ref);

        if (Q50 == null) {
            h += `<tr><td>${c.id}</td><td colspan="4">— нет данных —</td></tr>`;
            continue;
        }

        const Qmin = Q50 * inv.k_min;
        const Qmax_inv = Q50 * inv.k_max;
        const Nmax_inv = Qmax_inv * inv.NQ_max;

        let Q_onoff = 0, N_onoff = 0;
        if (c.oo) {
            const oo = DATA.onoff[c.oo];
            Q_onoff = bilinear(oo.Q, oo.To_grid, oo.Tk_grid, To_ref, Tk_ref) || 0;
            N_onoff = bilinear(oo.N, oo.To_grid, oo.Tk_grid, To_ref, Tk_ref) || 0;
        }

        const Qmax = Qmax_inv + Q_onoff;
        const Nmax = Nmax_inv + N_onoff;
        const Qcond = Qmax + Nmax;

        const isAlt = ALT_CONFIGS.includes(c.id);
        const rowClass = isAlt ? 'alt-row' : '';
        h += '<tr class="' + rowClass + '">' +
            '<td>' + c.id + '</td>' +
            '<td>' + Qmin.toFixed(2) + '</td>' +
            '<td>' + Qmax.toFixed(2) + '</td>' +
            '<td>' + Nmax.toFixed(2) + '</td>' +
            '<td>' + Qcond.toFixed(2) + '</td>' +
            '</tr>';
    }

    h += '</tbody></table>' +
        '<p class="alt-legend">' +
        '<span class="alt-marker"></span>' +
        '<b>Альтернативные конфигурации</b> — второй ряд линейки. ' +
        'Применяются, когда стандартная конфигурация не покрывает требуемый диапазон или недоступна.' +
        '</p>';

    document.getElementById('ref-configs').innerHTML = h;

    h = `<table><thead><tr>
    <th>Модель</th><th>Режим</th><th>Шум, дБ(А)</th>
    <th>Расход max, м³/ч</th><th>Напор max, Па</th><th>Ток, А</th>
  </tr></thead><tbody>`;
    for (const fan of Object.values(DATA.fans)) {
        if (fan.modes) {
            for (const [mode, m] of Object.entries(fan.modes)) {
                const maxFlow = Math.max(...m.curve.map(c => c[0]));
                const maxPress = Math.max(...m.curve.map(c => c[1]));
                const maxI = Math.max(...m.curve.map(c => c[2]));
                h += `<tr>
          <td>${fan.model}</td>
          <td>${mode === 'triangle' ? 'треугольник' : 'звезда'}</td>
          <td>${m.noise}</td>
          <td>${maxFlow}</td>
          <td>${maxPress}</td>
          <td>${maxI.toFixed(2)}</td>
        </tr>`;
            }
        } else {
            const maxFlow = Math.max(...fan.curve.map(c => c[0]));
            const maxPress = Math.max(...fan.curve.map(c => c[1]));
            const maxI = Math.max(...fan.curve.map(c => c[2]));
            h += `<tr>
        <td>${fan.model}</td>
        <td>${fan.connection}</td>
        <td>${fan.noise}</td>
        <td>${maxFlow}</td>
        <td>${maxPress}</td>
        <td>${maxI.toFixed(2)}</td>
      </tr>`;
        }
    }
    h += '</tbody></table>';
    document.getElementById('ref-fans').innerHTML = h;
}

function exportCSV(T_nar, To, Q_req) {
    if (!LAST_RESULTS || !LAST_RESULTS.length) return;

    // Заменяем точку на запятую для русской локали Excel
    const num = (v, dec = 2) => String(Number(v).toFixed(dec)).replace('.', ',');

    const rows = [
        ['Конфигурация', 'Q мин, кВт', 'Q макс, кВт', 'Частота, Гц',
            'N, кВт', 'Q конд, кВт', 'ΔT макс, K', 'Tк макс, °C',
            'Вентилятор', 'V, м/с', 'Расход, м³/ч', 'Напор, Па', 'Ток, А', 'Шум, дБ(А)']
    ];

    for (const r of LAST_RESULTS) {
        const casing = DATA.casings[r.casing];
        const selIdx = state.selections[r.id] ?? r.fanIdx;
        const opt = casing.fan_options[selIdx];
        const fan = DATA.fans[opt.fan];

        const cfg = DATA.configs.find(c => c.id === r.id);
        const analysis = analyzeConfigFan(cfg, selIdx, T_nar, To, Q_req);

        const fanLabel = `${opt.qty}×${fan.model}${opt.mode ? (opt.mode === 'triangle' ? ' (Δ)' : ' (Y)') : ''}`;
        const noise = getFanNoise(fan, opt.mode);

        if (analysis && analysis.passes) {
            rows.push([
                r.id,
                num(analysis.Qmin),
                num(analysis.Qmax),
                String(Math.round(analysis.freq)),
                num(analysis.N),
                num(analysis.Q_cond),
                num(analysis.dT_max, 1),
                num(analysis.Tk_max, 1),
                fanLabel,
                num(analysis.V),
                String(Math.round(analysis.op.flowTotal)),
                String(Math.round(analysis.op.pressure)),
                num(analysis.op.current),
                String(noise)
            ]);
        } else {
            rows.push([
                r.id,
                analysis ? num(analysis.Qmin) : '—',
                analysis ? num(analysis.Qmax) : '—',
                '—', '—', '—', '—', '—',
                fanLabel, '—', '—', '—', '—', String(noise)
            ]);
        }
    }

    // Заголовок с условиями
    const header = [
        ['Подбор ККБ'],
        [`Тнар = ${T_nar} °C`, `To = ${To} °C`, `Q = ${Q_req} кВт`],
        [`Дата: ${new Date().toLocaleString('ru-RU')}`],
        []
    ];

    const allRows = [...header, ...rows];

    // Каждое поле — в кавычках
    const body = allRows.map(row =>
        row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(';')
    ).join('\r\n');

      // BOM для UTF-8. Без sep= — иначе Excel игнорирует BOM.
  const csv = body;

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ККБ_подбор_Tнар${T_nar}_To${To}_Q${Q_req}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Аккордеон: открываем один блок — закрываем остальные
(function setupAccordion() {
    const items = document.querySelectorAll('.accordion .acc-item');
    items.forEach(d => {
        d.addEventListener('toggle', () => {
            if (d.open) {
                items.forEach(other => {
                    if (other !== d) other.open = false;
                });
            }
        });
    });
})();

// ============================================================
// СТАРТ
// ============================================================
loadData().catch(err => {
    document.getElementById('out').innerHTML =
        `<div class="empty">Ошибка загрузки: ${err.message}<br>
    Убедитесь, что <code>compressors_final.json</code> лежит рядом с index.html</div>`;
});