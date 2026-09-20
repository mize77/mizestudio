/*
 * xquix-sound-studio.js — XquiX Sound Studio, the athlete-facing Sound Box
 * function. Built from soundbox/sound-studio.src.js + builder.js +
 * builder-vocabulary.json by soundbox/build_module.py; edit those, not this.
 *
 * Attaches like the Game Tracker: one classic <script src>, one Home entry,
 * one router branch (soundbox/ARCHITECTURE.md §7).
 *
 *   MIZE.SoundStudio.start()   open the overlay (needs a user gesture for audio)
 *   MIZE.SoundStudio.exit()    stop audio, release Media Session, remove overlay
 *   MIZE.SoundStudio.isOpen()
 *   MIZE.SoundStudio.config    { supabaseUrl, supabaseKey, audioBase, getAccessToken,
 *                                mount, background, analyse }
 *   MIZE.SoundStudio.onExit / onTrackChange / onBeat / onLevel   optional host callbacks
 *   MIZE.SoundStudio.analyser()  live AnalyserNode or null
 *   MIZE.SoundStudio.prime()   call inside a user gesture if play() will come from a timer (Safari)
 *   MIZE.SoundStudio.play/pause/togglePlay/next/prev/state/session   host transport
 *   MIZE.SoundStudio.onSessionBuilt / onPlayState   optional host callbacks
 *                              (see soundbox/STAGE-HOOKS-CONTRACT.md)
 *
 * Leaves nothing behind on exit: no timers, no listeners, no DOM, no state.
 */
(function () {
  "use strict";
  const root = (typeof window !== "undefined" ? window : globalThis);
  root.MIZE = root.MIZE || {};

  const VOCAB = {"_about":"Builder vocabulary for XquiX Sound Studio. PROPOSED 2026-09-09 from the matrix text; every line carries the matrix wording it was read from. Nothing here is approved until MIZE says so. Only approved functions appear; unreviewed ones are never offered.","_status":"proposed","states":{"_about":"The athlete-state tags. The first eight are the feeling words the athlete taps (ARCHITECTURE §6); the rest are states a track can leave the athlete in.","feelings":["down","nervous","unsure","flat","frustrated","okay","good","fired-up"],"exits":["calm","open","positive","energized","competitive","ready","unresolved"],"negative":["down","nervous","unsure","frustrated"],"low_energy":["flat"],"_note":"'flat' is low energy, not a negative state: it is met by an opener and raised by an activate track, not handled by a transform."},"roles":{"_about":"Slot roles the builder fills. A function may hold several.","meet":"meets the athlete where they are; opens a session","transform":"changes a negative state into a competitive one","bridge":"keeps an existing state going; connective tissue","activate":"raises energy","launch":"the last track before action","close":"ends a session at rest or in a good mood","adversity":"deliberate discomfort; only in adversity training"},"situations":{"_about":"Arc templates. 'fill' repeats until the time budget is nearly used. 'close_roles' lists what may end the session, in order of preference.","game":{"arc":["meet","transform?","fill:bridge|activate","launch"],"close_roles":["launch"]},"practice":{"arc":["meet","transform?","fill:activate|bridge","launch"],"close_roles":["launch","activate"]},"recovery":{"arc":["meet:calm","fill:bridge","close"],"close_roles":["close"],"avoid_roles":["activate"]},"travel":{"arc":["meet","fill:bridge","close"],"close_roles":["close","bridge"]},"just-me":{"arc":["meet","fill:bridge","close"],"close_roles":["close","bridge"]},"adversity":{"arc":["meet?","adversity","transform","fill:bridge","launch"],"close_roles":["launch"]}},"functions":{"origin":{"roles":["meet","bridge"],"entry":["okay","unsure","flat","open"],"exit":["open"],"maintains":false,"basis":"Opening / transition · Wake up → engage → settle → flow → think · Open thinking, free reflection"},"journey":{"roles":["activate"],"entry":["okay","good","flat","open","positive"],"exit":["energized"],"maintains":false,"basis":"Beginning / middle · Immediate engagement → activation → intensity → momentum · Switches on; creates momentum"},"unity":{"roles":["close"],"entry":["good","positive","energized","competitive"],"exit":["positive"],"maintains":false,"basis":"Ending · Accomplished → relax → enjoy → flow → happy closure"},"lift":{"roles":["launch"],"entry":["okay","good","positive","energized","open"],"exit":["ready"],"maintains":false,"basis":"Late preparation / launch · The gates are open. Go."},"reflection":{"roles":["meet","bridge"],"entry":["calm","okay"],"exit":["open"],"maintains":false,"basis":"Transition out of calm / meditation · Returns awareness after deep calm · Come back. You're here."},"resolve":{"roles":["launch"],"entry":["energized","competitive","good","positive"],"exit":["ready"],"maintains":false,"basis":"Very late preparation / launch · Everything is in place. Go."},"action":{"roles":["activate"],"entry":["energized","good","fired-up","competitive"],"exit":["energized"],"maintains":false,"basis":"Active phase / late preparation · Power → move → react → keep going → power"},"ascent":{"roles":["activate"],"entry":["okay","flat","open","positive"],"exit":["energized"],"maintains":false,"basis":"Transition / rapid build · Take me up. Quickly. (physical-response classification still open)"},"clarity":{"roles":["meet","bridge","close"],"entry":["okay","frustrated","unsure","open","positive","energized"],"exit":["positive"],"maintains":false,"basis":"Middle or ending · entry: Open / mixed / frustrated · exit: Optimistic reassurance: life is good"},"depth":{"roles":["transform"],"entry":["down","unsure"],"exit":["competitive"],"maintains":false,"basis":"Transformation journey · entry: Not-so-great / sad / uncertain · exit: Positive, powerful, competitive"},"drive":{"roles":["bridge","activate"],"entry":["energized","good","positive","competitive"],"exit":["energized"],"maintains":true,"basis":"Middle / transition · Already moving → continue → reinforce → energize · Keep going. Build on it."},"force":{"roles":["activate"],"entry":["flat","fired-up","energized","okay"],"exit":["energized"],"maintains":false,"basis":"Middle-to-late · Impact → attention → organize → positive power → balance · Get me moving. Then control the power."},"forward":{"roles":["transform"],"entry":["frustrated"],"exit":["competitive"],"maintains":false,"basis":"Response / transformation · entry: Angry / challenged / wronged · exit: Committed, self-believing statement"},"identity":{"roles":["transform"],"entry":["unsure","nervous"],"exit":["competitive"],"maintains":false,"basis":"Turnaround / belief / late preparation · entry: Chaos / uncertainty · exit: Belief, victory feeling, serious finish"},"light":{"roles":["bridge","close"],"entry":["okay","good","positive","open","energized","competitive"],"exit":["positive"],"maintains":false,"basis":"Flexible; recovery / ending / Just Me · Good mood → smile → move → enjoy → flow → life is good"},"master":{"roles":["transform"],"entry":["nervous","unsure","down"],"exit":["competitive"],"maintains":false,"basis":"Middle / late preparation · entry: Inferior / outmatched · exit: Equal opponent; ready to fight"},"momentum":{"roles":["transform"],"entry":["nervous"],"exit":["competitive"],"maintains":false,"basis":"Transformation / middle-to-late · entry: Threatened / escaping · exit: Superior / strike-back"},"motion":{"roles":["bridge"],"entry":["okay","calm","positive","energized","open","competitive","good"],"exit":[],"maintains":true,"basis":"Bridge / transition · Keep moving. Nothing needs to happen yet. (maintains: leaves the state it found)"},"neutral":{"roles":["bridge"],"entry":["unsure","okay","flat","open","positive","energized"],"exit":["energized"],"maintains":false,"basis":"Flexible / bridge / routing · entry: Unclear / I don't know · exit: Energized and content without imposed emotion"},"patience":{"roles":["meet","close"],"entry":["fired-up","okay","nervous","good","positive"],"exit":["calm"],"maintains":false,"basis":"Calm phase / recovery · entry: Receptive / busy / overexcited · exit: Relaxed and gently positive"},"presence":{"roles":["launch"],"entry":["good","positive","open","calm"],"exit":["ready"],"maintains":false,"basis":"Late preparation / final track · entry: Already reasonably good · exit: Alert, aware, ready without hype"},"reveal":{"roles":["meet","bridge"],"entry":["okay","good","open","positive","calm"],"exit":["open"],"maintains":false,"basis":"Beginning / bridge / travel / Just Me · Open → discover → explore → surprise → enjoy"},"rise":{"roles":["meet","bridge"],"entry":["okay","calm","down","open"],"exit":["positive"],"maintains":false,"basis":"Beginning / bridge / reflective development · Begin → grow → develop → rise → blossom"},"scary":{"roles":["adversity"],"entry":["good","okay","positive","calm","open"],"exit":["unresolved"],"maintains":false,"basis":"Specialized setup / adversity simulation · entry: Stable enough for deliberate discomfort · exit: Unresolved insecurity; must be resolved"},"steady":{"roles":["bridge"],"entry":["positive","good","competitive","energized"],"exit":[],"maintains":true,"basis":"Bridge / maintenance / longer sessions · Maintains and enriches an existing positive state (maintains: leaves the state it found)"}},"transform_after":{"_about":"After a transformation the athlete is 'competitive'. 'unresolved' (after Scary) must be resolved by a transform before anything else; this map says which transform functions can take it.","unresolved":["identity","master","depth","momentum"]},"_review":["2026-09-09: 'energized' and 'competitive' added to Light's entry and 'energized' to Clarity's so a long session has a good-mood bridge after the energy builds; the matrix says 'Good mood → smile → move' and 'flexible' for Light, 'middle or ending' for Clarity. MIZE to confirm.","2026-09-09: Clarity given the 'meet' role so a frustrated athlete choosing Recovery/Travel/Just me is met by reassurance (matrix entry 'Open / mixed / frustrated') rather than by an opener that ignores the frustration. MIZE to confirm.","2026-09-09: Adversity training is not built from a negative state (matrix: Scary 'should not automatically be given to an already nervous or insecure athlete'); the builder substitutes the Game arc and says so in notes.","2026-09-09: 'calm' and 'open' added to Scary's entry (matrix: 'Stable enough for deliberate discomfort'); a fired-up or flat athlete choosing Adversity training is first settled or opened by a meet track, then given Scary. MIZE to confirm.","2026-09-09: Recovery fill avoids activate-role functions (Drive, Force, Action, Ascent, Journey) so a recovery session cannot drift into an energy build."]};
  const XquiXSoundBuilder = (function () { const self = {}; const module = undefined;
/*
 * XquiX Sound Studio — session builder.  See soundbox/ARCHITECTURE.md §6.
 *
 *   buildSession(inputs, catalog, vocab) -> plan
 *
 *   inputs  { feeling, situation, minutes, collection? }
 *             feeling    one of vocab.states.feelings
 *             situation  one of Object.keys(vocab.situations)
 *             minutes    number
 *             collection 'xquix-sound' | 'perfect-piano' | 'mizes-fav' | 'mix' | undefined
 *   catalog { functions: [sound_functions rows], tracks: [sound_tracks rows] }
 *   vocab   soundbox/builder-vocabulary.json
 *
 * Pure and deterministic: no randomness, no I/O, no clock. The same inputs
 * against the same catalog always give the same plan, so an athlete can get
 * yesterday's session again and a test can pin every rule.
 *
 * Rules it enforces (ARCHITECTURE §6, "Selection rules"):
 *   1. a slot only takes a function holding the slot's role
 *   2. the next track's entry must include the current state; if nothing does,
 *      a bridge connector is tried first, and only then is the match relaxed —
 *      and the plan says so (plan.relaxed)
 *   3. a follow_up = 'required' function never closes a session
 *   4. guard = 'adversity_only' functions only appear in the adversity template
 *   5. transform functions only when the state is negative (or unresolved)
 *   6. no function repeats inside one session, across collections
 *   7. fill to the time budget; overshoot by at most one track
 *   8. only canonical or confirmed tracks are used
 * Works in Node (module.exports) and in the browser (window.XquiXSoundBuilder).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.XquiXSoundBuilder = factory();
})(typeof self !== "undefined" ? self : this, function () {

  const OK_VARIANTS = new Set(["canonical", "confirmed"]);

  function buildSession(inputs, catalog, vocab) {
    const notes = [];
    const feeling = inputs.feeling, situation = inputs.situation;
    if (!vocab.states.feelings.includes(feeling)) throw new Error(`unknown feeling ${feeling}`);
    let template = vocab.situations[situation];
    if (!template) throw new Error(`unknown situation ${situation}`);
    let situationApplied = situation;
    if (situation === "adversity" && vocab.states.negative.includes(feeling)) {
      // Matrix: Scary must not be handed to an already nervous or insecure athlete.
      template = vocab.situations.game; situationApplied = "game";
      notes.push(`adversity: not offered from '${feeling}'; built the game arc instead`);
    }
    const target = Math.round(Number(inputs.minutes) * 60);
    if (!(target > 0)) throw new Error("minutes must be positive");
    const negative = new Set(vocab.states.negative);
    const notes0 = notes.length;

    // --- eligible tracks per function, honoring collection preference -------
    const tracksByFn = {};
    for (const t of catalog.tracks) {
      if (t.status !== "active" || !OK_VARIANTS.has(t.variant_status)) continue;
      (tracksByFn[t.function_id] ??= []).push(t);
    }
    const fns = {};
    for (const f of catalog.functions) {
      const v = vocab.functions[f.id];
      if (f.status !== "approved" || !v || !tracksByFn[f.id]) continue;
      fns[f.id] = { ...f, v, tracks: tracksByFn[f.id] };
    }
    const collections = [...new Set(catalog.tracks.map(t => t.collection_id))].sort();
    let slotIndex = 0;
    function pickTrack(fn) {
      const ts = fn.tracks;
      const want = inputs.collection;
      if (want && want !== "mix") return ts.find(t => t.collection_id === want) || ts.find(t => t.variant_status === "canonical") || ts[0];
      if (want === "mix") {
        const order = collections.slice(slotIndex % collections.length).concat(collections.slice(0, slotIndex % collections.length));
        for (const c of order) { const t = ts.find(x => x.collection_id === c); if (t) return t; }
      }
      return ts.find(t => t.variant_status === "canonical") || ts[0];
    }
    const durOf = fn => Number(pickTrack(fn).duration_s);

    // --- state threading ---------------------------------------------------
    let state = feeling;
    const used = new Set();
    const plan = [];
    let elapsed = 0;

    const accepts = (fn, st) => {
      if (fn.v.entry.includes(st)) return true;
      if (st === "unresolved") return (vocab.transform_after.unresolved || []).includes(fn.id);
      return false;
    };
    const exitOf = (fn, st) => fn.v.maintains ? st : (fn.v.exit[0] || st);

    function candidates(roles, opts = {}) {
      const list = Object.values(fns).filter(fn =>
        !used.has(fn.id) &&
        fn.v.roles.some(r => roles.includes(r)) &&
        !(template.avoid_roles || []).some(r => fn.v.roles.includes(r) && !roles.includes(r) && !opts.closing) &&
        (situationApplied === "adversity" || fn.guard !== "adversity_only") &&
        (!fn.v.roles.includes("transform") || negative.has(state) || state === "unresolved" || opts.allowTransform) &&
        (!opts.closing || fn.follow_up !== "required") &&
        (!opts.exitIn || opts.exitIn.includes(exitOf(fn, state)))
      );
      const exact = list.filter(fn => accepts(fn, state));
      return { exact, any: list };
    }

    // Deterministic ordering: fit to the remaining budget first, then id.
    function best(list, room) {
      return list.slice().sort((a, b) => {
        const da = Math.abs(durOf(a) - room), db = Math.abs(durOf(b) - room);
        if (room != null && da !== db) return da - db;
        return a.id < b.id ? -1 : 1;
      })[0];
    }

    function take(fn, role, relaxed) {
      const t = pickTrack(fn);
      const d = Number(t.duration_s);
      plan.push({
        index: plan.length + 1, role, track_id: t.id, title: t.title, collection_id: t.collection_id, r2_key: t.r2_key,
        bpm: t.bpm == null ? null : Number(t.bpm),
        function_id: fn.id, function: fn.display_name, shorthand: fn.shorthand,
        activity: (fn.activities && fn.activities[0]) || null,
        duration_s: d, start_s: elapsed, state_in: state, state_out: exitOf(fn, state),
        relaxed: !!relaxed,
      });
      used.add(fn.id); elapsed += d; state = exitOf(fn, state); slotIndex++;
    }

    // Could the session still end on a real closer if `fn` were taken now?
    function canCloseAfter(fn) {
      const st = exitOf(fn, state);
      const closers = Object.values(fns).filter(c => c.id !== fn.id && !used.has(c.id) && c.follow_up !== "required" &&
        c.v.roles.some(r => template.close_roles.includes(r)) && (situationApplied === "adversity" || c.guard !== "adversity_only") && !c.v.roles.includes("transform"));
      if (closers.some(c => c.v.entry.includes(st))) return true;
      const bridges = Object.values(fns).filter(b => b.id !== fn.id && !used.has(b.id) && b.v.roles.includes("bridge") && b.v.entry.includes(st));
      return bridges.some(b => closers.some(c => c.id !== b.id && c.v.entry.includes(exitOf(b, st))));
    }

    // Estimated reserve for the closing track, so fill does not eat its time.
    function closeReserve() {
      const roles = template.close_roles;
      const c = candidates(roles, { closing: true, allowTransform: false }).any;
      if (!c.length) return 180;
      return Math.min(...c.map(durOf));
    }

    // --- walk the arc --------------------------------------------------------
    for (const step of template.arc) {
      const [kind, arg] = step.replace("?", "").split(":");
      const optional = step.endsWith("?");
      const remaining = target - elapsed;

      if (kind === "meet") {
        // A negative athlete is met by the transform, not by an opener.
        if (negative.has(state) && template.arc.some(s => s.startsWith("transform"))) continue;
        // An optional opener is only used when the next step cannot take the state as it is.
        if (optional) {
          const nextKind = (template.arc[template.arc.indexOf(step) + 1] || "").split(":")[0];
          if (nextKind === "adversity" && candidates(["adversity"]).exact.length) continue;
        }
        let { exact, any } = candidates(["meet"]);
        // 'meet:calm' (recovery) prefers an opener that settles the athlete;
        // a plain 'meet' (game, practice, travel) prefers one that does not.
        const calm = exact.filter(fn => exitOf(fn, state) === "calm"), lively = exact.filter(fn => exitOf(fn, state) !== "calm");
        if (arg === "calm" && calm.length) exact = calm;
        if (arg !== "calm" && lively.length) exact = lively;
        if (exact.length) take(best(exact, null), "meet", false);
        else if (any.length && !optional) { notes.push(`meet: no opener accepts '${state}', relaxed`); take(best(any, null), "meet", true); }
        continue;
      }
      if (kind === "transform") {
        if (!(negative.has(state) || state === "unresolved")) { if (!optional) notes.push("transform: state not negative, skipped"); continue; }
        const { exact, any } = candidates(["transform"]);
        if (exact.length) take(best(exact, null), "transform", false);
        else if (any.length) { notes.push(`transform: no transform accepts '${state}', relaxed`); take(best(any, null), "transform", true); }
        else notes.push(`transform: nothing available for '${state}'`);
        continue;
      }
      if (kind === "adversity") {
        const { exact, any } = candidates(["adversity"]);
        if (exact.length) take(best(exact, null), "adversity", false);
        else if (any.length) { notes.push(`adversity: entry relaxed from '${state}'`); take(best(any, null), "adversity", true); }
        else notes.push("adversity: no adversity track available");
        continue;
      }
      if (kind === "fill") {
        const roles = arg.split("|");
        const MIN = 45; // never add a track for less than 45 s of room
        for (let guard = 0; guard < 12; guard++) {
          const room = target - elapsed - closeReserve();
          if (room < MIN) break;
          let { exact, any } = candidates(roles);
          // Keep the last two possible closers out of the fill, or the session
          // ends on whatever is left rather than on a real closing track.
          const closers = candidates(template.close_roles, { closing: true }).any;
          if (closers.length <= 2) { const keep = new Set(closers.map(c => c.id)); exact = exact.filter(fn => !keep.has(fn.id)); any = any.filter(fn => !keep.has(fn.id)); }
          exact = exact.filter(canCloseAfter); any = any.filter(canCloseAfter);
          // Prefer an exact state match; otherwise a bridge connector; otherwise stop filling.
          let pick = exact.length ? best(exact, room) : null;
          if (!pick) {
            const conn = candidates(["bridge"]).exact.filter(fn => !(closers.length <= 2 && closers.some(c => c.id === fn.id))).filter(canCloseAfter);
            if (conn.length) pick = best(conn, room);
          }
          if (!pick) break;
          if (durOf(pick) > room + 60) {
            // Would overshoot by more than a minute: only allowed if nothing shorter fits.
            const shorter = (exact.length ? exact : any).filter(fn => durOf(fn) <= room + 60);
            if (!shorter.length) break;
            pick = best(shorter, room);
          }
          take(pick, pick.v.roles.includes("activate") && roles.includes("activate") ? "activate" : "bridge", false);
        }
        if (target - elapsed - closeReserve() >= MIN) notes.push(`fill: ran out of eligible tracks at '${state}' with ${Math.round(target - elapsed - closeReserve())}s unfilled`);
        continue;
      }
      if (kind === "launch" || kind === "close") {
        let chosen = null, relaxed = false;
        for (const role of template.close_roles) {
          const { exact } = candidates([role], { closing: true });
          if (exact.length) { chosen = best(exact, target - elapsed); break; }
        }
        if (!chosen) {
          // Try one bridge connector that leads into a valid closer.
          for (const role of template.close_roles) {
            const closers = candidates([role], { closing: true }).any;
            const exits = new Set(closers.flatMap(c => c.v.entry));
            const conn = candidates(["bridge"], { exitIn: [...exits] }).exact;
            if (conn.length && closers.length) {
              take(best(conn, null), "bridge", false);
              const { exact } = candidates([role], { closing: true });
              if (exact.length) { chosen = best(exact, target - elapsed); break; }
            }
          }
        }
        if (!chosen) {
          for (const role of template.close_roles) {
            const { any } = candidates([role], { closing: true });
            if (any.length) { chosen = best(any, target - elapsed); relaxed = true; notes.push(`${kind}: no closer accepts '${state}', relaxed`); break; }
          }
        }
        if (chosen) take(chosen, kind, relaxed);
        else notes.push(`${kind}: no eligible closing track`);
        continue;
      }
    }

    return {
      inputs: { ...inputs, entry_state: feeling },
      situation, situation_applied: situationApplied, target_s: target, total_s: elapsed,
      plan, final_state: state,
      relaxed: plan.some(p => p.relaxed),
      notes,
    };
  }

  function describe(session) {
    const m = s => { s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
    const lines = [`${session.inputs.feeling} · ${session.situation} · ${session.inputs.minutes} min  →  ${m(session.total_s)} of ${m(session.target_s)}${session.relaxed ? "  (relaxed)" : ""}`];
    for (const p of session.plan) lines.push(`  ${p.index}. [${p.role.padEnd(9)}] ${p.function.padEnd(11)} ${m(p.duration_s)}  ${p.state_in} → ${p.state_out}${p.relaxed ? "  !" : ""}   “${p.shorthand || ""}”`);
    for (const n of session.notes) lines.push(`  note: ${n}`);
    return lines.join("\n");
  }

  return { buildSession, describe };
});

return self.XquiXSoundBuilder; })();

  const config = {
    supabaseUrl: "https://asmmplnwbzlnmsctbhmx.supabase.co",
    supabaseKey: "sb_publishable_ncm3IqQ2v7FvJCIQ5Z8d-A_-MR-n5_k",
    audioBase: "https://sound.xquix.com/",
    crossfadeSeconds: 3,
    // The Studio sets this to return the signed-in user's access token, so
    // sessions can be saved. Returning null means "don't save" — never an error.
    getAccessToken: async () => null,
    // Stage integration (STAGE-HOOKS-CONTRACT.md §"Mounting"): an element or
    // selector to render inside instead of covering the viewport. The host
    // gives that element its size and position:relative; the overlay fills it.
    mount: null,
    background: "#0b0f14",   // "transparent" lets a stage canvas show through
    // Real audio analysis for onLevel/analyser(): "auto" = on when a host set
    // onLevel before start(); true/false force. Needs CORS on the bucket —
    // checked once at start(); silently off if the check fails.
    analyse: "auto",
    // "one" asks the three questions one screen at a time, advancing on each
    // answer (decided 2026-09-13); "all" is the original single page.
    questions: "one",
  };

  const FEELINGS = [
    ["down", "Down"], ["nervous", "Nervous"], ["unsure", "Unsure"], ["flat", "Flat"],
    ["frustrated", "Frustrated"], ["okay", "Okay"], ["good", "Good"], ["fired-up", "Fired up"],
  ];
  const SITUATIONS = [
    ["game", "Game"], ["practice", "Practice"], ["recovery", "Recovery"],
    ["travel", "Travel"], ["just-me", "Just me"], ["adversity", "Adversity training"],
  ];
  const MINUTES = [10, 20, 30, 45];

  const CSS = `
#xqSoundStudio{position:fixed;inset:0;z-index:100000;background:var(--xqss-bg,#0b0f14);color:#e8edf2;font:15px/1.45 -apple-system,BlinkMacSystemFont,"DM Sans","Segoe UI",sans-serif;overflow:hidden;display:flex;flex-direction:column}
#xqSoundStudio.xqss-embedded{position:absolute;z-index:auto}
#xqSoundStudio *{box-sizing:border-box}
#xqSoundStudio p{text-align:left;max-width:none;margin:8px 0}
#xqSoundStudio button{font-family:inherit;text-transform:none;letter-spacing:0;line-height:1.2;-webkit-appearance:none;appearance:none}
#xqSoundStudio .xqss-top{display:flex;align-items:center;gap:10px;padding:max(12px,env(safe-area-inset-top)) 16px 10px;border-bottom:1px solid #1e2a33}
#xqSoundStudio .xqss-top button{background:none;border:1px solid #2a5f5c;color:#cfeaea;border-radius:8px;padding:6px 9px;font-size:12px;font-weight:800;cursor:pointer;white-space:nowrap}
#xqSoundStudio .xqss-top h1{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#00d4aa;margin:0;flex:1;white-space:nowrap;font-weight:700}
#xqSoundStudio .xqss-tabs{display:flex;gap:6px}
#xqSoundStudio .xqss-tabs button.on{background:#00d4aa;color:#062;border-color:#00d4aa}
#xqSoundStudio .xqss-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:16px 16px 140px}
#xqSoundStudio h2{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#f5c623;margin:18px 0 8px}
#xqSoundStudio .xqss-chips{display:flex;flex-wrap:wrap;gap:8px}
#xqSoundStudio .xqss-trail{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
#xqSoundStudio .xqss-trail .xqss-chip{padding:5px 11px;font-size:12px}
#xqSoundStudio .xqss-stepn{margin-top:14px;font-variant-numeric:tabular-nums}
#xqSoundStudio .xqss-chip{border:1px solid #1e2a33;background:#121820;color:#c9d3dc;border-radius:999px;padding:9px 14px;font-size:14px;cursor:pointer;user-select:none;touch-action:manipulation}
#xqSoundStudio .xqss-chip.on{border-color:#00d4aa;color:#00d4aa;background:#0f1f1d}
#xqSoundStudio .xqss-primary{display:block;width:100%;margin-top:24px;padding:14px;border-radius:12px;border:0;background:#00d4aa;color:#06261f;font-size:15px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;cursor:pointer}
#xqSoundStudio .xqss-primary:disabled{opacity:.35;cursor:default}
#xqSoundStudio .xqss-muted{color:#8a98a6;font-size:13px}
#xqSoundStudio .xqss-plan{list-style:none;margin:0;padding:0}
#xqSoundStudio .xqss-plan li{display:grid;grid-template-columns:26px 1fr auto;gap:10px;padding:10px 0;border-top:1px solid #1e2a33;align-items:center;cursor:pointer}
#xqSoundStudio .xqss-plan li.now{color:#00d4aa}
#xqSoundStudio .xqss-plan li.done{opacity:.45}
#xqSoundStudio .xqss-plan .n{color:#8a98a6;font-variant-numeric:tabular-nums}
#xqSoundStudio .xqss-plan .f{font-weight:700}
#xqSoundStudio .xqss-plan .f small{display:block;font-weight:400;color:#8a98a6;font-style:italic}
#xqSoundStudio .xqss-plan .d{color:#8a98a6;font-variant-numeric:tabular-nums}
#xqSoundStudio .xqss-note{background:#121820;border:1px solid #1e2a33;border-radius:10px;padding:10px 12px;color:#8a98a6;font-size:13px;margin-top:12px}
#xqSoundStudio .xqss-player{position:absolute;left:0;right:0;bottom:0;background:#0f151c;border-top:1px solid #1e2a33;padding:12px 16px max(12px,env(safe-area-inset-bottom))}
#xqSoundStudio .xqss-player .now{font-weight:700}
#xqSoundStudio .xqss-player .now small{display:block;font-weight:400;color:#00d4aa;font-style:italic}
#xqSoundStudio .xqss-player .act{color:#c9d3dc;font-size:13px;margin-top:4px;min-height:18px}
#xqSoundStudio .xqss-bar{height:4px;background:#1e2a33;border-radius:2px;margin:10px 0 8px;overflow:hidden}
#xqSoundStudio .xqss-bar i{display:block;height:100%;width:0;background:#00d4aa}
#xqSoundStudio .xqss-ctl{display:flex;align-items:center;gap:14px;justify-content:center}
#xqSoundStudio .xqss-ctl button{width:44px;height:44px;border-radius:50%;border:1px solid #2a5f5c;background:transparent;color:#cfeaea;font-size:16px;cursor:pointer}
#xqSoundStudio .xqss-ctl button.big{width:56px;height:56px;background:#00d4aa;border-color:#00d4aa;color:#06261f;font-size:20px}
#xqSoundStudio .xqss-ctl .t{color:#8a98a6;font-size:12px;font-variant-numeric:tabular-nums;min-width:84px;text-align:center}
#xqSoundStudio .xqss-rate{display:flex;gap:8px;justify-content:center;margin:14px 0}
#xqSoundStudio .xqss-rate button{width:40px;height:40px;border-radius:50%;border:1px solid #1e2a33;background:#121820;color:#c9d3dc;cursor:pointer}
#xqSoundStudio .xqss-rate button.on{border-color:#f5c623;color:#f5c623}
#xqSoundStudio .xqss-fn{display:grid;grid-template-columns:1fr auto;gap:8px;padding:10px 0;border-top:1px solid #1e2a33;align-items:start}
#xqSoundStudio .xqss-fn .short{color:#00d4aa;font-style:italic;font-size:13px}
#xqSoundStudio .xqss-fn .tag{font-size:10px;letter-spacing:.08em;text-transform:uppercase;border:1px solid #1e2a33;border-radius:4px;padding:1px 6px;color:#8a98a6;margin-left:6px}
#xqSoundStudio .xqss-fn .tr{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
#xqSoundStudio .xqss-fn .tr button{border:1px solid #2a5f5c;background:transparent;color:#cfeaea;border-radius:999px;padding:5px 10px;font-size:12px;cursor:pointer}
#xqSoundStudio .xqss-fn .tr button.playing{background:#00d4aa;color:#06261f;border-color:#00d4aa}
#xqSoundStudio .xqss-err{color:#e5636b;padding:12px 0}
`;

  // ---------------------------------------------------------------- state --
  let el = null, styleEl = null, catalog = null, session = null, view = "ask";
  let answers = { feeling: null, situation: null, minutes: 20, collection: null };
  let step = 0, reached = 0;   // question index in "one" mode, and the furthest one seen
  let player = null;
  const listeners = [];
  const on = (t, ev, fn) => { t.addEventListener(ev, fn); listeners.push([t, ev, fn]); };

  // ------------------------------------------------------------- catalog --
  async function api(table, q, opts = {}) {
    const headers = { apikey: config.supabaseKey, Authorization: `Bearer ${opts.token || config.supabaseKey}`, "Content-Type": "application/json", Prefer: opts.prefer || "" };
    const r = await fetch(`${config.supabaseUrl}/rest/v1/${table}${q ? "?" + q : ""}`, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (!r.ok) throw new Error(`${table}: HTTP ${r.status}`);
    return r.status === 204 ? null : r.json();
  }
  async function loadCatalog() {
    const [collections, functions, tracks] = await Promise.all([
      api("sound_collections", "select=*&order=sort_order"),
      api("sound_functions", "select=*&order=display_name"),
      api("sound_tracks", "select=*&order=collection_id,function_id"),
    ]);
    return { collections, functions, tracks };
  }

  // ------------------------------------------------------------ analysis --
  // The real signal for a stage: a Web Audio AnalyserNode on whatever is
  // playing, read every animation frame into onLevel({bass,mid,high,level,hit}).
  // A cross-origin <audio> only feeds Web Audio when it was loaded with
  // crossOrigin="anonymous" AND the bucket answered with CORS headers —
  // otherwise the graph plays silence. So: probe once, enable only on a pass,
  // and never touch the elements' CORS mode when the probe fails.
  const analysis = { wanted: false, ok: null, ctx: null, node: null, srcA: null, srcB: null, raf: null, lastHit: 0 };
  function analysisWanted() {
    const a = config.analyse;
    if (a === true || a === false) return a;
    return typeof (root.MIZE.SoundStudio && root.MIZE.SoundStudio.onLevel) === "function";
  }
  async function probeCors(cat) {
    if (analysis.ok !== null) return analysis.ok;
    try {
      // Probe a track, not a cover: Cloudflare edge-caches images by default
      // and a cover cached before the CORS policy was set answers without the
      // headers for as long as it lives in cache (seen 2026-09-13); MP3 is not
      // in the default cacheable extensions, so a track answers fresh.
      const trk = cat && cat.tracks.find(t => t.status === "active");
      const col = cat && cat.collections.find(c => c.cover_key);
      const key = trk ? trk.r2_key : col ? col.cover_key : null;
      if (!key) { analysis.ok = false; return false; }
      const r = await fetch(config.audioBase + key, { mode: "cors", cache: "no-store", headers: { Range: "bytes=0-1" } });
      if (r.body && r.body.cancel) r.body.cancel().catch(() => {});
      analysis.ok = r.type === "cors" && (r.ok || r.status === 206);
    } catch (e) { analysis.ok = false; }
    if (!analysis.ok) console.warn("[SoundStudio] onLevel is off: " + config.audioBase + " does not answer with CORS headers for this origin. Add a CORS policy on the R2 bucket (AllowedOrigins [\"*\"], AllowedMethods [\"GET\",\"HEAD\"], AllowedHeaders [\"Range\"]).");
    return analysis.ok;
  }
  // The AudioContext is created separately from the media sources so a host
  // can create it inside a user gesture (prime()) before the CORS probe has
  // answered; sources are attached only once the probe passed.
  function analysisEnsureCtx() {
    if (analysis.ctx) return analysis.ctx;
    const AC = root.AudioContext || root.webkitAudioContext; if (!AC) return null;
    try { analysis.ctx = new AC(); } catch (e) { analysis.ctx = null; }
    return analysis.ctx;
  }
  function analysisAttach(A, B) {
    if (analysis.node || !analysis.ok) return;
    const ctx = analysisEnsureCtx(); if (!ctx) { analysis.ok = false; return; }
    try {
      // No analyser smoothing: onsets need frame-to-frame contrast. Bands are
      // smoothed here instead, gently, for the stage's benefit.
      const node = ctx.createAnalyser(); node.fftSize = 2048; node.smoothingTimeConstant = 0;
      analysis.srcA = ctx.createMediaElementSource(A); analysis.srcB = ctx.createMediaElementSource(B);
      analysis.srcA.connect(node); analysis.srcB.connect(node); node.connect(ctx.destination);
      analysis.node = node;
      analysis.freq = new Float32Array(node.frequencyBinCount); analysis.prev = new Float32Array(node.frequencyBinCount).fill(-100);
      analysis.time = new Uint8Array(1024);
      analysis.sm = { bass: 0, mid: 0, high: 0, level: 0 }; analysis.fluxMean = 0; analysis.fluxVar = 0; analysis.fluxPrev = 0; analysis.lastHit = 0;
    } catch (e) { analysis.ok = false; analysis.node = null; }
  }
  function analysisFrame() {
    analysis.raf = null;
    const n = analysis.node, cb = root.MIZE.SoundStudio && root.MIZE.SoundStudio.onLevel;
    if (!n || !player || player.cur.paused) return;
    const F = analysis.freq, P = analysis.prev;
    n.getFloatFrequencyData(F); n.getByteTimeDomainData(analysis.time);
    for (let i = 0; i < F.length; i++) if (!(F[i] > -120)) F[i] = -120;      // silence is -Infinity in float data
    const hz = analysis.ctx.sampleRate / n.fftSize;                     // Hz per bin
    const bin = h => Math.min(F.length - 1, Math.max(1, Math.round(h / hz)));
    // Band energy: mean dB over the band, mapped -70…-10 dBFS → 0…1.
    const bandDb = (lo, hi) => { let s = 0, c = 0; for (let i = bin(lo); i <= bin(hi); i++) { s += F[i]; c++; } return s / c; };
    // Mapped per band onto the range the normalised catalogue actually spans
    // (measured across the XquiX Sound tracks), so each lands in 0…1 with room
    // to move: bass −65…−30 dB, mid −85…−50, high −105…−60. Relative, not
    // calibrated — a stage reads shape and motion from these, not physics.
    const band = (lo, hi, a, b) => Math.max(0, Math.min(1, (bandDb(lo, hi) - a) / (b - a)));
    // Onset: positive spectral flux in the kick band (30–180 Hz), thresholded
    // against its own running mean + 1.8σ, taken on the rising edge, 200 ms
    // refractory (300 BPM). This is what a real drum hit looks like even when
    // the bass is sustained — level alone cannot tell them apart.
    let flux = 0; for (let i = bin(30); i <= bin(180); i++) { const d = F[i] - P[i]; if (d > 0) flux += d; }
    P.set(F);
    const m = analysis.fluxMean, v = analysis.fluxVar;
    const thr = m + 1.8 * Math.sqrt(v);
    const now = performance.now();
    const hit = flux > thr && flux > 6 && analysis.fluxPrev <= thr && now - analysis.lastHit > 200;
    analysis.fluxMean = m * 0.95 + flux * 0.05; analysis.fluxVar = v * 0.95 + (flux - m) * (flux - m) * 0.05; analysis.fluxPrev = flux;
    if (hit) analysis.lastHit = now;
    let sq = 0; for (let i = 0; i < analysis.time.length; i++) { const x = (analysis.time[i] - 128) / 128; sq += x * x; }
    const raw = { bass: band(20, 150, -65, -30), mid: band(150, 2000, -85, -50), high: band(2000, 8000, -105, -60), level: Math.min(1, Math.sqrt(sq / analysis.time.length) * 2.5) };
    const sm = analysis.sm; for (const k in raw) sm[k] = sm[k] * 0.6 + raw[k] * 0.4;
    if (typeof cb === "function") { try { cb({ bass: sm.bass, mid: sm.mid, high: sm.high, level: sm.level, hit, t: player.cur.currentTime || 0 }); } catch (e) {} }
    analysis.raf = requestAnimationFrame(analysisFrame);
  }
  function analysisResume() { if (analysis.ctx && analysis.ctx.state !== "running") { try { analysis.ctx.resume().catch(() => {}); } catch (e) {} } }
  function analysisRun() { analysisResume(); if (analysis.node && !analysis.raf) analysis.raf = requestAnimationFrame(analysisFrame); }
  function analysisStop() { if (analysis.raf) { cancelAnimationFrame(analysis.raf); analysis.raf = null; } }
  function analysisClose() {
    analysisStop();
    if (analysis.ctx) { try { analysis.ctx.close(); } catch (e) {} }
    analysis.ctx = analysis.node = analysis.srcA = analysis.srcB = null; analysis.lastHit = 0; analysis.primed = false;
  }

  // -------------------------------------------------------------- player --
  // Two <audio> elements alternate so one track can fade into the next.
  function makePlayer() {
    const A = new Audio(), B = new Audio();
    [A, B].forEach(a => { a.preload = "auto"; a.crossOrigin = null; });
    const p = { a: A, b: B, cur: A, idx: -1, plan: [], fading: false, timer: null, onchange: () => {} };
    // Switch both elements to CORS mode and build the analysis graph — only
    // once the probe passed, and before any src is set for the new mode.
    p.arm = () => { if (analysis.ok && !analysis.node) { [A, B].forEach(a => { a.crossOrigin = "anonymous"; }); analysisAttach(A, B); } };
    // prime(): run inside a user gesture. Unlocks both <audio> elements for
    // later play() calls that come from timers (a countdown), and creates /
    // resumes the AudioContext while the gesture is live. Safari refuses both
    // otherwise — the music simply never starts, with no error on screen.
    const SILENT = "data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    p.prime = () => {
      if (analysis.wanted) { analysisEnsureCtx(); analysisResume(); }
      [A, B].forEach(a => {
        if (a._primed || (a.src && !a.paused)) return;
        try {
          a.src = SILENT;
          const pr = a.play();
          const done = () => { if (a.src === SILENT || a.currentSrc === SILENT) { a.pause(); a.removeAttribute("src"); a.load(); } a._primed = true; };
          if (pr && pr.then) pr.then(done, () => {}); else done();
        } catch (e) {}
      });
      analysis.primed = true;
    };

    p.load = (plan) => { p.plan = plan; p.idx = -1; };

    // --- host callbacks (stage hooks, brief SOUNDBOX-STAGE-HOOKS 2026-09-12) --
    // onTrackChange fires once per actual track start; onBeat ticks on a
    // setInterval derived from the track's measured BPM. Both are optional,
    // both are wrapped so a host error can never reach the module.
    let beatTimer = null, beat = 0, beatBpm = null;
    function stopBeatClock() { if (beatTimer) { clearInterval(beatTimer); beatTimer = null; } beat = 0; beatBpm = null; }
    function runBeatClock() {
      if (beatTimer || !beatBpm) return;
      beatTimer = setInterval(() => {
        beat++;
        const cb = root.MIZE.SoundStudio && root.MIZE.SoundStudio.onBeat;
        if (typeof cb === "function") { try { cb({ beat, bpm: beatBpm }); } catch (e) {} }
      }, Math.round(60000 / beatBpm));
    }
    function startBeatClock(bpm) { stopBeatClock(); if (!(bpm > 0)) return; beatBpm = bpm; runBeatClock(); }
    // The clock pauses with the music and resumes without resetting the count.
    function pauseBeatClock() { if (beatTimer) { clearInterval(beatTimer); beatTimer = null; } }
    function announce(i) {
      const t = p.plan[i]; if (!t) return;
      const cb = root.MIZE.SoundStudio && root.MIZE.SoundStudio.onTrackChange;
      if (typeof cb === "function") {
        try {
          cb({ title: t.title, bpm: t.bpm == null ? null : Number(t.bpm), coverKey: t.cover_key || null, coverBase: config.audioBase,
               trackIndex: i + 1, total: p.plan.length, role: t.role || "track", function: t.function || null, trackId: t.track_id || t.id || null });
        } catch (e) {}
      }
      startBeatClock(t.bpm == null ? null : Number(t.bpm));
    }
    p._beat = { stop: stopBeatClock, pause: pauseBeatClock, run: runBeatClock };
    p.playIndex = (i) => {
      if (i < 0 || i >= p.plan.length) return p.stop();
      const next = (p.cur === A ? B : A);
      const src = config.audioBase + p.plan[i].r2_key;
      stopBeatClock(); p.arm();
      p.cur.pause(); p.cur.volume = 1;
      next.src = src; next.volume = 1;
      p.cur = next; p.idx = i;
      analysisResume();
      const ctxState = () => analysis.ctx ? analysis.ctx.state : "none";
      const trackId = p.plan[i].track_id || p.plan[i].id;
      console.info("[SoundStudio] play " + trackId + " | ctx=" + ctxState() + " routed=" + !!analysis.node + " primed=" + !!next._primed + " crossOrigin=" + next.crossOrigin);
      next.play().then(() => {
        // 1.5 s later: is time actually advancing, and is the context running? If not, say so and retry once.
        const t0 = next.currentTime;
        setTimeout(() => {
          if (p.cur !== next || next.paused) return;
          const advanced = next.currentTime > t0 + 0.2;
          const cs = ctxState();
          if (!advanced || (analysis.node && cs !== "running")) {
            console.warn("[SoundStudio] " + trackId + " after 1.5 s: currentTime " + t0.toFixed(2) + "→" + next.currentTime.toFixed(2) + ", readyState=" + next.readyState + ", networkState=" + next.networkState + ", error=" + (next.error ? next.error.code + " " + next.error.message : "none") + ", ctx=" + cs + ", muted=" + next.muted + ", volume=" + next.volume + " — retrying resume()+play()");
            analysisResume(); next.play().catch(() => {});
          } else console.info("[SoundStudio] " + trackId + " playing: currentTime " + next.currentTime.toFixed(2) + ", ctx=" + cs);
        }, 1500);
      }).catch(e => { console.warn("[SoundStudio] play() was blocked by the browser (" + (e && e.name) + "). Call MIZE.SoundStudio.prime() inside the tap that leads to playback — e.g. the tap that starts a countdown."); });
      p.onchange();
      mediaSession(p);
      announce(i);
    };
    p.toggle = () => { if (p.idx < 0) return p.playIndex(0); if (p.cur.paused) { analysisResume(); p.cur.play().catch(() => {}); } else p.cur.pause(); p.onchange(); };
    p.next = () => p.playIndex(p.idx + 1);
    p.prev = () => (p.cur.currentTime > 5 ? (p.cur.currentTime = 0) : p.playIndex(Math.max(0, p.idx - 1)));
    p.stop = () => { stopBeatClock(); analysisStop(); [A, B].forEach(a => { a.pause(); a.removeAttribute("src"); a.load(); }); p.idx = -1; p.fading = false; p.onchange(); };
    // Crossfade: when the current track is within N seconds of its end, start
    // the next one quietly and swap the volumes over those seconds.
    function tick() {
      const c = p.cur, n = config.crossfadeSeconds;
      if (!p.fading && p.idx >= 0 && p.idx + 1 < p.plan.length && c.duration && c.duration - c.currentTime <= n) {
        p.fading = true;
        const from = c, to = (c === A ? B : A);
        to.src = config.audioBase + p.plan[p.idx + 1].r2_key; to.volume = 0; to.play().catch(() => {});
        const t0 = performance.now();
        const step = () => {
          const k = Math.min(1, (performance.now() - t0) / (n * 1000));
          from.volume = 1 - k; to.volume = k;
          if (k < 1 && p.fading) requestAnimationFrame(step);
          else { from.pause(); from.volume = 1; p.cur = to; p.idx += 1; p.fading = false; p.onchange(); mediaSession(p); announce(p.idx); }
        };
        requestAnimationFrame(step);
      }
      p.onchange("time");
    }
    [A, B].forEach(a => { on(a, "timeupdate", tick); on(a, "ended", () => { if (!p.fading) p.next(); }); on(a, "play", () => { if (a === p.cur) runBeatClock(); analysisRun(); p.onchange(); }); on(a, "pause", () => { if (a === p.cur && !p.fading) { pauseBeatClock(); analysisStop(); } p.onchange(); }); });
    return p;
  }
  function mediaSession(p) {
    if (!("mediaSession" in navigator) || p.idx < 0) return;
    const t = p.plan[p.idx];
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.function, artist: "XquiX Sound Box", album: t.shorthand || "" });
      navigator.mediaSession.setActionHandler("play", () => p.cur.play());
      navigator.mediaSession.setActionHandler("pause", () => p.cur.pause());
      navigator.mediaSession.setActionHandler("nexttrack", p.next);
      navigator.mediaSession.setActionHandler("previoustrack", p.prev);
    } catch (e) { /* not supported */ }
  }
  function releaseMediaSession() {
    if (!("mediaSession" in navigator)) return;
    try { navigator.mediaSession.metadata = null; ["play", "pause", "nexttrack", "previoustrack"].forEach(a => navigator.mediaSession.setActionHandler(a, null)); } catch (e) {}
  }

  // ------------------------------------------------------------ sessions --
  function jwtSub(token) { try { return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub; } catch (e) { return null; } }
  async function saveSession(s, rating) {
    const token = await config.getAccessToken().catch(() => null);
    const uid = token && jwtSub(token);
    if (!uid) return null;
    const body = {
      user_id: uid,
      inputs: { entry_state: s.inputs.entry_state, situation: s.situation, minutes: s.inputs.minutes, collection: s.inputs.collection || null },
      feeling_raw: s.inputs.feeling,
      plan: s.plan.map(p => ({ track_id: p.track_id, role: p.role, start_s: p.start_s, activity: p.activity })),
      started_at: s.started_at || null, completed_at: new Date().toISOString(), rating: rating || null,
    };
    return api("sound_sessions", "", { method: "POST", body, token, prefer: "return=minimal" }).catch(() => null);
  }

  // ---------------------------------------------------------------- view --
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = s => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

  function render() {
    if (!el) return;
    const body = el.querySelector(".xqss-body");
    el.querySelectorAll(".xqss-tabs button").forEach(b => b.classList.toggle("on", b.dataset.view === view));
    if (view === "ask") body.innerHTML = renderAsk();
    else if (view === "session") body.innerHTML = renderSession();
    else body.innerHTML = renderBox();
    el.querySelector(".xqss-player").hidden = !(player && player.idx >= 0) && view !== "session";
    bind();
    renderPlayer();
  }

  function usableCollections() {
    if (!catalog) return [];
    const ok = new Set(catalog.tracks.filter(t => t.status === "active" && ["canonical", "confirmed"].includes(t.variant_status)).map(t => t.collection_id));
    return catalog.collections.filter(c => ok.has(c.id));
  }

  const LABEL = { feeling: v => (FEELINGS.find(f => f[0] === v) || [])[1], situation: v => (SITUATIONS.find(f => f[0] === v) || [])[1],
                  minutes: v => `${v} min`, collection: v => v === "mix" ? "Mix" : v ? esc((usableCollections().find(c => c.id === v) || {}).display_name || v) : "XquiX Sound" };
  function questionList() {
    const cols = usableCollections();
    const q = [
      { id: "feeling", title: "How do you feel?", chips: FEELINGS.map(([v, l]) => [v, l]) },
      { id: "situation", title: "What's ahead?", chips: SITUATIONS.map(([v, l]) => [v, l]) },
      { id: "minutes", title: "How long?", chips: MINUTES.map(m => [m, `${m} min`]) },
    ];
    if (cols.length > 1) q.push({ id: "collection", title: "Sound", chips: [["", "XquiX Sound"], ...cols.filter(c => c.id !== "xquix-sound").map(c => [c.id, esc(c.display_name)]), ["mix", "Mix"]] });
    return q;
  }
  const isOn = (id, v) => (id === "collection" ? (answers.collection || "") === v : answers[id] === v);
  const chipsFor = q => `<div class="xqss-chips" data-q="${q.id}">${q.chips.map(([v, l]) => `<button class="xqss-chip${isOn(q.id, v) ? " on" : ""}" data-v="${v}">${l}</button>`).join("")}</div>`;

  function renderAsk() {
    const qs = questionList();
    if (config.questions !== "one") {
      return qs.map(q => `<h2>${q.title}</h2>${chipsFor(q)}`).join("") +
        `<button class="xqss-primary" data-act="build" ${answers.feeling && answers.situation ? "" : "disabled"}>Build my session</button>
      ${catalog ? "" : `<p class="xqss-muted" style="margin-top:12px">Loading the Sound Box…</p>`}
      <div class="xqss-err" id="xqss-err" hidden></div>`;
    }
    // One question per screen. Answered questions collapse into a row of
    // chips above; tapping one reopens that question.
    step = Math.max(0, Math.min(step, qs.length)); reached = Math.max(reached, step);
    const done = qs.slice(0, step).filter(q => q.id === "minutes" || q.id === "collection" || answers[q.id] != null);
    const trail = done.length ? `<div class="xqss-trail">${done.map(q => `<button class="xqss-chip on" data-step="${qs.indexOf(q)}">${LABEL[q.id](q.id === "collection" ? (answers.collection || "") : answers[q.id])}</button>`).join("")}</div>` : "";
    const q = qs[step];
    const body = q
      ? `<h2>${q.title}</h2>${chipsFor(q)}<p class="xqss-muted xqss-stepn">${step + 1} / ${qs.length}</p>`
      : `<h2>Ready</h2><p class="xqss-muted">Tap an answer above to change it.</p>
         <button class="xqss-primary" data-act="build" ${answers.feeling && answers.situation ? "" : "disabled"}>Build my session</button>`;
    return `${trail}${body}
      ${catalog ? "" : `<p class="xqss-muted" style="margin-top:12px">Loading the Sound Box…</p>`}
      <div class="xqss-err" id="xqss-err" hidden></div>`;
  }

  function renderSession() {
    if (!session) return `<p class="xqss-muted">No session yet.</p>`;
    const cur = player ? player.idx : -1;
    const items = session.plan.map((p, i) => `
      <li class="${i === cur ? "now" : i < cur ? "done" : ""}" data-i="${i}">
        <span class="n">${i + 1}</span>
        <span class="f">${esc(p.function)}<small>${esc(p.shorthand || "")}</small></span>
        <span class="d">${fmt(p.duration_s)}</span>
      </li>`).join("");
    const shortNote = session.notes.find(n => n.startsWith("fill: ran out"));
    const advNote = session.notes.find(n => n.startsWith("adversity: not offered"));
    return `
      <p class="xqss-muted">${FEELINGS.find(f => f[0] === session.inputs.feeling)[1]} · ${SITUATIONS.find(s => s[0] === session.situation)[1]} · ${fmt(session.total_s)}</p>
      <ul class="xqss-plan">${items}</ul>
      ${advNote ? `<div class="xqss-note">Adversity training starts from a stable place. Since you're feeling ${esc(session.inputs.feeling)}, this is a game session instead.</div>` : ""}
      ${shortNote ? `<div class="xqss-note">The Sound Box has enough for ${fmt(session.total_s)} of this kind of session right now.</div>` : ""}
      ${cur < 0 ? `<button class="xqss-primary" data-act="start">Start</button>` : ""}
      ${session.ended ? `<h2>How was it?</h2><div class="xqss-rate">${[1, 2, 3, 4, 5].map(n => `<button data-rate="${n}" class="${session.rating === n ? "on" : ""}">${n}</button>`).join("")}</div><button class="xqss-primary" data-act="new">New session</button>` : ""}`;
  }

  function renderBox() {
    if (!catalog) return `<p class="xqss-muted">Loading…</p>`;
    const byFn = {}; catalog.tracks.filter(t => t.status === "active").forEach(t => (byFn[t.function_id] ??= []).push(t));
    const colName = id => (catalog.collections.find(c => c.id === id) || {}).display_name || id;
    const approved = catalog.functions.filter(f => f.status === "approved"), pending = catalog.functions.filter(f => f.status !== "approved");
    const row = f => `
      <div class="xqss-fn">
        <div><b>${esc(f.display_name)}</b>${f.status !== "approved" ? '<span class="tag">unreviewed</span>' : ""}${f.guard ? '<span class="tag">adversity only</span>' : ""}
          <div class="short">${esc(f.shorthand || "")}</div>
          <div class="xqss-muted">${(f.journey || []).join(" → ")}</div></div>
        <div class="tr">${(byFn[f.id] || []).map(t => `<button data-box="${esc(t.id)}" title="${esc(t.title)}">${esc(colName(t.collection_id))}${t.variant_status === "unverified" ? " ·?" : ""}</button>`).join("") || `<span class="xqss-muted">no audio</span>`}</div>
      </div>`;
    return `<p class="xqss-muted">Every function, every rendering. “·?” marks a version not yet confirmed by listening.</p>
      ${approved.map(row).join("")}
      ${pending.length ? `<h2>Awaiting a listening description</h2>${pending.map(row).join("")}` : ""}`;
  }

  function renderPlayer() {
    const pl = el && el.querySelector(".xqss-player"); if (!pl) return;
    const p = player;
    const active = p && p.idx >= 0 && p.plan[p.idx];
    pl.hidden = !active && view !== "session";
    if (!active) { pl.querySelector(".now").innerHTML = `Ready<small>${session ? "Press start when you are." : "Build a session first."}</small>`; pl.querySelector(".act").textContent = ""; pl.querySelector(".xqss-bar i").style.width = "0"; pl.querySelector(".t").textContent = "0:00 / 0:00"; pl.querySelector(".big").textContent = "▶"; return; }
    const t = p.plan[p.idx], a = p.cur;
    pl.querySelector(".now").innerHTML = `${esc(t.function)}<small>${esc(t.shorthand || "")}</small>`;
    pl.querySelector(".act").textContent = t.activity || "";
    pl.querySelector(".xqss-bar i").style.width = a.duration ? `${(a.currentTime / a.duration) * 100}%` : "0";
    pl.querySelector(".t").textContent = `${fmt(a.currentTime)} / ${fmt(a.duration || t.duration_s)}`;
    pl.querySelector(".big").textContent = a.paused ? "▶" : "❚❚";
  }

  function bind() {
    el.querySelectorAll(".xqss-chips").forEach(g => g.querySelectorAll(".xqss-chip").forEach(b => b.onclick = () => {
      const q = g.dataset.q; let v = b.dataset.v;
      if (q === "minutes") v = Number(v); if (q === "collection" && v === "") v = null;
      answers[q] = v;
      // Advance — or, when the athlete came back from a later step, return there.
      if (config.questions === "one" && view === "ask") { reached = Math.max(reached, step + 1); step = reached; }
      render();
    }));
    el.querySelectorAll("[data-step]").forEach(b => b.onclick = () => { step = Number(b.dataset.step); render(); });
    const build = el.querySelector('[data-act="build"]'); if (build) build.onclick = buildNow;
    const start = el.querySelector('[data-act="start"]'); if (start) start.onclick = () => { player.prime(); session.started_at = new Date().toISOString(); player.playIndex(0); render(); };
    const nw = el.querySelector('[data-act="new"]'); if (nw) nw.onclick = () => { player.stop(); session = null; view = "ask"; step = reached = 0; render(); };
    el.querySelectorAll(".xqss-plan li").forEach(li => li.onclick = () => { player.playIndex(Number(li.dataset.i)); render(); });
    el.querySelectorAll("[data-rate]").forEach(b => b.onclick = () => { session.rating = Number(b.dataset.rate); saveSession(session, session.rating); render(); });
    el.querySelectorAll("[data-box]").forEach(b => b.onclick = () => {
      const t = catalog.tracks.find(x => x.id === b.dataset.box);
      const f = catalog.functions.find(x => x.id === t.function_id);
      const col = catalog.collections.find(c => c.id === t.collection_id);
      player.load([{ ...t, track_id: t.id, role: "library", function: f.display_name, shorthand: f.shorthand, activity: null, cover_key: (col && col.cover_key) || null }]);
      player.playIndex(0); render();
    });
  }

  function buildNow() {
    const err = el.querySelector("#xqss-err");
    if (!catalog) { err.hidden = false; err.textContent = "The Sound Box is still loading."; return; }
    try {
      session = MIZE.SoundStudio.buildSession({ feeling: answers.feeling, situation: answers.situation, minutes: answers.minutes, collection: answers.collection || undefined }, catalog, VOCAB);
      if (!session.plan.length) throw new Error("no tracks available for that combination");
      // Cover art lives on the collection (sound_collections.cover_key); carry it onto each row for onTrackChange.
      session.plan.forEach(p => { const col = catalog.collections.find(c => c.id === p.collection_id); p.cover_key = (col && col.cover_key) || null; });
      player.load(session.plan);
      view = "session"; render();
      hostCall("onSessionBuilt", sessionSummary());
    } catch (e) { err.hidden = false; err.textContent = "Could not build a session: " + e.message; }
  }

  // ------------------------------------------------- host transport API --
  // Round 4 (2026-09-13): a stage that draws its own play/pause/skip controls
  // drives the same player the overlay does. Every call is a safe no-op when
  // the overlay is closed or no session exists; every host callback is
  // wrapped so a throwing host never reaches the module.
  function hostCall(name, arg) {
    const cb = root.MIZE.SoundStudio && root.MIZE.SoundStudio[name];
    if (typeof cb === "function") { try { cb(arg); } catch (e) {} }
  }
  function sessionSummary() {
    if (!session) return null;
    return {
      feeling: session.inputs.feeling, situation: session.situation, minutes: session.inputs.minutes,
      total: session.plan.length, durationS: Math.round(session.plan.reduce((a, p) => a + (p.duration_s || 0), 0)),
      plan: session.plan.map((p, i) => ({ trackIndex: i + 1, trackId: p.track_id, function: p.function, role: p.role, durationS: Math.round(p.duration_s || 0), activity: p.activity || null, coverKey: p.cover_key || null })),
    };
  }
  function playState() {
    const idle = !player || player.idx < 0;
    return { open: !!el, built: !!session, started: !!(session && session.started_at), ended: !!(session && session.ended),
             playing: !idle && !player.cur.paused, paused: !idle && player.cur.paused, trackIndex: idle ? 0 : player.idx + 1, total: player ? player.plan.length : 0 };
  }
  let lastState = "";
  function announceState() {
    const st = playState(); const key = JSON.stringify(st);
    if (key === lastState) return; lastState = key;
    hostCall("onPlayState", st);
  }
  function beginSession() { if (session && !session.started_at) session.started_at = new Date().toISOString(); }
  const transport = {
    play() { if (!el || !player) return; if (player.idx < 0) { if (!session) return; beginSession(); player.playIndex(0); } else if (player.cur.paused) { analysisResume(); player.cur.play().catch(() => {}); } render(); },
    prime() { if (player) player.prime(); return !!player; },
    pause() { if (!el || !player || player.idx < 0) return; player.cur.pause(); render(); },
    togglePlay() { if (!el || !player) return; if (player.idx < 0) return transport.play(); player.toggle(); render(); },
    next() { if (!el || !player || player.idx < 0) return; player.next(); render(); },
    prev() { if (!el || !player || player.idx < 0) return; player.prev(); render(); },
    state: playState,
    session: sessionSummary,
    // debug(): everything needed to tell "blocked", "silent", "not loaded" and "not started" apart. Paste into a console.
    debug() {
      const els = player ? [player.a, player.b].map(a => ({ current: a === player.cur, src: a.currentSrc || a.src || null, crossOrigin: a.crossOrigin, paused: a.paused, ended: a.ended, currentTime: +a.currentTime.toFixed(2), duration: a.duration || null, readyState: a.readyState, networkState: a.networkState, error: a.error ? { code: a.error.code, message: a.error.message } : null, volume: a.volume, muted: a.muted, primed: !!a._primed })) : [];
      return { state: playState(), analysis: { wanted: analysis.wanted, corsOk: analysis.ok, ctx: analysis.ctx ? analysis.ctx.state : null, attached: !!analysis.node, primed: analysis.primed }, elements: els, ua: navigator.userAgent };
    },
  };

  // ---------------------------------------------------------- lifecycle --
  function start() {
    if (el) return;
    styleEl = document.createElement("style"); styleEl.id = "xqSoundStudioStyle"; styleEl.textContent = CSS; document.head.appendChild(styleEl);
    el = document.createElement("div"); el.id = "xqSoundStudio";
    const mount = typeof config.mount === "string" ? document.querySelector(config.mount) : config.mount;
    if (mount && mount.nodeType === 1) el.classList.add("xqss-embedded");
    if (config.background) el.style.setProperty("--xqss-bg", config.background);
    el.innerHTML = `
      <div class="xqss-top">
        <button data-exit type="button">‹ Home</button>
        <h1>Sound Box</h1>
        <div class="xqss-tabs"><button type="button" data-view="ask">Session</button><button type="button" data-view="box">Library</button></div>
      </div>
      <div class="xqss-body"></div>
      <div class="xqss-player" hidden>
        <div class="now"></div><div class="act"></div>
        <div class="xqss-bar"><i></i></div>
        <div class="xqss-ctl"><button data-p="prev" type="button">⏮</button><button data-p="toggle" class="big" type="button">▶</button><button data-p="next" type="button">⏭</button><span class="t">0:00 / 0:00</span></div>
      </div>`;
    (mount && mount.nodeType === 1 ? mount : document.body).appendChild(el);
    player = makePlayer();
    analysis.wanted = analysisWanted();
    player.onchange = (what) => {
      if (what === "time") { renderPlayer(); return; }
      if (player.idx >= 0 && session && view === "session") { el.querySelectorAll(".xqss-plan li").forEach((li, i) => { li.classList.toggle("now", i === player.idx); li.classList.toggle("done", i < player.idx); }); }
      if (player.idx < 0 && session && session.started_at && !session.ended && view === "session") { session.ended = true; render(); }
      renderPlayer();
      announceState();
    };
    el.querySelector("[data-exit]").onclick = exit;
    el.querySelectorAll(".xqss-tabs button").forEach(b => b.onclick = () => { view = b.dataset.view === "ask" && session ? "session" : b.dataset.view; render(); });
    el.querySelector('[data-p="toggle"]').onclick = () => { if (player.idx < 0 && session) { session.started_at = session.started_at || new Date().toISOString(); } player.toggle(); render(); };
    el.querySelector('[data-p="next"]').onclick = () => { player.next(); render(); };
    el.querySelector('[data-p="prev"]').onclick = () => { player.prev(); render(); };
    view = "ask"; render();
    loadCatalog().then(c => { catalog = c; if (view === "ask" || view === "box") render(); if (analysis.wanted) probeCors(c); })
      .catch(e => { const err = el && el.querySelector("#xqss-err"); if (err) { err.hidden = false; err.textContent = "Could not load the Sound Box: " + e.message; } });
  }

  function exit() {
    if (!el) return;
    if (player) { player.stop(); }
    analysisClose();
    releaseMediaSession();
    listeners.splice(0).forEach(([t, ev, fn]) => t.removeEventListener(ev, fn));
    el.remove(); el = null; styleEl.remove(); styleEl = null;
    player = null; session = null; catalog = null; view = "ask";
    answers = { feeling: null, situation: null, minutes: 20, collection: null }; step = reached = 0;
    lastState = ""; announceState();
    if (typeof root.MIZE.SoundStudio.onExit === "function") root.MIZE.SoundStudio.onExit();
  }

  root.MIZE.SoundStudio = {
    start, exit, isOpen: () => !!el, config,
    buildSession: (inputs, cat, vocab) => XquiXSoundBuilder.buildSession(inputs, cat, vocab || VOCAB),
    vocabulary: VOCAB,
    onExit: null,
    onTrackChange: null,   // ({title,bpm,coverKey,coverBase,trackIndex,total,role,function,trackId}) on every track start
    onBeat: null,          // ({beat,bpm}) on every beat of a track with a measured BPM
    onLevel: null,         // ({bass,mid,high,level,hit,t}) every animation frame while playing — real audio, needs CORS on the bucket
    analyser: () => analysis.node,   // the live AnalyserNode, or null (not enabled, or before the first play)
    // Round 4: transport for a stage that draws its own controls (STAGE-HOOKS-CONTRACT.md §"Transport")
    onSessionBuilt: null,  // (summary) once a session has been built and is waiting for Start
    onPlayState: null,     // (state) whenever playing/paused/track/ended changes
    prime: transport.prime,   // call inside a user gesture when playback will start later from a timer (Safari)
    play: transport.play, pause: transport.pause, togglePlay: transport.togglePlay, next: transport.next, prev: transport.prev,
    state: transport.state, session: transport.session, debug: transport.debug,
  };
})();
