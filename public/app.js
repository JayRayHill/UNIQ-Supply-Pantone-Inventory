/**
 * app.js — all client-side logic for the Ink Inventory app.
 * Written to be readable if you're strong in HTML/CSS and still learning JS:
 *   - ONE `state` object is the single source of truth for the UI.
 *   - Any time state changes, render() rebuilds the visible cards.
 *   - The server is a small same-origin API (see /functions/api):
 *       GET  /api/inventory  -> { inks, families, generatedAt }
 *       POST /api/inks       -> add    -> { ok, message, inventory }
 *       PUT  /api/inks       -> update -> { ok, message, inventory }
 */
(function () {
  'use strict';

  /* =========================================================================
   * 1) STATE — everything the UI needs to know, in one place.
   * ====================================================================== */
  var state = {
    inks: [],                    // full list from the server
    familyCounts: {},            // { BLUE: 70, ... } in-stock counts from the server
    selectedFamilies: new Set(), // active color chips (empty = show all)
    search: '',                  // text in the search box
    sort: 'rainbow',             // 'rainbow' | 'pantone' | 'weight'
    showUsedUp: false,           // include "Used Up" inks?
    showUnmatched: false,        // include inks with no swatch preview?
    selectMode: false,           // card taps select instead of opening the editor
    selected: new Set(),         // ids of selected inks (select mode)
    matchTarget: null,           // { hex, lab } when the closest-match helper is on
    loading: true
  };

  // Chip + dropdown order: rainbow first, then neutrals, brown last.
  var FAMILIES = ['RED','ORANGE','YELLOW','GREEN','BLUE','PURPLE','WHITE','BLACK','GREY','BROWN'];

  // Small representative color for each family chip's dot (not a real Pantone).
  var FAMILY_DOT = {
    RED:'#e10600', ORANGE:'#ff6a00', YELLOW:'#ffd400', GREEN:'#12a150', BLUE:'#1668e3',
    PURPLE:'#7a2ff2', WHITE:'#f2f2f2', BLACK:'#222327', GREY:'#8a8f98', BROWN:'#7a4a1e'
  };

  /* =========================================================================
   * 2) SERVER CALLS — one tiny helper wraps fetch + JSON + error handling.
   * ====================================================================== */
  async function api(method, path, body) {
    var resp = await fetch(path, {
      method: method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    var data = await resp.json().catch(function () { return {}; });
    if (!resp.ok) throw new Error(data.error || ('Request failed (' + resp.status + ')'));
    return data;
  }

  /* =========================================================================
   * 3) PANTONE -> HEX matching (uses window.PANTONE_COATED from pantone-data.js)
   *    All our inks are coated, so everything matches the solid coated book.
   * ====================================================================== */
  function pantoneHex(rawCode) {
    var MAP = window.PANTONE_COATED || {};
    if (rawCode == null || rawCode === '') return null;
    var s = String(rawCode).toLowerCase().trim();
    // The color book spells it "gray"; our data says "grey" — normalize.
    s = s.replace(/grey/g, 'gray');

    // Build a few candidate keys and take the first that exists in the map.
    var candidates = [];
    // (a) fully normalized: spaces -> hyphens, strip anything but a-z0-9-
    candidates.push(s.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''));
    // (b) drop a trailing finish letter (u/c/m): "186u" -> "186", "warm red c" -> "warm-red"
    candidates.push(s.replace(/[\s-]*[ucm]$/, '').trim().replace(/\s+/g, '-'));
    // (c) leading digits only, so "165 U" falls back to base number "165"
    var lead = s.match(/^\d{1,4}/);
    if (lead) candidates.push(lead[0]);

    for (var i = 0; i < candidates.length; i++) {
      var key = candidates[i];
      if (key && MAP[key]) return MAP[key];
    }
    return null; // e.g. CMYK-guide codes like "P-115-5" -> honest "no preview" swatch
  }

  /* =========================================================================
   * 4) COLOR MATH for the closest-match helper (hex -> Lab, CIEDE2000).
   *    CIEDE2000 is the industry-standard perceptual color-difference formula.
   * ====================================================================== */
  function hexToRgb(hex) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    if (h.length !== 6) return null;
    var n = parseInt(h, 16);
    if (isNaN(n)) return null;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  // sRGB -> CIE L*a*b* (D65). Standard conversion.
  function rgbToLab(rgb) {
    var srgb = [rgb.r, rgb.g, rgb.b].map(function (v) {
      v = v / 255;
      return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
    });
    var x = (srgb[0]*0.4124 + srgb[1]*0.3576 + srgb[2]*0.1805) / 0.95047;
    var y = (srgb[0]*0.2126 + srgb[1]*0.7152 + srgb[2]*0.0722) / 1.00000;
    var z = (srgb[0]*0.0193 + srgb[1]*0.1192 + srgb[2]*0.9505) / 1.08883;
    var f = function (t) { return t > 0.008856 ? Math.pow(t, 1/3) : (7.787 * t) + 16/116; };
    x = f(x); y = f(y); z = f(z);
    return { L: (116 * y) - 16, a: 500 * (x - y), b: 200 * (y - z) };
  }

  // CIEDE2000 delta-E between two Lab colors. Lower = more similar.
  function deltaE00(l1, l2) {
    var rad = Math.PI / 180, deg = 180 / Math.PI;
    var avgL = (l1.L + l2.L) / 2;
    var c1 = Math.sqrt(l1.a*l1.a + l1.b*l1.b);
    var c2 = Math.sqrt(l2.a*l2.a + l2.b*l2.b);
    var avgC = (c1 + c2) / 2;
    var g = 0.5 * (1 - Math.sqrt(Math.pow(avgC, 7) / (Math.pow(avgC, 7) + Math.pow(25, 7))));
    var a1p = l1.a * (1 + g), a2p = l2.a * (1 + g);
    var c1p = Math.sqrt(a1p*a1p + l1.b*l1.b), c2p = Math.sqrt(a2p*a2p + l2.b*l2.b);
    var avgCp = (c1p + c2p) / 2;
    var h1p = Math.atan2(l1.b, a1p) * deg; if (h1p < 0) h1p += 360;
    var h2p = Math.atan2(l2.b, a2p) * deg; if (h2p < 0) h2p += 360;
    var avgHp = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + 360) / 2 : (h1p + h2p) / 2;
    var t = 1 - 0.17*Math.cos((avgHp-30)*rad) + 0.24*Math.cos((2*avgHp)*rad)
              + 0.32*Math.cos((3*avgHp+6)*rad) - 0.20*Math.cos((4*avgHp-63)*rad);
    var dhp = h2p - h1p;
    if (Math.abs(dhp) > 180) dhp += (h2p <= h1p) ? 360 : -360;
    var dLp = l2.L - l1.L;
    var dCp = c2p - c1p;
    var dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp * rad) / 2);
    var sL = 1 + (0.015 * Math.pow(avgL - 50, 2)) / Math.sqrt(20 + Math.pow(avgL - 50, 2));
    var sC = 1 + 0.045 * avgCp;
    var sH = 1 + 0.015 * avgCp * t;
    var dTheta = 30 * Math.exp(-Math.pow((avgHp - 275) / 25, 2));
    var rc = 2 * Math.sqrt(Math.pow(avgCp, 7) / (Math.pow(avgCp, 7) + Math.pow(25, 7)));
    var rt = -rc * Math.sin(2 * dTheta * rad);
    return Math.sqrt(
      Math.pow(dLp / sL, 2) + Math.pow(dCp / sC, 2) + Math.pow(dHp / sH, 2)
      + rt * (dCp / sC) * (dHp / sH)
    );
  }

  // hex -> { h: 0..360 hue, s: 0..1 saturation, l: 0..1 lightness } for rainbow sort.
  function hexToHsl(hex) {
    var rgb = hexToRgb(hex);
    if (!rgb) return null;
    var r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2;
    var d = max - min;
    if (d === 0) return { h: 0, s: 0, l: l }; // pure grey — no hue
    var s = d / (1 - Math.abs(2 * l - 1));
    var h;
    if (max === r)      h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * (((b - r) / d) + 2);
    else                h = 60 * (((r - g) / d) + 4);
    if (h < 0) h += 360;
    return { h: h, s: s, l: l };
  }

  // Rainbow comparator: chromatic inks sweep red -> orange -> yellow -> green ->
  // blue -> violet -> pink; near-neutral inks (whites/greys/blacks/browns with
  // almost no saturation) group at the end, light to dark. Within a similar hue,
  // lighter inks come first so each band fades naturally.
  function byRainbow(a, b) {
    var ha = a._hsl, hb = b._hsl;
    var aN = !ha || ha.s < 0.14, bN = !hb || hb.s < 0.14; // N = neutral
    if (aN && bN) return (hb ? hb.l : 0) - (ha ? ha.l : 0); // neutrals: light -> dark
    if (aN) return 1;  // neutrals after colors
    if (bN) return -1;
    // Bucket hue into 12° bands so the order reads as clean color stripes,
    // then light -> dark inside each band.
    var bandA = Math.floor(ha.h / 12), bandB = Math.floor(hb.h / 12);
    if (bandA !== bandB) return bandA - bandB;
    return hb.l - ha.l;
  }

  /* =========================================================================
   * 5) DOM SHORTCUTS
   * ====================================================================== */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function esc(s) { // escape text before inserting as HTML
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  /* =========================================================================
   * 6) LOADING DATA
   * ====================================================================== */
  function loadInventory() {
    state.loading = true;
    $('state').textContent = 'Loading inventory…';
    $('state').className = 'state';
    $('state').hidden = false;

    api('GET', '/api/inventory')
      .then(applyInventory)
      .catch(function (err) {
        state.loading = false;
        $('state').textContent = 'Could not load inventory: ' + err.message;
        $('state').className = 'state error';
      });
  }

  // Store a server response (from load OR after a write) and re-render.
  function applyInventory(data) {
    state.loading = false;
    state.inks = (data && data.inks) || [];
    state.familyCounts = (data && data.families) || {};
    // Attach computed hex + Lab + HSL to each ink once, so render() stays cheap.
    state.inks.forEach(function (ink) {
      ink._hex = pantoneHex(ink.pantone);
      ink._lab = ink._hex ? rgbToLab(hexToRgb(ink._hex)) : null;
      ink._hsl = ink._hex ? hexToHsl(ink._hex) : null;
    });
    // Show how many inks are hidden behind the "unmatched" toggle.
    var unmatched = state.inks.filter(function (i) { return !i._hex; }).length;
    var lbl = $('showUnmatchedLabel');
    if (lbl) lbl.textContent = 'Show unmatched' + (unmatched ? ' (' + unmatched + ')' : '');
    renderChips();
    render();
  }

  /* =========================================================================
   * 7) FILTER + SORT PIPELINE
   * ====================================================================== */
  function visibleInks() {
    var q = state.search.trim().toLowerCase();
    // Cards display the coated suffix ("186 C") but the database stores the
    // bare code — so let a search for "186 c" / "186c" still find "186".
    q = q.replace(/[\s-]*c$/, '');

    var list = state.inks.filter(function (ink) {
      var isUsed = (ink.status || '').toLowerCase() === 'used up';
      if (isUsed && !state.showUsedUp) return false;
      // No honest color preview -> hidden unless the toggle reveals them
      // (they still exist in the database; reveal to fix a mistyped code).
      if (!ink._hex && !state.showUnmatched) return false;
      if (state.selectedFamilies.size && !state.selectedFamilies.has(ink.colorFamily)) return false;
      if (q) {
        var hay = (ink.pantone + ' ' + (ink.description || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });

    // Sorting: closest-match mode overrides the normal sort.
    if (state.matchTarget) {
      list.forEach(function (ink) {
        ink._dist = ink._lab ? deltaE00(state.matchTarget.lab, ink._lab) : Infinity;
      });
      list.sort(function (a, b) { return a._dist - b._dist; });
    } else if (state.sort === 'weight') {
      list.sort(function (a, b) { return (b.weight || 0) - (a.weight || 0); });
    } else if (state.sort === 'pantone') {
      list.sort(byPantone);
    } else {
      list.sort(byRainbow); // default
    }
    return list;
  }

  // Natural-ish sort for Pantone codes: numbers ascending, then names A–Z.
  function byPantone(a, b) {
    var na = parseInt(a.pantone, 10), nb = parseInt(b.pantone, 10);
    var aNum = !isNaN(na) && /^\d/.test(a.pantone);
    var bNum = !isNaN(nb) && /^\d/.test(b.pantone);
    if (aNum && bNum) return na - nb || a.pantone.localeCompare(b.pantone);
    if (aNum) return -1;
    if (bNum) return 1;
    return a.pantone.localeCompare(b.pantone);
  }

  /* =========================================================================
   * 8) RENDERING
   * ====================================================================== */
  function renderChips() {
    var wrap = $('familyChips');
    wrap.innerHTML = '';
    FAMILIES.forEach(function (fam) {
      var count = state.familyCounts[fam] || 0;
      var chip = el('button', 'chip');
      chip.type = 'button';
      chip.setAttribute('aria-pressed', state.selectedFamilies.has(fam) ? 'true' : 'false');
      chip.innerHTML =
        '<span class="swatch-sm" style="background:' + FAMILY_DOT[fam] + '"></span>' +
        esc(fam.charAt(0) + fam.slice(1).toLowerCase()) +
        ' <span class="n">' + count + '</span>';
      chip.addEventListener('click', function () {
        if (state.selectedFamilies.has(fam)) state.selectedFamilies.delete(fam);
        else state.selectedFamilies.add(fam);
        chip.setAttribute('aria-pressed', state.selectedFamilies.has(fam) ? 'true' : 'false');
        render();
      });
      wrap.appendChild(chip);
    });
  }

  function render() {
    var grid = $('grid');
    var list = visibleInks();

    // Running count: "Showing X of Y inks" (Y respects both visibility toggles).
    var total = state.inks.filter(function (i) {
      if (!state.showUsedUp && (i.status || '').toLowerCase() === 'used up') return false;
      if (!state.showUnmatched && !i._hex) return false;
      return true;
    }).length;
    $('count').textContent = 'Showing ' + list.length + ' of ' + total + ' inks'
      + (state.matchTarget ? ' · sorted by closeness to ' + state.matchTarget.hex : '');

    grid.innerHTML = '';
    if (state.loading) return;

    if (!list.length) {
      $('state').textContent = state.inks.length ? 'No inks match your filters.' : 'No inks in the database yet.';
      $('state').className = 'state';
      $('state').hidden = false;
      return;
    }
    $('state').hidden = true;

    // Build all cards in a fragment (one DOM insertion = faster).
    var frag = document.createDocumentFragment();
    list.forEach(function (ink) { frag.appendChild(buildCard(ink)); });
    grid.appendChild(frag);
  }

  function buildCard(ink) {
    var card = el('div', 'card');
    var isUsed = (ink.status || '').toLowerCase() === 'used up';
    if (isUsed) card.classList.add('is-used-up');

    /* ---- swatch ---- */
    var swatch = el('div', 'swatch');
    var codeSpan = el('span', 'swatch__code');
    // Every ink in the shop is coated, so matched codes display with the
    // official "C" finish suffix ("186" -> "186 C"). The database stores the
    // bare code; this is display-only. Unmatched codes show exactly as stored,
    // and shop product inks (White 7706 / Black 7707) skip the suffix — they
    // aren't Pantone book colors.
    var shopKey = ink.pantone.toLowerCase().trim().replace(/\s+/g, '-');
    var isShopInk = (window.PANTONE_SHOP_INKS || {})[shopKey];
    codeSpan.textContent = ink._hex && !isShopInk && !/c$/i.test(ink.pantone.trim())
      ? ink.pantone + ' C'
      : ink.pantone;

    if (ink._hex) {
      swatch.style.background = ink._hex;
      // (The code pill and ΔE badge keep their own dark plates via CSS, so
      // their text stays white no matter how light the swatch color is.)
      if (state.matchTarget && isFinite(ink._dist)) {
        var badge = el('span', 'swatch__badge');
        badge.textContent = 'ΔE ' + ink._dist.toFixed(1);
        swatch.appendChild(badge);
      }
    } else {
      // Honest "no preview" swatch — never fake a color.
      swatch.classList.add('swatch--none');
      var np = el('span', 'swatch__noprev');
      np.textContent = 'no preview';
      swatch.appendChild(np);
    }
    swatch.insertBefore(codeSpan, swatch.firstChild);
    card.appendChild(swatch);

    /* ---- body ---- */
    var body = el('div', 'card__body');

    var desc = el('div', 'card__desc');
    if (ink.description) { desc.textContent = ink.description; }
    else { desc.textContent = '(no description)'; desc.classList.add('empty'); }
    body.appendChild(desc);

    var meta = el('div', 'card__meta');
    meta.innerHTML =
      '<span>Wt <b>' + (ink.weight != null ? esc(ink.weight) : '—') + '</b> lb</span>' +
      '<span>Qty <b>' + esc(ink.quantity != null ? ink.quantity : 1) + '</b></span>';
    body.appendChild(meta);

    if (isUsed) {
      var tag = el('div', 'tag-used');
      tag.textContent = 'USED UP';
      body.appendChild(tag);
    }

    card.appendChild(body);

    if (state.selected.has(ink.id)) card.classList.add('is-selected');

    // Normal mode: open the editor. Select mode: toggle selection.
    card.addEventListener('click', function () {
      if (!state.selectMode) { openEdit(ink); return; }
      if (state.selected.has(ink.id)) {
        state.selected.delete(ink.id);
        card.classList.remove('is-selected');
      } else {
        state.selected.add(ink.id);
        card.classList.add('is-selected');
      }
      updateBulkBar();
    });
    return card;
  }

  /* =========================================================================
   * SELECT MODE + BULK ACTIONS
   * ====================================================================== */
  function enterSelectMode() {
    state.selectMode = true;
    state.selected.clear();
    document.body.classList.add('select-mode');
    $('selectBtn').textContent = 'Done';
    $('bulkBar').hidden = false;
    updateBulkBar();
  }

  function exitSelectMode() {
    state.selectMode = false;
    state.selected.clear();
    document.body.classList.remove('select-mode');
    $('selectBtn').textContent = 'Select';
    $('bulkBar').hidden = true;
    $('bulkFamily').selectedIndex = 0;
    render();
  }

  function updateBulkBar() {
    var n = state.selected.size;
    $('bulkCount').textContent = n + ' selected';
    $('bulkDelete').disabled = !n;
    $('bulkFamily').disabled = !n;
  }

  // Select every card that passes the current filters (filter first, then grab all).
  function selectVisible() {
    visibleInks().forEach(function (ink) { state.selected.add(ink.id); });
    render();
    updateBulkBar();
  }

  function bulkApply(body, busyEl) {
    busyEl.disabled = true;
    api('POST', '/api/bulk', body)
      .then(function (res) {
        busyEl.disabled = false;
        applyInventory(res.inventory);
        toast(res.message, 'ok');
        exitSelectMode();
      })
      .catch(function (err) {
        busyEl.disabled = false;
        toast(err.message, 'err');
      });
  }

  function bulkChangeFamily() {
    var fam = $('bulkFamily').value;
    if (!fam || !state.selected.size) return;
    bulkApply({ action: 'family', ids: Array.from(state.selected), colorFamily: fam }, $('bulkFamily'));
  }

  function bulkDelete() {
    var n = state.selected.size;
    if (!n) return;
    if (!window.confirm('Permanently delete ' + n + ' ink' + (n === 1 ? '' : 's') + '?\n\nIf cans just ran out, use "Mark used up" instead — it keeps the history.')) {
      return;
    }
    bulkApply({ action: 'delete', ids: Array.from(state.selected) }, $('bulkDelete'));
  }

  /* =========================================================================
   * 9) MODAL (add / edit)
   * ====================================================================== */
  var editing = null; // the ink being edited, or null when adding

  function fillFamilySelect() {
    // Both the modal dropdown and the bulk bar dropdown list every family.
    [['f_colorFamily', 'Choose…'], ['bulkFamily', 'Change family…']].forEach(function (pair) {
      var sel = $(pair[0]);
      sel.innerHTML = '<option value="" disabled selected>' + pair[1] + '</option>';
      FAMILIES.forEach(function (fam) {
        var o = el('option');
        o.value = fam;
        o.textContent = fam.charAt(0) + fam.slice(1).toLowerCase();
        sel.appendChild(o);
      });
    });
  }

  function openAdd() {
    editing = null;
    $('modalTitle').textContent = 'Add ink';
    $('inkForm').reset();
    $('f_id').value = '';
    // Pre-select the family if exactly one chip is active (nice shortcut).
    if (state.selectedFamilies.size === 1) {
      $('f_colorFamily').value = Array.from(state.selectedFamilies)[0];
    }
    $('statusRow').hidden = true;
    $('deleteBtn').hidden = true; // nothing to delete when adding
    hideFormError();
    showModal();
    $('f_pantone').focus();
  }

  function openEdit(ink) {
    editing = ink;
    $('modalTitle').textContent = 'Edit ink';
    $('f_id').value = ink.id;
    $('f_pantone').value = ink.pantone;
    $('f_description').value = ink.description || '';
    $('f_colorFamily').value = ink.colorFamily || '';
    $('f_weight').value = (ink.weight != null ? ink.weight : '');
    $('f_quantity').value = (ink.quantity != null && ink.quantity > 1 ? ink.quantity : '');

    // Status + delete controls (edit only).
    $('statusRow').hidden = false;
    $('deleteBtn').hidden = false;
    setStatusUI(ink.status || 'In Stock');

    hideFormError();
    showModal();
    $('f_quantity').focus(); // the field most often adjusted on an edit
  }

  var pendingStatus = 'In Stock';
  function setStatusUI(status) {
    pendingStatus = (String(status).toLowerCase() === 'used up') ? 'Used Up' : 'In Stock';
    var label = $('statusLabel');
    label.textContent = pendingStatus;
    label.classList.toggle('used', pendingStatus === 'Used Up');
    $('statusToggleBtn').textContent = (pendingStatus === 'Used Up') ? 'Mark back in stock' : 'Mark used up';
  }

  function showModal() { $('modal').hidden = false; document.addEventListener('keydown', onEsc); }
  function closeModal() { $('modal').hidden = true; document.removeEventListener('keydown', onEsc); }
  function onEsc(e) { if (e.key === 'Escape') closeModal(); }

  function showFormError(msg) { var b = $('formError'); b.textContent = msg; b.hidden = false; }
  function hideFormError() { $('formError').hidden = true; }

  // Gather the form into a plain payload object for the server.
  function readForm() {
    return {
      id: $('f_id').value,
      pantone: $('f_pantone').value,
      description: $('f_description').value,
      colorFamily: $('f_colorFamily').value,
      weight: $('f_weight').value,
      quantity: $('f_quantity').value,
      status: pendingStatus
    };
  }

  function submitForm(e) {
    e.preventDefault();
    hideFormError();
    var payload = readForm();

    // Light client-side check; the server validates for real.
    if (!payload.pantone.trim()) { showFormError('Pantone code is required.'); return; }
    if (!payload.colorFamily) { showFormError('Please choose a color family.'); return; }

    setBusy(true);
    api(editing ? 'PUT' : 'POST', '/api/inks', payload)
      .then(function (res) {
        setBusy(false);
        closeModal();
        applyInventory(res.inventory);
        toast(res.message || 'Saved.', 'ok');
      })
      .catch(function (err) {
        setBusy(false);
        showFormError(err.message);
      });
  }

  function setBusy(b) {
    $('saveBtn').disabled = b;
    $('deleteBtn').disabled = b;
    $('inkForm').classList.toggle('is-busy', b);
    $('saveBtn').textContent = b ? 'Saving…' : 'Save';
  }

  // Permanently remove the ink being edited (with a confirm step).
  // For real cans that ran out, "Mark used up" is the better choice — it keeps
  // history. Delete is for rows that shouldn't exist (typos, true duplicates).
  function deleteInk() {
    if (!editing) return;
    var label = editing.pantone + (editing.description ? ' (' + editing.description + ')' : '');
    if (!window.confirm('Permanently delete ' + label + '?\n\nIf the can just ran out, use "Mark used up" instead — it keeps the history.')) {
      return;
    }
    setBusy(true);
    api('DELETE', '/api/inks', { id: editing.id })
      .then(function (res) {
        setBusy(false);
        closeModal();
        applyInventory(res.inventory);
        toast(res.message || 'Deleted.', 'ok');
      })
      .catch(function (err) {
        setBusy(false);
        showFormError(err.message);
      });
  }

  /* =========================================================================
   * 10) CLOSEST-MATCH HELPER
   * ====================================================================== */
  function runMatch() {
    var raw = $('matchInput').value.trim();
    if (!raw) { clearMatch(); return; }
    // Accept either a hex (#abc / #aabbcc) or a Pantone code we can resolve.
    var hex = null;
    if (/^#?[0-9a-fA-F]{3}$/.test(raw) || /^#?[0-9a-fA-F]{6}$/.test(raw)) {
      hex = raw[0] === '#' ? raw : '#' + raw;
    } else {
      hex = pantoneHex(raw);
    }
    if (!hex) { toast('Could not resolve "' + raw + '" to a color.', 'err'); return; }
    state.matchTarget = { hex: hex.toLowerCase(), lab: rgbToLab(hexToRgb(hex)) };
    $('matchClear').hidden = false;
    render();
  }
  function clearMatch() {
    state.matchTarget = null;
    $('matchInput').value = '';
    $('matchClear').hidden = true;
    render();
  }

  /* =========================================================================
   * 11) TOAST
   * ====================================================================== */
  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast ' + (kind || '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }

  /* =========================================================================
   * 12) WIRE UP EVENTS + BOOT
   * ====================================================================== */
  function boot() {
    fillFamilySelect();

    $('search').addEventListener('input', function () { state.search = this.value; render(); });
    $('sort').addEventListener('change', function () { state.sort = this.value; render(); });
    $('showUsedUp').addEventListener('change', function () { state.showUsedUp = this.checked; render(); });
    $('showUnmatched').addEventListener('change', function () { state.showUnmatched = this.checked; render(); });

    $('addBtn').addEventListener('click', openAdd);
    $('inkForm').addEventListener('submit', submitForm);
    $('deleteBtn').addEventListener('click', deleteInk);

    // Select mode + bulk actions.
    $('selectBtn').addEventListener('click', function () {
      state.selectMode ? exitSelectMode() : enterSelectMode();
    });
    $('bulkCancel').addEventListener('click', exitSelectMode);
    $('bulkSelectVisible').addEventListener('click', selectVisible);
    $('bulkFamily').addEventListener('change', bulkChangeFamily);
    $('bulkDelete').addEventListener('click', bulkDelete);
    $('statusToggleBtn').addEventListener('click', function () {
      setStatusUI(pendingStatus === 'Used Up' ? 'In Stock' : 'Used Up');
    });

    // Any element with data-close closes the modal (backdrop, X, Cancel).
    document.querySelectorAll('[data-close]').forEach(function (n) {
      n.addEventListener('click', closeModal);
    });

    $('matchBtn').addEventListener('click', runMatch);
    $('matchClear').addEventListener('click', clearMatch);
    $('matchInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') runMatch(); });

    loadInventory();
  }

  // Wait for the DOM before wiring events.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
