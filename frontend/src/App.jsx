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
  { key: '2.1',   label: 'AlgorithmInsulinHistory (1/3)' },
  { key: '2.1',   label: 'AlgorithmInsulinHistory (2/3)' },
  { key: '2.1',   label: 'AlgorithmInsulinHistory (3/3)' },
  { key: '3.12',  label: 'UnifiedAidPodStatus', alternate: '3.11' },
];

function pulsesToUnits(pulses) {
  if (pulses == null) return 0;
  return Math.round(pulses * 0.05 * 100) / 100;
}

function dec2bin(dec) {
  return (dec >>> 0).toString(2);
}

// SHA-256 hex digest of a base64-encoded byte string (Go []byte is base64'd
// by encoding/json). Returned as colon-separated lowercase hex pairs to
// match the visual style of openssl/cert tool output.
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

// base64 -> short colon-hex preview of first/last few bytes.
function b64Preview(base64, head = 8, tail = 4) {
  if (!base64) return '';
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0'));
    if (hex.length <= head + tail + 1) return hex.join(':');
    return hex.slice(0, head).join(':') + '…' + hex.slice(-tail).join(':');
  } catch {
    return '<base64 error>';
  }
}

function ModeBadge({ mode }) {
  if (!mode) return null;
  const isO5 = mode === 'o5';
  return (
    <span className={`modeBadge ${isO5 ? 'modeBadgeO5' : 'modeBadgeDash'}`}>
      {isO5 ? 'Omnipod 5' : 'Dash'}
    </span>
  );
}

function PodIdentityPanel({ certDER }) {
  const [fingerprint, setFingerprint] = useState('');
  useEffect(() => {
    let cancelled = false;
    sha256ColonHex(certDER).then(fp => { if (!cancelled) setFingerprint(fp); });
    return () => { cancelled = true; };
  }, [certDER]);

  if (!certDER) {
    return (
      <div className="group">
        <h3>Pod Identity (O5)</h3>
        <div className="muted">No pod cert yet. Run `./pod -fresh -mode o5` and pair with a controller to generate one.</div>
      </div>
    );
  }

  // base64 length -> raw bytes length: ceil(b64.length * 3 / 4) minus padding.
  const certBytes = Math.floor(certDER.length * 3 / 4) - (certDER.endsWith('==') ? 2 : certDER.endsWith('=') ? 1 : 0);

  return (
    <div className="group">
      <h3>Pod Identity (O5)</h3>
      <div><span className="var">Cert size</span> <span className="val">{certBytes} bytes (DER)</span></div>
      <div><span className="var">SHA-256</span> <span className="val mono small">{fingerprint || '…'}</span></div>
      <div><span className="var">Preview</span> <span className="val mono small">{b64Preview(certDER, 12, 6)}</span></div>
    </div>
  );
}

function PDMIdentityPanel({ pdmPubkey, verifiedCount }) {
  return (
    <div className="group">
      <h3>PDM Identity (O5)</h3>
      {pdmPubkey ? (
        <>
          <div><span className="var">Pubkey (X‖Y)</span> <span className="val mono small">{b64Preview(pdmPubkey, 16, 8)}</span></div>
          <div><span className="var">Source</span> <span className="val">extracted from PDM SPS2 cert</span></div>
        </>
      ) : (
        <div className="muted">No PDM pubkey yet. Will populate once SPS2 completes.</div>
      )}
      <div><span className="var">Type-4 sigs verified</span> <span className="val">{verifiedCount ?? 0}</span></div>
    </div>
  );
}

// Linear interpolation of bolus progress for the in-flight pulses, ticking
// every second. Backend already ships EffectiveDelivered/EffectiveReservoir
// in the JSON; this panel adds the visual progress bar + remaining time.
function BolusProgressPanel({ podState }) {
  const [now, setNow] = useState(() => Date.now());
  const active = podState.BolusPulses && podState.BolusPulses > 0;

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  if (!active) {
    return (
      <div className="group">
        <h3>Bolus Progress</h3>
        <div className="muted">No bolus in flight.</div>
      </div>
    );
  }

  const start = new Date(podState.BolusStartTime).getTime();
  const end = new Date(podState.BolusEnd).getTime();
  const totalMs = Math.max(end - start, 1);
  const elapsed = Math.min(Math.max(now - start, 0), totalMs);
  const pct = Math.round((elapsed / totalMs) * 100);
  const remainingSec = Math.max(0, Math.round((end - now) / 1000));

  return (
    <div className="group">
      <h3>Bolus Progress</h3>
      <div className="progressOuter">
        <div className="progressInner" style={{ width: pct + '%' }} />
      </div>
      <div><span className="var">Progress</span> <span className="val">{pct}% ({remainingSec}s left)</span></div>
      <div><span className="var">Total pulses</span> <span className="val">{podState.BolusPulses} ({pulsesToUnits(podState.BolusPulses)} U)</span></div>
      <div><span className="var">Effective delivered</span> <span className="val">{pulsesToUnits(podState.EffectiveDelivered)} U</span></div>
      <div><span className="var">Effective reservoir</span> <span className="val">{pulsesToUnits(podState.EffectiveReservoir)} U</span></div>
    </div>
  );
}

function AIDSetupPanel({ completed }) {
  // Match each expected step against `completed` in order. Repeated keys
  // (the three "2.1" history batches) are matched by counting occurrences.
  const seenCounts = useMemo(() => {
    const c = {};
    for (const k of completed || []) c[k] = (c[k] || 0) + 1;
    return c;
  }, [completed]);

  // Walk steps in order, decrementing seenCounts as we attribute completions.
  const remaining = { ...seenCounts };
  const decorated = AID_STEPS.map(step => {
    let done = false;
    if (remaining[step.key] > 0) {
      remaining[step.key]--;
      done = true;
    } else if (step.alternate && remaining[step.alternate] > 0) {
      remaining[step.alternate]--;
      done = true;
    }
    return { ...step, done };
  });

  const completedCount = decorated.filter(s => s.done).length;

  return (
    <div className="group">
      <h3>O5 AID Phase-1 Setup ({completedCount}/{AID_STEPS.length})</h3>
      <ul className="aidList">
        {decorated.map((s, i) => (
          <li key={i} className={s.done ? 'aidDone' : 'aidPending'}>
            <span className="aidMark">{s.done ? '✓' : '○'}</span>{' '}
            <span className="mono small">{s.key}</span>{' '}
            <span>{s.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function App() {

  const [podState, setPodState] = useState({});
  const [reservoir, setReservoir] = useState(0);
  const [alertMask, setAlertMask] = useState(0);
  const [selectedAlerts, setSelectedAlerts] = useState([]);
  const [selectedFault, setSelectedFault] = useState();
  const [activeTime, setActiveTime] = useState("");
  const [reservoirInputError, setReservoirInputError] = useState("");

  const alertOptions = [
    { value: 'slot0', label: 'AutoOff(0)' },
    { value: 'slot1', label: 'Unused(1)' },
    { value: 'slot2', label: 'ShutdownImminent(2)' },
    { value: 'slot3', label: 'ExpirationReminder(3)' },
    { value: 'slot4', label: 'LowReservoir(4)' },
    { value: 'slot5', label: 'SuspendedReminder(5)' },
    { value: 'slot6', label: 'SuspendExpired(6)' },
    { value: 'slot7', label: 'Lifecycle(7)' },
  ]

  const faultOptions = faultData.map((f) => { return {value: parseInt(f["code"], 16), label: f["description"] + " (" + f["code"] + ")"}});

  useEffect(() => {
    connect((newState) => {
      setPodState(newState)
      // Prefer the interpolated reservoir for the input default; fall back
      // to the snapshot value when it isn't present (Dash mode / older sim).
      const liveRes = newState.EffectiveReservoir ?? newState.Reservoir;
      setReservoir(pulsesToUnits(liveRes))
      setAlertMask(newState.ActiveAlertSlots)

      var selected = []
      for (let i = 0; i < 8; i++) {
        if ((newState.ActiveAlertSlots & (1<<i)) != 0) {
          selected.push(alertOptions[i])
        }
      }
      setSelectedAlerts(selected)

      for (let i = 0; i < faultOptions.length; i++) {
        if (faultOptions[i].value == newState.FaultEvent) {
          setSelectedFault(faultOptions[i])
          break
        }
      }

      const activationDate = new Date(newState.ActivationTime);
      const activeTimeMinutes = Math.round(((new Date()) - activationDate) / 60000);
      setActiveTime(activeTimeMinutes.toString());

      console.log("New pod state:", newState)
    });
  }, [])

  function reservoirInputChanged(event) {
    setReservoir(event.target.value);
    setReservoirInputError("")
  };

  function sendReservoir(event) {
    const val = parseFloat(reservoir);
    if (val < 0 || val > 200) {
      setReservoirInputError("Bounds error")
    } else {
      sendMsg({"command": "changeReservoir", "value": val});
    }
    event.preventDefault();
  };

  function alertsChanged(newValue) {
    var newAlertMask = 0;
    for (const element of newValue) {
      const slot = parseInt(element.value.substring(4,6))
      newAlertMask |= 1 << slot
    }
    setAlertMask(newAlertMask)
    setSelectedAlerts(newValue)
  }

  function faultChanged(newValue) {
    setSelectedFault(newValue)
  }

  function sendFault() {
    if (selectedFault) {
      sendMsg({"command": "setFault", "value": selectedFault.value});
    }
  }

  function sendAlerts(event) {
    sendMsg({"command": "setAlerts", "value": alertMask});
    event.preventDefault();
  };

  function activeTimeChanged(event) {
    setActiveTime(event.target.value);
  }

  function sendActiveTime(event) {
    sendMsg({"command": "setActiveTime", "value": parseInt(activeTime)});
    event.preventDefault();
  };

  function sendCrashNextCommand(beforeProcessing) {
    sendMsg({"command": "crashNextCommand", "beforeProcessing": beforeProcessing});
  }

  function crashBeforeProcessing() {
    sendCrashNextCommand(true);
  }

  function crashAfterProcessing() {
    sendCrashNextCommand(false);
  }

  const isO5 = podState.Mode === 'o5';
  const liveReservoir = podState.EffectiveReservoir ?? podState.Reservoir;
  const liveDelivered = podState.EffectiveDelivered ?? podState.Delivered;

  return (
    <div className="App">
      <div className="Header">
        <h2>Pod Simulator <ModeBadge mode={podState.Mode} /></h2>
        <div>
          <img src="s08.jpg"/>

        </div>
      </div>

      <div className="group">
        <h3>Pod State</h3>
        <div><span className="var">PodProgress</span> <span className="val">{podState.PodProgress}</span></div>
        <div><span className="var">Reservoir</span> <span className="val">{pulsesToUnits(liveReservoir)} U</span></div>
        <div><span className="var">Delivered</span> <span className="val">{pulsesToUnits(liveDelivered)} U</span></div>
        <div><span className="var">ActiveAlertSlots</span> <span>0b{dec2bin(podState.ActiveAlertSlots)}</span></div>
        <div><span className="var">BolusActive</span> <span>{podState.BolusActive ? "Yes" : "No"}</span></div>
        <div><span className="var">BasalActive</span> <span>{podState.BasalActive ? "Yes" : "No"}</span></div>
        <div><span className="var">TempBasalActive</span> <span>{podState.TempBasalActive ? "Yes" : "No"}</span></div>
      </div>

      {isO5 && <BolusProgressPanel podState={podState} />}
      {isO5 && <AIDSetupPanel completed={podState.AIDCompleted} />}
      {isO5 && <PodIdentityPanel certDER={podState.O5CertDER} />}
      {isO5 && <PDMIdentityPanel pdmPubkey={podState.PDMPublicKey} verifiedCount={podState.Type4SignaturesVerified} />}

      <div className="group">
        <h3>Reservoir</h3>
        <form onSubmit={sendReservoir}>
          <label>
            <input type="number" value={reservoir} onChange={reservoirInputChanged} />
          </label>
          <input type="submit" value="Set Reservoir" />
          <span className="inputError">{reservoirInputError}</span>
        </form>
      </div>

      <div className="group">
        <h3>Minutes Since Activation</h3>
        <form onSubmit={sendActiveTime}>
          <label>
            <input type="number" value={activeTime} onChange={activeTimeChanged} />
          </label>
          <input type="submit" value="Set Active Time" />
        </form>
      </div>


      <div className="group">
        <h3>Active Alerts</h3>
        <Select className="basic-multi-select" isMulti options={alertOptions} onChange={alertsChanged} value={selectedAlerts} />
        <button onClick={sendAlerts}>
          Set Alerts
        </button>
      </div>

      <div className="group">
        <h3>Fault</h3>
        <Select options={faultOptions} onChange={faultChanged} value={selectedFault} />
        <button onClick={sendFault} disabled={selectedFault == null}>
          Trigger Fault
        </button>
      </div>

      <div className="group">
        <h3>Unacknowledged Command Helper</h3>
        <button onClick={crashBeforeProcessing}>
          Crash before processing next command
        </button>
        <button onClick={crashAfterProcessing}>
          Crash after processing next command
        </button>
      </div>

      <div className="group">
        <h3>Comms</h3>
        <div><span className="var">MsgSeq</span> <span>{podState.MsgSeq}</span></div>
        <div><span className="var">CmdSeq</span> <span>{podState.CmdSeq}</span></div>
        <div><span className="var">LastProgSeqNum</span> <span>{podState.LastProgSeqNum}</span></div>
        <div><span className="var">LTK</span> <span className="mono small">{podState.LTK}</span></div>
        <div><span className="var">EapAkaSeq</span> <span>{podState.EapAkaSeq}</span></div>
        <div><span className="var">NoncePrefix</span> <span className="mono small">{podState.NoncePrefix}</span></div>
        <div><span className="var">NonceSeq</span> <span>{podState.NonceSeq}</span></div>
        <div><span className="var">CK</span> <span className="mono small">{podState.CK}</span></div>
      </div>


      <div className="logs">
      </div>
    </div>
  );
}

export default App;
