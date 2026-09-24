/* XquiX video analysis - tracking a play (MIZE, 2026-09-24: "screenshots every 0.5 seconds ... track the movement of
   the players from frame to frame ... animate the play on the tactical board").

   The coach confirms the FIRST frame of the play (field, teams, goalkeeper, attacking side). Those confirmed players
   are the tracks: their number, teams and roles never change during the play - nothing is invented later. Every
   further frame is read by the detector with the same calibration, and each detection is linked to the nearest
   track (a one-to-one assignment on the water plane, in meters). A track that gets no detection in a frame keeps its
   last position and is flagged "held"; a track that moved more than a swimmer can in the step is flagged "jump".
   Detections that match no track are dropped (a false alarm, or a player not in the confirmed frame).

   Node and browser. */
(function (root) {
  'use strict';
  const BIG = 1e6;

  // Hungarian assignment (Kuhn-Munkres with potentials), n rows <= m columns; returns the column per row (-1 = none).
  function hungarian(cost) {
    const n = cost.length; if (!n) return [];
    const m = Math.max(n, cost[0].length);
    const a = cost.map(r => { const q = r.slice(); while (q.length < m) q.push(BIG); return q; });
    const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      p[0] = i; let j0 = 0; const minv = new Array(m + 1).fill(Infinity), used = new Array(m + 1).fill(false);
      do {
        used[j0] = true; const i0 = p[j0]; let delta = Infinity, j1 = 0;
        for (let j = 1; j <= m; j++) if (!used[j]) {
          const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= m; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta; }
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    const out = new Array(n).fill(-1);
    for (let j = 1; j <= m; j++) if (p[j] > 0 && a[p[j] - 1][j - 1] < BIG) out[p[j] - 1] = j - 1;
    return out;
  }

  const DEF = { gate: 3.0, jump: 1.6, teamPenalty: 2.0, rolePenalty: 3.0 };

  /* tracks: [{ id, team, role, X, Y, ... }] (mutated: X, Y, held, jump, moved, det)
     dets:   [{ id, team, role, X, Y, ... }] from the detector, world meters
     Returns { matched, held, jumps } for the frame. */
  function link(tracks, dets, opts) {
    const o = Object.assign({}, DEF, opts || {});
    const cost = tracks.map(t => dets.map(d => {
      const dist = Math.hypot(t.X - d.X, t.Y - d.Y); if (dist > o.gate) return BIG;
      let c = dist;
      if (t.team !== 'unknown' && d.team !== 'unknown' && t.team !== d.team) c += o.teamPenalty;
      if ((t.role === 'goalkeeper') !== (d.role === 'goalkeeper')) c += o.rolePenalty;
      return c;
    }));
    const asg = dets.length ? hungarian(cost) : tracks.map(() => -1);
    let matched = 0, held = 0, jumps = 0;
    tracks.forEach((t, i) => {
      const j = asg[i];
      if (j < 0) { t.held = true; t.jump = false; t.moved = 0; t.det = null; held++; return; }
      const d = dets[j], moved = Math.hypot(t.X - d.X, t.Y - d.Y);
      t.X = d.X; t.Y = d.Y; t.det = d; t.moved = moved; t.held = false; t.jump = moved > o.jump; if (t.jump) jumps++; matched++;
    });
    return { matched, held, jumps, unmatchedDets: dets.length - matched };
  }

  /* Whole play from per-frame detections (for tests and for re-runs without the browser):
     first: confirmed players [{ id, team, role, X, Y }]; frames: [[dets], [dets], ...] for t = step, 2 step, ...
     Returns [{ t, players: [{ track, id, team, role, X, Y, held, jump, moved }] }] including the confirmed frame at t = 0. */
  function trackPlay(first, frames, opts) {
    const o = Object.assign({ step: 0.5 }, opts || {});
    const tracks = first.map((p, i) => ({ track: i + 1, id: p.id, team: p.team, role: p.role, X: p.X, Y: p.Y, held: false, jump: false, moved: 0 }));
    const snap = t => ({ t: +t.toFixed(2), players: tracks.map(k => ({ track: k.track, id: k.id, team: k.team, role: k.role, X: +k.X.toFixed(3), Y: +k.Y.toFixed(3), held: k.held, jump: k.jump, moved: +k.moved.toFixed(2) })) });
    const out = [snap(0)];
    frames.forEach((dets, k) => { link(tracks, dets, o); out.push(snap((k + 1) * o.step)); });
    return out;
  }

  const api = { hungarian, link, trackPlay, DEF };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.VATrack = api;
})(typeof window !== 'undefined' ? window : globalThis);
