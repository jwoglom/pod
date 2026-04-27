import './App.css';
import { connect, sendMsg } from "./api";
import React, { useEffect, useMemo, useRef, useState } from 'react'
import Select from 'react-select'
import faultData from './faults.json';

// O5 AID Phase-1 commands in the order OmnipodKit issues them (and that real
// pods accept them) per O5AidCommands.swift / BlePodComms.swift. The "key" is
// the feature.attribute string the simulator records in PODState.AIDCompleted.
const AID_STEPS = [
  { key: '255.2', label: 'UtcCommand' },
  { key: '3.2',   label: 'TdiCommand' },
  { key: '3.1',   label: 'TargetBgProfileCommand' },
  { key: '3.9',   label: 'DiaCommand' },
  { key: '3.7',   label: 'EgvCommand' },
  { key: '2.1',   label: 'AlgorithmInsulinHistory', tag: '1/3', group: 'hist' },
  { key: '2.1',   label: 'AlgorithmInsulinHistory', tag: '2/3', group: 'hist' },
  { key: '2.1',   label: 'AlgorithmInsulinHistory', tag: '3/3', group: 'hist' },
  { key: '3.12',  label: 'UnifiedAidPodStatus', alternate: '3.11' },
];

const ALERT_SLOTS = [
  { idx: 0, name: 'AutoOff' },
  { idx: 1, name: 'Unused' },
  { idx: 2, name: 'ShutdownImminent' },
  { idx: 3, name: 'ExpirationReminder' },
  { idx: 4, name: 'LowReservoir' },
  { idx: 5, name: 'SuspendedReminder' },
  { idx: 6, name: 'SuspendExpired' },
  { idx: 7, name: 'Lifecycle' },
];

function pulsesToUnits(pulses) {
  if (pulses == null) return 0;
  return Math.round(pulses * 0.05 * 100) / 100;
}

function fmtUnits(pulses) {
  return pulsesToUnits(pulses).toFixed(2);
}

function fmtUptime(minutes) {
  if (minutes == null || isNaN(minutes)) return '—';
  const m = Math.max(0, parseInt(minutes, 10));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h${String(mm).padStart(2, '0')}`;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function dec2bin(dec) {
  return (dec >>> 0).toString(2).padStart(8, '0');
}

async function sha256ColonHex(base64) {
  if (!base64) return '';
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join(':');
}

function b64ToHex(base64) {
  if (!base64) return '';
  try {
    const bin = atob(base64);
    const out = new Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i).toString(16).padStart(2, '0');
    }
    return out.join(':');
  } catch {
    return '<base64 error>';
  }
}

function b64Bytes(base64) {
  if (!base64) return 0;
  return Math.floor(base64.length * 3 / 4)
    - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
}

// Render an SHA-256 digest as two rows of 16 octets, like ssh-keygen -lv.
function splitFingerprint(fp) {
  if (!fp) return [];
  const parts = fp.split(':');
  if (parts.length !== 32) return [fp];
  return [parts.slice(0, 16).join(':'), parts.slice(16).join(':')];
}

function ModeBadge({ mode }) {
  if (!mode) return <span className="modeBadge unknown">— / —</span>;
  const isO5 = mode === 'o5';
  return (
    <span className={`modeBadge ${isO5 ? 'o5' : 'dash'}`}>
      {isO5 ? 'Omnipod 5' : 'Dash'}
    </span>
  );
}

function Flash({ value, children }) {
  // Re-keys on value change, retriggering the flash animation once.
  return <span key={String(value ?? '∅')} className="flash">{children}</span>;
}

function SectionHeader({ glyph = '◦', children, meta }) {
  return (
    <div className="sectionHeader">
      <span className="glyph">{glyph}</span>
      <span>{children}</span>
      {meta && <span className="meta">{meta}</span>}
    </div>
  );
}

function CopyButton({ text }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      className={`copyBtn ${ok ? 'ok' : ''}`}
      onClick={() => {
        if (!text) return;
        navigator.clipboard?.writeText(text).then(() => {
          setOk(true);
          setTimeout(() => setOk(false), 900);
        });
      }}
    >
      {ok ? '✓ copied' : 'copy'}
    </button>
  );
}

function Register({ label, value, render, wrap = false, copyValue }) {
  const ref = useRef(null);
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || wrap) return;
    setScrollable(el.scrollWidth > el.clientWidth + 1);
  }, [value, wrap]);

  if (!value) {
    return (
      <div className="reg">
        <div className="regLabel"><span>{label}</span></div>
        <div className="regVal muted">unset</div>
      </div>
    );
  }
  const display = render ? render(value) : value;
  return (
    <div className="reg">
      <div className="regLabel">
        <span>{label}</span>
        <CopyButton text={copyValue ?? (typeof display === 'string' ? display : value)} />
      </div>
      <div
        ref={ref}
        className={`regVal ${wrap ? 'wrap' : ''} ${scrollable ? 'scrollable' : ''}`}
      >
        {display}
      </div>
    </div>
  );
}

// ─── Status strip ──────────────────────────────────────────────

function StatusStrip({ podState, connected, activeTime, liveReservoir, liveDelivered }) {
  return (
    <div className="statusStrip">
      <div className={`brand ${connected ? '' : 'cold'}`}>
        <span className="pulse" />
        <span>Pod Simulator</span>
      </div>
      <ModeBadge mode={podState.Mode} />
      <div className="stat">
        <span className="k">Up</span>
        <span className="v"><Flash value={fmtUptime(activeTime)}>{fmtUptime(activeTime)}</Flash></span>
      </div>
      <div className="stat">
        <span className="k">Progress</span>
        <span className="v"><Flash value={podState.PodProgress ?? '—'}>{podState.PodProgress ?? '—'}</Flash></span>
      </div>
      <div className="stat">
        <span className="k">Res</span>
        <span className="v">{fmtUnits(liveReservoir)} U</span>
      </div>
      <div className="stat">
        <span className="k">Del</span>
        <span className="v">{fmtUnits(liveDelivered)} U</span>
      </div>
      <div className="stat">
        <span className="k">Msg</span>
        <span className="v"><Flash value={podState.MsgSeq}>#{podState.MsgSeq ?? '—'}</Flash></span>
      </div>
      <div className="stat">
        <span className="k">Cmd</span>
        <span className="v"><Flash value={podState.CmdSeq}>#{podState.CmdSeq ?? '—'}</Flash></span>
      </div>
    </div>
  );
}

// ─── Pod state telemetry ───────────────────────────────────────

function PodStatePanel({ podState, liveReservoir, liveDelivered }) {
  const flag = (b, label) => (
    <span className={`v ${b ? 'ok' : 'dim'}`}>{b ? `● ${label}` : `○ off`}</span>
  );
  return (
    <div className="section">
      <SectionHeader>Pod State</SectionHeader>
      <div className="kv">
        <span className="k">Reservoir</span>
        <span className="v live">{fmtUnits(liveReservoir)} U</span>
      </div>
      <div className="kv">
        <span className="k">Delivered</span>
        <span className="v">{fmtUnits(liveDelivered)} U</span>
      </div>
      <div className="kv">
        <span className="k">Active alert mask</span>
        <span className="v dim">0b{dec2bin(podState.ActiveAlertSlots ?? 0)}</span>
      </div>
      <div className="kv">
        <span className="k">Bolus</span>
        {flag(podState.BolusActive, 'active')}
      </div>
      <div className="kv">
        <span className="k">Basal</span>
        {flag(podState.BasalActive, 'active')}
      </div>
      <div className="kv">
        <span className="k">Temp basal</span>
        {flag(podState.TempBasalActive, 'active')}
      </div>
      {podState.FaultEvent ? (
        <div className="kv">
          <span className="k">Fault</span>
          <span className="v danger">0x{Number(podState.FaultEvent).toString(16).padStart(2, '0').toUpperCase()}</span>
        </div>
      ) : null}
    </div>
  );
}

// ─── Bolus progress ────────────────────────────────────────────

function BolusProgressPanel({ podState }) {
  const [now, setNow] = useState(() => Date.now());
  const active = podState.BolusPulses && podState.BolusPulses > 0;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [active]);

  if (!active) {
    return (
      <div className="section">
        <SectionHeader>Bolus Progress</SectionHeader>
        <div className="muted">No bolus in flight.</div>
      </div>
    );
  }

  const start = new Date(podState.BolusStartTime).getTime();
  const end = new Date(podState.BolusEnd).getTime();
  const totalMs = Math.max(end - start, 1);
  const elapsed = Math.min(Math.max(now - start, 0), totalMs);
  const pct = elapsed / totalMs;
  const remainingSec = Math.max(0, Math.round((end - now) / 1000));
  const total = podState.BolusPulses;

  // Up to ~70 segments visually; otherwise each segment represents multiple pulses.
  const segs = Math.min(total, 70);
  const filled = pct * segs;
  const segments = Array.from({ length: segs }, (_, i) => {
    if (i + 1 <= filled) return { kind: 'done' };
    if (i < filled)      return { kind: 'partial', p: ((filled - i) * 100).toFixed(1) };
    return { kind: 'pending' };
  });

  return (
    <div className="section">
      <SectionHeader meta={`${(pct * 100).toFixed(0)}% · ${remainingSec}s left`}>
        Bolus Progress
      </SectionHeader>
      <div className="bignum">
        {fmtUnits(podState.EffectiveDelivered ?? 0)}
        <span className="unit">/ {fmtUnits(total)} U</span>
      </div>
      <div className="pulseBar">
        {segments.map((s, i) =>
          s.kind === 'partial'
            ? <span key={i} className="seg partial" style={{ '--p': s.p + '%' }} />
            : <span key={i} className={`seg ${s.kind === 'done' ? 'done' : ''}`} />
        )}
      </div>
      <div className="bolusGrid">
        <div className="kv"><span className="k">Pulses</span><span className="v">{total}</span></div>
        <div className="kv"><span className="k">@</span><span className="v dim">0.05 U/pulse</span></div>
        <div className="kv"><span className="k">Eff. reservoir</span><span className="v">{fmtUnits(podState.EffectiveReservoir)} U</span></div>
        <div className="kv"><span className="k">Eff. delivered</span><span className="v">{fmtUnits(podState.EffectiveDelivered)} U</span></div>
      </div>
    </div>
  );
}

// ─── AID stepper ────────────────────────────────────────────────

function AIDSetupPanel({ completed }) {
  const seenCounts = useMemo(() => {
    const c = {};
    for (const k of completed || []) c[k] = (c[k] || 0) + 1;
    return c;
  }, [completed]);

  const remaining = { ...seenCounts };
  const decorated = AID_STEPS.map(step => {
    let done = false;
    if (remaining[step.key] > 0) { remaining[step.key]--; done = true; }
    else if (step.alternate && remaining[step.alternate] > 0) { remaining[step.alternate]--; done = true; }
    return { ...step, done };
  });

  const completedCount = decorated.filter(s => s.done).length;

  // Group consecutive "hist" rows so they share the bracket.
  const blocks = [];
  let cur = null;
  for (const s of decorated) {
    if (s.group) {
      if (!cur || cur.group !== s.group) { cur = { group: s.group, items: [] }; blocks.push(cur); }
      cur.items.push(s);
    } else {
      blocks.push({ group: null, items: [s] });
      cur = null;
    }
  }

  return (
    <div className="section">
      <SectionHeader meta={`${completedCount}/${AID_STEPS.length}`}>
        O5 AID Phase-1
      </SectionHeader>
      <ul className="aidList">
        {blocks.map((b, bi) => (
          <li key={bi} className={b.group ? 'aidGroup' : ''}>
            <ul className="aidList">
              {b.items.map((s, i) => (
                <li key={i} className={`aidStep ${s.done ? 'done' : 'pending'}`}>
                  <span className="aidPip" />
                  <span className="aidKey">{s.key}</span>
                  <span className="aidLbl">{s.label}</span>
                  <span className="aidTag">{s.tag ?? ''}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Identity (cert + PDM) ─────────────────────────────────────

function IdentityPanel({ certDER, pdmPubkey, verifiedCount }) {
  const [fingerprint, setFingerprint] = useState('');
  useEffect(() => {
    let cancelled = false;
    sha256ColonHex(certDER).then(fp => { if (!cancelled) setFingerprint(fp); });
    return () => { cancelled = true; };
  }, [certDER]);

  return (
    <div className="section">
      <SectionHeader>Identity (O5)</SectionHeader>
      {certDER ? (
        <>
          <div className="kv">
            <span className="k">Pod cert</span>
            <span className="v dim">{b64Bytes(certDER)} B (DER)</span>
          </div>
          <Register
            label="Pod cert SHA-256"
            value={fingerprint}
            wrap
            render={fp => splitFingerprint(fp).map((row, i) => (
              <div key={i}>{row}</div>
            ))}
          />
        </>
      ) : (
        <div className="muted">No pod cert yet. Run <code>./pod -fresh -mode o5</code> and pair.</div>
      )}
      {pdmPubkey ? (
        <Register
          label="PDM pubkey (X‖Y)"
          value={b64ToHex(pdmPubkey)}
          copyValue={pdmPubkey}
        />
      ) : (
        <div className="muted">PDM pubkey not yet extracted.</div>
      )}
      <div className="kv">
        <span className="k">Type-4 sigs verified</span>
        <span className="v ok"><Flash value={verifiedCount ?? 0}>{verifiedCount ?? 0}</Flash></span>
      </div>
    </div>
  );
}

// ─── Comms ──────────────────────────────────────────────────────

function CommsPanel({ podState }) {
  return (
    <div className="section">
      <SectionHeader>Comms</SectionHeader>
      <div className="kv"><span className="k">MsgSeq</span><span className="v"><Flash value={podState.MsgSeq}>{podState.MsgSeq ?? '—'}</Flash></span></div>
      <div className="kv"><span className="k">CmdSeq</span><span className="v"><Flash value={podState.CmdSeq}>{podState.CmdSeq ?? '—'}</Flash></span></div>
      <div className="kv"><span className="k">LastProgSeqNum</span><span className="v">{podState.LastProgSeqNum ?? '—'}</span></div>
      <div className="kv"><span className="k">EapAkaSeq</span><span className="v"><Flash value={podState.EapAkaSeq}>{podState.EapAkaSeq ?? '—'}</Flash></span></div>
      <div className="kv"><span className="k">NonceSeq</span><span className="v"><Flash value={podState.NonceSeq}>{podState.NonceSeq ?? '—'}</Flash></span></div>
      {podState.LTK && <Register label="LTK" value={b64ToHex(podState.LTK)} copyValue={podState.LTK} />}
      {podState.CK && <Register label="CK" value={b64ToHex(podState.CK)} copyValue={podState.CK} />}
      {podState.NoncePrefix && <Register label="NoncePrefix" value={b64ToHex(podState.NoncePrefix)} copyValue={podState.NoncePrefix} />}
    </div>
  );
}

// ─── Controls ──────────────────────────────────────────────────

function ReservoirControl({ initial, onSubmit }) {
  const [val, setVal] = useState(initial);
  const [err, setErr] = useState('');
  useEffect(() => { setVal(initial); }, [initial]);
  function submit(e) {
    e.preventDefault();
    const n = parseFloat(val);
    if (isNaN(n) || n < 0 || n > 200) { setErr('Out of bounds (0–200)'); return; }
    setErr('');
    onSubmit(n);
  }
  return (
    <div className="section">
      <SectionHeader>Set Reservoir</SectionHeader>
      <form className="inputRow" onSubmit={submit}>
        <input type="number" step="0.05" value={val} onChange={e => setVal(e.target.value)} />
        <span className="unit">U</span>
        <button type="submit" className="submit">↵ Set</button>
        {err && <span className="err">{err}</span>}
      </form>
    </div>
  );
}

function ActiveTimeControl({ initial, onSubmit }) {
  const [val, setVal] = useState(initial);
  useEffect(() => { setVal(initial); }, [initial]);
  function submit(e) {
    e.preventDefault();
    const n = parseInt(val, 10);
    if (!isNaN(n)) onSubmit(n);
  }
  return (
    <div className="section">
      <SectionHeader>Activation Time</SectionHeader>
      <form className="inputRow" onSubmit={submit}>
        <input type="number" value={val} onChange={e => setVal(e.target.value)} />
        <span className="unit">min</span>
        <button type="submit" className="submit">↵ Set</button>
      </form>
    </div>
  );
}

function AlertChips({ mask, onSubmit }) {
  const [local, setLocal] = useState(mask ?? 0);
  useEffect(() => { setLocal(mask ?? 0); }, [mask]);
  const dirty = local !== (mask ?? 0);
  return (
    <div className="section">
      <SectionHeader meta={`0b${dec2bin(local)}`}>Active Alerts</SectionHeader>
      <div className="chipRow">
        {ALERT_SLOTS.map(s => {
          const on = (local & (1 << s.idx)) !== 0;
          return (
            <button
              key={s.idx}
              className={`chip ${on ? 'on' : ''}`}
              onClick={() => setLocal(l => l ^ (1 << s.idx))}
              title={s.name}
              type="button"
            >
              <span className="chipIdx">{s.idx}</span>
              <span className="chipName">{s.name}</span>
            </button>
          );
        })}
      </div>
      <div className="inputRow">
        <button
          type="button"
          className="submit"
          disabled={!dirty}
          onClick={() => onSubmit(local)}
        >
          ↵ Apply
        </button>
      </div>
    </div>
  );
}

const selectStyles = {
  control: (base, state) => ({
    ...base,
    background: 'var(--bg-deep)',
    borderColor: state.isFocused ? 'var(--info)' : 'var(--rule)',
    boxShadow: 'none',
    minHeight: '34px',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    ':hover': { borderColor: 'var(--text-dim)' },
  }),
  valueContainer: b => ({ ...b, padding: '2px 8px' }),
  singleValue:    b => ({ ...b, color: 'var(--text)' }),
  input:          b => ({ ...b, color: 'var(--text)' }),
  placeholder:    b => ({ ...b, color: 'var(--label)' }),
  indicatorSeparator: b => ({ ...b, background: 'var(--rule)' }),
  dropdownIndicator: b => ({ ...b, color: 'var(--label)', ':hover': { color: 'var(--text-dim)' } }),
  menu: b => ({
    ...b,
    background: 'var(--surface-2)',
    border: '1px solid var(--rule)',
    borderRadius: '2px',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
  }),
  menuList: b => ({ ...b, padding: 0 }),
  option: (b, state) => ({
    ...b,
    background: state.isFocused ? 'var(--surface)' : 'transparent',
    color: state.isSelected ? 'var(--info)' : 'var(--text-dim)',
    cursor: 'pointer',
    padding: '6px 10px',
  }),
};

function FaultControl({ options, onTrigger, currentFault }) {
  const [selected, setSelected] = useState(null);
  useEffect(() => {
    if (currentFault) {
      const match = options.find(o => o.value === currentFault);
      if (match) setSelected(match);
    }
  }, [currentFault, options]);
  return (
    <div className="section">
      <SectionHeader>Fault</SectionHeader>
      <Select
        options={options}
        value={selected}
        onChange={setSelected}
        styles={selectStyles}
        placeholder="Select fault…"
      />
      <div className="inputRow">
        <button
          type="button"
          className="submit"
          disabled={!selected}
          onClick={() => selected && onTrigger(selected.value)}
        >
          ↵ Trigger Fault
        </button>
      </div>
    </div>
  );
}

function CrashHarness({ onCrash }) {
  return (
    <div className="section danger">
      <SectionHeader glyph="⚠">Crash Harness</SectionHeader>
      <button className="dangerBtn" onClick={() => onCrash(true)}>
        <span className="ix">↳</span> Crash before processing next command
      </button>
      <button className="dangerBtn" onClick={() => onCrash(false)}>
        <span className="ix">↳</span> Crash after processing next command
      </button>
    </div>
  );
}

// ─── Event log ──────────────────────────────────────────────────

function fmtTs(d) {
  return d.toTimeString().slice(0, 8);
}

function EventLog({ events, paused, onTogglePause }) {
  const bodyRef = useRef(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || paused) return;
    el.scrollTop = 0;
  }, [events, paused]);

  return (
    <div className="section">
      <div className="logHeader">
        <SectionHeader meta={`${events.length}`}>Event Stream</SectionHeader>
        <button
          type="button"
          className={`logToggle ${paused ? 'paused' : ''}`}
          onClick={onTogglePause}
        >
          {paused ? '▶ Resume' : '❚❚ Pause'}
        </button>
      </div>
      <div className="logBody" ref={bodyRef}>
        {events.map((e, i) => (
          <div key={e.id} className={`logRow ${e.kind}`}>
            <span className="t">{fmtTs(e.ts)}</span>
            <span className="k">{e.kind}</span>
            <span className="m">{e.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── App ────────────────────────────────────────────────────────

function App() {
  const [podState, setPodState] = useState({});
  const [activeTime, setActiveTime] = useState('');
  const [events, setEvents] = useState([]);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);

  const prevRef = useRef({});
  const pausedRef = useRef(false);
  const eventIdRef = useRef(0);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  const faultOptions = useMemo(
    () => faultData.map(f => ({
      value: parseInt(f.code, 16),
      label: f.description + ' (' + f.code + ')',
    })),
    []
  );

  function pushEvents(newEvents) {
    if (!newEvents.length) return;
    if (pausedRef.current) return;
    setEvents(prev => [...newEvents, ...prev].slice(0, 250));
  }

  function diffEvents(prev, next) {
    const out = [];
    const ts = new Date();
    const mk = (kind, text) => ({ id: ++eventIdRef.current, ts, kind, text });

    if (prev.Mode !== next.Mode && next.Mode) {
      out.push(mk('mode', `mode → ${next.Mode}`));
    }
    if (prev.PodProgress !== next.PodProgress) {
      out.push(mk('state', `PodProgress ${prev.PodProgress ?? '∅'} → ${next.PodProgress}`));
    }
    if (prev.BolusActive !== next.BolusActive) {
      out.push(mk('bolus', next.BolusActive
        ? `bolus start · ${next.BolusPulses} pulses (${fmtUnits(next.BolusPulses)} U)`
        : `bolus end · delivered ${fmtUnits(next.EffectiveDelivered ?? next.Delivered)} U`));
    }
    if (prev.BasalActive !== next.BasalActive) {
      out.push(mk('basal', `basal ${next.BasalActive ? 'on' : 'off'}`));
    }
    if (prev.TempBasalActive !== next.TempBasalActive) {
      out.push(mk('basal', `temp basal ${next.TempBasalActive ? 'on' : 'off'}`));
    }
    if ((prev.ActiveAlertSlots ?? 0) !== (next.ActiveAlertSlots ?? 0)) {
      out.push(mk('alert', `alert mask 0b${dec2bin(prev.ActiveAlertSlots ?? 0)} → 0b${dec2bin(next.ActiveAlertSlots ?? 0)}`));
    }
    if ((prev.FaultEvent ?? 0) !== (next.FaultEvent ?? 0) && next.FaultEvent) {
      out.push(mk('fault', `FaultEvent 0x${Number(next.FaultEvent).toString(16).padStart(2, '0').toUpperCase()}`));
    }
    // AID: emit one event per new completion.
    const prevAid = prev.AIDCompleted || [];
    const nextAid = next.AIDCompleted || [];
    if (nextAid.length > prevAid.length) {
      for (let i = prevAid.length; i < nextAid.length; i++) {
        out.push(mk('aid', `${nextAid[i]} ack`));
      }
    } else if (nextAid.length < prevAid.length) {
      out.push(mk('aid', `AID list reset (${prevAid.length} → ${nextAid.length})`));
    }
    if ((prev.Type4SignaturesVerified ?? 0) !== (next.Type4SignaturesVerified ?? 0)) {
      out.push(mk('aid', `Type-4 sig verified · ${next.Type4SignaturesVerified}`));
    }
    return out;
  }

  useEffect(() => {
    connect((newState) => {
      setConnected(true);
      const prev = prevRef.current;
      const newEvents = diffEvents(prev, newState);
      pushEvents(newEvents);

      prevRef.current = newState;
      setPodState(newState);

      const activationDate = new Date(newState.ActivationTime);
      const minutes = Math.round(((new Date()) - activationDate) / 60000);
      setActiveTime(minutes.toString());
    });
  }, []);

  const isO5 = podState.Mode === 'o5';
  const liveReservoir = podState.EffectiveReservoir ?? podState.Reservoir;
  const liveDelivered = podState.EffectiveDelivered ?? podState.Delivered;
  const initialReservoirU = pulsesToUnits(liveReservoir);

  return (
    <div className="app">
      <StatusStrip
        podState={podState}
        connected={connected}
        activeTime={activeTime}
        liveReservoir={liveReservoir}
        liveDelivered={liveDelivered}
      />

      <div className="layout">
        {/* Column 1 — telemetry */}
        <div className="column">
          <PodStatePanel
            podState={podState}
            liveReservoir={liveReservoir}
            liveDelivered={liveDelivered}
          />
          {isO5 && <BolusProgressPanel podState={podState} />}
          {isO5 && <AIDSetupPanel completed={podState.AIDCompleted} />}
          <CommsPanel podState={podState} />
          {isO5 && (
            <IdentityPanel
              certDER={podState.O5CertDER}
              pdmPubkey={podState.PDMPublicKey}
              verifiedCount={podState.Type4SignaturesVerified}
            />
          )}
        </div>

        {/* Column 2 — controls */}
        <div className="column">
          <ReservoirControl
            initial={initialReservoirU}
            onSubmit={v => sendMsg({ command: 'changeReservoir', value: v })}
          />
          <ActiveTimeControl
            initial={activeTime}
            onSubmit={v => sendMsg({ command: 'setActiveTime', value: v })}
          />
          <AlertChips
            mask={podState.ActiveAlertSlots}
            onSubmit={m => sendMsg({ command: 'setAlerts', value: m })}
          />
          <FaultControl
            options={faultOptions}
            currentFault={podState.FaultEvent}
            onTrigger={v => sendMsg({ command: 'setFault', value: v })}
          />
          <CrashHarness
            onCrash={before => sendMsg({ command: 'crashNextCommand', beforeProcessing: before })}
          />
        </div>

        {/* Column 3 — event stream */}
        <div className="column">
          <EventLog
            events={events}
            paused={paused}
            onTogglePause={() => setPaused(p => !p)}
          />
        </div>
      </div>
    </div>
  );
}

export default App;
