/* XquiX Frame Reader — water-plane geometry core.
   Pure JS, no dependencies. Shared by the browser tool and the Node test harness.

   WORLD FRAME ("attack frame"), metres:
     X = distance from the attacked goal line, into the field of play (0 .. 25)
     Y = lateral offset from the goal centre    (-10 .. +10, +Y toward one sideline)
   This is deliberately goal-anchored, because that is the reference the camera
   actually gives us and the reference XquiX's own field zones use (polar around
   FIELD_ZONE_GOAL). Conversion to XquiX board space happens in xquix.js.
*/
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HG = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- small linear algebra ----------

  function solveLinear(A, b) {
    // Gaussian elimination with partial pivoting. A is n x n (array of rows), b length n.
    const n = b.length;
    const M = A.map((r, i) => r.slice().concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-12) return null; // singular
      const t = M[c]; M[c] = M[p]; M[p] = t;
      const piv = M[c][c];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / piv;
        if (f === 0) continue;
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((r, i) => r[n] / r[i]);
  }

  function matMul3(A, B) {
    const C = [[0,0,0],[0,0,0],[0,0,0]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      let s = 0; for (let k = 0; k < 3; k++) s += A[i][k] * B[k][j];
      C[i][j] = s;
    }
    return C;
  }

  function invert3(M) {
    const [a,b,c] = M[0], [d,e,f] = M[1], [g,h,i] = M[2];
    const A =  (e*i - f*h), B = -(d*i - f*g), C =  (d*h - e*g);
    const det = a*A + b*B + c*C;
    if (Math.abs(det) < 1e-14) return null;
    const D = -(b*i - c*h), E =  (a*i - c*g), F = -(a*h - b*g);
    const G =  (b*f - c*e), H = -(a*f - c*d), I =  (a*e - b*d);
    return [[A/det, D/det, G/det], [B/det, E/det, H/det], [C/det, F/det, I/det]];
  }

  // ---------- projective helpers ----------

  // Homogeneous cross product: line through two points, or intersection of two lines.
  function cross(p, q) {
    return [p[1]*q[2] - p[2]*q[1], p[2]*q[0] - p[0]*q[2], p[0]*q[1] - p[1]*q[0]];
  }

  // Intersection of the line through a,b with the line through c,d (image pixels).
  // Returns a homogeneous point; w may be ~0 when the lines are parallel (point at infinity).
  function lineIntersection(a, b, c, d) {
    return cross(cross([a[0], a[1], 1], [b[0], b[1], 1]), cross([c[0], c[1], 1], [d[0], d[1], 1]));
  }

  function applyH(H, x, y, w) {
    w = (w === undefined) ? 1 : w;
    const u = H[0][0]*x + H[0][1]*y + H[0][2]*w;
    const v = H[1][0]*x + H[1][1]*y + H[1][2]*w;
    const s = H[2][0]*x + H[2][1]*y + H[2][2]*w;
    return { x: u/s, y: v/s, w: s };
  }

  /* Direct Linear Transform.
     pairs: [{ world:[X,Y,W], image:[u,v,w] }, ...]  — homogeneous on BOTH sides, so
     points at infinity (vanishing points, W=0) are first-class inputs. That is what
     lets the goal frame alone carry the calibration.
     Needs >= 4 pairs; more are solved in least squares. */
  /* Hartley normalisation, extended to cope with points at infinity.
     Vanishing points routinely come out with homogeneous magnitudes around 1e9
     while a post base is ~1e3 — without this the least-squares fit is completely
     dominated by the vanishing point and collapses to a degenerate H. The
     similarity transform is built from the FINITE points only, then every
     homogeneous vector (finite or not) is rescaled to unit length so each
     correspondence carries equal weight. */
  function normalizingTransform(pts) {
    const finite = pts.filter(p => Math.abs(p[2]) > 1e-9).map(p => [p[0]/p[2], p[1]/p[2]]);
    if (finite.length === 0) return [[1,0,0],[0,1,0],[0,0,1]];
    let cx = 0, cy = 0;
    for (const p of finite) { cx += p[0]; cy += p[1]; }
    cx /= finite.length; cy /= finite.length;
    let d = 0;
    for (const p of finite) d += Math.hypot(p[0]-cx, p[1]-cy);
    d /= finite.length;
    const s = d > 1e-12 ? Math.SQRT2 / d : 1;
    return [[s, 0, -s*cx], [0, s, -s*cy], [0, 0, 1]];
  }

  function applyT(T, p) {
    return [
      T[0][0]*p[0] + T[0][1]*p[1] + T[0][2]*p[2],
      T[1][0]*p[0] + T[1][1]*p[1] + T[1][2]*p[2],
      T[2][0]*p[0] + T[2][1]*p[1] + T[2][2]*p[2]
    ];
  }

  function unit(p) {
    const n = Math.hypot(p[0], p[1], p[2]);
    return n > 1e-300 ? [p[0]/n, p[1]/n, p[2]/n] : p;
  }

  function homographyFromPairs(pairs) {
    if (!pairs || pairs.length < 4) return null;
    const worldPts = pairs.map(p => p.world.slice());
    const imagePts = pairs.map(p => p.image.length === 3 ? p.image.slice() : [p.image[0], p.image[1], 1]);
    const S = normalizingTransform(worldPts);
    const T = normalizingTransform(imagePts);
    const wN = worldPts.map(p => unit(applyT(S, p)));
    const iN = imagePts.map(p => unit(applyT(T, p)));

    // Two rows per correspondence: the two independent components of image x H*world = 0.
    const rows = [];
    for (let k = 0; k < pairs.length; k++) {
      const [X, Y, W] = wN[k];
      const [u, v, w] = iN[k];
      rows.push([0, 0, 0,  -w*X, -w*Y, -w*W,   v*X,  v*Y,  v*W]);
      rows.push([w*X, w*Y, w*W,  0, 0, 0,     -u*X, -u*Y, -u*W]);
    }
    // Solve A h = 0 with |h| = 1 via the smallest eigenvector of A^T A (Jacobi).
    const ATA = [];
    for (let i = 0; i < 9; i++) ATA.push(new Array(9).fill(0));
    for (const r of rows) for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) ATA[i][j] += r[i]*r[j];
    const h = smallestEigenvector(ATA);
    if (!h) return null;
    const Hn = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], h[8]]];
    // Undo the normalisation: H = T^-1 * Hn * S
    const Tinv = invert3(T);
    if (!Tinv) return null;
    const H = matMul3(matMul3(Tinv, Hn), S);
    // Rescale so the matrix sits at a sane magnitude (purely cosmetic; H is
    // defined only up to scale, but it keeps the singularity test meaningful).
    let m = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m = Math.max(m, Math.abs(H[i][j]));
    if (m > 0) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) H[i][j] /= m;
    return H;
  }

  // Cyclic Jacobi eigen-decomposition of a symmetric matrix; returns the eigenvector
  // for the smallest eigenvalue. n is small (9) so this is cheap and dependency-free.
  function smallestEigenvector(Ain) {
    const n = Ain.length;
    const A = Ain.map(r => r.slice());
    let V = []; for (let i = 0; i < n; i++) { V.push(new Array(n).fill(0)); V[i][i] = 1; }
    for (let sweep = 0; sweep < 100; sweep++) {
      let off = 0;
      for (let i = 0; i < n; i++) for (let j = i+1; j < n; j++) off += A[i][j]*A[i][j];
      if (off < 1e-24) break;
      for (let p = 0; p < n; p++) for (let q = p+1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-18) continue;
        const theta = (A[q][q] - A[p][p]) / (2*A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta*theta + 1));
        const c = 1/Math.sqrt(t*t + 1), s = t*c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c*akp - s*akq; A[k][q] = s*akp + c*akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c*apk - s*aqk; A[q][k] = s*apk + c*aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c*vkp - s*vkq; V[k][q] = s*vkp + c*vkq;
        }
      }
    }
    let best = 0;
    for (let i = 1; i < n; i++) if (A[i][i] < A[best][best]) best = i;
    const vec = []; for (let k = 0; k < n; k++) vec.push(V[k][best]);
    return vec;
  }

  // ---------- calibration ----------

  const GOAL_WIDTH = 3.0;    // metres, inner face to inner face
  const GOAL_HEIGHT = 0.9;   // metres, waterline to underside of crossbar

  /* MODE R — "goal + real field references" (the only mode the Phase B harness uses;
     the goal-only and goal+lines modes of the original file are omitted from this copy
     because Phase B measures with known references only).
     points: [{ X, Y, u, v, label }] known water-plane points. */
  function calibrateFromReferences(ref, opts) {
    opts = opts || {};
    const sgn = opts.flipY ? -1 : 1;
    const pairs = [];
    if (ref.goal && ref.goal.baseL && ref.goal.baseR) {
      pairs.push({ world: [0, -sgn*GOAL_WIDTH/2, 1], image: [ref.goal.baseL[0], ref.goal.baseL[1], 1], label: 'left post base' });
      pairs.push({ world: [0,  sgn*GOAL_WIDTH/2, 1], image: [ref.goal.baseR[0], ref.goal.baseR[1], 1], label: 'right post base' });
    }
    if (ref.downPool && ref.downPool.a && ref.downPool.b &&
        [ref.downPool.a[0], ref.downPool.a[1], ref.downPool.b[0], ref.downPool.b[1]].every(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
      const Vd = lineIntersection(ref.downPool.a[0], ref.downPool.a[1], ref.downPool.b[0], ref.downPool.b[1]);
      if (isFinitePt(Vd)) pairs.push({ world: [1, 0, 0], image: Vd, label: 'down-pool vanishing point' });
    }
    for (const p of (ref.points || [])) pairs.push({ world: [p.X, p.Y, 1], image: [p.u, p.v, 1], label: p.label || `(${p.X},${p.Y})` });

    // Degeneracy guard: a homography needs four points in general position, and
    // everything on the goal line is collinear. Count how many references sit
    // off the goal line — post bases alone can never be enough.
    const offGoalLine = pairs.filter(p => p.world[2] === 0 || Math.abs(p.world[0]) > 1e-6).length;
    if (pairs.length < 4 || offGoalLine < 2) {
      return { error: 'needs at least two references away from the goal line — ' +
                      'a down-pool direction plus one known distance, or two known field points' };
    }
    const H = homographyFromPairs(pairs);
    if (!H) return { error: 'could not solve — check the clicked points' };
    const out = finish(H, { mode: 'references', nRefs: pairs.length });
    if (!out) return { error: 'degenerate configuration — the references are too close to one line' };
    out.pairs = pairs;
    return out;
  }

  function isFinitePt(p) {
    return p && p.every(Number.isFinite) && (Math.abs(p[0]) + Math.abs(p[1]) + Math.abs(p[2])) > 1e-12;
  }

  /* Wraps a world->image H with its inverse and some derived quantities the UI
     needs: the horizon (vanishing line of the water plane) and a scale estimate
     so we can warn when a detection sits in a badly-conditioned part of the frame. */
  function finish(H, info) {
    const Hinv = invert3(H);
    if (!Hinv) return null;
    const horizon = cross(
      [H[0][0], H[1][0], H[2][0]],   // image of the X direction at infinity
      [H[0][1], H[1][1], H[2][1]]    // image of the Y direction at infinity
    );
    return {
      H, Hinv, info, horizon,
      /* image pixel -> world metres. This is where a screenshot becomes tactics. */
      toWorld(u, v) {
        const p = applyH(Hinv, u, v, 1);
        return { X: p.x, Y: p.y, w: p.w };
      },
      /* world metres -> image pixel, for drawing the calibration back onto the frame */
      toImage(X, Y) {
        const p = applyH(H, X, Y, 1);
        return { u: p.x, v: p.y, w: p.w };
      },
      /* How many metres does one pixel cover at this image point? Grows without
         bound toward the horizon — the honest measure of "how much should I trust
         a player detected up there". */
      metresPerPixel(u, v) {
        const c = this.toWorld(u, v);
        const dx = this.toWorld(u + 1, v), dy = this.toWorld(u, v + 1);
        return Math.max(Math.hypot(dx.X - c.X, dx.Y - c.Y), Math.hypot(dy.X - c.X, dy.Y - c.Y));
      },
      /* Distance in the image, in pixels, from a point down to the horizon line.
         Small or negative means the point is at/above the horizon: unusable. */
      horizonMargin(u, v) {
        const l = horizon;
        return (l[0]*u + l[1]*v + l[2]) / Math.hypot(l[0], l[1]);
      },
      /* Residual check: reproject the calibration points and report the error in
         metres. This is the number that tells a coach whether to re-click. */
      residuals(pairs) {
        const out = [];
        for (const p of pairs) {
          if (p.world[2] === 0) continue; // skip points at infinity
          const im = this.toImage(p.world[0], p.world[1]);
          const w = this.toWorld(p.image[0], p.image[1]);
          out.push({
            world: [p.world[0], p.world[1]],
            pixelError: Math.hypot(im.u - p.image[0], im.v - p.image[1]),
            metreError: Math.hypot(w.X - p.world[0], w.Y - p.world[1])
          });
        }
        return out;
      }
    };
  }

  return {
    GOAL_WIDTH, GOAL_HEIGHT,
    solveLinear, matMul3, invert3, cross, lineIntersection, applyH,
    homographyFromPairs, smallestEigenvector,
    calibrateFromReferences, finish
  };
});
