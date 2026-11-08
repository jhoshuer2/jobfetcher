/* Meet Radar — CV intake, voice/text interview (Claude + ElevenLabs), and the editable profile. */
(function(){
const {api, esc} = window.JR;
const $ = id => document.getElementById(id);
const blank = () => ({name:'', brief:'', messages:[], done:false, voice:true});
let S = blank();
const persist = () => JR.saveRadar(S);
const firstName = () => (S.name || (JR.me && JR.me.user.name) || '').split(' ')[0] || 'Hi';

function step(name){
  ['landing','intake','call','profile'].forEach(x => $('r-' + x).hidden = x !== name);
}
let loaded = false;
function show(){
  if(!JR.me) return;
  if(!loaded){ S = Object.assign(blank(), JR.me.radar || {}); loaded = true }
  $('intakeMsg').innerHTML = '';
  document.querySelectorAll('.hiName').forEach(el => el.textContent = firstName());
  if(JR.profile() && S.done) { renderProfile(JR.profile()); step('profile'); return }
  if(S.brief){ enterCall(false); return }
  const cv = JR.me.cv;
  $('cvName').textContent = cvFile ? cvFile.name : cv ? 'Using your saved CV: ' + cv.name : 'Choose a file';
  $('cvHint').textContent = cv ? 'Choose a file to replace it.' : 'Word file? Save it as PDF first.';
  step('intake');
}

/* ---------- intake ---------- */
let cvFile = null;
$('cv').addEventListener('change', e => {
  cvFile = e.target.files[0] || null;
  $('cvName').textContent = cvFile ? cvFile.name : 'Choose a file';
});
$('mode').value = S.voice === false ? 'text' : 'voice';
function err(el, m){ $(el).innerHTML = m ? `<p class="msg err">${esc(m)}</p>` : '' }

$('startBtn').addEventListener('click', async () => {
  err('intakeMsg', '');
  const notes = $('notes').value.trim();
  const saved = JR.me.cv;
  if(!cvFile && !saved && notes.length < 40) return err('intakeMsg', 'Add your CV or paste a bit about your work first.');
  if(cvFile && cvFile.size > 3e6) return err('intakeMsg', 'That file is over 3 MB. Try a smaller PDF.');
  S.voice = $('mode').value === 'voice';
  const btn = $('startBtn'); btn.disabled = true; btn.classList.add('loading');
  try{
    unlockAudio();
    if(cvFile){ await JR.saveCv(cvFile); cvFile = null }
    const r = await api('chat', {mode:'brief', notes, useStoredCv: !!JR.me.cv}, {timeout:90000});
    Object.assign(S, {name:r.name || firstName(), brief:r.brief || notes, messages:[], done:false}); persist();
    enterCall(true);
  }catch(e){ err('intakeMsg', e.message) }
  finally{ btn.disabled = false; btn.classList.remove('loading') }
});

/* ---------- call ---------- */
const tr = $('transcript');
function addLine(role, text){
  const p = document.createElement('p');
  p.className = 't' + (role === 'user' ? ' me' : '');
  p.innerHTML = `<span class="who">${role === 'user' ? esc(S.name || 'You') : 'Radar'}</span>${esc(text)}`;
  tr.appendChild(p); tr.scrollTop = tr.scrollHeight;
}
function redrawTranscript(){ tr.innerHTML = ''; S.messages.forEach(m => addLine(m.role, m.content)); }
function setStatus(t){ $('status').textContent = t }
function qCount(){ const n = S.messages.filter(m => m.role === 'assistant').length; $('qCount').textContent = n ? `Question ${n}` : '' }

function enterCall(fresh){
  document.querySelectorAll('.hiName').forEach(el => el.textContent = firstName());
  redrawTranscript(); qCount(); step('call'); startOrb();
  $('voiceNote').textContent = S.voice ? 'Voice on' : 'Typing mode';
  $('micBtn').hidden = !S.voice;
  if(fresh || !S.messages.length) think();
  else { setStatus(S.voice ? 'Tap the mic to continue' : 'Type to continue') }
}

let busy = false;
async function think(){
  if(busy) return; busy = true;
  setStatus('Thinking…'); phase = 'think';
  try{
    const r = await api('chat', {mode:'interview', brief:S.brief, name:S.name, messages:S.messages});
    S.messages.push({role:'assistant', content:r.reply}); persist();
    addLine('assistant', r.reply); qCount();
    busy = false;
    await speak(r.reply);
    if(r.done) return finish();
    if(S.voice) listen(); else { setStatus('Your turn, type below'); phase = 'idle'; $('typeBox').focus() }
  }catch(e){
    busy = false; phase = 'idle';
    setStatus('Something went wrong'); addLine('assistant', '⚠️ ' + e.message);
  }
}
function answer(text){
  text = String(text || '').trim(); if(!text) return;
  S.messages.push({role:'user', content:text}); persist();
  addLine('user', text); think();
}
$('sendBtn').addEventListener('click', () => { stopListening(false); stopSpeaking(); const v = $('typeBox').value; $('typeBox').value = ''; answer(v) });
$('typeBox').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); $('sendBtn').click() } });
$('micBtn').addEventListener('click', () => {
  if(rec) return stopListening(true);
  stopSpeaking(); if(!busy) listen();
});
$('endBtn').addEventListener('click', () => { stopListening(false); stopSpeaking(); finish() });
$('restartBtn').addEventListener('click', () => {
  if(!confirm('Start over? This clears the current conversation.')) return;
  stopListening(false); stopSpeaking(); S = Object.assign(blank(), {voice:S.voice}); persist(); show();
});

/* ---------- audio: shared context + level meter for the orb ---------- */
// Two meters: outMeter sits between Radar's voice and the speakers; micMeter has no output, so the mic is never played back.
let ctx = null, outMeter = null, micMeter = null, level = 0, phase = 'idle';
function unlockAudio(){
  try{
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if(ctx.state === 'suspended') ctx.resume();
    if(!outMeter){ outMeter = Object.assign(ctx.createAnalyser(), {fftSize:512}); outMeter.connect(ctx.destination) }
    if(!micMeter){ micMeter = Object.assign(ctx.createAnalyser(), {fftSize:512}); const mute = ctx.createGain(); mute.gain.value = 0; micMeter.connect(mute); mute.connect(ctx.destination) }
  }catch(e){}
}
const buf = new Uint8Array(512);
function readLevel(which){
  const a = (which || (phase === 'speak' ? 'out' : 'mic')) === 'out' ? outMeter : micMeter;
  if(!a) return 0;
  a.getByteTimeDomainData(buf);
  let sum = 0; for(let i = 0; i < buf.length; i++){ const v = (buf[i] - 128) / 128; sum += v*v }
  return Math.sqrt(sum / buf.length);
}

/* ---------- speaking (ElevenLabs, browser voice as fallback) ---------- */
let audioEl = null, speakResolve = null, fellBack = false;
function stopSpeaking(){
  if(audioEl){ audioEl.pause(); audioEl = null }
  try{ speechSynthesis.cancel() }catch(e){}
  if(speakResolve){ const r = speakResolve; speakResolve = null; r() }
}
async function speak(text){
  if(!S.voice) return;
  phase = 'speak'; setStatus('Speaking…'); unlockAudio();
  try{
    const r = await api('tts', {text}, {raw:true, timeout:40000});
    const url = URL.createObjectURL(await r.blob());
    await new Promise(res => {
      speakResolve = res;
      audioEl = new Audio(url);
      try{ if(ctx && outMeter) ctx.createMediaElementSource(audioEl).connect(outMeter) }catch(e){}
      audioEl.onended = audioEl.onerror = () => { URL.revokeObjectURL(url); if(speakResolve){ speakResolve = null; res() } };
      audioEl.play().catch(() => { if(speakResolve){ speakResolve = null; res() } });
    });
  }catch(e){
    if(!fellBack){ fellBack = true; $('voiceNote').textContent = 'Voice on' }
    await new Promise(res => {
      try{
        const u = new SpeechSynthesisUtterance(text); speakResolve = res;
        u.onend = u.onerror = () => { if(speakResolve){ speakResolve = null; res() } };
        speechSynthesis.speak(u);
      }catch(_){ res() }
    });
  }
  phase = 'idle';
}

/* ---------- listening (MediaRecorder → ElevenLabs Scribe) ---------- */
let stream = null, rec = null, chunks = [], micSrc = null, vadTimer = null, opening = false;
const pickMime = () => ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg'].find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
async function listen(){
  if(rec || busy || opening) return;
  if(!window.MediaRecorder || !navigator.mediaDevices){ setStatus('This browser can\'t record. Type instead'); return }
  opening = true; unlockAudio();
  try{
    if(stream && !stream.getAudioTracks().some(t => t.readyState === 'live')) stream = null;
    stream ||= await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true}});
    if(ctx && ctx.state === 'suspended') await ctx.resume().catch(() => {});
  }
  catch(e){ opening = false; setStatus('Microphone blocked: allow it, or type instead'); phase = 'idle'; return }
  opening = false;
  if(rec || busy) return;
  try{ micSrc && micSrc.disconnect() }catch(e){}
  try{ micSrc = ctx.createMediaStreamSource(stream); micSrc.connect(micMeter) }catch(e){ micSrc = null }
  const mime = pickMime();
  rec = new MediaRecorder(stream, mime ? {mimeType:mime} : undefined); chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.start(250);
  phase = 'listen'; setStatus('Listening… tap the mic when you\'re done'); $('micBtn').classList.add('on');
  // voice-activity detection that adapts to the mic: learn the room's noise level, then stop ~1.6s after you stop talking
  let heard = 0, quiet = 0, floor = null, peak = 0; const t0 = Date.now();
  vadTimer = setInterval(() => {
    const l = readLevel('mic'); peak = Math.max(peak, l);
    const secs = (Date.now() - t0) / 1000;
    if(secs < 0.4){ floor = floor === null ? l : Math.min(floor, l); return }
    const on = l > Math.max(0.012, (floor || 0) * 3);
    if(on){ heard += 100; quiet = 0; if(heard === 300) setStatus('Hearing you… tap the mic when you\'re done') } else quiet += 100;
    if(heard >= 400 && quiet >= 1600) stopListening(true);
    else if(!heard && secs > 20) stopListening(true, peak < 0.003 ? 'silent' : 'quiet');
    else if(secs > 120) stopListening(true);
  }, 100);
}
function stopListening(send, why){
  clearInterval(vadTimer); vadTimer = null;
  $('micBtn').classList.remove('on');
  try{ micSrc && micSrc.disconnect() }catch(e){}
  if(!rec) return;
  const r = rec; rec = null; phase = 'idle';
  r.onstop = async () => {
    if(!send){ return }
    const blob = new Blob(chunks, {type: r.mimeType || 'audio/webm'});
    const noMic = 'I can\'t hear your microphone. Check it isn\'t muted and the right mic is selected in your browser, or type instead.';
    if(blob.size < 2000){ setStatus(why === 'silent' ? noMic : 'Didn\'t catch that. Tap the mic and try again'); return }
    setStatus('Transcribing…'); phase = 'think';
    try{
      const b64 = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.onerror = no; fr.readAsDataURL(blob) });
      const {text} = await api('stt', {audio:b64, mime:blob.type});
      if(!text){ phase = 'idle'; setStatus(why === 'silent' ? noMic : 'Didn\'t catch that. Tap the mic and try again, or type instead.'); return }
      answer(text);
    }catch(e){ phase = 'idle'; setStatus('Couldn\'t transcribe: ' + e.message + '. You can type instead.') }
  };
  try{ r.stop() }catch(e){}
}

/* ---------- orb ---------- */
const orbsOn = {};
function startOrb(id = 'orb'){
  if(orbsOn[id]) return; orbsOn[id] = true;
  const c = $(id), g = c.getContext('2d'), W = c.width, H = c.height;
  const host = c.closest('section');
  const glow = getComputedStyle(document.documentElement).getPropertyValue('--glow').trim() || '#33E0BF';
  function frame(t){
    if(!host.hidden && !document.hidden){
      const target = id !== 'orb' ? 0.12 + 0.06*Math.sin(t/600) : (phase === 'speak' || phase === 'listen') ? Math.min(1, readLevel() * 6) : phase === 'think' ? 0.18 + 0.08*Math.sin(t/200) : 0.06;
      level += (target - level) * 0.15;
      g.clearRect(0, 0, W, H);
      const R = W * 0.27;
      for(let k = 0; k < 4; k++){
        g.beginPath();
        for(let a = 0; a <= Math.PI*2 + 0.01; a += Math.PI/90){
          const n = Math.sin(a*3 + t/700 + k) * 0.5 + Math.sin(a*5 - t/900 + k*2) * 0.35 + Math.sin(a*2 + t/1300) * 0.25;
          const r = R * (1 + (0.035 + level*0.16) * n) + k*3;
          const x = W/2 + Math.cos(a)*r, y = H/2 + Math.sin(a)*r;
          a === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
        }
        g.closePath();
        g.strokeStyle = glow; g.globalAlpha = 0.9 - k*0.2; g.lineWidth = 5 - k;
        g.shadowColor = glow; g.shadowBlur = 24 + level*30;
        g.stroke();
      }
      g.globalAlpha = 1; g.shadowBlur = 0;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/* ---------- profile ---------- */
async function finish(){
  stopListening(false);
  if(!S.messages.some(m => m.role === 'user')){ setStatus('Answer at least one question first'); return }
  setStatus('Building your profile…'); phase = 'think';
  $('endBtn').disabled = true;
  try{
    const {profile} = await api('chat', {mode:'profile', brief:S.brief, messages:S.messages}, {timeout:90000});
    if(!profile.name && S.name) profile.name = S.name;
    await JR.setProfile(profile);
    S.done = true; persist();
    renderProfile(profile); step('profile');
  }catch(e){ setStatus('Couldn\'t build the profile: ' + e.message) }
  finally{ $('endBtn').disabled = false; phase = 'idle' }
}
const FIELDS = [
  ['headline','Headline','text'], ['summary','Summary','area'],
  ['roles','Roles you fit','list'], ['skills','Skills','list'], ['tools','Tools','list'],
  ['seniority','Seniority','select:junior,mid,senior,lead'], ['years','Years of experience','number'],
  ['country','Country you live in','text'], ['portfolio','Portfolio / links','list'],
  ['workTypes','Open to','list'], ['minMonthlyUSD','Minimum pay (USD / month)','number'], ['hours','Hours & time zone','text'],
  ['strengths','Strengths (with proof)','list'], ['interests','Wants to work on','list'], ['dealbreakers','Dealbreakers','list'], ['keywords','Search keywords','list']
];
function renderProfile(p){
  $('profileMsg').innerHTML = '';
  const v = k => Array.isArray(p[k]) ? p[k].join(', ') : (p[k] ?? '');
  $('profileForm').innerHTML = `<div class="two">` + FIELDS.map(([k, label, type]) => {
    const wide = type === 'area' || ['strengths','summary'].includes(k);
    const style = wide ? ' style="grid-column:1/-1"' : '';
    let input;
    if(type === 'area') input = `<textarea name="${k}">${esc(v(k))}</textarea>`;
    else if(type.startsWith('select:')) input = `<select name="${k}">${type.slice(7).split(',').map(o => `<option${String(p[k]).toLowerCase() === o ? ' selected' : ''}>${o}</option>`).join('')}</select>`;
    else input = `<input name="${k}" type="${type === 'number' ? 'number' : 'text'}" value="${esc(v(k))}">`;
    return `<div class="field"${style}><label>${label}${type === 'list' ? ' <span class="hint">comma-separated</span>' : ''}</label>${input}</div>`;
  }).join('') + `</div>`;
}
function readProfile(){
  const f = $('profileForm'), p = Object.assign({}, JR.profile() || {});
  FIELDS.forEach(([k, , type]) => {
    const el = f.elements[k]; if(!el) return;
    if(type === 'list') p[k] = el.value.split(',').map(s => s.trim()).filter(Boolean);
    else if(type === 'number') p[k] = el.value === '' ? null : Number(el.value);
    else p[k] = el.value.trim();
  });
  return p;
}
$('saveProfile').addEventListener('click', async e => {
  e.preventDefault();
  const b = $('saveProfile'); b.disabled = true;
  try{
    const p = readProfile();
    if(!p.roles || !p.roles.length){ $('profileMsg').innerHTML = '<p class="msg err">Add at least one role so Radar knows what to search for.</p>'; return }
    await JR.setProfile(p); S.done = true; persist();
    location.hash = '#matches';
  }catch(err){ $('profileMsg').innerHTML = `<p class="msg err">${esc(err.message)}</p>` }
  finally{ b.disabled = false }
});
function redo(){
  if(!confirm('Redo the interview? Your current profile stays until the new one is built.')) return;
  S = Object.assign(blank(), {name:S.name, brief:S.brief, voice:S.voice}); persist();
  if(location.hash !== '#radar') location.hash = '#radar';
  unlockAudio(); enterCall(true);
}
$('redo').addEventListener('click', e => { e.preventDefault(); redo() });
function editProfile(){ S.done = true; if(JR.profile()){ renderProfile(JR.profile()); step('profile') } }
function landingOrb(){ startOrb('orbLanding') }

window.Radar = {show, redo, editProfile, landingOrb};
if(JR.route) JR.route();
})();
