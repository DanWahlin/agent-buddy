// Motion runtime for the Agent Buddy overview video. scripts/build.mjs
// inlines this file into index.html after window.__PLAN__. All tween positions
// are global seconds. Motion rules: expo.out to enter, power2.in to leave,
// power2.inOut to move, sine.inOut to drift. No overshoot, no infinite loops.
(function () {
  const P = window.__PLAN__;
  const T = P.T;
  const $ = (id) => document.getElementById(id);
  const q = (sel, rootEl) => Array.from((rootEl || document).querySelectorAll(sel));
  const STATE_GLOW = {
    working: "0 0 120px 24px rgba(95, 211, 255, 0.42), 0 40px 120px rgba(0, 0, 0, 0.55)",
    attention: "0 0 130px 28px rgba(255, 181, 71, 0.45), 0 40px 120px rgba(0, 0, 0, 0.55)",
    complete: "0 0 130px 28px rgba(94, 224, 160, 0.42), 0 40px 120px rgba(0, 0, 0, 0.55)",
    calm: "0 0 110px 20px rgba(79, 166, 255, 0.34), 0 40px 120px rgba(0, 0, 0, 0.55)",
  };

  // Masked words rise into place.
  function riseWords(tl, container, at, opts = {}) {
    if (!container) return;
    const items = q(".wi", container);
    tl.fromTo(items, { yPercent: 118 }, { yPercent: 0, duration: opts.duration ?? 0.85, ease: "expo.out", stagger: opts.stagger ?? 0.07 }, at);
  }
  function leave(tl, targets, at, dy = -24) {
    const list = (Array.isArray(targets) ? targets : [targets]).filter(Boolean);
    if (list.length) tl.to(list, { y: `+=${dy}`, opacity: 0, duration: 0.45, ease: "power2.in", stagger: 0.04 }, at);
  }
  function sweep(tl, at) {
    const band = $("sweep");
    tl.fromTo(band, { x: -900, rotation: 18 }, { x: 2500, rotation: 18, duration: 1.2, ease: "power2.inOut" }, at - 0.55);
    tl.fromTo(band, { opacity: 0 }, { opacity: 1, duration: 0.45, ease: "sine.out" }, at - 0.55);
    tl.to(band, { opacity: 0, duration: 0.5, ease: "sine.in" }, at + 0.15);
  }
  // A device appears: the case settles in, then the screen turns on.
  function deviceIn(tl, id, at, opts = {}) {
    tl.fromTo(`#${id}`, { opacity: 0, scale: opts.from ?? 0.86, y: opts.dy ?? 30 }, { opacity: 1, scale: 1, y: 0, duration: opts.duration ?? 1.0, ease: "expo.out" }, at);
    tl.fromTo(`#${id}-scr`, { opacity: 0 }, { opacity: 1, duration: 0.5, ease: "sine.out" }, at + (opts.screenDelay ?? 0.25));
  }
  function deviceOut(tl, id, at) {
    tl.to(`#${id}`, { opacity: 0, scale: 0.94, y: 16, duration: 0.45, ease: "power2.in" }, at);
  }
  // Fit a headline to its column when the longest line is too wide.
  function fitHeadlines() {
    for (const head of q(".ch-head")) {
      const max = head.clientWidth;
      const widest = Math.max(...q(".line", head).map((line) => line.scrollWidth));
      if (widest > max) head.style.fontSize = `${Math.floor((parseFloat(getComputedStyle(head).fontSize) * max) / widest)}px`;
    }
  }

  function build() {
    fitHeadlines();
    const tl = gsap.timeline({ paused: true });

    // ---------- Background ----------
    tl.fromTo("#a1", { x: 0, y: 0 }, { x: 180, y: 110, duration: 15, ease: "sine.inOut", yoyo: true, repeat: Math.ceil(P.total / 15) }, 0);
    tl.fromTo("#a2", { x: 0, y: 0 }, { x: -200, y: -90, duration: 12, ease: "sine.inOut", yoyo: true, repeat: Math.ceil(P.total / 12) }, 0);
    tl.fromTo("#a3", { x: -80, y: 40, scale: 0.92, opacity: 0.7 }, { x: 120, y: -40, scale: 1.08, opacity: 1, duration: 10, ease: "sine.inOut", yoyo: true, repeat: Math.ceil(P.total / 10) }, 0);
    tl.fromTo("#hexgrid", { x: 0, y: 0 }, { x: -42, y: -48, duration: P.total, ease: "none" }, 0);
    tl.fromTo("#grain", { x: 0, y: 0 }, { x: 256, y: 128, duration: P.total, ease: `steps(${Math.round(P.total * 12)})` }, 0);
    for (const p of P.particles) {
      tl.fromTo(`#${p.id}`, { y: 0 }, { y: -p.dy, duration: P.total, ease: "none" }, 0);
      const loops = Math.max(1, Math.floor(P.total / p.tw) - 1);
      tl.fromTo(`#${p.id}`, { opacity: p.op * 0.25 }, { opacity: p.op, duration: p.tw / 2, ease: "sine.inOut", yoyo: true, repeat: loops * 2 - 1 }, (p.tw * 7) % 1.7);
    }
    for (const at of P.sweeps) sweep(tl, at);

    // ---------- Hook ----------
    // Agent windows fly in and work. One finishes, one stops to ask, and the
    // text asks whether you noticed. Then they all fly into the device.
    if (T.hook) {
      const s = T.hook.start;
      const end = s + T.hook.dur;
      for (const t of P.tiles) {
        const el = `#${t.id}`;
        const fly = s + 0.1 + t.order * 0.7;
        tl.fromTo(el, { x: t.ox, y: t.oy, rotation: t.rot, scale: 0.8, opacity: 0 }, { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1, duration: 1.2, ease: "expo.out" }, fly);
        // Working: the progress bar moves back and forth until something happens.
        const stop = t.at !== null ? s + t.at : end - 0.6;
        const workFrom = fly + 0.4;
        // Whole swings only, so the bar never moves after the task ends.
        const half = t.period / 2;
        const swings = Math.floor((stop - workFrom) / half);
        if (swings >= 1) tl.fromTo(`${el}-f`, { scaleX: t.low }, { scaleX: t.high, duration: half, ease: "sine.inOut", yoyo: true, repeat: swings - 1 }, workFrom);
        else tl.fromTo(`${el}-f`, { scaleX: t.low }, { scaleX: t.high, duration: Math.max(0.2, stop - workFrom), ease: "sine.inOut" }, workFrom);
        if (t.outcome === "done") {
          tl.to(`${el}-f`, { scaleX: 1, duration: 0.35, ease: "power2.out" }, stop);
          tl.to(`${el}-task`, { opacity: 0, y: -8, duration: 0.25, ease: "power2.in" }, stop);
          tl.fromTo(`${el}-st`, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.4, ease: "expo.out" }, stop + 0.2);
          tl.fromTo(`${el}-mk`, { opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1, duration: 0.45, ease: "expo.out" }, stop + 0.1);
          tl.fromTo(`${el}-edge`, { opacity: 0 }, { opacity: 1, duration: 0.4, ease: "sine.out" }, stop + 0.1);
          tl.set(`${el}-f`, { background: "#5ee0a0" }, stop);
        }
        if (t.outcome === "attention") {
          tl.to(`${el}-f`, { opacity: 0.35, duration: 0.3 }, stop);
          tl.to(`${el}-task`, { opacity: 0, y: -8, duration: 0.25, ease: "power2.in" }, stop);
          tl.fromTo(`${el}-st`, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.4, ease: "expo.out" }, stop + 0.2);
          tl.fromTo(`${el}-mk`, { opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1, duration: 0.45, ease: "expo.out" }, stop + 0.1);
          tl.fromTo(`${el}-edge`, { opacity: 0 }, { opacity: 1, duration: 0.4, ease: "sine.out" }, stop + 0.1);
          // A slow pulse: the agent waits and nobody answers.
          const pulses = Math.max(1, Math.floor((end - 0.8 - stop) / 1.2));
          tl.fromTo(`${el}-pulse`, { opacity: 0.8, scale: 1 }, { opacity: 0, scale: 1.12, duration: 1.2, ease: "power2.out", repeat: pulses - 1 }, stop + 0.4);
        }
        // Into the device: every window flies to the screen's centre.
        tl.to(el, { x: t.tx, y: t.ty, scale: 0.12, opacity: 0, duration: 0.75, ease: "power2.in" }, end - 0.85 + t.order * 0.12);
      }
      const done = P.tiles.find((t) => t.outcome === "done");
      const ask = P.tiles.find((t) => t.outcome === "attention");
      riseWords(tl, $("hook-l1"), s + (done ? done.at + 0.15 : 1.0), { stagger: 0.06 });
      riseWords(tl, $("hook-l2"), s + (ask ? ask.at + 0.15 : 2.2), { stagger: 0.06 });
      riseWords(tl, $("hook-l3"), s + 4.0, { stagger: 0.08, duration: 1.0 });
      leave(tl, $("hook-wrap"), end - 0.75);
    }

    // ---------- Hero device: meet, states, agents ----------
    if (P.hero) {
      const H = P.hero;
      const id = H.id;
      const P0 = H.poses;
      const showAt = H.footage ? T.states.start - 0.2 : T.meet.start - 0.25;
      if (H.footage) {
        tl.fromTo(`#${H.footage}`, { opacity: 0, scale: 1.03 }, { opacity: 1, scale: 1, duration: 0.9, ease: "expo.out" }, T.meet.start);
        tl.to(`#${H.footage}`, { opacity: 0, duration: 0.5, ease: "power2.in" }, T.meet.start + T.meet.dur - 0.5);
        tl.set(`#${id}`, { x: P0.states.x, y: P0.states.y, scale: P0.states.s }, 0);
        tl.fromTo(`#${id}`, { opacity: 0 }, { opacity: 1, duration: 0.6, ease: "sine.out" }, showAt);
        tl.set(`#${id}-scr`, { opacity: 1 }, showAt);
      } else {
        // The windows land in the case, then the screen turns on and the character wakes.
        tl.fromTo(`#${id}`, { opacity: 0, scale: 0.55 }, { opacity: 1, scale: 1, duration: 1.3, ease: "expo.out" }, showAt);
        tl.fromTo(`#${id}-scr`, { opacity: 0 }, { opacity: 1, duration: 0.6, ease: "sine.out" }, T.meet.start + 0.55);
        tl.fromTo(`#${id}-glow`, { opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1, duration: 1.2, ease: "expo.out" }, T.meet.start + 0.55);
      }
      // A gentle idle float while it is the star.
      tl.fromTo(`#${id}`, { rotation: -1.2 }, { rotation: 1.2, duration: 3, ease: "sine.inOut", yoyo: true, repeat: 1 }, T.meet.start + 0.6);
      if (P0.states && T.states) tl.to(`#${id}`, { x: P0.states.x, y: P0.states.y, scale: P0.states.s, rotation: 0, duration: 1.1, ease: "power2.inOut" }, T.states.start - 0.6);
      if (P0.agents && T.agents) tl.to(`#${id}`, { x: P0.agents.x, y: P0.agents.y, scale: P0.agents.s, duration: 1.1, ease: "power2.inOut" }, T.agents.start - 0.6);
      // The glow takes the colour of each state, just after the device changes.
      for (const st of P.stateSteps) tl.to(`#${id}-glow`, { boxShadow: STATE_GLOW[st.state], duration: 0.6, ease: "sine.inOut" }, st.start + 0.4);
      if (T.agents) tl.to(`#${id}-glow`, { boxShadow: STATE_GLOW.working, duration: 0.6, ease: "sine.inOut" }, T.agents.start + 0.3);
      if (T.agents) deviceOut(tl, id, T.agents.start + T.agents.dur - 0.5);
    }

    // ---------- Meet ----------
    if (T.meet) {
      const s = T.meet.start;
      riseWords(tl, $("meet-kicker"), s + 1.3, { stagger: 0.05, duration: 0.8 });
      riseWords(tl, $("meet-title"), s + 1.55, { stagger: 0.07 });
      tl.fromTo("#meet-sub", { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.8, ease: "expo.out" }, s + 2.4);
      leave(tl, [$("meet-kicker"), $("meet-title"), $("meet-sub")], s + T.meet.dur - 0.7);
    }

    // ---------- States ----------
    // Cause, then effect: the agent event appears first, then the device reacts.
    if (T.states) {
      const s = T.states.start;
      const end = s + T.states.dur;
      tl.fromTo("#st-label", { opacity: 0, x: -20 }, { opacity: 1, x: 0, duration: 0.6, ease: "expo.out" }, s + 0.1);
      P.stateSteps.forEach((st, k) => {
        const last = k === P.stateSteps.length - 1;
        riseWords(tl, q(".st-title", $(`st${k}`))[0], st.start + 0.15, { stagger: 0.06 });
        tl.fromTo(q(".st-sub", $(`st${k}`)), { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.7, ease: "expo.out" }, st.start + 0.45);
        tl.fromTo(`#evg${k}`, { opacity: 0, x: k ? 0 : -30 }, { opacity: 1, x: 0, duration: k ? 0.35 : 0.7, ease: k ? "sine.out" : "expo.out" }, st.start + (k ? 0 : 0.05));
        q(".ev.working .ev-mark", $(`evg${k}`)).forEach((m) => tl.fromTo(m, { rotation: 0 }, { rotation: 360 * Math.ceil(st.dur / 0.9), duration: st.dur + 0.4, ease: "none" }, st.start));
        if (!last) {
          tl.to(q(".st-title .wi", $(`st${k}`)), { yPercent: -118, duration: 0.4, ease: "power2.in", stagger: 0.03 }, st.start + st.dur - 0.4);
          tl.to(q(".st-sub", $(`st${k}`)), { opacity: 0, duration: 0.3, ease: "power2.in" }, st.start + st.dur - 0.35);
          // The next step's rows appear as these finish leaving, so text never overlaps.
          tl.to(`#evg${k}`, { opacity: 0, duration: 0.3, ease: "sine.in" }, st.start + st.dur - 0.3);
        }
      });
      if ($("st-note")) {
        tl.fromTo("#st-note", { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.6, ease: "expo.out" }, s + 1.4);
        tl.to("#st-note", { opacity: 0, duration: 0.4, ease: "power2.in" }, s + 9.6);
      }
      const lastStep = P.stateSteps.length - 1;
      leave(tl, [$("st-label"), $(`st${lastStep}`), $(`evg${lastStep}`)], end - 0.55);
    }

    // ---------- Agents ----------
    if (T.agents) {
      const s = T.agents.start;
      riseWords(tl, $("ag-l1"), s + 0.25, { stagger: 0.07 });
      riseWords(tl, $("ag-l2"), s + 0.65, { stagger: 0.08 });
      q("#s-agents .chip").forEach((chip, i) => {
        const left = chip.classList.contains("left");
        const row = i % 3;
        tl.fromTo(chip, { opacity: 0, x: left ? 40 : -40, scale: 0.92 }, { opacity: 1, x: 0, scale: 1, duration: 0.8, ease: "expo.out" }, s + 0.9 + row * 0.12 + (left ? 0 : 0.06));
      });
      tl.fromTo("#ag-sub", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.7, ease: "expo.out" }, s + 1.8);
      leave(tl, [q(".ag-lines")[0], ...q("#s-agents .chip"), $("ag-sub")], s + T.agents.dur - 0.55);
    }

    // ---------- Touches ----------
    if (T.touches) {
      const s = T.touches.start;
      riseWords(tl, $("tc-title"), s + 0.05, { stagger: 0.08 });
      P.touches.forEach((d, i) => {
        if (d.footage) {
          tl.fromTo(`#${d.footage}`, { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 1.0, ease: "expo.out" }, s + 0.1 + i * 0.15);
          tl.to(`#${d.footage}`, { opacity: 0, duration: 0.45, ease: "power2.in" }, s + T.touches.dur - 0.5);
        } else {
          deviceIn(tl, d.id, s + 0.1 + i * 0.15);
          deviceOut(tl, d.id, s + T.touches.dur - 0.5);
        }
        tl.fromTo(`#tcap${i}`, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.7, ease: "expo.out" }, s + 0.6 + i * 0.15);
        for (const at of d.footage ? [] : d.tap) {
          tl.fromTo(`#${d.id}-rp`, { opacity: 0.95, scale: 0.3 }, { opacity: 0, scale: 1.6, duration: 0.8, ease: "power2.out" }, s + at - 0.05);
        }
        if (d.lens) {
          tl.fromTo(`#${d.id}-lens`, { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.8, ease: "expo.out" }, s + 1.5);
        }
      });
      leave(tl, [$("tc-title"), ...P.touches.map((_, i) => $(`tcap${i}`))], s + T.touches.dur - 0.55);
    }

    // ---------- Characters ----------
    if (T.characters) {
      const s = T.characters.start;
      riseWords(tl, $("ch-title"), s + 0.05, { stagger: 0.08 });
      if ($("ch-note")) tl.fromTo("#ch-note", { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.7, ease: "expo.out" }, s + 0.6);
      P.chars.forEach((c, i) => {
        const at = s + 0.12 + i * 0.16;
        if (c.id) {
          deviceIn(tl, c.id, at);
          deviceOut(tl, c.id, s + T.characters.dur - 0.5);
        } else {
          tl.fromTo(`#${c.slot}`, { opacity: 0, scale: 0.86, rotation: -40 }, { opacity: 1, scale: 1, rotation: 0, duration: 1.1, ease: "expo.out" }, at);
          tl.to(`#${c.slot}`, { opacity: 0, scale: 0.94, duration: 0.45, ease: "power2.in" }, s + T.characters.dur - 0.5);
        }
        tl.fromTo(`#ccap${i}`, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.7, ease: "expo.out" }, at + 0.5);
      });
      leave(tl, [$("ch-title"), $("ch-note"), ...P.chars.map((_, i) => $(`ccap${i}`))], s + T.characters.dur - 0.55);
    }

    // ---------- Chapters (screenshot cards) ----------
    for (const ch of P.chapters) {
      const s = ch.start;
      const end = s + ch.dur;
      const text = $(`${ch.id}-text`);
      tl.fromTo(q(".ch-label", text), { x: -20, opacity: 0 }, { x: 0, opacity: 1, duration: 0.6, ease: "expo.out" }, s + 0.2);
      riseWords(tl, q(".ch-head", text)[0], s + 0.3, { stagger: 0.06, duration: 0.9 });
      tl.fromTo(q(".ch-sub", text), { y: 16, opacity: 0 }, { y: 0, opacity: 1, duration: 0.7, ease: "expo.out" }, s + 0.85);
      tl.to(text, { y: -16, opacity: 0, duration: 0.4, ease: "power2.in" }, end - 0.4);
      const wrap = [$(`${ch.id}-wrap`), $(`${ch.id}-vwrap`)].filter(Boolean);
      tl.fromTo(wrap, { x: 70, rotationY: -12, scale: 1.02, opacity: 0 }, { x: 0, rotationY: -5, scale: 1, opacity: 1, duration: 1.1, ease: "expo.out" }, s + 0.05);
      tl.to(wrap, { rotationY: -2, duration: Math.max(0.5, ch.dur - 1.6), ease: "sine.inOut" }, s + 1.15);
      tl.to(wrap, { x: -50, scale: 0.97, opacity: 0, duration: 0.5, ease: "power2.in" }, end - 0.4);
      tl.fromTo(`#${ch.id}-sheen`, { xPercent: -120, opacity: 1 }, { xPercent: 330, opacity: 1, duration: 1.2, ease: "power2.inOut" }, s + 0.7);
      // Each screen holds at full view first, then the camera pushes to its focus.
      ch.shots.forEach((sh, k) => {
        const inner = [$(`${sh.id}-in`), $(`${sh.id}-vin`)].filter(Boolean);
        const last = k === ch.shots.length - 1;
        const hold = k === 0 ? 1.3 : 0.9;
        const pushDur = Math.max(0.8, sh.t1 - sh.t0 - hold - (last ? 0.9 : 0.5));
        tl.fromTo(inner, { x: sh.from.x, y: sh.from.y, scale: sh.from.s }, { x: sh.from.x, y: sh.from.y, scale: sh.from.s, duration: 0.01 }, Math.max(0, sh.t0 - 0.7));
        if (sh.moves.length) for (const m of sh.moves) tl.to(inner, { x: m.to.x, y: m.to.y, scale: m.to.s, duration: m.dur, ease: "power2.inOut" }, m.at);
        else tl.to(inner, { x: sh.to.x, y: sh.to.y, scale: sh.to.s, duration: pushDur, ease: "power2.inOut" }, sh.t0 + hold);
        if (sh.video) {
          tl.fromTo(`#${sh.id}-vcard`, { opacity: 0 }, { opacity: 1, duration: 0.6, ease: "sine.inOut" }, sh.t0 - 0.3);
          if (!last) tl.to(`#${sh.id}-vcard`, { opacity: 0, duration: 0.6, ease: "sine.inOut" }, sh.t1 - 0.3);
        }
        if (sh.ring) tl.fromTo(`#${sh.id}-ring`, { opacity: 0, scale: 1.06, transformOrigin: "50% 50%" }, { opacity: 1, scale: 1, duration: 0.5, ease: "expo.out" }, sh.t0 + hold + pushDur * 0.7);
        if (k > 0) {
          tl.fromTo(`#${sh.id}`, { opacity: 0 }, { opacity: 1, duration: 0.6, ease: "sine.inOut" }, sh.t0 - 0.3);
          tl.to(`#${ch.shots[k - 1].id}`, { opacity: 0, duration: 0.01 }, sh.t0 + 0.35);
        }
      });
    }

    // ---------- Values ----------
    if (T.values) {
      const s = T.values.start;
      q("#values-words .vword").forEach((el, k) => riseWords(tl, el, s + 0.1 + k * 0.42, { stagger: 0.05, duration: 0.8 }));
      tl.fromTo("#v-underline", { scaleX: 0 }, { scaleX: 1, duration: 0.7, ease: "power2.inOut" }, s + 1.5);
      tl.fromTo(q("#chips .pill"), { y: 26, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "expo.out", stagger: 0.1 }, s + 1.8);
      leave(tl, [$("values-words"), $("chips")], s + T.values.dur - 0.55, -36);
    }

    // ---------- End ----------
    if (T.end) {
      const s = T.end.start;
      if (P.end?.footage) tl.fromTo(`#${P.end.footage}`, { opacity: 0, scale: 1.03 }, { opacity: 1, scale: 1, duration: 1.0, ease: "expo.out" }, s + 0.1);
      else if (P.end) {
        deviceIn(tl, P.end.id, s + 0.1, { from: 0.8, duration: 1.2 });
        tl.fromTo(`#${P.end.id}-glow`, { boxShadow: STATE_GLOW.complete }, { boxShadow: STATE_GLOW.calm, duration: 2.5, ease: "sine.inOut" }, s + 1.5);
      }
      // One block at a time: the name, the two ways to use it, then where to get it.
      riseWords(tl, q("#s-end .end-title")[0], s + 0.4, { stagger: 0.07 });
      tl.fromTo(q("#s-end .end-opt"), { opacity: 0, x: -24 }, { opacity: 1, x: 0, duration: 0.8, ease: "expo.out", stagger: 0.35 }, s + 1.3);
      tl.fromTo("#end-cta", { opacity: 0, y: 16, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.8, ease: "expo.out" }, s + 2.7);
      tl.fromTo("#end-url", { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.7, ease: "expo.out" }, s + 3.1);
      tl.fromTo("#fade-black", { opacity: 0 }, { opacity: 1, duration: 0.7, ease: "sine.in" }, P.total - 0.7);
    }

    return tl;
  }

  document.fonts.ready.then(() => {
    window.__timelines["main"] = build();
  });
})();
