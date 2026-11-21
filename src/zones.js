// Wi-Fi zone switch. A Power Saving Zone matches the Wi-Fi network name in `zone_id`; renaming it to a name no network
// has switches the zone off (the tracker uses GPS there too) and restoring the name switches it back on. The original
// name is stored before every write, and the marker lets a zone be restored even without that record.
export const OFF_MARKER = '~ot-off';
export const isOff = (zone) => typeof zone?.zone_id === 'string' && zone.zone_id.endsWith(OFF_MARKER);
export const ssidOf = (zone) => (isOff(zone) ? zone.zone_id.slice(0, -OFF_MARKER.length) : zone?.zone_id ?? null);

const KV = 'zoneSwitch';
const RETRY_S = 300;
export const LOCATE_MAX_S = 7200; // a locate gives up and switches the zones back on after 2 h without a GPS fix

export function createZoneSwitch({
  store, tractive, trackerId, zones, refresh, inWindow, settings, flags, currentZone = () => null, now = Date.now, log = () => {}, notify = () => {}, raise = () => {},
}) {
  const nowS = () => Math.floor(now() / 1000);
  const tid = () => (typeof trackerId === 'function' ? trackerId() : trackerId);
  const read = () => store.getKv(KV) ?? { zones: {} };
  const write = (v) => store.setKv(KV, v);
  const record = (id) => read().zones[id] ?? null;
  const setRecord = (id, r) => { const v = read(); if (r) v.zones[id] = r; else delete v.zones[id]; write(v); };
  let chain = Promise.resolve();
  // automatic mode: the window state last acted on, zones still to switch off in this window, zones the user took over
  let lastWindow = null, pendingOff = new Set(), manualInWindow = new Set(), failures = 0, retryAt = 0, ticking = false;

  function status() {
    const rec = read().zones;
    return (zones() ?? []).map((z) => {
      const r = rec[z._id] ?? {};
      return {
        id: z._id, name: z.name ?? null, off: isOff(z), offAt: isOff(z) ? r.offAt ?? null : null,
        confirmedAt: isOff(z) ? r.confirmedAt ?? null : null, confirmedAcc: isOff(z) ? r.confirmedAcc ?? null : null,
        auto: isOff(z) ? !!r.auto : false,
      };
    });
  }

  // Reads the zone fresh and writes the target name; on a version conflict the whole decision is made again from a
  // fresh read, so a Wi-Fi name changed elsewhere is never overwritten.
  async function apply(zoneId, on, actor, auto, locate) {
    for (let attempt = 1; ; attempt++) {
      const zone = await tractive.powerSavingZone(zoneId);
      const ssid = ssidOf(zone);
      if (!ssid) throw new Error('the zone has no Wi-Fi name');
      if (on === !isOff(zone)) return zone; // already in the wanted state
      if (!on) setRecord(zoneId, { ssid, offAt: nowS(), by: actor, auto, locate }); // stored before the write: never lost
      const target = on ? (record(zoneId)?.ssid ?? ssid) : ssid + OFF_MARKER;
      try {
        await tractive.updatePowerSavingZone({ ...zone, zone_id: target });
        return zone;
      } catch (e) {
        if (e?.status !== 409 || attempt >= 3) throw e;
      }
    }
  }

  async function doSwitch(zoneId, on, actor, { auto = false, locate = false } = {}) {
    // a user switch must name a known zone; an automatic restore works from its record and the fresh read alone
    if (!auto && !(zones() ?? []).some((z) => z._id === zoneId)) throw Object.assign(new Error('unknown zone'), { status: 404 });
    if (auto) { // an automatic switch never undoes what the user did
      if (!on && manualInWindow.has(zoneId)) return null;
      if (on && record(zoneId)?.auto !== true) return null;
    } else if (locate) { // a locate only switches back on the zones it switched off
      if (on && record(zoneId)?.locate !== true) return null;
    } else {
      if (lastWindow) { manualInWindow.add(zoneId); pendingOff.delete(zoneId); }
      dropFromLocate(zoneId); // the user takes the zone over from a running locate
    }
    const before = record(zoneId);
    const zone = await apply(zoneId, on, actor, auto, locate);
    if (on) setRecord(zoneId, null);
    else if (!auto && !locate && before && (before.auto || before.locate)) setRecord(zoneId, { ...record(zoneId), auto: false, locate: false, by: actor }); // the user takes it over
    store.logCommand({ t: nowS(), actor, action: `zone:${on ? 'on' : 'off'}`, params: { zone: zoneId, name: zone?.name ?? null }, ok: true, result: 'ok' });
    try { await refresh(); } catch (e) { log(`zones: refresh after switch failed (${e?.message ?? e})`); }
    notify();
    return status().find((z) => z.id === zoneId) ?? null;
  }

  // Switches run one at a time so two writes never race for the same _version.
  function switchZone(zoneId, on, actor, opts) {
    const p = chain.then(() => doSwitch(zoneId, on, actor, opts));
    chain = p.catch(() => {});
    return p;
  }

  // ---- locate: zones off until the first GPS fix, then back on ----
  const locateState = () => read().locate ?? null;
  function dropFromLocate(zoneId) {
    const v = read();
    if (!v.locate?.zones?.includes(zoneId)) return;
    v.locate.zones = v.locate.zones.filter((id) => id !== zoneId);
    if (v.zones[zoneId]) v.zones[zoneId].locate = false;
    write(v);
  }

  async function locate(actor) {
    const running = locateState();
    if (running) return running;
    const fl = flags();
    const ids = new Set(fl.filter((f) => f.coversYard && !f.off).map((f) => f.id));
    const cur = currentZone();
    if (cur && fl.some((f) => f.id === cur && !f.off)) ids.add(cur);
    if (!ids.size) throw Object.assign(new Error('There is no Wi-Fi zone to switch off: the tracker already uses GPS here.'), { status: 409 });
    const v = read();
    v.locate = { since: nowS(), until: nowS() + LOCATE_MAX_S, zones: [...ids], by: actor };
    write(v);
    for (const id of ids) {
      try { await switchZone(id, false, actor, { locate: true }); } catch (e) { log(`zones: locate could not switch off ${id} (${e?.message ?? e})`); dropFromLocate(id); }
    }
    if (!locateState()?.zones?.length) { finishRecord(); throw new Error('No Wi-Fi zone could be switched off.'); }
    notify();
    return locateState();
  }

  function finishRecord(result) {
    const v = read();
    const done = v.locate;
    v.locate = null;
    v.lastLocate = done ? { since: done.since, endedAt: nowS(), ...result } : v.lastLocate ?? null;
    write(v);
    return done;
  }

  // Ends a locate (first GPS fix, timeout or cancel) and switches its zones back on.
  async function endLocate(result) {
    const done = finishRecord(result);
    if (!done) return;
    for (const id of done.zones) {
      try { await switchZone(id, true, 'auto:locate', { locate: true }); } catch (e) { log(`zones: locate could not switch ${id} back on (${e?.message ?? e})`); }
    }
    if (result?.reason === 'timeout') raise('zone_failed', { title: 'Locate: no GPS fix within 2 h', body: 'The Wi-Fi zone is back on. The tracker probably did not move.' });
    notify();
  }
  const cancelLocate = () => endLocate({ reason: 'cancelled' });

  // The first real fix (not a Wi-Fi zone pin) after a zone went off proves the tracker applied the change.
  function onFix(row) {
    if (!row || row.tracker_id !== tid() || row.psz_id || row.sensor === 'KNOWN_WIFI') return;
    const all = read();
    let changed = false;
    for (const z of zones() ?? []) {
      const r = all.zones[z._id];
      if (!isOff(z) || !r || r.confirmedAt || row.t < r.offAt) continue;
      r.confirmedAt = row.t;
      r.confirmedAcc = row.acc ?? null;
      changed = true;
      raise('zone_confirmed', { title: `Wi-Fi zone ${z.name} is off: GPS confirmed`, body: `The tracker reported GPS (±${Math.round(row.acc ?? 0)} m) while the zone was off.` });
    }
    if (changed) { write(all); notify(); }
    const loc = locateState();
    if (loc && row.t >= loc.since) {
      raise('zone_confirmed', { title: 'Located: GPS fix received', body: `±${Math.round(row.acc ?? 0)} m. The Wi-Fi zone is switched back on.` });
      endLocate({ reason: 'fix', fixAt: row.t, acc: row.acc ?? null, lat: row.lat, lng: row.lng }).catch((e) => log(`zones: ${e?.message ?? e}`));
    }
  }

  // Automatic mode. In a Yard watch window (with the mode on) the zones covering the yard are switched off once at the
  // window start, retrying only the ones that failed; outside it every zone the app switched off automatically (by its
  // stored record, not the cached list) is switched back on, on every tick until none is left.
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const loc = locateState();
      if (loc && nowS() >= loc.until) await endLocate({ reason: 'timeout' });
      const s = settings();
      const wanted = !!(s.yardWatch?.enabled && s.yardWatch?.autoZones && inWindow());
      if (wanted && !(zones() ?? []).length) return; // zones not loaded yet: decide on a later tick
      if (wanted !== lastWindow) {
        manualInWindow = new Set();
        pendingOff = wanted ? new Set(flags().filter((f) => f.coversYard && !f.off).map((f) => f.id)) : new Set();
        lastWindow = wanted;
        failures = 0;
        retryAt = 0;
      }
      const targets = wanted ? [...pendingOff] : Object.entries(read().zones).filter(([, r]) => r.auto).map(([id]) => id);
      if (!targets.length || nowS() < retryAt) return;
      let failed = null;
      for (const id of targets) {
        try {
          await switchZone(id, !wanted, 'auto:yard-watch', { auto: true });
          pendingOff.delete(id);
        } catch (e) {
          if ([403, 404].includes(e?.status) && !wanted) setRecord(id, null); // the zone was deleted: nothing to restore
          else failed = e;
        }
      }
      if (!failed) { failures = 0; retryAt = 0; return; }
      failures++;
      retryAt = nowS() + RETRY_S;
      log(`zones: automatic switch failed (${failed?.message ?? failed})`);
      if (failures === 3) raise('zone_failed', { title: 'Wi-Fi zone switch failed', body: `3 attempts failed: ${failed?.message ?? failed}` });
    } finally {
      ticking = false;
    }
  }

  const locateStatus = () => ({ active: locateState(), last: read().lastLocate ?? null });
  return { status, switchZone, onFix, tick, locate, cancelLocate, locateStatus };
}
