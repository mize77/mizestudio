/*
 * xquix-stage-fx.js — XquiX stage fog + laser effect (WebGL).
 *
 * One full-screen fragment shader: a volumetric-looking fog plume from a
 * fog-machine nozzle (domain-warped fbm noise advected upward, with a real
 * emission history so bursts rise as puffs), lit by two narrow teal lasers
 * whose visible brightness is the fog density they pass through. Black
 * negative space, no sprites, no CSS blur.
 *
 *   const fx = MIZE.StageFX.attach(hostElement, opts?)   // a <canvas> is inserted, absolute inset:0
 *   fx.burst(seconds = 2.5, strength = 1, outlet?)        // fog machine(s) fire: all, one index, or a list
 *   fx.set({ energy, hit, haze, laser, sources, spread, beams })   // live parameters (all optional)
 *   fx.destroy()
 *
 * Wire to the Sound Box: onLevel(l) → fx.set({energy: l.level, hit: l.hit}),
 * onTrackChange → fx.burst(3). See STAGE-HOOKS-CONTRACT.md §"Stage FX".
 */
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  root.MIZE = root.MIZE || {};

  const VS = `attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }`;

  const FS = `
precision highp float;
uniform vec2  uRes;        // canvas size in px
uniform float uTime;       // seconds
uniform vec3  uSrc[3];     // per outlet: x, y (0..1), lean angle in radians (+ = right)
uniform int   uCount;      // outlets in use (1..3)
uniform float uSpread;     // how wide a plume opens with height
uniform vec4  uBeamL;      // x0,y0,x1,y1 in 0..1
uniform vec4  uBeamR;
uniform vec3  uTeal;
uniform float uHaze;       // residual fog floor 0..1
uniform float uLaser;      // laser brightness 0..1.5
uniform float uEnergy;     // music energy 0..1 (adds turbulence + glow)
uniform sampler2D uHist;   // emission history: texel x = age/uHistSpan, row = outlet
uniform float uHistSpan;   // seconds covered by the history texture
uniform float uRise;       // rise speed in plume-heights per second

// --- noise -----------------------------------------------------------------
vec3 hash3(vec3 p){ p = vec3(dot(p,vec3(127.1,311.7,74.7)), dot(p,vec3(269.5,183.3,246.1)), dot(p,vec3(113.5,271.9,124.6))); return -1.0 + 2.0*fract(sin(p)*43758.5453123); }
float noise(vec3 p){
  vec3 i = floor(p), f = fract(p); vec3 u = f*f*(3.0-2.0*f);
  return mix(mix(mix(dot(hash3(i+vec3(0,0,0)),f-vec3(0,0,0)), dot(hash3(i+vec3(1,0,0)),f-vec3(1,0,0)),u.x),
                 mix(dot(hash3(i+vec3(0,1,0)),f-vec3(0,1,0)), dot(hash3(i+vec3(1,1,0)),f-vec3(1,1,0)),u.x),u.y),
             mix(mix(dot(hash3(i+vec3(0,0,1)),f-vec3(0,0,1)), dot(hash3(i+vec3(1,0,1)),f-vec3(1,0,1)),u.x),
                 mix(dot(hash3(i+vec3(0,1,1)),f-vec3(0,1,1)), dot(hash3(i+vec3(1,1,1)),f-vec3(1,1,1)),u.x),u.y),u.z);
}
float fbm(vec3 p){
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s;
}
float fbm3(vec3 p){
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 3; i++) { s += a * noise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s;
}

// --- geometry --------------------------------------------------------------
float segDist(vec2 p, vec2 a, vec2 b, out float tt){
  vec2 pa = p - a, ba = b - a; tt = clamp(dot(pa,ba)/dot(ba,ba), 0.0, 1.0);
  return length(pa - ba*tt);
}

// Fog density at a point (0..1). The plume: a jet that widens with height,
// carried upward and drifting; density is what the machine emitted when this
// parcel left the nozzle (emission history), times turbulent noise.
float plumeAt(vec2 p, float aspect, vec3 src, float row){
  vec2 q = p - src.xy;                        // nozzle-relative
  q.x *= aspect;
  // lean: a side machine blows toward the stage; rotate into the outlet's frame
  float ca = cos(src.z), sa = sin(src.z);
  q = vec2(ca * q.x - sa * q.y, sa * q.x + ca * q.y);
  float h = q.y;                              // height along the jet axis
  if (h < -0.16) return 0.0;
  // early out: nothing this far from the axis (keeps three outlets affordable)
  if (abs(q.x) > 0.12 + uSpread * 1.6 * pow(max(h, 0.0), 0.72) + 0.25) return 0.0;
  float t = uTime + row * 37.0;              // each outlet its own turbulence phase
  // slow large-scale turbulence warps the whole plume (curls, pockets)
  vec3 w = vec3(q * 1.6, t * 0.06);
  vec2 warp = vec2(fbm3(w + 3.1), fbm3(w + 7.7)) * 0.40 * smoothstep(0.0, 0.7, h);   // straight at the nozzle, turbulent above
  vec2 qq = q + warp;
  float hh = max(qq.y, 0.0);
  // jet: narrow at the nozzle, opening up; the plume leans with a slow drift
  float drift = 0.10 * sin(t * 0.13) * hh;
  float halfW = 0.028 + uSpread * pow(hh, 0.72);
  float xr = abs(qq.x - drift) / halfW;
  float envelope = smoothstep(1.2, 0.45, xr);
  // top thins out; ceiling dissolves
  envelope *= smoothstep(1.3, 0.6, hh);
  // turbulence rising with the plume: big slow curls plus finer detail
  float n1 = fbm(vec3(qq * 2.0 + vec2(0.0, -t * uRise * 0.8), t * 0.05));
  float n2 = fbm(vec3(qq * 6.5 + vec2(0.4, -t * uRise * 1.4), t * 0.11));
  float n3 = fbm3(vec3(qq * 14.0 + vec2(-0.2, -t * uRise * 2.2), t * 0.2));
  float n = 0.5 + 0.5 * (n1 * 1.4 + n2 * 1.1 + n3 * 0.5);
  // emission history: parcels at height hh left the nozzle hh/uRise seconds ago
  float age = clamp(hh / uRise, 0.0, uHistSpan);
  float emitted = texture2D(uHist, vec2(age / uHistSpan, row)).r;
  float base = uHaze + emitted * 1.15;
  // near the nozzle the jet is solid; higher up the noise carves pockets and wisps
  // the jet: a concentrated column straight out of the nozzle that rises,
  // then lets go into the plume. Only as strong as the machine is firing
  // (emission history), textured by the same turbulence.
  float ax = abs(qq.x - drift);
  // the column rises about three times faster than the drifting plume
  float jetAge = clamp(hh / (uRise * 3.0), 0.0, uHistSpan);
  float jetEmit = texture2D(uHist, vec2(jetAge / uHistSpan, row)).r;
  float jet = smoothstep(0.022 + 0.17 * hh, 0.0, abs(q.x - drift * 0.3)) * smoothstep(0.58, 0.10, hh) * (0.45 + 0.55 * smoothstep(0.3, 0.8, n + 0.25 * n3)) * jetEmit;
  float carve = smoothstep(0.44, 0.70, n);
  // the plume emerges from the nozzle: no hard base line
  float emerge = smoothstep(-0.14, 0.08, h);   // settled fog also lies below the nozzle height
  // fog that has settled: spreads sideways along the floor and thins upward
  float floorFog = smoothstep(0.40, -0.10, q.y) * smoothstep(1.3, 0.15, ax) * smoothstep(0.42, 0.78, n) * (0.6 + 0.4 * n3) * (uHaze * 0.4 + emitted * 0.35);
  float plume = envelope * carve * base;
  return (plume + jet * 2.3 + floorFog) * emerge;
}
float density(vec2 p, float aspect){
  float d = 0.0;
  for (int i = 0; i < 3; i++) {
    if (i >= uCount) break;
    d += plumeAt(p, aspect, uSrc[i], (float(i) + 0.5) / 3.0);
  }
  return clamp(d, 0.0, 1.0);
}

void main(){
  vec2 uv = gl_FragCoord.xy / uRes;          // 0..1, y up
  float aspect = uRes.x / uRes.y;
  float fog = density(uv, aspect);

  // lasers
  vec2 pa = uv * vec2(aspect, 1.0);
  float tl, tr;
  float dl = segDist(pa, uBeamL.xy * vec2(aspect,1.0), uBeamL.zw * vec2(aspect,1.0), tl);
  float dr = segDist(pa, uBeamR.xy * vec2(aspect,1.0), uBeamR.zw * vec2(aspect,1.0), tr);
  float px = 1.0 / uRes.y;
  // thin crisp core (about 1.5 px), always faintly visible, bright in fog
  float coreL = exp(-pow(dl / (1.6 * px), 2.0));
  float coreR = exp(-pow(dr / (1.6 * px), 2.0));
  // scattering halo: only exists where there is fog to scatter in
  float haloL = exp(-dl / 0.018) * fog;
  float haloR = exp(-dr / 0.018) * fog;
  // wider ambient teal light the beams throw into the fog
  float ambL = exp(-dl / 0.22);
  float ambR = exp(-dr / 0.22);
  float amb = clamp(ambL + ambR, 0.0, 1.0);

  // fog colour: grey-white, tinted by the teal light around it, brighter near the beams
  vec3 grey = vec3(0.70, 0.76, 0.78);
  vec3 lit  = mix(grey, uTeal * 1.15, 0.30 + 0.55 * amb);
  vec3 col  = lit * fog * (0.65 + 1.25 * amb + 0.5 * uEnergy * amb);
  // beams
  float L = uLaser;
  col += uTeal * (coreL + coreR) * (0.35 + 1.1 * fog) * L;
  col += uTeal * (haloL + haloR) * 0.9 * L;
  // beam origins: small hot points
  col += uTeal * 0.6 * L * (exp(-length(pa - uBeamL.xy * vec2(aspect,1.0)) / 0.012) + exp(-length(pa - uBeamR.xy * vec2(aspect,1.0)) / 0.012));
  // floor reflection: faint teal sheen below the nozzle line, mirrored fog glow
  float floorY = uSrc[0].y;
  float below = smoothstep(floorY, floorY - 0.18, uv.y);
  float refl = 0.0;
  for (int i = 0; i < 3; i++) { if (i >= uCount) break; refl += smoothstep(0.30, 0.0, abs(uv.x - uSrc[i].x) * aspect) * 0.35; }
  col += uTeal * below * (0.04 + 0.16 * refl) * 0.5;
  // tone + subtle grain so gradients never band
  float grain = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * 0.012;
  col = col / (1.0 + col * 0.55) + grain;   // soft shoulder: dense fog goes pale, never clips
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}`;

  function attach(host, opts) {
    opts = opts || {};
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;background:#000";
    canvas.className = "xq-stagefx";
    host.appendChild(canvas);
    const gl = canvas.getContext("webgl", { alpha: false, antialias: false, premultipliedAlpha: false, powerPreference: "high-performance" });
    if (!gl) { canvas.remove(); return null; }

    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aLoc = gl.getAttribLocation(prog, "a"); gl.enableVertexAttribArray(aLoc); gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
    const U = {}; ["uRes", "uTime", "uSrc", "uCount", "uSpread", "uBeamL", "uBeamR", "uTeal", "uHaze", "uLaser", "uEnergy", "uHist", "uHistSpan", "uRise"].forEach(n => U[n] = gl.getUniformLocation(prog, n));

    // Emission history per outlet: 64 texels over HIST_SPAN seconds, texel 0 = now; one row per outlet.
    const HIST = 64, HIST_SPAN = 9.0, DT = HIST_SPAN / HIST, MAXSRC = 3;
    const hist = new Uint8Array(HIST * MAXSRC);
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const upload = () => { gl.bindTexture(gl.TEXTURE_2D, tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, HIST, MAXSRC, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, hist); };

    const p = {
      teal: opts.teal || [0.0, 0.84, 0.72],
      // Outlets: {x, y} in 0..1 from left / from bottom, lean in degrees (+ = toward the right).
      // Default: one centre machine straight up and one each side blowing toward the stage.
      sources: opts.sources || (opts.source ? [{ x: opts.source[0], y: opts.source[1], lean: 0 }] : [{ x: 0.5, y: 0.10, lean: 0 }, { x: 0.10, y: 0.10, lean: 32 }, { x: 0.90, y: 0.10, lean: -32 }]),
      spread: opts.spread != null ? opts.spread : 0.75,   // how wide a plume opens with height (1.25 = the old single-outlet look)
      beams: opts.beams || [[0.045, 0.085, 0.50, 1.02], [0.955, 0.085, 0.50, 1.02]],
      haze: opts.haze != null ? opts.haze : 0.30,   // residual fog when the machine is idle
      laser: opts.laser != null ? opts.laser : 1.0,
      energy: 0, rise: opts.rise || 0.16,           // plume heights per second (slow, atmospheric)
      resolutionScale: opts.resolutionScale || 0.6,
    };
    const emit = [0, 0, 0], burstUntil = [0, 0, 0], burstStrength = [1, 1, 1]; let hitGlow = 0;
    let acc = 0, last = performance.now(), t0 = last, raf = null, running = true;

    function resize() {
      const r = host.getBoundingClientRect();
      const s = Math.min(root.devicePixelRatio || 1, 2) * p.resolutionScale;
      const w = Math.max(2, Math.round(r.width * s)), h = Math.max(2, Math.round(r.height * s));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
    }
    function frame(now) {
      raf = null; if (!running) return;
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      resize();
      // emission envelope: bursts ramp up fast, tail off slowly
      for (let i = 0; i < MAXSRC; i++) { const target = now < burstUntil[i] ? burstStrength[i] : 0; emit[i] += (target - emit[i]) * (target > emit[i] ? 0.25 : 0.03); }
      acc += dt;
      while (acc >= DT) { acc -= DT; for (let i = 0; i < MAXSRC; i++) { const o = i * HIST; hist.copyWithin(o + 1, o, o + HIST - 1); } }
      for (let i = 0; i < MAXSRC; i++) hist[i * HIST] = Math.round(Math.min(1, emit[i]) * 255);
      upload();
      hitGlow *= 0.85;
      gl.uniform2f(U.uRes, canvas.width, canvas.height);
      gl.uniform1f(U.uTime, (now - t0) / 1000);
      const n = Math.min(MAXSRC, p.sources.length), srcArr = new Float32Array(9);
      for (let i = 0; i < n; i++) { const o = p.sources[i]; srcArr[i * 3] = o.x; srcArr[i * 3 + 1] = o.y; srcArr[i * 3 + 2] = (o.lean || 0) * Math.PI / 180; }
      gl.uniform3fv(U.uSrc, srcArr); gl.uniform1i(U.uCount, n); gl.uniform1f(U.uSpread, p.spread);
      gl.uniform4fv(U.uBeamL, p.beams[0]); gl.uniform4fv(U.uBeamR, p.beams[1]);
      gl.uniform3fv(U.uTeal, p.teal);
      gl.uniform1f(U.uHaze, p.haze);
      gl.uniform1f(U.uLaser, p.laser * (1 + 0.6 * hitGlow));
      gl.uniform1f(U.uEnergy, p.energy);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(U.uHist, 0);
      gl.uniform1f(U.uHistSpan, HIST_SPAN);
      gl.uniform1f(U.uRise, p.rise);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(frame);
    }
    const onVis = () => { if (document.hidden) { running = false; if (raf) cancelAnimationFrame(raf); raf = null; } else if (!running) { running = true; last = performance.now(); raf = requestAnimationFrame(frame); } };
    document.addEventListener("visibilitychange", onVis);
    raf = requestAnimationFrame(frame);

    return {
      canvas, params: p,
      // burst(seconds, strength, outlet): outlet = index, an array of indices, or undefined for all
      burst(seconds, strength, outlet) {
        const idx = outlet == null ? p.sources.map((_, i) => i) : Array.isArray(outlet) ? outlet : [outlet];
        idx.forEach(i => { if (i >= 0 && i < MAXSRC) { burstUntil[i] = performance.now() + (seconds || 2.5) * 1000; burstStrength[i] = strength == null ? 1 : strength; } });
      },
      set(o) {
        if (!o) return;
        if (o.energy != null) p.energy = Math.max(0, Math.min(1, o.energy));
        if (o.hit) hitGlow = 1;
        if (o.haze != null) p.haze = o.haze; if (o.laser != null) p.laser = o.laser;
        if (o.sources) p.sources = o.sources; if (o.spread != null) p.spread = o.spread; if (o.beams) p.beams = o.beams; if (o.teal) p.teal = o.teal;
        if (o.rise != null) p.rise = o.rise;
      },
      destroy() { running = false; if (raf) cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", onVis); gl.getExtension("WEBGL_lose_context")?.loseContext(); canvas.remove(); },
    };
  }

  root.MIZE.StageFX = { attach, version: "2026-09-14" };
})();
