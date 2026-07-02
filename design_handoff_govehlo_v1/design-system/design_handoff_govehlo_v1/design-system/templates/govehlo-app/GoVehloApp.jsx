// GoVehlo App Template
// Requires: GoVehlo Design System bundle loaded via ds-base.js

const { useState } = React;

// Access DS at render time — ensures bundle is loaded before use
function ds() { return window.GoVehloDesignSystem_c5fd4e || {}; }


/* ── Sample data ─────────────────────────────────────────────── */
const MEMBERS = ['Christian', 'Lars', 'Sara', 'Mikkel'];

const TRIPS = [
  { id:1, driver:'Christian', startOdo:45231, endOdo:45318, cost:22.50, date:'22 jun' },
  { id:2, driver:'Lars',      startOdo:45318, endOdo:45502, cost:47.00, date:'18 jun' },
  { id:3, driver:'Sara',      startOdo:45502, endOdo:45571, cost:17.60, date:'15 jun' },
  { id:4, driver:'Christian', startOdo:45571, endOdo:45660, cost:22.75, date:'12 jun' },
];

const FUEL = [
  { id:1, paidBy:'Christian', amountDkk:495.90, liters:34.2, station:'Circle K Roskilde', fullTank:true,  date:'22 jun' },
  { id:2, paidBy:'Lars',      amountDkk:409.00, liters:28.5, station:'Q8 København',       fullTank:false, date:'15 jun' },
  { id:3, paidBy:'Sara',      amountDkk:452.60, liters:31.0, station:'Shell Taastrup',      fullTank:true,  date:' 8 jun' },
];

const SETTLEMENTS = [
  { personName:'Lars',   amount:52.00,  direction:'owe',     status:'open' },
  { personName:'Sara',   amount:120.50, direction:'receive', status:'requested' },
  { personName:'Mikkel', amount:34.00,  direction:'settled', status:'paid' },
];

const TABS = [
  { id:'log',      label:'Log' },
  { id:'book',     label:'Book' },
  { id:'settle',   label:'Settle' },
  { id:'payments', label:'Payments', badge:1 },
  { id:'history',  label:'History' },
  { id:'insights', label:'Insights' },
];

/* ── Helpers ─────────────────────────────────────────────────── */
function SLabel({ children, top }) {
  return (
    <div style={{
      fontFamily:'var(--font-body)', fontSize:11, fontWeight:600,
      color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'.07em',
      padding: top ? '14px 16px 6px' : '0 0 6px',
    }}>
      {children}
    </div>
  );
}

function SubTabs({ options, active, onChange }) {
  return (
    <div style={{display:'flex', gap:8, padding:'12px 16px 4px'}}>
      {options.map(o => (
        <button key={o.id} onClick={() => onChange(o.id)} style={{
          padding:'6px 16px', borderRadius:9999, border:'none', cursor:'pointer',
          fontFamily:'var(--font-body)', fontSize:13, fontWeight:600, minHeight:44,
          background:active===o.id ? 'var(--color-forest)' : 'var(--color-mist)',
          color:active===o.id ? '#fff' : 'var(--color-forest)',
          transition:'background 140ms ease',
        }}>{o.label}</button>
      ))}
    </div>
  );
}

/* ── Home ────────────────────────────────────────────────────── */
function HomeScreen() {
  const { Avatar, TripCard, AmountDisplay } = ds();
  return (
    <div style={{flex:1, overflowY:'auto'}}>
      {/* Balance */}
      <div style={{margin:'16px 16px 0', background:'#fff', borderRadius:16, padding:16, boxShadow:'0 1px 3px rgba(26,46,31,.07),0 2px 8px rgba(26,46,31,.04)', display:'flex'}}>
        <div style={{flex:1, borderRight:'1px solid var(--border-color)', paddingRight:16}}>
          <div style={{fontFamily:'var(--font-body)', fontSize:11, fontWeight:500, color:'var(--text-muted)', marginBottom:4}}>You owe</div>
          <AmountDisplay amount={52.00} direction="owe" size="lg" />
          <div style={{fontFamily:'var(--font-body)', fontSize:12, color:'var(--text-secondary)', marginTop:4}}>to Lars</div>
        </div>
        <div style={{flex:1, paddingLeft:16}}>
          <div style={{fontFamily:'var(--font-body)', fontSize:11, fontWeight:500, color:'var(--text-muted)', marginBottom:4}}>Owed to you</div>
          <AmountDisplay amount={120.50} direction="receive" size="lg" />
          <div style={{fontFamily:'var(--font-body)', fontSize:12, color:'var(--text-secondary)', marginTop:4}}>from Sara</div>
        </div>
      </div>

      {/* Group */}
      <SLabel top>Your group</SLabel>
      <div style={{padding:'0 16px', display:'flex', gap:20}}>
        {MEMBERS.map((name, i) => (
          <div key={name} style={{display:'flex', flexDirection:'column', alignItems:'center', gap:5}}>
            <Avatar name={name} size="md" online={i < 3} />
            <span style={{fontFamily:'var(--font-body)', fontSize:11, color:'var(--text-secondary)', fontWeight:500}}>{name}</span>
          </div>
        ))}
      </div>

      {/* Recent trips */}
      <SLabel top>Recent trips</SLabel>
      <div style={{padding:'0 16px 16px', display:'flex', flexDirection:'column', gap:8}}>
        {TRIPS.slice(0,3).map(t => (
          <TripCard key={t.id} driver={t.driver} startOdo={t.startOdo} endOdo={t.endOdo} cost={t.cost} date={t.date} onClick={() => {}} />
        ))}
      </div>
    </div>
  );
}

/* ── Log ─────────────────────────────────────────────────────── */
function LogScreen({ onToast }) {
  const { Button, Input, Select, Checkbox, ParticipantSelector, FuelCard } = ds();
  const [view, setView] = useState('trip');
  const [split, setSplit] = useState(['Christian']);
  const [fullTank, setFullTank] = useState(false);

  // Null-guard until bundle regenerates
  const SafeSelect   = Select   || Input;
  const SafeCheckbox = Checkbox || null;

  return (
    <div style={{flex:1, overflowY:'auto'}}>
      <SubTabs
        options={[{ id:'trip', label:'Trip' }, { id:'fuel', label:'Fuel' }]}
        active={view}
        onChange={setView}
      />

      {view === 'trip' && (
        <div style={{padding:'12px 16px 24px', display:'flex', flexDirection:'column', gap:12}}>
          <SLabel>Log distance</SLabel>
          <Input label="Driver" value="Christian" disabled />
          <Input label="Date" type="date" value="2026-06-24" onChange={() => {}} />
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12}}>
            <Input label="Start odometer" type="number" placeholder="45 318" suffix="km" />
            <Input label="End odometer"   type="number" placeholder="45 402" suffix="km" />
          </div>
          <Input label="Note" placeholder="Optional" />
          <div>
            <div style={{fontFamily:'var(--font-body)', fontSize:13, fontWeight:500, color:'var(--text-secondary)', marginBottom:8}}>Split between</div>
            <ParticipantSelector
              participants={MEMBERS.map(m => ({ id:m, name:m }))}
              selected={split}
              onChange={setSplit}
            />
          </div>
          <Button variant="primary" fullWidth onClick={() => onToast('Trip logged.')}>Add trip</Button>
        </div>
      )}

      {view === 'fuel' && (
        <div style={{padding:'12px 16px 24px', display:'flex', flexDirection:'column', gap:12}}>
          <SLabel>Log fuel payment</SLabel>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12}}>
            <Input label="Paid by" value="Christian" disabled />
            <Input label="Date" type="date" value="2026-06-24" onChange={() => {}} />
            <Input label="Amount paid" type="number" placeholder="0,00" suffix="kr" />
            <Input label="Liters added" type="number" placeholder="Required" suffix="L" />
          </div>
          <Input label="Station / place" placeholder="Type or pick nearby" />
          {SafeCheckbox && React.createElement(SafeCheckbox, { label:'Filled to full tank', checked:fullTank, onChange:e => setFullTank(e.target.checked), hint:'Enables real-world L/100 km statistics between full-tank fills.' })}
          <Button variant="primary" fullWidth onClick={() => onToast('Fuel logged.')}>Add fuel</Button>
          <SLabel top>Recent fuel logs</SLabel>
          <div style={{display:'flex', flexDirection:'column', gap:8}}>
            {FUEL.map(f => <FuelCard key={f.id} {...f} />)}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Book ────────────────────────────────────────────────────── */
function BookScreen({ onToast }) {
  const { Button, Input, ParticipantSelector } = ds();
  const [dist, setDist] = useState('');
  const [people, setPeople] = useState(['Christian']);
  const est = dist && people.length > 0 ? ((parseFloat(dist) * 2.47) / people.length).toFixed(2).replace('.', ',') : null;

  return (
    <div style={{flex:1, overflowY:'auto', padding:'12px 16px 24px', display:'flex', flexDirection:'column', gap:12}}>
      <SLabel>Estimate trip cost</SLabel>
      <Input label="Planned distance" type="number" placeholder="e.g. 350" suffix="km" value={dist} onChange={e => setDist(e.target.value)} />
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12}}>
        <Input label="From" placeholder="Roskilde" />
        <Input label="To"   placeholder="Aarhus" />
      </div>
      <div>
        <div style={{fontFamily:'var(--font-body)', fontSize:13, fontWeight:500, color:'var(--text-secondary)', marginBottom:8}}>People joining</div>
        <ParticipantSelector
          participants={MEMBERS.map(m => ({ id:m, name:m }))}
          selected={people}
          onChange={setPeople}
        />
      </div>
      {est && (
        <div style={{padding:16, background:'var(--color-mist)', borderRadius:16}}>
          <div style={{fontFamily:'var(--font-body)', fontSize:12, color:'var(--text-muted)'}}>Estimated cost per person</div>
          <div style={{fontFamily:'var(--font-display)', fontWeight:900, fontSize:32, color:'var(--color-amber)', letterSpacing:'-0.02em', marginTop:4, lineHeight:1}}>{est} kr</div>
          <div style={{fontFamily:'var(--font-body)', fontSize:12, color:'var(--text-muted)', marginTop:6}}>
            {dist} km × 2,47 kr/km ÷ {people.length} {people.length === 1 ? 'person' : 'people'}
          </div>
        </div>
      )}
      <Button variant="secondary" fullWidth onClick={() => onToast('Booking added.')}>Add booking</Button>
    </div>
  );
}

/* ── Settle ──────────────────────────────────────────────────── */
function SettleScreen({ onToast }) {
  const { SummaryBand, SettlementCard, StatusChip, Button } = ds();
  return (
    <div style={{flex:1, overflowY:'auto', padding:'12px 16px 24px', display:'flex', flexDirection:'column', gap:12}}>
      <SummaryBand items={[
        { label:'Fuel rate',   value:'2,47 kr/km' },
        { label:'Trip shares', value:'1.357 kr' },
        { label:'Fuel paid',   value:'1.358 kr' },
      ]} />
      <SLabel top>Who pays whom</SLabel>
      <div style={{display:'flex', flexDirection:'column', gap:8}}>
        {SETTLEMENTS.map((s, i) => (
          <div key={i} style={{display:'flex', flexDirection:'column', gap:6}}>
            <SettlementCard
              personName={s.personName}
              amount={s.amount}
              direction={s.direction}
              onAction={() => onToast(
                s.direction === 'owe'
                  ? `Payment requested from ${s.personName}.`
                  : `Marked paid by ${s.personName}.`
              )}
            />
            <div style={{display:'flex', justifyContent:'flex-end', paddingRight:4}}>
              <StatusChip status={s.status} />
            </div>
          </div>
        ))}
      </div>
      <Button variant="outline" fullWidth onClick={() => onToast('Period closed.')}>Close period</Button>
    </div>
  );
}

/* ── Payments ────────────────────────────────────────────────── */
function PaymentsScreen({ onToast }) {
  const { Button, StatusChip, Avatar } = ds();
  const unpaid = [{ person:'Lars', amount:52.00, requested:'19 jun', period:'Jun 2026' }];
  return (
    <div style={{flex:1, overflowY:'auto', padding:'12px 16px 24px'}}>
      <SLabel>Unpaid payments</SLabel>
      <p style={{fontFamily:'var(--font-body)', fontSize:13, color:'var(--text-muted)', margin:'0 0 12px', lineHeight:1.45}}>
        Requested payments not yet marked paid, from current and closed settlements.
      </p>
      {unpaid.map((p, i) => (
        <div key={i} style={{background:'#fff', borderRadius:16, padding:14, boxShadow:'0 1px 3px rgba(26,46,31,.07)', display:'flex', flexDirection:'column', gap:12}}>
          <div style={{display:'flex', alignItems:'center', gap:10}}>
            <Avatar name={p.person} size="md" />
            <div style={{flex:1}}>
              <div style={{fontFamily:'var(--font-display)', fontWeight:700, fontSize:15, color:'var(--text-primary)'}}>You owe {p.person}</div>
              <div style={{fontFamily:'var(--font-body)', fontSize:11, color:'var(--text-muted)', marginTop:2}}>{p.period} · Requested {p.requested}</div>
            </div>
            <div style={{fontFamily:'var(--font-display)', fontWeight:900, fontSize:22, color:'var(--color-amber)', letterSpacing:'-0.02em'}}>{p.amount.toFixed(2).replace('.',',')} kr</div>
          </div>
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
            <StatusChip status="requested" />
            <Button variant="amber" size="sm" onClick={() => onToast(`Marked paid to ${p.person}.`)}>Mark paid</Button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── History ─────────────────────────────────────────────────── */
function HistoryScreen() {
  const { TripCard, FuelCard } = ds();
  const [section, setSection] = useState('trips');
  return (
    <div style={{flex:1, overflowY:'auto'}}>
      <SubTabs
        options={[
          { id:'trips',   label:'Trips' },
          { id:'fuel',    label:'Fuel' },
          { id:'archive', label:'Closed' },
        ]}
        active={section}
        onChange={setSection}
      />
      {section === 'trips' && (
        <div style={{padding:'8px 16px 24px', display:'flex', flexDirection:'column', gap:8}}>
          {TRIPS.map(t => <TripCard key={t.id} driver={t.driver} startOdo={t.startOdo} endOdo={t.endOdo} cost={t.cost} date={t.date} onClick={() => {}} />)}
        </div>
      )}
      {section === 'fuel' && (
        <div style={{padding:'8px 16px 24px', display:'flex', flexDirection:'column', gap:8}}>
          {FUEL.map(f => <FuelCard key={f.id} {...f} />)}
        </div>
      )}
      {section === 'archive' && (
        <div style={{padding:'8px 16px 24px', display:'flex', flexDirection:'column', gap:10}}>
          {[{month:'Jun 2026',trips:4,dist:'517 km',total:'1.357 kr',status:'paid'},{month:'May 2026',trips:3,dist:'487 km',total:'891 kr',status:'paid'}].map(p => (
            <div key={p.month} style={{background:'#fff', borderRadius:16, padding:14, boxShadow:'0 1px 3px rgba(26,46,31,.07)'}}>
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10}}>
                <div>
                  <div style={{fontFamily:'var(--font-display)', fontWeight:700, fontSize:15, color:'var(--text-primary)'}}>{p.month}</div>
                  <div style={{fontFamily:'var(--font-body)', fontSize:12, color:'var(--text-muted)', marginTop:2}}>{p.trips} trips · {p.dist}</div>
                </div>
                <div style={{fontFamily:'var(--font-display)', fontWeight:800, fontSize:18, color:'var(--color-amber)'}}>{p.total}</div>
              </div>
              <div style={{display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8}}>
                {[['Trips',p.trips],['Distance',p.dist],['Fuel','895 kr'],['Rate','2,47 kr/km']].map(([l,v]) => (
                  <div key={l} style={{border:'1px solid var(--border-color)', borderRadius:10, padding:'8px 10px', background:'#fbfcfb'}}>
                    <div style={{fontFamily:'var(--font-body)', fontSize:9, fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'.04em', marginBottom:2}}>{l}</div>
                    <div style={{fontFamily:'var(--font-display)', fontWeight:800, fontSize:13, color:'var(--text-primary)'}}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Insights ────────────────────────────────────────────────── */
function InsightsScreen() {
  const { SummaryBand } = ds();
  const intel = [
    { label:'DKK/km', value:'2,47 kr' },
    { label:'DKK/L',  value:'14,50 kr' },
    { label:'L/100 km', value:'5,3 L' },
    { label:'Confidence', value:'High' },
  ];
  const stations = [
    { name:'Circle K Roskilde', rate:'14,50 kr/L', count:3, best:true },
    { name:'Q8 København',      rate:'14,63 kr/L', count:2, best:false },
    { name:'Shell Taastrup',    rate:'14,60 kr/L', count:2, best:false },
  ];
  return (
    <div style={{flex:1, overflowY:'auto', padding:'12px 16px 24px', display:'flex', flexDirection:'column', gap:12}}>
      <SLabel>Fuel intelligence</SLabel>
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10}}>
        {intel.map(s => (
          <div key={s.label} style={{border:'1px solid var(--border-color)', borderRadius:16, background:'#fff', padding:'12px 14px', boxShadow:'0 1px 3px rgba(26,46,31,.07)'}}>
            <div style={{fontFamily:'var(--font-body)', fontSize:10, fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6}}>{s.label}</div>
            <div style={{fontFamily:'var(--font-display)', fontWeight:900, fontSize:22, color:'var(--text-primary)', letterSpacing:'-0.02em', lineHeight:1}}>{s.value}</div>
          </div>
        ))}
      </div>
      <SLabel top>Monthly summary — June 2026</SLabel>
      <SummaryBand items={[
        { label:'Distance',   value:'517 km' },
        { label:'Your share', value:'214 kr' },
        { label:'Trips',      value:'4' },
      ]} />
      <SLabel top>Station insights</SLabel>
      <div style={{display:'flex', flexDirection:'column', gap:8}}>
        {stations.map(s => (
          <div key={s.name} style={{background:'#fff', borderRadius:16, padding:'12px 14px', boxShadow:'0 1px 3px rgba(26,46,31,.07)', display:'flex', justifyContent:'space-between', alignItems:'center'}}>
            <div>
              <div style={{fontFamily:'var(--font-display)', fontWeight:700, fontSize:14, color:'var(--text-primary)'}}>{s.name}</div>
              <div style={{fontFamily:'var(--font-mono)', fontSize:12, color:'var(--text-muted)', letterSpacing:'.04em', marginTop:2}}>{s.rate} · {s.count} receipts</div>
            </div>
            {s.best && (
              <span style={{background:'var(--color-success-light)', color:'#1A7A47', borderRadius:9999, padding:'3px 10px', fontSize:11, fontWeight:600, fontFamily:'var(--font-body)'}}>Best price</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── App shell ───────────────────────────────────────────────── */
function App() {
  const { AppHeader, Odometer, TabNav } = ds();
  const [tab, setTab]     = useState('log');
  const [toast, setToast] = useState(null);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  return (
    <div style={{
      position:'relative',
      width:'100%', height:'100%',
      background:'var(--color-warm-white)',
      display:'flex', flexDirection:'column',
      fontFamily:'var(--font-body)',
      overflow:'hidden',
    }}>
      {/* Header */}
      <div style={{flexShrink:0}}>
        <AppHeader
          greeting="Good morning, Christian."
          subtitle="Database · Saved 14:05"
          actions={React.createElement(Odometer, { value:1679, unit:'km' })}
          compact={false}
        />
      </div>

      {/* Tab nav */}
      <div style={{flexShrink:0, padding:'0 16px', background:'var(--color-warm-white)'}}>
        <TabNav items={TABS} active={tab} onSelect={setTab} />
      </div>

      {/* Screen */}
      <div style={{flex:1, minHeight:0, display:'flex', flexDirection:'column', overflowY:'auto'}}>
        {tab === 'log'      && React.createElement(LogScreen,      { onToast: showToast })}
        {tab === 'book'     && React.createElement(BookScreen,     { onToast: showToast })}
        {tab === 'settle'   && React.createElement(SettleScreen,   { onToast: showToast })}
        {tab === 'payments' && React.createElement(PaymentsScreen, { onToast: showToast })}
        {tab === 'history'  && React.createElement(HistoryScreen,  null)}
        {tab === 'insights' && React.createElement(InsightsScreen, null)}
      </div>

      {/* Toast */}
      {toast && (
        <div style={{
          position:'absolute', bottom:16, left:12, right:12, zIndex:200,
          background:'var(--color-deep-forest)', color:'#fff',
          borderRadius:12, padding:'12px 16px',
          display:'flex', alignItems:'center', gap:10,
          boxShadow:'var(--shadow-elevated)',
          fontFamily:'var(--font-body)', fontSize:14, fontWeight:500,
          animation:'slideUp .22s ease',
        }}>
          <span style={{width:20,height:20,borderRadius:'50%',background:'rgba(255,255,255,.18)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:700,flexShrink:0}}>✓</span>
          <span style={{flex:1}}>{toast}</span>
          <button onClick={() => setToast(null)} style={{background:'none',border:'none',color:'rgba(255,255,255,.6)',cursor:'pointer',fontSize:18,lineHeight:1,padding:0}}>×</button>
        </div>
      )}
    </div>
  );
}

window.GoVehloApp = App;
