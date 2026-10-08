const { PDFDocument, StandardFonts, rgb } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const $ = id => document.getElementById(id);
let SC = { s: {}, co: [] }, F = {}, CO = [], bytes, fname = 'documento.pdf', scale = 1.3, tool = 'select', items = [], sel = null, uid = 0;

function setTool(t) {
    tool = t; document.body.classList.toggle('tool', t !== 'select');
    document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
}
document.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
$('open').onclick = $('open2').onclick = () => $('file').click();
$('file').onchange = e => e.target.files[0] && openFile(e.target.files[0]);
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; f && f.type === 'application/pdf' && openFile(f) });


/* ===== Números, formatação e fórmulas (interpretador próprio, sem eval) ===== */
const toNum = v => {
    if (typeof v === 'number') return v; let s = String(v == null ? '' : v).trim(); if (!s) return 0;
    const neg = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/[^\d.,()\-]/g, ''));
    s = s.replace(/[^\d.,]/g, '');
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); else if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
    else { const c = s.lastIndexOf(','), d = s.lastIndexOf('.'); s = c > d ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '') }
    const n = parseFloat(s); return isNaN(n) ? 0 : neg ? -n : n
};
function parseFmt(a) {
    let m = a.match(/AFNumber_Format\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*\d+\s*,\s*["']([^"']*)["']\s*,\s*(true|false)/);
    if (m) return { d: +m[1], s: +m[2], n: +m[3], c: m[4], p: m[5] === 'true' };
    m = a.match(/AFPercent_Format\(\s*(\d+)\s*,\s*(\d+)/);
    return m ? { d: +m[1], s: +m[2], n: 0, c: '%', p: false, pct: 1 } : null
}
function fmtNum(n, f) {
    let [ip, dp] = Math.abs(f.pct ? n * 100 : n).toFixed(f.d).split('.');
    const th = [',', '', '.', '', "'"][f.s]; if (th) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, th);
    let b = ip + (dp ? (f.s === 2 || f.s === 3 ? ',' : '.') + dp : '');
    if (f.c) b = f.p ? f.c + b : b + f.c;
    return n < 0 && +ip + (+dp || 0) > 0 ? (f.n >= 2 ? '(' + b + ')' : '-' + b) : b
}
/* ===== Mini-interpretador do JavaScript do Acrobat (sem eval) ===== */
function tokJS(s) {
    const re = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([A-Za-z_$][\w$]*)|(===|!==|==|!=|<=|>=|&&|\|\||\+\+|--|\+=|-=|\*=|\/=|[-+*\/%=<>!?:;,.(){}\[\]])/y;
    const T = []; let p = 0, m;
    while (p < s.length) {
        re.lastIndex = p; m = re.exec(s); if (!m) return null; p = re.lastIndex;
        if (m[1] != null) T.push({ t: 'n', v: +m[1] });
        else if (m[2]) T.push({ t: 's', v: m[2].slice(1, -1).replace(/\\(.)/g, (a, c) => c === 'n' ? '\n' : c === 't' ? '\t' : c) });
        else if (m[3]) T.push({ t: 'i', v: m[3] });
        else if (m[4]) T.push({ t: 'p', v: m[4] })
    }
    return T
}
function parseJS(src) {
    const T = tokJS(src); if (!T) return null; let i = 0;
    const isP = v => T[i] && T[i].t === 'p' && (Array.isArray(v) ? v.includes(T[i].v) : T[i].v === v);
    const isK = v => T[i] && T[i].t === 'i' && T[i].v === v;
    const ex = v => { if (!isP(v)) throw 0; i++ }, semi = () => { if (isP(';')) i++ };
    const list = end => { const a = []; if (!isP(end)) { do a.push(asg()); while (isP(',') && ++i) } ex(end); return a };
    function varD() { i++; const d = []; do { const t = T[i++]; if (!t || t.t !== 'i') throw 0; let e = null; if (isP('=')) { i++; e = asg() } d.push([t.v, e]) } while (isP(',') && ++i); return ['var', d] }
    function st() {
        if (isP(';')) { i++; return ['block', []] }
        if (isP('{')) { i++; const b = []; while (!isP('}')) { if (i >= T.length) throw 0; b.push(st()) } i++; return ['block', b] }
        if (isK('var')) { const d = varD(); semi(); return d }
        if (isK('if')) { i++; ex('('); const c = asg(); ex(')'); const a = st(); let b = null; if (isK('else')) { i++; b = st() } return ['if', c, a, b] }
        if (isK('for')) {
            i++; ex('('); let n = null; if (!isP(';')) n = isK('var') ? varD() : ['expr', asg()]; ex(';');
            const c = isP(';') ? null : asg(); ex(';'); const u = isP(')') ? null : asg(); ex(')'); return ['for', n, c, u, st()]
        }
        const e = asg(); semi(); return ['expr', e]
    }
    function asg() { const l = cnd(); if (isP(['=', '+=', '-=', '*=', '/='])) { const op = T[i++].v; return ['asg', op, l, asg()] } return l }
    function cnd() { const c = bin(0); if (isP('?')) { i++; const a = asg(); ex(':'); return ['cnd', c, a, asg()] } return c }
    const LV = [['||'], ['&&'], ['==', '!=', '===', '!=='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];
    function bin(l) { if (l === LV.length) return un(); let x = bin(l + 1); while (isP(LV[l])) { const op = T[i++].v; x = ['bin', op, x, bin(l + 1)] } return x }
    function un() {
        if (isP('!')) { i++; return ['not', un()] } if (isP('-')) { i++; return ['neg', un()] } if (isP('+')) { i++; return ['pos', un()] }
        const e = call(); return isP(['++', '--']) ? ['upd', T[i++].v, e] : e
    }
    function call() {
        let e = prim(); for (; ;) {
            if (isP('.')) { i++; const t = T[i++]; if (!t || t.t !== 'i') throw 0; e = ['mem', e, t.v] }
            else if (isP('[')) { i++; const x = asg(); ex(']'); e = ['idx', e, x] }
            else if (isP('(')) { i++; e = ['call', e, list(')')] }
            else return e
        }
    }
    function prim() {
        const t = T[i++]; if (!t) throw 0;
        if (t.t === 'n' || t.t === 's') return ['lit', t.v];
        if (t.t === 'p') { if (t.v === '(') { const e = asg(); ex(')'); return e } if (t.v === '[') return ['arr', list(']')]; throw 0 }
        const k = t.v;
        if (k === 'true' || k === 'false') return ['lit', k === 'true']; if (k === 'null') return ['lit', null]; if (k === 'this') return ['this'];
        if (k === 'new') { const c = T[i++]; if (!c || c.v !== 'Array') throw 0; ex('('); return ['arr', list(')')] }
        return ['id', k]
    }
    try { const b = []; while (i < T.length) b.push(st()); return ['block', b] } catch (e) { return null }
}
function runJS(ast, get, name) {
    let steps = 0; const env = Object.create(null), ev = { value: get(name), target: { name } };
    const H = new WeakSet([ev, ev.target]);
    const doc = { documentFileName: fname, getField: n => { const f = { name: String(n), value: get(String(n)), calcOrderIndex: 0 }; H.add(f); return f } }; H.add(doc);
    const MT = { round: Math.round, floor: Math.floor, ceil: Math.ceil, abs: Math.abs, max: Math.max, min: Math.min, pow: Math.pow, sqrt: Math.sqrt };
    const FNS = { Number, parseFloat, parseInt, String, isNaN };
    const SM = ['substring', 'substr', 'slice', 'indexOf', 'lastIndexOf', 'replace', 'toUpperCase', 'toLowerCase', 'charAt', 'trim', 'toString'];
    const own = (o, p) => Object.prototype.hasOwnProperty.call(o, p);
    function put(t, v) {
        if (t[0] === 'id') { env[t[1]] = v; return v }
        if (t[0] === 'mem') { const o = e(t[1]); if (H.has(o) && t[2] !== 'constructor') { o[t[2]] = v; return v } }
        if (t[0] === 'idx') { const o = e(t[1]), k = e(t[2]); if (Array.isArray(o) && typeof k === 'number') { o[k] = v; return v } }
        throw 0
    }
    function e(n) {
        if (++steps > 300000) throw 0; switch (n[0]) {
            case 'lit': return n[1];
            case 'this': return doc;
            case 'arr': return n[1].map(e);
            case 'id': { const k = n[1]; if (k in env) return env[k]; if (k === 'event') return ev; if (k === 'Math') return MT; if (k === 'undefined') return undefined; if (k === 'NaN') return NaN; throw 0 }
            case 'mem': {
                const o = e(n[1]), p = n[2]; if (o == null) throw 0;
                if ((typeof o === 'string' || Array.isArray(o)) && p === 'length') return o.length;
                if (H.has(o) && own(o, p)) return o[p]; throw 0
            }
            case 'idx': { const o = e(n[1]), k = e(n[2]); if ((Array.isArray(o) || typeof o === 'string') && typeof k === 'number') return o[k]; throw 0 }
            case 'call': {
                const c = n[1], a = n[2].map(e);
                if (c[0] === 'id' && FNS[c[1]] && !(c[1] in env)) return FNS[c[1]](...a);
                if (c[0] === 'mem') {
                    const o = e(c[1]), p = c[2];
                    if (o === doc && p === 'getField') return doc.getField(a[0]);
                    if (o === MT && own(MT, p)) return MT[p](...a);
                    if (typeof o === 'string' && SM.includes(p)) return o[p](...a);
                    if (typeof o === 'number' && p === 'toFixed') return o.toFixed(...a)
                }
                throw 0
            }
            case 'bin': {
                const op = n[1];
                if (op === '&&') { const l = e(n[2]); return l ? e(n[3]) : l }
                if (op === '||') { const l = e(n[2]); return l ? l : e(n[3]) }
                const a = e(n[2]), b = e(n[3]);
                switch (op) {
                    case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b; case '%': return a % b;
                    case '==': return a == b; case '!=': return a != b; case '===': return a === b; case '!==': return a !== b;
                    case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b
                }throw 0
            }
            case 'not': return !e(n[1]); case 'neg': return -e(n[1]); case 'pos': return +e(n[1]);
            case 'cnd': return e(n[1]) ? e(n[2]) : e(n[3]);
            case 'asg': { const op = n[1]; let v = e(n[3]); if (op !== '=') { const c = e(n[2]); v = op === '+=' ? c + v : op === '-=' ? c - v : op === '*=' ? c * v : c / v } return put(n[2], v) }
            case 'upd': { const c = e(n[2]); put(n[2], n[1] === '++' ? c + 1 : c - 1); return c }
        }
        throw 0
    }
    function x(n) {
        if (++steps > 300000) throw 0; switch (n[0]) {
            case 'block': n[1].forEach(x); break;
            case 'var': n[1].forEach(d => { env[d[0]] = d[1] ? e(d[1]) : undefined }); break;
            case 'expr': e(n[1]); break;
            case 'if': if (e(n[1])) x(n[2]); else if (n[3]) x(n[3]); break;
            case 'for': if (n[1]) x(n[1]); while (!n[2] || e(n[2])) { x(n[4]); if (n[3]) e(n[3]) } break
        }
    }
    x(ast); return ev.value
}
function compile(src) {
    const m = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').match(/AFSimple_Calculate\(\s*["'](\w+)["']\s*,\s*(?:new\s+Array\s*\(|\[)([^)\]]*)/);
    if (m) return mkCalc({ op: m[1].toUpperCase(), names: [...m[2].matchAll(/["']([^"']+)["']/g)].map(x => x[1]) });
    const ast = parseJS(src); return ast ? (g, name) => runJS(ast, g, name) : null
}
function setVal(f, v, src) { f.value = v; f.els.forEach(e => { if (e !== src) e.value = v }) }
function recalc() {
    const get = n => {
        const f = F[n]; if (!f || f.value === '' || f.value == null) return '';
        return f.fmt || /^[\s\-+()$%R.,\d]*\d[\s\-+()$%R.,\d]*$/.test(f.value) ? toNum(f.value) : f.value
    };
    for (let k = 0; k < 10; k++) {
        let ch = 0;
        for (const n of CO) {
            const f = F[n]; if (!f || !f.calc) continue; let r;
            try { r = f.calc(get, n) } catch (e) { cellErr(n, e); continue }
            if (typeof r === 'number') r = isFinite(r) ? (f.fmt ? fmtNum(r, f.fmt) : String(+r.toFixed(8))) : '';
            r = r == null ? '' : String(r);
            if (r !== f.value) { ch = 1; setVal(f, r) }
        }
        if (!ch) break
    }
}
function mountField(L, vp, a) {
    if (a.subtype !== 'Widget' || a.fieldType !== 'Tx' || a.hidden) return;
    const f = F[a.fieldName] || (F[a.fieldName] = { name: a.fieldName, value: null, els: [] });
    if (f.value === null) { const v = a.fieldValue; f.value = Array.isArray(v) ? v.join('\n') : v || ''; if (f.fmt && /^-?\d*\.?\d+$/.test(f.value)) f.value = fmtNum(+f.value, f.fmt) }
    f.tx = 1;
    const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1), da = a.defaultAppearanceData || {}, ml = a.multiLine;
    f.pos = { p: +L.dataset.n, x: Math.min(x1, x2) / scale, y: Math.min(y1, y2) / scale, w: w / scale, h: h / scale };
    const fs = (da.fontSize || (ml ? 12 : Math.max(6, Math.min(14, h / scale * .62)))) * scale, c = da.fontColor;
    const el = document.createElement(ml ? 'textarea' : 'input'); el.className = 'fld' + (f.calc ? ' calc' : ''); el.value = f.value; el.spellcheck = false;
    Object.assign(el.style, {
        left: Math.min(x1, x2) + 'px', top: Math.min(y1, y2) + 'px', width: w + 'px', height: h + 'px', fontSize: fs + 'px',
        color: c ? `rgb(${c[0]},${c[1]},${c[2]})` : '#000', textAlign: ['left', 'center', 'right'][a.textAlignment] || 'left',
        fontFamily: /cour/i.test(da.fontName) ? '"Courier New",monospace' : /ti(me|ro)/i.test(da.fontName) ? '"Times New Roman",serif' : 'Helvetica,Arial,sans-serif'
    });
    if (a.backgroundColor) el.style.background = `rgb(${[...a.backgroundColor].join(',')})`;
    if (a.borderColor && a.borderColor.length >= 3) el.style.border = Math.max(1, ((a.borderStyle || {}).width || 1) * scale) + 'px solid rgb(' + [...a.borderColor].join(',') + ')';
    if (a.maxLen) { el.maxLength = a.maxLen; if (a.comb) el.style.letterSpacing = Math.max(0, w / a.maxLen - fs * .55) + 'px' }
    if (f.calc) { el.readOnly = true; el.title = 'Calculado por fórmula' }
    else { if (a.readOnly) el.readOnly = true; if (f.js) el.title = 'Fórmula não suportada (mantida no PDF)' }
    el.oninput = () => { setVal(f, el.value, el); recalc() };
    el.onfocus = () => { select(null); focusField(f.name) };
    el.onkeydown = e => { if (e.key === 'Enter' && !ml) el.blur() };
    el.onblur = () => { if (f.fmt && !f.calc && /\d/.test(el.value)) { setVal(f, fmtNum(toNum(el.value), f.fmt)); el.value = f.value; recalc() } };
    f.els.push(el); L.append(el)
}

async function readScripts() {
    const o = { s: {}, co: [], xfa: [], info: {} };
    try {
        const { PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFRawStream, decodePDFRawStream } = PDFLib, N = k => PDFName.of(k);
        const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
        const txt = v => {
            if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
            if (v instanceof PDFRawStream) { const u = decodePDFRawStream(v).decode(); return new TextDecoder(u[0] === 254 && u[1] === 255 ? 'utf-16be' : 'latin1').decode(u) } return ''
        };
        const nameOf = d => { const p = []; for (let g = 0; d instanceof PDFDict && g < 12; g++, d = d.lookup(N('Parent'))) { const t = d.lookup(N('T')); if (t) p.unshift(txt(t)) } return p.join('.') };
        const refs = {}; let nJS = 0;
        for (const [ref, ob] of pdf.context.enumerateIndirectObjects()) {
            const d = ob instanceof PDFRawStream ? ob.dict : ob; if (!(d instanceof PDFDict)) continue;
            if (d.has(N('JS'))) nJS++;
            const nm = d.has(N('T')) || d.has(N('Parent')) ? nameOf(d) : ''; if (!nm) continue;
            refs[ref.toString()] = nm;
            const aa = d.lookup(N('AA')); if (!(aa instanceof PDFDict)) continue;
            for (const k of ['C', 'F']) {
                const ac = aa.lookup(N(k)), t = ac instanceof PDFDict ? txt(ac.lookup(N('JS'))) : '';
                if (t && !(o.s[nm] && o.s[nm][k])) (o.s[nm] = o.s[nm] || {})[k] = t
            }
        }
        const af = pdf.catalog.lookup(N('AcroForm'));
        o.info = { enc: pdf.isEncrypted, nJS, acro: af instanceof PDFDict, xfa: af instanceof PDFDict && af.has(N('XFA')) };
        if (af instanceof PDFDict) {
            const co = af.lookup(N('CO')); if (co instanceof PDFArray) co.asArray().forEach(r => refs[r.toString()] && o.co.push(refs[r.toString()]));
            const x = af.lookup(N('XFA')); let xml = '';
            if (x instanceof PDFArray) { for (let i = 0; i + 1 < x.size(); i += 2)if (txt(x.lookup(i)) === 'template') { const st = x.lookup(i + 1); if (st instanceof PDFRawStream) xml = new TextDecoder().decode(decodePDFRawStream(st).decode()) } }
            else if (x instanceof PDFRawStream) xml = new TextDecoder().decode(decodePDFRawStream(x).decode());
            for (const m of xml.matchAll(/<field\b[^>]*\bname="([^"]*)"[\s\S]*?<\/field>/g)) {
                const c = m[0].match(/<calculate\b[\s\S]*?<script[^>]*>([\s\S]*?)<\/script>/); if (c) o.xfa.push([m[1], c[1]])
            }
        }
    } catch (e) { o.info.err = String(e && e.message || e); console.warn('readScripts', e) }
    return o
}

/* ===== Formato manual, fórmula manual e diagnóstico ===== */
const FM = { num2: { d: 2, s: 2, n: 0, c: '', p: false }, brl: { d: 2, s: 2, n: 0, c: 'R$ ', p: true }, pct: { d: 2, s: 2, n: 0, c: '%', p: false, pct: 1 }, none: null };
let curF = null;
function mkCalc(x) {
    return g => {
        const v = x.names.flatMap(n => { const ks = Object.keys(F).filter(k => k === n || k.startsWith(n + '.')); return (ks.length ? ks : [n]).map(k => toNum(g(k))) }), sum = v.reduce((a, b) => a + b, 0);
        return x.op === 'SUM' ? sum : x.op === 'PRD' ? v.reduce((a, b) => a * b, 1) : x.op === 'AVG' ? sum / (v.length || 1) : x.op === 'MIN' ? Math.min(...v) : Math.max(...v)
    }
}
function suggest(f) {
    const p = f.pos; if (!p) return [];
    return Object.values(F).filter(g => g !== f && g.tx && !g.calc && g.pos && g.pos.p === p.p && g.pos.y < p.y - 1 && Math.abs(g.pos.x + g.pos.w / 2 - p.x - p.w / 2) < Math.max(g.pos.w, p.w) / 2)
        .sort((a, b) => a.pos.y - b.pos.y).map(g => g.name)
}
function focusField(name) { curF = name; const f = F[name]; $('fmt').disabled = $('fxb').disabled = !f; if (f) $('fmt').value = f.mk || '' }
$('fmt').onchange = () => {
    const f = F[curF]; if (!f) return; const k = $('fmt').value;
    if (k) { f.mk = k; f.fmt = FM[k] } else { delete f.mk; f.fmt = f.pdfFmt }
    if (f.fmt && !f.calc && /\d/.test(f.value)) setVal(f, fmtNum(toNum(f.value), f.fmt)); recalc(); diag()
};
$('fxb').onclick = () => {
    const f = F[curF]; if (!f) return; $('fxn').textContent = f.name;
    const x = f.mx || { op: 'SUM', names: suggest(f) }; $('fxo').value = x.op; $('fxl').value = x.names.join(', '); $('fx').hidden = false
};
$('fxc').onclick = () => { $('fx').hidden = true };
$('fxa').onclick = () => {
    const f = F[curF], names = $('fxl').value.split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
    if (!f || !names.length) return; f.mx = { op: $('fxo').value, names }; $('fx').hidden = true; render()
};
$('fxr').onclick = () => { const f = F[curF]; if (f) { delete f.mx; $('fx').hidden = true; render() } };
const TI = { err: ['✕', 'Erro'], ok: ['✓', 'Pronto'], warn: ['!', 'Atenção'], info: ['i', 'Aviso'] };
function toast(msg, kind, o) {
    o = o || {}; kind = kind || 'info'; const box = $('toasts'), t = document.createElement('div'), ic = TI[kind] || TI.info;
    const el = (tag, cls, txt) => { const x = document.createElement(tag); if (cls) x.className = cls; if (txt != null) x.textContent = txt; return x };
    t.className = 'toast ' + kind; t.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    const body = el('div', 'tb'); body.append(el('div', 'tt', o.title || ic[1]));
    if (msg) body.append(el('div', 'tm', msg));
    const it = o.items || [];
    if (it.length) {
        const ul = el('ul', 'tl'); it.slice(0, 5).forEach(x => ul.append(el('li', null, x)));
        if (it.length > 5) ul.append(el('li', 'more', '+ ' + (it.length - 5) + ' outras')); body.append(ul)
    }
    if (it.length > 5) {
        const a = el('div', 'ta'), c = el('button', 'tc', 'Copiar lista completa');
        c.onclick = async () => { try { await navigator.clipboard.writeText(it.join('\n')); c.textContent = 'Copiado ✓' } catch (e) { c.textContent = 'Não foi possível copiar' } }; a.append(c); body.append(a)
    }
    const x = el('button', 'tx', '×'); x.setAttribute('aria-label', 'Fechar'); x.onclick = () => t.remove();
    const bar = el('div', 'tp'); bar.style.animationDuration = (kind === 'err' || kind === 'warn' ? 14 : 5) + 's'; bar.onanimationend = () => t.remove();
    t.append(el('div', 'ti', ic[0]), body, x, bar); box.append(t);
    while (box.children.length > 4) box.firstChild.remove()
}
const warned = new Set();
function cellErr(n, e) {
    if (warned.has(n)) return; warned.add(n);
    const m = e && e.message ? e.message : 'instrução não suportada ou campo inexistente na fórmula';
    toast('Célula ' + n + ': ' + m, 'err', { title: 'Erro na fórmula' }); console.warn('fórmula', n, e)
}
function diag() {
    const tx = Object.values(F).filter(f => f.tx), cc = tx.filter(f => f.calc).length, un = tx.filter(f => f.js && !f.calc);
    $('st').textContent = tx.length + ' campos detectados' + (cc ? ' · ' + cc + ' com fórmula' : '') + (un.length ? ' · ' + un.length + ' fórmula(s) não suportada(s)' : '');
    if (un.length && !diag.un) { diag.un = 1; toast('Não foi possível executar a fórmula destas células. Elas continuam editáveis manualmente.', 'warn', { title: 'Fórmula não suportada', items: un.map(f => f.name) }) }
    const I = SC.info || {};
    if (I.err && !diag.rd) { diag.rd = 1; toast(I.err, 'err', { title: 'Não foi possível ler as fórmulas do PDF' }) }
}

async function openFile(f) {
    try {
        bytes = new Uint8Array(await f.arrayBuffer()); fname = f.name; items = []; sel = null; F = {}; warned.clear(); diag.un = diag.rd = 0; SC = await readScripts();
        $('empty').hidden = true; $('save').disabled = false; select(null); await render();
    } catch (e) { toast(String(e && e.message || e), 'err', { title: 'Não foi possível abrir o PDF' }) }
}
async function render() {
    const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    for (const k in F) F[k].els = [];
    const FO = (await doc.getFieldObjects()) || {}, ids = (await doc.getCalculationOrderIds()) || [], idn = {}; CO = [];
    for (const nm of new Set([...Object.keys(FO), ...Object.keys(SC.s)])) {
        const f = F[nm] || (F[nm] = { name: nm, value: null, els: [] }); (FO[nm] || []).forEach(o => idn[o.id] = nm);
        const ac = ((FO[nm] || []).find(o => o.actions) || {}).actions || {}, sc = SC.s[nm] || {};
        f.js0 = sc.C || [].concat(ac.Calculate || []).join(';'); f.pdfFmt = parseFmt(sc.F || [].concat(ac.Format || []).join(';'))
    }
    for (const f of Object.values(F)) {
        f.js = f.js0 || ''; f.calc = f.js ? compile(f.js) : null; f.fmt = f.pdfFmt || null; if (f.mk !== undefined) f.fmt = FM[f.mk];
        if (f.mx) { f.calc = mkCalc(f.mx); f.js = '(manual) ' + f.mx.op + '(' + f.mx.names.join(', ') + ')' }
    }
    for (const f of Object.values(F)) if (f.mx && !f.fmt) { const q = F[f.mx.names[0]]; if (q && q.fmt) f.fmt = q.fmt }
    SC.co.forEach(n => CO.includes(n) || CO.push(n));
    ids.forEach(id => idn[id] && !CO.includes(idn[id]) && CO.push(idn[id]));
    for (const nm in F) if (F[nm].calc && !CO.includes(nm)) CO.push(nm);
    const box = $('pages'); box.innerHTML = '';
    for (let n = 1; n <= doc.numPages; n++) {
        const p = await doc.getPage(n), vp = p.getViewport({ scale }), r = devicePixelRatio || 1;
        const w = document.createElement('div'); w.className = 'page'; w.style.width = vp.width + 'px'; w.style.height = vp.height + 'px';
        const c = document.createElement('canvas'); c.width = vp.width * r; c.height = vp.height * r; c.style.width = vp.width + 'px'; c.style.height = vp.height + 'px';
        const L = document.createElement('div'); L.className = 'layer'; L.dataset.n = n - 1;
        w.append(c, L); box.append(w);
        L.onpointerdown = e => {
            if (e.target !== L) return;
            if (tool === 'select') { select(null); return }
            const b = L.getBoundingClientRect(), k = tool === 'field';
            const it = { id: ++uid, page: n - 1, kind: tool, x: (e.clientX - b.left) / scale, y: (e.clientY - b.top) / scale, w: k ? 180 : 160, h: k ? 28 : 30, text: '', size: +$('size').value || 14, color: $('color').value };
            items.push(it); const t = mount(it); setTool('select'); setTimeout(() => t.focus(), 0);
        };
        await p.render({ canvasContext: c.getContext('2d'), viewport: vp, transform: [r, 0, 0, r, 0, 0] }).promise;
        (await p.getAnnotations({ intent: 'display' })).forEach(a => mountField(L, vp, a));
    }
    recalc(); items.forEach(mount); select(sel);
    diag();
}
function place(it, d, t) {
    d.style.left = it.x * scale + 'px'; d.style.top = it.y * scale + 'px';
    t.style.width = it.w * scale + 'px'; t.style.height = it.h * scale + 'px'; t.style.fontSize = it.size * scale + 'px'; t.style.color = it.color;
}
function mount(it) {
    const L = document.querySelector('.layer[data-n="' + it.page + '"]'); if (!L) return;
    const d = document.createElement('div'); d.className = 'item ' + it.kind; d.dataset.id = it.id;
    const g = document.createElement('span'); g.className = 'grip'; g.textContent = '✥';
    const t = document.createElement('textarea'); t.value = it.text; t.placeholder = it.kind === 'field' ? 'Campo' : 'Texto'; t.spellcheck = false;
    d.append(g, t); L.append(d); place(it, d, t);
    t.oninput = () => { it.text = t.value };
    t.onfocus = () => select(it.id);
    new ResizeObserver(() => { if (t.offsetWidth) { it.w = t.offsetWidth / scale; it.h = t.offsetHeight / scale } }).observe(t);
    g.onpointerdown = e => {
        e.preventDefault(); select(it.id); g.setPointerCapture(e.pointerId);
        const sx = e.clientX, sy = e.clientY, ox = it.x, oy = it.y;
        g.onpointermove = m => { it.x = ox + (m.clientX - sx) / scale; it.y = oy + (m.clientY - sy) / scale; d.style.left = it.x * scale + 'px'; d.style.top = it.y * scale + 'px' };
        g.onpointerup = () => { g.onpointermove = null };
    };
    return t;
}
const cur = () => items.find(i => i.id === sel);
function select(id) {
    sel = id; const it = cur();
    document.querySelectorAll('.item').forEach(d => d.classList.toggle('sel', +d.dataset.id === id));
    $('size').disabled = $('color').disabled = $('del').disabled = !it;
    if (it) { $('size').value = it.size; $('color').value = it.color }
}
function restyle() { const it = cur(); if (!it) return; const d = document.querySelector('.item[data-id="' + it.id + '"]'); place(it, d, d.querySelector('textarea')) }
$('size').oninput = () => { const it = cur(); if (it) { it.size = Math.max(6, +$('size').value || 14); restyle() } };
$('color').oninput = () => { const it = cur(); if (it) { it.color = $('color').value; restyle() } };
$('del').onclick = () => {
    const it = cur(); if (!it) return; items = items.filter(i => i !== it);
    document.querySelector('.item[data-id="' + it.id + '"]').remove(); select(null)
};
function zoom(f) { if (!bytes) return; scale = Math.min(3, Math.max(.5, scale + f)); $('zv').textContent = Math.round(scale * 100) + '%'; render() }
$('zin').onclick = () => zoom(.2); $('zout').onclick = () => zoom(-.2);

const hex = h => { const n = parseInt(h.slice(1), 16); return rgb((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255) };
const clean = s => s.replace(/[^\x00-\xFF]/g, '?');
/* Localiza os campos de texto direto nos objetos do PDF (não depende de AcroForm /Fields) */
function locateFields(pdf) {
    const { PDFName, PDFDict, PDFArray, PDFString, PDFHexString } = PDFLib, N = k => PDFName.of(k), map = {};
    const txt = v => v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '';
    const inh = (d, k) => { for (let g = 0; d instanceof PDFDict && g < 12; g++, d = d.lookup(N('Parent'))) { const v = d.lookup(N(k)); if (v) return v } };
    const nameOf = d => { const p = []; for (let g = 0; d instanceof PDFDict && g < 12; g++, d = d.lookup(N('Parent'))) { const t = d.lookup(N('T')); if (t) p.unshift(txt(t)) } return p.join('.') };
    for (const [ref, d] of pdf.context.enumerateIndirectObjects()) {
        if (!(d instanceof PDFDict) || !d.has(N('T'))) continue;
        const k = d.lookup(N('Kids'));
        if (k instanceof PDFArray && k.size()) { const k0 = k.lookup(0); if (k0 instanceof PDFDict && k0.has(N('T'))) continue }
        const ft = inh(d, 'FT'); if (!ft || String(ft) !== '/Tx') continue;
        map[nameOf(d)] = { ref, dict: d }
    }
    return map
}
$('save').onclick = async () => {
    if (!bytes) return;
    const errs = [], want = {}, { PDFName, PDFString, PDFHexString, PDFTextField, PDFAcroText } = PDFLib, N = k => PDFName.of(k);
    try {
        const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true }), font = await pdf.embedFont(StandardFonts.Helvetica), form = pdf.getForm(), byName = locateFields(pdf);
        for (const f of Object.values(F)) {
            if (!f.tx) continue;
            const loc = byName[f.name];
            if (!loc) { errs.push([f.name, 'campo não encontrado no PDF']); continue }
            const raw = f.fmt && String(f.value).trim() ? String(f.fmt.pct ? toNum(f.value) / 100 : toNum(f.value)) : null, txt = clean(String(f.value));
            want[f.name] = raw !== null ? raw : txt;
            try {
                const d = loc.dict, ml = d.get(N('MaxLen'));
                if (ml) d.delete(N('MaxLen'));
                let tf = null; try { tf = PDFTextField.of(PDFAcroText.fromDict(d, loc.ref), loc.ref, pdf) } catch (e) { }
                if (tf) { tf.setText(txt || undefined); try { tf.defaultUpdateAppearances(font) } catch (e) { console.warn('aparência', f.name, e) } }
                else if (txt) d.set(N('V'), PDFString.of(txt)); else d.delete(N('V'));
                if (raw !== null) d.set(N('V'), PDFString.of(raw));
                if (ml) d.set(N('MaxLen'), ml);
            } catch (e) { errs.push([f.name, String(e && e.message || e)]) }
        }
        for (const it of items) {
            const lbl = (it.kind === 'field' ? 'Campo' : 'Texto') + ' novo (pág. ' + (it.page + 1) + ')';
            try {
                const pg = pdf.getPage(it.page), H = pg.getHeight(), col = hex(it.color);
                if (it.kind === 'field') {
                    const f = form.createTextField('campo_' + it.id);
                    f.setText(clean(it.text) || undefined); if (it.h > it.size * 2.2) f.enableMultiline(); f.setFontSize(it.size);
                    f.addToPage(pg, { x: it.x, y: H - it.y - it.h, width: it.w, height: it.h, font, textColor: col, borderColor: rgb(.15, .4, .9), borderWidth: 1 });
                    f.defaultUpdateAppearances(font);
                } else if (it.text.trim()) {
                    const lines = [];
                    for (const para of clean(it.text).split('\n')) {
                        let line = '';
                        for (const word of para.split(' ')) {
                            const test = line ? line + ' ' + word : word;
                            if (line && font.widthOfTextAtSize(test, it.size) > it.w - 4) { lines.push(line); line = word } else line = test;
                        }
                        lines.push(line);
                    }
                    lines.forEach((l, i) => pg.drawText(l, { x: it.x + 2, y: H - it.y - 2 - it.size * (.95 + i * 1.2), size: it.size, font, color: col }));
                }
            } catch (e) { errs.push([lbl, String(e && e.message || e)]) }
        }
        try { form.acroForm.dict.set(N('NeedAppearances'), PDFLib.PDFBool.True) } catch (e) { }
        const out = await pdf.save({ updateFieldAppearances: false });
        try { // verificação: relê o arquivo gerado e confere cada célula
            const cf = locateFields(await PDFDocument.load(out, { ignoreEncryption: true })), vt = v => v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '';
            for (const n in want) {
                const got = cf[n] ? vt(cf[n].dict.lookup(N('V'))) : '';
                if (got !== want[n] && !errs.some(x => x[0] === n)) errs.push([n, 'o valor não ficou gravado no arquivo'])
            }
        } catch (e) { console.warn('verificação', e) }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([out], { type: 'application/pdf' }));
        a.download = fname.replace(/\.pdf$/i, '') + '-editado.pdf'; a.click();
        if (errs.length) toast('O arquivo foi baixado, mas ' + errs.length + ' célula(s) não foram gravadas:', 'err', { title: 'Download com problemas', items: errs.map(x => x[0] + ' — ' + x[1]) });
        else toast(Object.keys(want).length + ' campo(s) de texto gravado(s) no arquivo.', 'ok', { title: 'PDF baixado' });
        errs.forEach(x => console.warn('célula com erro:', x[0], x[1]));
    } catch (e) { toast(String(e && e.message || e), 'err', { title: 'Erro ao gerar o PDF' }) }
};