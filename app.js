const { useState, useEffect, useMemo, useRef } = React;

// ====== SETUP: paste your own Google OAuth Client ID here (see README.md) ======
const GOOGLE_CLIENT_ID = "930647615202-071mpu5o1j35d3vndrlnopm3qbbv860r.apps.googleusercontent.com";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email";
const DATA_FILENAME = "flower-ledger-data.json";
// =================================================================================

const DEFAULT_FLOWERS = ["Mirable","SY","AG","SG","MG","Purple","BW","IW","CW","Chocolate","Mix","Mango","Orange","Dera","Modi","Apple"];
const DEFAULT_SUPPLIERS = ["ARS", "WC", "AIS"];
const COMMISSION_RATE = 0.10;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const todayISO = () => new Date().toISOString().slice(0, 10);
const daysAgoISO = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const fmtDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const rupee = (n) => "₹" + (Math.round((n || 0) * 100) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kg = (n) => (Math.round((n || 0) * 100) / 100).toLocaleString("en-IN") + " kg";

function emptyDb() {
  return { flowers: DEFAULT_FLOWERS.slice(), suppliers: DEFAULT_SUPPLIERS.slice(), days: {}, remainingIndex: [], payments: [] };
}
function openRemainingOf(entry) {
  const resolved = (entry.resolutions || []).reduce((s, r) => s + r.weight, 0);
  return Math.max(0, (entry.remaining || 0) - resolved);
}
function resolvedValueOf(entry) {
  return (entry.resolutions || []).reduce((s, r) => s + r.value, 0);
}

// ---------------- Google Drive storage layer ----------------

let tokenClient = null;
let accessToken = null;

function loadTokenClient(onToken) {
  if (!window.google || !window.google.accounts) { setTimeout(() => loadTokenClient(onToken), 200); return; }
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: (resp) => { if (resp && resp.access_token) { accessToken = resp.access_token; onToken(resp.access_token); } },
  });
}

async function driveFetch(url, options = {}, retry = true) {
  const res = await fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${accessToken}` } });
  if (res.status === 401 && retry) {
    await new Promise((resolve) => {
      tokenClient.callback = (resp) => { if (resp && resp.access_token) { accessToken = resp.access_token; } resolve(); };
      tokenClient.requestAccessToken({ prompt: "" });
    });
    return driveFetch(url, options, false);
  }
  return res;
}

async function driveFindFile() {
  const q = encodeURIComponent(`name='${DATA_FILENAME}' and trashed=false`);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`);
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}

async function driveCreateFile(initialData) {
  const boundary = "flowerledgerboundary";
  const metadata = { name: DATA_FILENAME, mimeType: "application/json" };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(initialData)}\r\n` +
    `--${boundary}--`;
  const res = await driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  const data = await res.json();
  return data.id;
}

async function driveReadFile(id) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
  if (!res.ok) throw new Error("drive read failed");
  return await res.json();
}

async function driveSaveFile(id, data) {
  await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function fetchUserEmail() {
  try {
    const res = await driveFetch("https://www.googleapis.com/oauth2/v3/userinfo");
    const data = await res.json();
    return data.email || "";
  } catch (e) { return ""; }
}

// ---------------- App ----------------

function App() {
  const [authed, setAuthed] = useState(false);
  const [authing, setAuthing] = useState(false);
  const [authError, setAuthError] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [fileId, setFileId] = useState(null);
  const [db, setDb] = useState(null);
  const [syncStatus, setSyncStatus] = useState("idle"); // idle | saving | saved | error
  const saveTimer = useRef(null);

  const [date, setDate] = useState(todayISO());
  const [tab, setTab] = useState("purchase");

  useEffect(() => { loadTokenClient(handleToken); }, []);

  async function handleToken(token) {
    setAuthing(true); setAuthError("");
    try {
      accessToken = token;
      const email = await fetchUserEmail();
      setUserEmail(email);
      let file = await driveFindFile();
      let id, data;
      if (file) {
        id = file.id;
        data = await driveReadFile(id);
      } else {
        data = emptyDb();
        id = await driveCreateFile(data);
      }
      setFileId(id);
      setDb(data);
      setAuthed(true);
    } catch (e) {
      setAuthError("Could not connect to Google Drive. Check your Client ID setup and try again.");
    }
    setAuthing(false);
  }

  function signIn() {
    setAuthError("");
    if (GOOGLE_CLIENT_ID.startsWith("YOUR_CLIENT_ID")) {
      setAuthError("This app hasn't been set up with a Google Client ID yet — see README.md.");
      return;
    }
    if (tokenClient) tokenClient.requestAccessToken();
  }
  function signOut() {
    if (accessToken && window.google) window.google.accounts.oauth2.revoke(accessToken, () => {});
    accessToken = null; setAuthed(false); setDb(null); setFileId(null); setUserEmail("");
  }

  // debounced autosave whenever db changes
  useEffect(() => {
    if (!authed || !db || !fileId) return;
    setSyncStatus("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try { await driveSaveFile(fileId, db); setSyncStatus("saved"); }
      catch (e) { setSyncStatus("error"); }
    }, 900);
    return () => clearTimeout(saveTimer.current);
  }, [db]);

  function updateDb(mutator) {
    setDb((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      mutator(next);
      return next;
    });
  }

  if (!authed) {
    return <SignInScreen onSignIn={signIn} authing={authing} error={authError} />;
  }

  return (
    <LedgerApp
      db={db} updateDb={updateDb} date={date} setDate={setDate} tab={tab} setTab={setTab}
      userEmail={userEmail} syncStatus={syncStatus} signOut={signOut}
    />
  );
}

function SignInScreen({ onSignIn, authing, error }) {
  return (
    <div className="fl-app min-h-screen flex items-center justify-center px-6">
      <FlStyles />
      <div className="fl-card p-6 max-w-sm w-full text-center">
        <div className="text-3xl mb-2">🌸</div>
        <h1 className="fl-display text-2xl font-semibold mb-1">Flower Ledger</h1>
        <p className="text-sm mb-5" style={{ color: "var(--ink-soft)" }}>Your data is saved to your own Google Drive as a single file, so it's private to your account and safe if you switch phones.</p>
        <button onClick={onSignIn} disabled={authing} className="fl-btn fl-btn-marigold w-full">{authing ? "Connecting…" : "Sign in with Google"}</button>
        {error && <p className="text-sm mt-3" style={{ color: "var(--rust)" }}>{error}</p>}
      </div>
    </div>
  );
}

function FlStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
      .fl-app { --paper:#FBF7EE; --paper-line:#E4D9C4; --ink:#24312A; --ink-soft:#6B7A70; --marigold:#E2872F; --marigold-dark:#B96A1E; --marigold-bg:#FBEBD8; --rose:#BD4577; --rose-dark:#96345D; --rose-bg:#F9E4ED; --sage:#5C8767; --sage-bg:#E8F0E9; --rust:#B5493A; --card:#FFFFFF; font-family:'Inter',sans-serif; background:var(--paper); color:var(--ink); }
      .fl-app * { box-sizing: border-box; }
      .fl-display { font-family:'Fraunces',serif; }
      .fl-mono { font-family:'IBM Plex Mono',monospace; }
      .fl-card { background:var(--card); border:1px solid var(--paper-line); border-radius:10px; }
      .fl-tab-btn { border-bottom:3px solid transparent; }
      .fl-tab-btn.active-purchase { border-color:var(--marigold); color:var(--marigold-dark); }
      .fl-tab-btn.active-sales { border-color:var(--rose); color:var(--rose-dark); }
      .fl-tab-btn.active-summary { border-color:var(--ink); color:var(--ink); }
      .fl-tab-btn.active-stock { border-color:var(--sage); color:var(--sage); }
      .fl-tab-btn.active-accounts { border-color:var(--ink-soft); color:var(--ink); }
      .fl-double { border-bottom:3px double var(--ink); }
      .fl-tape-item { border-bottom:1px dashed var(--paper-line); }
      .fl-input { border:1px solid var(--paper-line); border-radius:8px; padding:9px 11px; background:#FFFEFA; width:100%; font-size:15px; }
      .fl-input:focus { outline:2px solid var(--marigold); outline-offset:1px; }
      .fl-input-rose:focus { outline:2px solid var(--rose); }
      .fl-btn { border-radius:8px; padding:10px 16px; font-weight:600; font-size:14px; cursor:pointer; border:none; transition:transform .05s ease; }
      .fl-btn:active { transform:scale(0.97); }
      .fl-btn-marigold { background:var(--marigold); color:#fff; }
      .fl-btn-rose { background:var(--rose); color:#fff; }
      .fl-btn-sage { background:var(--sage); color:#fff; }
      .fl-btn-outline { background:transparent; border:1px solid var(--paper-line); color:var(--ink); }
      .fl-btn-sm { padding:6px 10px; font-size:12.5px; border-radius:6px; }
      .fl-badge { font-size:11px; font-weight:600; padding:2px 7px; border-radius:20px; }
    `}</style>
  );
}

function LedgerApp({ db, updateDb, date, setDate, tab, setTab, userEmail, syncStatus, signOut }) {
  const flowers = db.flowers;
  const suppliers = db.suppliers;
  const day = db.days[date] || { purchases: [], sales: [] };
  const purchases = day.purchases || [];
  const sales = day.sales || [];
  const remainingIndex = db.remainingIndex || [];
  const knownDates = useMemo(() => Object.keys(db.days).sort().reverse(), [db.days]);

  // purchase form
  const [pFlower, setPFlower] = useState("");
  const [pSupplier, setPSupplier] = useState("");
  const [pType, setPType] = useState("");
  const [pWeights, setPWeights] = useState([]);
  const [pWeightInput, setPWeightInput] = useState("");
  const [pError, setPError] = useState("");
  const [showAddFlower, setShowAddFlower] = useState(false);
  const [newFlowerName, setNewFlowerName] = useState("");
  const [showAddSupplier, setShowAddSupplier] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState("");

  // sales form
  const [sFlower, setSFlower] = useState("");
  const [sType, setSType] = useState("");
  const [sWeight, setSWeight] = useState("");
  const [sPrice, setSPrice] = useState("");
  const [sWaste, setSWaste] = useState("");
  const [sRemaining, setSRemaining] = useState("");
  const [sError, setSError] = useState("");

  function ensureDay(d, dt) { if (!d.days[dt]) d.days[dt] = { purchases: [], sales: [] }; return d.days[dt]; }

  function confirmAddFlower() {
    const name = newFlowerName.trim();
    if (!name) return;
    if (!flowers.some((f) => f.toLowerCase() === name.toLowerCase())) {
      updateDb((d) => { d.flowers.push(name); });
    }
    setPFlower(name); setShowAddFlower(false); setNewFlowerName("");
  }
  function confirmAddSupplier() {
    const name = newSupplierName.trim();
    if (!name) return;
    if (!suppliers.some((s) => s.toLowerCase() === name.toLowerCase())) {
      updateDb((d) => { d.suppliers.push(name); });
    }
    setPSupplier(name); setShowAddSupplier(false); setNewSupplierName("");
  }

  function addWeightEntry() {
    const v = parseFloat(pWeightInput);
    if (!v || v <= 0) { setPError("Enter a weight above 0"); return; }
    setPWeights([...pWeights, { id: uid(), val: v }]);
    setPWeightInput(""); setPError("");
  }
  function removeWeightEntry(id) { setPWeights(pWeights.filter((w) => w.id !== id)); }
  const pTotalWeight = pWeights.reduce((s, w) => s + w.val, 0);

  function addPurchaseBatch() {
    if (!pFlower) { setPError("Choose a flower"); return; }
    if (!pSupplier) { setPError("Choose who you bought it from"); return; }
    if (pTotalWeight <= 0) { setPError("Add at least one weight entry"); return; }
    const entry = { id: uid(), flower: pFlower, supplier: pSupplier, type: pType.trim(), weights: pWeights.map((w) => w.val), totalWeight: pTotalWeight, cost: null, commission: 0, rate: 0, total: 0, paid: false };
    updateDb((d) => { ensureDay(d, date).purchases.push(entry); });
    setPWeights([]); setPWeightInput(""); setPType(""); setPError("");
  }
  function deletePurchase(id) {
    updateDb((d) => { const dd = ensureDay(d, date); dd.purchases = dd.purchases.filter((e) => e.id !== id); });
  }
  function setBatchCost(id, cost) {
    const commission = cost * COMMISSION_RATE;
    const rate = cost - commission;
    updateDb((d) => {
      const dd = ensureDay(d, date);
      dd.purchases = dd.purchases.map((e) => e.id === id ? { ...e, cost, commission, rate, total: e.totalWeight * rate } : e);
    });
  }

  const purchaseGroups = useMemo(() => {
    const map = {};
    purchases.forEach((e) => {
      if (!map[e.flower]) map[e.flower] = { entries: [], subtotal: 0, weight: 0, pendingWeight: 0 };
      map[e.flower].entries.push(e);
      map[e.flower].weight += e.totalWeight;
      if (e.cost != null) map[e.flower].subtotal += e.total; else map[e.flower].pendingWeight += e.totalWeight;
    });
    return map;
  }, [purchases]);
  const purchaseGrandTotal = purchases.filter((e) => e.cost != null).reduce((s, e) => s + e.total, 0);
  const purchaseGrandWeight = purchases.reduce((s, e) => s + e.totalWeight, 0);
  const purchasePendingWeight = purchases.filter((e) => e.cost == null).reduce((s, e) => s + e.totalWeight, 0);

  const sWeightNum = parseFloat(sWeight) || 0;
  const sPriceNum = parseFloat(sPrice) || 0;
  const sWasteNum = parseFloat(sWaste) || 0;
  const sRemainingNum = parseFloat(sRemaining) || 0;
  const sValue = sWeightNum * sPriceNum;

  const purchasedTodayFor = (flower) => purchases.filter((e) => e.flower === flower).reduce((s, e) => s + e.totalWeight, 0);
  const allocatedTodayFor = (flower) => sales.filter((e) => e.flower === flower).reduce((s, e) => s + e.weight + e.waste + e.remaining, 0);
  const availableFor = (flower) => (flower ? purchasedTodayFor(flower) - allocatedTodayFor(flower) : 0);

  function addSaleEntry() {
    if (!sFlower) { setSError("Choose a flower"); return; }
    const requested = sWeightNum + sWasteNum + sRemainingNum;
    if (requested <= 0) { setSError("Enter weight sold, waste, or remaining"); return; }
    if (sWeightNum > 0 && (!sPriceNum || sPriceNum <= 0)) { setSError("Enter sale price per kg"); return; }
    const available = availableFor(sFlower);
    if (requested > available + 0.001) { setSError(`Only ${kg(available)} of ${sFlower} available today (bought ${kg(purchasedTodayFor(sFlower))} − already allocated ${kg(allocatedTodayFor(sFlower))})`); return; }
    const entry = { id: uid(), flower: sFlower, type: sType.trim(), weight: sWeightNum, price: sWeightNum > 0 ? sPriceNum : 0, value: sValue, waste: sWasteNum, remaining: sRemainingNum, resolutions: [] };
    updateDb((d) => {
      ensureDay(d, date).sales.push(entry);
      if (sRemainingNum > 0) d.remainingIndex.push({ id: entry.id, date, flower: sFlower, type: sType.trim(), openWeight: sRemainingNum });
    });
    setSWeight(""); setSPrice(""); setSWaste(""); setSRemaining(""); setSType(""); setSError("");
  }
  function deleteSale(id) {
    updateDb((d) => {
      const dd = ensureDay(d, date);
      dd.sales = dd.sales.filter((e) => e.id !== id);
      d.remainingIndex = d.remainingIndex.filter((r) => r.id !== id);
    });
  }
  function resolveRemaining(record, weightToResolve, price) {
    updateDb((d) => {
      const dd = d.days[record.date];
      if (dd) {
        dd.sales = dd.sales.map((e) => e.id === record.id
          ? { ...e, resolutions: [...(e.resolutions || []), { id: uid(), weight: weightToResolve, price, value: weightToResolve * price, resolvedOn: todayISO() }] }
          : e);
      }
      const newOpen = record.openWeight - weightToResolve;
      if (newOpen <= 0.001) d.remainingIndex = d.remainingIndex.filter((r) => r.id !== record.id);
      else d.remainingIndex = d.remainingIndex.map((r) => (r.id === record.id ? { ...r, openWeight: newOpen } : r));
    });
  }
  function markPurchasesPaid(entries, supplier, from, to, amount) {
    updateDb((d) => {
      entries.forEach((r) => {
        const dd = d.days[r.date];
        if (dd) dd.purchases = dd.purchases.map((e) => (e.id === r.id ? { ...e, paid: true } : e));
      });
      d.payments.push({ id: uid(), supplier, from, to, amount, entries: entries.length, paidOn: todayISO() });
    });
  }

  const saleGroups = useMemo(() => {
    const map = {};
    sales.forEach((e) => {
      if (!map[e.flower]) map[e.flower] = { entries: [], subtotal: 0, weight: 0, waste: 0, remaining: 0 };
      map[e.flower].entries.push(e);
      map[e.flower].subtotal += e.value + resolvedValueOf(e);
      map[e.flower].weight += e.weight;
      map[e.flower].waste += e.waste;
      map[e.flower].remaining += openRemainingOf(e);
    });
    return map;
  }, [sales]);
  const saleGrandRevenue = sales.reduce((s, e) => s + e.value + resolvedValueOf(e), 0);
  const saleGrandWaste = sales.reduce((s, e) => s + e.waste, 0);
  const saleGrandRemaining = sales.reduce((s, e) => s + openRemainingOf(e), 0);
  const allFlowersToday = useMemo(() => Array.from(new Set([...Object.keys(purchaseGroups), ...Object.keys(saleGroups)])), [purchaseGroups, saleGroups]);
  const profit = saleGrandRevenue - purchaseGrandTotal;

  return (
    <div className="fl-app min-h-screen pb-20">
      <FlStyles />
      <header className="border-b" style={{ borderColor: "var(--paper-line)", background: "var(--paper)" }}>
        <div className="max-w-2xl mx-auto px-4 pt-5 pb-4">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <span className="text-xl">🌸</span>
              <h1 className="fl-display text-2xl" style={{ fontWeight: 600 }}>Flower Ledger</h1>
            </div>
            <button onClick={signOut} className="text-xs" style={{ color: "var(--ink-soft)" }}>Sign out</button>
          </div>
          <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
            {userEmail || "Google Drive"} · {syncStatus === "saving" ? "Saving…" : syncStatus === "error" ? "Sync error — will retry" : "Saved to Drive"}
          </p>

          <div className="mt-4 flex items-center gap-2">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="fl-input fl-mono text-sm" style={{ width: "auto" }} />
            <span className="text-sm fl-display" style={{ color: "var(--ink-soft)" }}>{fmtDate(date)}</span>
          </div>
          {knownDates.length > 1 && (
            <div className="mt-2 flex gap-1.5 flex-wrap">
              {knownDates.slice(0, 8).map((d) => (
                <button key={d} onClick={() => setDate(d)} className="fl-mono" style={{ fontSize: 11.5, padding: "3px 8px", borderRadius: 6, border: `1px solid ${d === date ? "var(--marigold)" : "var(--paper-line)"}`, background: d === date ? "var(--marigold-bg)" : "transparent", color: d === date ? "var(--marigold-dark)" : "var(--ink-soft)", cursor: "pointer" }}>{d.slice(5)}</button>
              ))}
            </div>
          )}
        </div>
        <nav className="max-w-2xl mx-auto px-4 flex gap-5 overflow-x-auto">
          <button onClick={() => setTab("purchase")} className={`fl-tab-btn pb-3 text-sm font-semibold flex items-center gap-1.5 whitespace-nowrap ${tab === "purchase" ? "active-purchase" : ""}`} style={{ color: tab === "purchase" ? undefined : "var(--ink-soft)" }}>🧺 Purchase</button>
          <button onClick={() => setTab("sales")} className={`fl-tab-btn pb-3 text-sm font-semibold flex items-center gap-1.5 whitespace-nowrap ${tab === "sales" ? "active-sales" : ""}`} style={{ color: tab === "sales" ? undefined : "var(--ink-soft)" }}>₹ Sales</button>
          <button onClick={() => setTab("summary")} className={`fl-tab-btn pb-3 text-sm font-semibold flex items-center gap-1.5 whitespace-nowrap ${tab === "summary" ? "active-summary" : ""}`} style={{ color: tab === "summary" ? undefined : "var(--ink-soft)" }}>🍃 Summary</button>
          <button onClick={() => setTab("stock")} className={`fl-tab-btn pb-3 text-sm font-semibold flex items-center gap-1.5 whitespace-nowrap ${tab === "stock" ? "active-stock" : ""}`} style={{ color: tab === "stock" ? undefined : "var(--ink-soft)" }}>📦 Carryover{remainingIndex.length > 0 && <span className="fl-badge" style={{ background: "var(--sage-bg)", color: "var(--sage)" }}>{remainingIndex.length}</span>}</button>
          <button onClick={() => setTab("accounts")} className={`fl-tab-btn pb-3 text-sm font-semibold flex items-center gap-1.5 whitespace-nowrap ${tab === "accounts" ? "active-accounts" : ""}`} style={{ color: tab === "accounts" ? undefined : "var(--ink-soft)" }}>🧾 Accounts</button>
          <button onClick={() => setTab("import")} className={`fl-tab-btn pb-3 text-sm font-semibold flex items-center gap-1.5 whitespace-nowrap ${tab === "import" ? "active-accounts" : ""}`} style={{ color: tab === "import" ? undefined : "var(--ink-soft)" }}>⬆ Import</button>
        </nav>
      </header>

      <main className="max-w-2xl mx-auto px-4 pt-5">
        {tab === "purchase" && (
          <PurchaseTab flowers={flowers} pFlower={pFlower} setPFlower={setPFlower} pType={pType} setPType={setPType}
            suppliers={suppliers} pSupplier={pSupplier} setPSupplier={setPSupplier}
            showAddSupplier={showAddSupplier} setShowAddSupplier={setShowAddSupplier} newSupplierName={newSupplierName} setNewSupplierName={setNewSupplierName} confirmAddSupplier={confirmAddSupplier}
            pWeights={pWeights} pWeightInput={pWeightInput} setPWeightInput={setPWeightInput} addWeightEntry={addWeightEntry} removeWeightEntry={removeWeightEntry} pTotalWeight={pTotalWeight}
            pError={pError} addPurchaseBatch={addPurchaseBatch}
            showAddFlower={showAddFlower} setShowAddFlower={setShowAddFlower} newFlowerName={newFlowerName} setNewFlowerName={setNewFlowerName} confirmAddFlower={confirmAddFlower}
            purchaseGroups={purchaseGroups} purchaseGrandTotal={purchaseGrandTotal} purchaseGrandWeight={purchaseGrandWeight} purchasePendingWeight={purchasePendingWeight}
            deletePurchase={deletePurchase} setBatchCost={setBatchCost} />
        )}
        {tab === "sales" && (
          <SalesTab flowers={flowers} sFlower={sFlower} setSFlower={setSFlower} sType={sType} setSType={setSType}
            sWeight={sWeight} setSWeight={setSWeight} sPrice={sPrice} setSPrice={setSPrice} sWaste={sWaste} setSWaste={setSWaste} sRemaining={sRemaining} setSRemaining={setSRemaining}
            sValue={sValue} sError={sError} addSaleEntry={addSaleEntry}
            saleGroups={saleGroups} saleGrandRevenue={saleGrandRevenue} saleGrandWaste={saleGrandWaste} saleGrandRemaining={saleGrandRemaining}
            deleteSale={deleteSale} availableFor={availableFor} purchasedTodayFor={purchasedTodayFor} />
        )}
        {tab === "summary" && (
          <SummaryTab purchaseGrandTotal={purchaseGrandTotal} purchaseGrandWeight={purchaseGrandWeight} purchasePendingWeight={purchasePendingWeight}
            saleGrandRevenue={saleGrandRevenue} saleGrandWaste={saleGrandWaste} saleGrandRemaining={saleGrandRemaining}
            profit={profit} allFlowersToday={allFlowersToday} purchaseGroups={purchaseGroups} saleGroups={saleGroups} />
        )}
        {tab === "stock" && <StockTab remainingIndex={remainingIndex} resolveRemaining={resolveRemaining} />}
        {tab === "accounts" && <AccountsTab db={db} suppliers={suppliers} markPurchasesPaid={markPurchasesPaid} />}
        {tab === "import" && <ImportTab updateDb={updateDb} />}
      </main>
    </div>
  );
}

function NamedSelect({ label, placeholder, addLabel, addPlaceholder, items, value, onChange, showAdd, setShowAdd, newName, setNewName, confirmAdd, accent }) {
  return (
    <div>
      <label className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--ink-soft)" }}>{label}</label>
      <div className="relative mt-1">
        <select value={value} onChange={(e) => { if (e.target.value === "__add__") { setShowAdd(true); return; } onChange(e.target.value); }} className="fl-input" style={{ appearance: "none", paddingRight: 32 }}>
          <option value="">{placeholder}</option>
          {items.map((f) => <option key={f} value={f}>{f}</option>)}
          <option value="__add__">{addLabel}</option>
        </select>
        <span style={{ position: "absolute", right: 12, top: 10, pointerEvents: "none", color: "var(--ink-soft)" }}>▾</span>
      </div>
      {showAdd && (
        <div className="mt-2 flex gap-2">
          <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && confirmAdd()} placeholder={addPlaceholder} className="fl-input" />
          <button onClick={confirmAdd} className="fl-btn" style={{ background: accent, color: "#fff" }}>Add</button>
          <button onClick={() => { setShowAdd(false); setNewName(""); }} className="fl-btn fl-btn-outline">Cancel</button>
        </div>
      )}
    </div>
  );
}

function CostEditor({ entry, setBatchCost }) {
  const [val, setVal] = useState("");
  const cost = parseFloat(val) || 0;
  const commission = cost * COMMISSION_RATE;
  const rate = cost - commission;
  const total = entry.totalWeight * rate;
  return (
    <div className="mt-2 p-2.5 rounded-lg" style={{ background: "var(--marigold-bg)" }}>
      <div className="flex gap-2 items-center">
        <input type="number" inputMode="decimal" step="0.1" value={val} onChange={(e) => setVal(e.target.value)} placeholder="Cost per kg" className="fl-input" style={{ background: "#fff" }} />
        <button onClick={() => cost > 0 && setBatchCost(entry.id, cost)} disabled={cost <= 0} className="fl-btn fl-btn-marigold fl-btn-sm" style={{ opacity: cost > 0 ? 1 : 0.5 }}>✓ Save</button>
      </div>
      {cost > 0 && <p className="fl-mono text-xs mt-1.5" style={{ color: "var(--marigold-dark)" }}>− {rupee(commission)} commission → net {rupee(rate)}/kg → total {rupee(total)}</p>}
    </div>
  );
}

function PurchaseTab(props) {
  const { flowers, pFlower, setPFlower, pType, setPType, suppliers, pSupplier, setPSupplier, showAddSupplier, setShowAddSupplier, newSupplierName, setNewSupplierName, confirmAddSupplier, pWeights, pWeightInput, setPWeightInput, addWeightEntry, removeWeightEntry, pTotalWeight, pError, addPurchaseBatch, showAddFlower, setShowAddFlower, newFlowerName, setNewFlowerName, confirmAddFlower, purchaseGroups, purchaseGrandTotal, purchaseGrandWeight, purchasePendingWeight, deletePurchase, setBatchCost } = props;
  const [editingCost, setEditingCost] = useState(null);

  return (
    <div className="space-y-5">
      <div className="fl-card p-4">
        <NamedSelect label="Flower" placeholder="Choose a flower" addLabel="+ Add new flower" addPlaceholder="New flower name" items={flowers} value={pFlower} onChange={setPFlower} showAdd={showAddFlower} setShowAdd={setShowAddFlower} newName={newFlowerName} setNewName={setNewFlowerName} confirmAdd={confirmAddFlower} accent="var(--marigold)" />

        <div className="mt-3">
          <NamedSelect label="Bought from" placeholder="Choose who you bought it from" addLabel="+ Add new person" addPlaceholder="New supplier name" items={suppliers} value={pSupplier} onChange={setPSupplier} showAdd={showAddSupplier} setShowAdd={setShowAddSupplier} newName={newSupplierName} setNewName={setNewSupplierName} confirmAdd={confirmAddSupplier} accent="var(--marigold)" />
        </div>

        <div className="mt-3">
          <label className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--ink-soft)" }}>Variety / grade (optional)</label>
          <input value={pType} onChange={(e) => setPType(e.target.value)} placeholder="e.g. Premium, loose, bunch" className="fl-input mt-1" />
        </div>

        <div className="mt-3">
          <label className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--ink-soft)" }}>Weight (kg) — add each lot</label>
          <div className="flex gap-2 mt-1">
            <input type="number" inputMode="decimal" step="0.1" value={pWeightInput} onChange={(e) => setPWeightInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addWeightEntry()} placeholder="48" className="fl-input" />
            <button onClick={addWeightEntry} className="fl-btn fl-btn-marigold">+ Add</button>
          </div>
          {pWeights.length > 0 && (
            <div className="mt-3 fl-card" style={{ background: "#FFFEFA" }}>
              {pWeights.map((w, i) => (
                <div key={w.id} className="fl-tape-item flex items-center justify-between px-3 py-2">
                  <span className="fl-mono text-sm">{i + 1}.  {w.val} kg</span>
                  <button onClick={() => removeWeightEntry(w.id)} aria-label="Remove entry" style={{ color: "var(--rust)" }}>✕</button>
                </div>
              ))}
              <div className="flex items-center justify-between px-3 py-2">
                <span className="fl-display text-sm font-semibold">Total weight</span>
                <span className="fl-mono font-semibold">{kg(pTotalWeight)}</span>
              </div>
            </div>
          )}
        </div>

        <p className="text-xs mt-3" style={{ color: "var(--ink-soft)" }}>Cost per kg isn't needed now — add it later from the list below once the day's rate is settled.</p>
        {pError && <p className="text-sm mt-2" style={{ color: "var(--rust)" }}>{pError}</p>}
        <button onClick={addPurchaseBatch} className="fl-btn fl-btn-marigold w-full mt-3">+ Add purchase entry</button>
      </div>

      {Object.keys(purchaseGroups).length > 0 && (
        <div className="fl-card p-4">
          <h2 className="fl-display text-lg font-semibold mb-3">Today's purchases</h2>
          <div className="space-y-4">
            {Object.entries(purchaseGroups).map(([flower, g]) => (
              <div key={flower}>
                <div className="flex justify-between items-baseline mb-1.5">
                  <span className="font-semibold text-sm">{flower}</span>
                  <span className="fl-mono text-sm" style={{ color: "var(--marigold-dark)" }}>{g.subtotal > 0 ? rupee(g.subtotal) + " · " : ""}{kg(g.weight)}{g.pendingWeight > 0 ? ` (${kg(g.pendingWeight)} cost pending)` : ""}</span>
                </div>
                {g.entries.map((e) => (
                  <div key={e.id} className="py-1.5" style={{ borderBottom: "1px solid var(--paper-line)" }}>
                    <div className="flex items-center justify-between text-xs" style={{ color: "var(--ink-soft)" }}>
                      <span className="fl-mono">{kg(e.totalWeight)}{e.supplier ? ` · ${e.supplier}` : ""}{e.type ? ` · ${e.type}` : ""}{e.cost != null ? ` @ ${rupee(e.cost)}/kg` : ""}</span>
                      <div className="flex items-center gap-2">
                        {e.cost != null ? <span className="fl-mono">{rupee(e.total)}</span> : <button onClick={() => setEditingCost(editingCost === e.id ? null : e.id)} className="fl-btn fl-btn-outline fl-btn-sm" style={{ borderColor: "var(--marigold)", color: "var(--marigold-dark)" }}>Set cost</button>}
                        <button onClick={() => deletePurchase(e.id)} aria-label="Delete entry" style={{ color: "var(--rust)" }}>🗑</button>
                      </div>
                    </div>
                    {editingCost === e.id && <CostEditor entry={e} setBatchCost={(id, cost) => { setBatchCost(id, cost); setEditingCost(null); }} />}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="fl-double flex justify-between items-baseline pt-3 mt-3">
            <span className="fl-display font-semibold">Grand total</span>
            <span className="fl-mono text-xl font-semibold">{rupee(purchaseGrandTotal)}</span>
          </div>
          <div className="flex justify-between text-xs mt-1" style={{ color: "var(--ink-soft)" }}><span>Total weight bought</span><span className="fl-mono">{kg(purchaseGrandWeight)}</span></div>
          {purchasePendingWeight > 0 && <div className="flex justify-between text-xs mt-1" style={{ color: "var(--marigold-dark)" }}><span>Cost still pending</span><span className="fl-mono">{kg(purchasePendingWeight)}</span></div>}
        </div>
      )}
    </div>
  );
}

function SalesTab(props) {
  const { flowers, sFlower, setSFlower, sType, setSType, sWeight, setSWeight, sPrice, setSPrice, sWaste, setSWaste, sRemaining, setSRemaining, sValue, sError, addSaleEntry, saleGroups, saleGrandRevenue, saleGrandWaste, saleGrandRemaining, deleteSale, availableFor, purchasedTodayFor } = props;
  const [showAddFlower, setShowAddFlower] = useState(false);
  const [newFlowerName, setNewFlowerName] = useState("");
  const available = sFlower ? availableFor(sFlower) : null;

  return (
    <div className="space-y-5">
      <div className="fl-card p-4">
        <NamedSelect label="Flower" placeholder="Choose a flower" addLabel="+ Add new flower" addPlaceholder="New flower name" items={flowers} value={sFlower} onChange={setSFlower} showAdd={showAddFlower} setShowAdd={setShowAddFlower} newName={newFlowerName} setNewName={setNewFlowerName} confirmAdd={() => { if (newFlowerName.trim()) setSFlower(newFlowerName.trim()); setShowAddFlower(false); setNewFlowerName(""); }} accent="var(--rose)" />
        {sFlower && <p className="text-xs mt-2 fl-mono" style={{ color: available > 0 ? "var(--sage)" : "var(--rust)" }}>{kg(available)} available today (bought {kg(purchasedTodayFor(sFlower))})</p>}

        <div className="mt-3">
          <label className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--ink-soft)" }}>Variety / grade (optional)</label>
          <input value={sType} onChange={(e) => setSType(e.target.value)} placeholder="e.g. Premium, loose, bunch" className="fl-input mt-1" />
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div><label className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--ink-soft)" }}>Weight sold (kg)</label><input type="number" inputMode="decimal" step="0.1" value={sWeight} onChange={(e) => setSWeight(e.target.value)} placeholder="40" className="fl-input fl-input-rose mt-1" /></div>
          <div><label className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--ink-soft)" }}>Sale price / kg (₹)</label><input type="number" inputMode="decimal" step="0.1" value={sPrice} onChange={(e) => setSPrice(e.target.value)} placeholder="200" className="fl-input fl-input-rose mt-1" /></div>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div><label className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--rust)" }}>Waste / loss (kg)</label><input type="number" inputMode="decimal" step="0.1" value={sWaste} onChange={(e) => setSWaste(e.target.value)} placeholder="2" className="fl-input mt-1" /></div>
          <div><label className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--sage)" }}>Remaining (sell later)</label><input type="number" inputMode="decimal" step="0.1" value={sRemaining} onChange={(e) => setSRemaining(e.target.value)} placeholder="3" className="fl-input mt-1" /></div>
        </div>
        {sValue > 0 && <div className="mt-3 p-3 rounded-lg flex justify-between items-baseline" style={{ background: "var(--rose-bg)" }}><span className="fl-display font-semibold" style={{ color: "var(--rose-dark)" }}>Sale value</span><span className="fl-mono text-xl font-semibold" style={{ color: "var(--rose-dark)" }}>{rupee(sValue)}</span></div>}
        {sError && <p className="text-sm mt-2" style={{ color: "var(--rust)" }}>{sError}</p>}
        <button onClick={addSaleEntry} className="fl-btn fl-btn-rose w-full mt-4">+ Add sale entry</button>
      </div>

      {Object.keys(saleGroups).length > 0 && (
        <div className="fl-card p-4">
          <h2 className="fl-display text-lg font-semibold mb-3">Today's sales</h2>
          <div className="space-y-4">
            {Object.entries(saleGroups).map(([flower, g]) => (
              <div key={flower}>
                <div className="flex justify-between items-baseline mb-1.5"><span className="font-semibold text-sm">{flower}</span><span className="fl-mono text-sm" style={{ color: "var(--rose-dark)" }}>{rupee(g.subtotal)} · {kg(g.weight)}</span></div>
                {g.entries.map((e) => (
                  <div key={e.id} className="flex items-center justify-between text-xs py-1.5" style={{ borderBottom: "1px solid var(--paper-line)", color: "var(--ink-soft)" }}>
                    <span className="fl-mono">{kg(e.weight)} @ {rupee(e.price)}/kg{e.type ? ` · ${e.type}` : ""}{e.waste ? ` · waste ${kg(e.waste)}` : ""}{openRemainingOf(e) ? ` · rem ${kg(openRemainingOf(e))}` : ""}</span>
                    <div className="flex items-center gap-2"><span className="fl-mono">{rupee(e.value + resolvedValueOf(e))}</span><button onClick={() => deleteSale(e.id)} aria-label="Delete entry" style={{ color: "var(--rust)" }}>🗑</button></div>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="fl-double flex justify-between items-baseline pt-3 mt-3"><span className="fl-display font-semibold">Grand revenue</span><span className="fl-mono text-xl font-semibold">{rupee(saleGrandRevenue)}</span></div>
          <div className="flex justify-between text-xs mt-1" style={{ color: "var(--rust)" }}><span>Total waste</span><span className="fl-mono">{kg(saleGrandWaste)}</span></div>
          <div className="flex justify-between text-xs mt-1" style={{ color: "var(--sage)" }}><span>Still remaining</span><span className="fl-mono">{kg(saleGrandRemaining)}</span></div>
        </div>
      )}
    </div>
  );
}

function SummaryTab({ purchaseGrandTotal, purchaseGrandWeight, purchasePendingWeight, saleGrandRevenue, saleGrandWaste, saleGrandRemaining, profit, allFlowersToday, purchaseGroups, saleGroups }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <div className="fl-card p-3"><p className="text-xs uppercase tracking-wide" style={{ color: "var(--marigold-dark)" }}>Purchase total</p><p className="fl-mono text-xl font-semibold mt-1">{rupee(purchaseGrandTotal)}</p><p className="text-xs fl-mono" style={{ color: "var(--ink-soft)" }}>{kg(purchaseGrandWeight)}{purchasePendingWeight > 0 ? ` (${kg(purchasePendingWeight)} pending)` : ""}</p></div>
        <div className="fl-card p-3"><p className="text-xs uppercase tracking-wide" style={{ color: "var(--rose-dark)" }}>Sales revenue</p><p className="fl-mono text-xl font-semibold mt-1">{rupee(saleGrandRevenue)}</p></div>
        <div className="fl-card p-3"><p className="text-xs uppercase tracking-wide" style={{ color: profit >= 0 ? "var(--sage)" : "var(--rust)" }}>{profit >= 0 ? "Profit" : "Loss"}</p><p className="fl-mono text-xl font-semibold mt-1" style={{ color: profit >= 0 ? "var(--sage)" : "var(--rust)" }}>{rupee(Math.abs(profit))}</p></div>
        <div className="fl-card p-3"><p className="text-xs uppercase tracking-wide" style={{ color: "var(--rust)" }}>Waste</p><p className="fl-mono text-xl font-semibold mt-1">{kg(saleGrandWaste)}</p><p className="text-xs fl-mono" style={{ color: "var(--sage)" }}>{kg(saleGrandRemaining)} still remaining</p></div>
      </div>
      {allFlowersToday.length > 0 ? (
        <div className="fl-card p-4">
          <h2 className="fl-display text-lg font-semibold mb-3">Flower-wise</h2>
          <div className="space-y-3">
            {allFlowersToday.map((f) => {
              const p = purchaseGroups[f]; const s = saleGroups[f];
              return (
                <div key={f} className="py-2" style={{ borderBottom: "1px solid var(--paper-line)" }}>
                  <span className="font-semibold text-sm">{f}</span>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-1.5">
                    <div className="flex justify-between text-xs"><span style={{ color: "var(--marigold-dark)" }}>Bought</span><span className="fl-mono">{p ? `${p.subtotal > 0 ? rupee(p.subtotal) + " · " : ""}${kg(p.weight)}` : "—"}</span></div>
                    <div className="flex justify-between text-xs"><span style={{ color: "var(--rose-dark)" }}>Sold</span><span className="fl-mono">{s ? `${rupee(s.subtotal)} · ${kg(s.weight)}` : "—"}</span></div>
                    <div className="flex justify-between text-xs"><span style={{ color: "var(--rust)" }}>Waste</span><span className="fl-mono">{s && s.waste ? kg(s.waste) : "—"}</span></div>
                    <div className="flex justify-between text-xs"><span style={{ color: "var(--sage)" }}>Remaining</span><span className="fl-mono">{s && s.remaining ? kg(s.remaining) : "—"}</span></div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : <p className="text-sm text-center py-10" style={{ color: "var(--ink-soft)" }}>No entries for this day yet.</p>}
    </div>
  );
}

function StockRow({ record, resolveRemaining }) {
  const [open, setOpen] = useState(false);
  const [weight, setWeight] = useState(record.openWeight);
  const [price, setPrice] = useState("");
  const priceNum = parseFloat(price) || 0;
  const weightNum = parseFloat(weight) || 0;
  const value = weightNum * priceNum;
  const valid = weightNum > 0 && weightNum <= record.openWeight + 0.001 && priceNum > 0;
  return (
    <div className="fl-card p-3">
      <div className="flex items-center justify-between">
        <div><p className="font-semibold text-sm">{record.flower}{record.type ? ` · ${record.type}` : ""}</p><p className="text-xs fl-mono" style={{ color: "var(--ink-soft)" }}>from {fmtDate(record.date)} · {kg(record.openWeight)} open</p></div>
        <button onClick={() => setOpen(!open)} className="fl-btn fl-btn-sage fl-btn-sm">{open ? "Close" : "Sell this"}</button>
      </div>
      {open && (
        <div className="mt-3 pt-3" style={{ borderTop: "1px dashed var(--paper-line)" }}>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--ink-soft)" }}>Weight sold (kg)</label><input type="number" inputMode="decimal" step="0.1" value={weight} onChange={(e) => setWeight(e.target.value)} className="fl-input mt-1" /></div>
            <div><label className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--ink-soft)" }}>Sale price / kg (₹)</label><input type="number" inputMode="decimal" step="0.1" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="180" className="fl-input mt-1" /></div>
          </div>
          {value > 0 && <p className="fl-mono text-sm mt-2" style={{ color: "var(--sage)" }}>Value: {rupee(value)} — credited to {fmtDate(record.date)}</p>}
          <button onClick={() => { if (valid) { resolveRemaining(record, weightNum, priceNum); setOpen(false); } }} disabled={!valid} className="fl-btn fl-btn-sage w-full mt-3" style={{ opacity: valid ? 1 : 0.5 }}>Mark sold</button>
        </div>
      )}
    </div>
  );
}

function StockTab({ remainingIndex, resolveRemaining }) {
  const grouped = useMemo(() => [...remainingIndex].sort((a, b) => (a.date < b.date ? 1 : -1)), [remainingIndex]);
  const totalOpen = remainingIndex.reduce((s, r) => s + r.openWeight, 0);
  return (
    <div className="space-y-3">
      <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Flowers marked remaining that haven't been sold yet. Selling one here credits the value back to the day it was left over from, so every day's numbers stay accurate.</p>
      {totalOpen > 0 && <div className="fl-card p-3 flex justify-between items-baseline"><span className="fl-display font-semibold" style={{ color: "var(--sage)" }}>Total carried over</span><span className="fl-mono text-lg font-semibold" style={{ color: "var(--sage)" }}>{kg(totalOpen)}</span></div>}
      {grouped.length === 0 ? <p className="text-sm text-center py-10" style={{ color: "var(--ink-soft)" }}>Nothing carried over — everything's accounted for.</p> : <div className="space-y-2">{grouped.map((r) => <StockRow key={r.id} record={r} resolveRemaining={resolveRemaining} />)}</div>}
    </div>
  );
}

function AccountsTab({ db, suppliers, markPurchasesPaid }) {
  const [supplier, setSupplier] = useState("");
  const [from, setFrom] = useState(daysAgoISO(7));
  const [to, setTo] = useState(todayISO());
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");

  const rows = useMemo(() => {
    if (!supplier) return [];
    const out = [];
    Object.entries(db.days).forEach(([d, day]) => {
      if (d < from || d > to) return;
      (day.purchases || []).forEach((e) => { if (e.supplier === supplier && e.cost != null) out.push({ ...e, date: d }); });
    });
    return out.sort((a, b) => (a.date < b.date ? -1 : 1));
  }, [db, supplier, from, to]);

  const unpaid = rows.filter((r) => !r.paid);
  const paid = rows.filter((r) => r.paid);
  const unpaidTotal = unpaid.reduce((s, r) => s + r.total, 0);
  const paidTotal = paid.reduce((s, r) => s + r.total, 0);
  const totalWeight = rows.reduce((s, r) => s + r.totalWeight, 0);
  const history = (db.payments || []).filter((p) => p.supplier === supplier).sort((a, b) => (a.paidOn < b.paidOn ? 1 : -1));

  return (
    <div className="space-y-5">
      <div className="fl-card p-4">
        <NamedSelect label="Supplier" placeholder="Choose who to bill" addLabel="+ Add new person" addPlaceholder="New supplier name" items={suppliers} value={supplier} onChange={setSupplier} showAdd={showAdd} setShowAdd={setShowAdd} newName={newName} setNewName={setNewName} confirmAdd={() => { if (newName.trim()) setSupplier(newName.trim()); setShowAdd(false); setNewName(""); }} accent="var(--ink)" />
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div><label className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--ink-soft)" }}>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="fl-input mt-1" /></div>
          <div><label className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--ink-soft)" }}>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="fl-input mt-1" /></div>
        </div>
      </div>

      {supplier && (
        rows.length === 0 ? (
          <p className="text-sm text-center py-10" style={{ color: "var(--ink-soft)" }}>No priced purchases from {supplier} in this period.</p>
        ) : (
          <div className="fl-card p-4">
            <h2 className="fl-display text-lg font-semibold mb-1">Bill for {supplier}</h2>
            <p className="text-xs mb-3" style={{ color: "var(--ink-soft)" }}>{fmtDate(from)} – {fmtDate(to)} · {kg(totalWeight)} total</p>
            <div className="space-y-1.5">
              {rows.map((r) => (
                <div key={r.id} className="flex items-center justify-between text-xs py-1.5" style={{ borderBottom: "1px solid var(--paper-line)", color: r.paid ? "var(--ink-soft)" : "var(--ink)" }}>
                  <span className="fl-mono">{r.date.slice(5)} · {r.flower}{r.type ? ` (${r.type})` : ""} · {kg(r.totalWeight)} @ {rupee(r.cost)}/kg</span>
                  <span className="fl-mono">{r.paid ? "✓ " : ""}{rupee(r.total)}</span>
                </div>
              ))}
            </div>
            <div className="fl-double flex justify-between items-baseline pt-3 mt-3"><span className="fl-display font-semibold">Balance due</span><span className="fl-mono text-xl font-semibold" style={{ color: unpaidTotal > 0 ? "var(--rust)" : "var(--sage)" }}>{rupee(unpaidTotal)}</span></div>
            {paidTotal > 0 && <div className="flex justify-between text-xs mt-1" style={{ color: "var(--sage)" }}><span>Already paid this period</span><span className="fl-mono">{rupee(paidTotal)}</span></div>}
            {unpaid.length > 0 && <button onClick={() => markPurchasesPaid(unpaid, supplier, from, to, unpaidTotal)} className="fl-btn fl-btn-marigold w-full mt-4">Mark {rupee(unpaidTotal)} as paid</button>}
          </div>
        )
      )}

      {supplier && history.length > 0 && (
        <div className="fl-card p-4">
          <h2 className="fl-display text-lg font-semibold mb-3">Payment history — {supplier}</h2>
          <div className="space-y-2">
            {history.map((p) => (
              <div key={p.id} className="flex justify-between text-xs py-1.5" style={{ borderBottom: "1px solid var(--paper-line)", color: "var(--ink-soft)" }}>
                <span className="fl-mono">Paid {fmtDate(p.paidOn)} for {fmtDate(p.from)}–{fmtDate(p.to)}</span>
                <span className="fl-mono font-semibold" style={{ color: "var(--ink)" }}>{rupee(p.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ImportTab({ updateDb }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");

  function doImport() {
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { setStatus("error: that isn't valid JSON — paste the whole block exactly as given."); return; }
    let dayCount = 0, purchaseCount = 0, saleCount = 0;
    updateDb((d) => {
      (parsed.flowers || []).forEach((f) => { if (!d.flowers.some((x) => x.toLowerCase() === f.toLowerCase())) d.flowers.push(f); });
      (parsed.suppliers || []).forEach((s) => { if (!d.suppliers.some((x) => x.toLowerCase() === s.toLowerCase())) d.suppliers.push(s); });
      Object.entries(parsed.days || {}).forEach(([dt, val]) => {
        d.days[dt] = { purchases: val.purchases || [], sales: val.sales || [] };
        dayCount++; purchaseCount += (val.purchases || []).length; saleCount += (val.sales || []).length;
      });
      (parsed.remainingIndex || []).forEach((r) => { if (!d.remainingIndex.some((x) => x.id === r.id)) d.remainingIndex.push(r); });
    });
    setStatus(`done: imported ${dayCount} day(s) — ${purchaseCount} purchase entries, ${saleCount} sale entries.`);
    setText("");
  }

  return (
    <div className="space-y-4">
      <div className="fl-card p-4">
        <h2 className="fl-display text-lg font-semibold mb-2">Import a backup</h2>
        <p className="text-sm mb-3" style={{ color: "var(--ink-soft)" }}>
          Paste the JSON block given to you (from a backup file or a previous export). This adds any new flowers or suppliers,
          fills in the listed date(s) — replacing anything already there for those exact dates — and adds any carryover stock that isn't already tracked.
        </p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder='{"flowers": [...], "suppliers": [...], "days": {...}, "remainingIndex": [...]}' className="fl-input fl-mono" style={{ fontSize: 12 }} />
        <button onClick={doImport} disabled={!text.trim()} className="fl-btn fl-btn-marigold w-full mt-3" style={{ opacity: text.trim() ? 1 : 0.5 }}>Import</button>
        {status && <p className="text-sm mt-2" style={{ color: status.startsWith("error") ? "var(--rust)" : "var(--sage)" }}>{status}</p>}
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
