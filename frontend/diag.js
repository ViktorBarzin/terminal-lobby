/**
 * The lobby's client diagnostics — performance and reliability
 * (docs/adr/0008-client-diagnostics.md).
 *
 * ONE implementation, three surfaces. index.html (lobby and terminal),
 * term.html (the v2 SPA's terminal iframe) and the v2 SPA all inline this exact
 * file at deploy. It carries no import or export statement on purpose: that is
 * what lets the same bytes be a classic inlined script tag and a side-effect ES
 * import in the test suite, so what is tested is what ships. term.html already
 * carries calls to a tlTrack it never defines — drift between hand-maintained
 * copies is the failure this arrangement avoids.
 *
 * Two rules, inherited from the usage tracker and non-negotiable here:
 *
 *   1. Diagnostics never break the page. Every failure path is swallowed, every
 *      buffer is bounded, and a dead intake costs one dropped batch.
 *   2. Only how the app PERFORMED and how it FAILED is recorded — timings,
 *      counts, close codes, stacks. Never conversation content, prompt text,
 *      file contents, or typed characters. The flight recorder holds input
 *      GEOMETRY and control keys, never what was typed.
 *
 * Everything is injected (now, send, storage, random) so the state machines are
 * testable without a browser and without wall-clock flake. bind() at the bottom
 * supplies the real browser implementations.
 */
globalThis.tlDiag = (function () {
  "use strict";

  /** Window and threshold defaults. See the ADR's open questions: the gate,
   *  the match deadline and the stall threshold are starting values chosen
   *  from the shape of the problem, not from measurement. */
  var DEFAULTS = {
    windowMs: 60000, // rollup cadence while active
    heartbeatMs: 300000, // liveness cadence while idle or hidden
    quietMs: 300, // output silence required before an echo sample
    matchMs: 2000, // how long an echo may take before it is unmatched
    stallMs: 3000, // input with no output for this long is a stall
    // An API call this slow is reported on its own. 500 ms sat BELOW a healthy
    // round trip on a 300 ms link, which is why 28,379 of 32,619 api.slow
    // records were for /telemetry itself — the reporting channel reporting on
    // its own latency, and each report generating the next.
    slowApiMs: 1500,
    ringMax: 30, // flight-recorder depth (the intake caps at 30 too)
    sampleMax: 512, // retained samples per metric per window
    bufferMax: 200, // queued records before the oldest are dropped
  };

  var LIVE_KEY = "tl_live";
  var DEVICE_KEY = "tl_device";

  /** Nearest-rank percentile over an ascending array. */
  function pct(sorted, p) {
    if (!sorted.length) return 0;
    var i = Math.ceil(p * sorted.length) - 1;
    if (i < 0) i = 0;
    if (i > sorted.length - 1) i = sorted.length - 1;
    return sorted[i];
  }

  function finite(v) {
    return typeof v === "number" && isFinite(v) && v >= 0;
  }

  /**
   * A bounded sample set. It keeps the true count and the true max whatever
   * happens, and retains at most sampleMax raw values for percentiles —
   * reservoir sampling past the cap, so a long window stays representative
   * instead of only remembering its beginning.
   */
  /**
   * What this ENGINE cannot do, out of the short list the lobby actually
   * depends on. Reported so a device that quietly loses a feature is visible
   * here instead of arriving as a screenshot.
   *
   * Measured, not inferred from the user agent: every browser on iPadOS uses
   * the system WebKit whatever its name says, so a Chrome version there tells
   * you nothing. It also runs BEFORE any polyfill: this file is inlined as the
   * first classic script on the page and the SPA bundle is a deferred module,
   * so what is recorded is the engine as it shipped, not as we patched it.
   *
   * Keep the list in step with frontend-v2/src/lib/baseline-polyfills.ts. A gap
   * named here and filled there is a device running on the polyfill; a gap
   * named here and NOT filled there is a feature that device is losing.
   */
  var ENGINE_PROBES = [
    // Safari 16.0. Read on the way into every lobby request, so its absence
    // threw before fetch and the session list never loaded (2026-08-19).
    ["AbortSignal.timeout", function (g) {
      return !!g.AbortSignal && typeof g.AbortSignal.timeout === "function";
    }],
    // Safari 17.0. Reached inside the URL sanitizer mermaid bundles.
    ["URL.canParse", function (g) {
      return !!g.URL && typeof g.URL.canParse === "function";
    }],
    // Safari 16.4. remark-gfm's autolink extension builds one on every markdown
    // render, so without it the text view drops the GFM extensions.
    ["RegExp lookbehind", function (g) {
      new (g.RegExp || RegExp)("(?<=a)b");
      return true;
    }],
  ];

  /** Comma-joined names of what `scope` is missing; "" when it has everything. */
  function engineGaps(scope) {
    var g = scope || globalThis;
    var out = [];
    for (var i = 0; i < ENGINE_PROBES.length; i++) {
      var ok = false;
      try {
        ok = !!ENGINE_PROBES[i][1](g);
      } catch (e) {
        ok = false; // a probe that throws IS the absence it tests for
      }
      if (!ok) out.push(ENGINE_PROBES[i][0]);
    }
    return out.join(",");
  }

  function samples(max, random) {
    var vals = [],
      n = 0,
      hi = 0;
    return {
      add: function (v) {
        if (!finite(v)) return;
        n += 1;
        if (v > hi) hi = v;
        if (vals.length < max) {
          vals.push(v);
          return;
        }
        var j = Math.floor(random() * n);
        if (j < max) vals[j] = v;
      },
      count: function () {
        return n;
      },
      retained: function () {
        return vals.length;
      },
      /** Writes tl.<name>.{n,p50,p95,max} into out, or nothing when empty. */
      into: function (out, name) {
        if (!n) return;
        var sorted = vals.slice().sort(function (a, b) {
          return a - b;
        });
        out["tl." + name + ".n"] = n;
        out["tl." + name + ".p50"] = pct(sorted, 0.5);
        out["tl." + name + ".p95"] = pct(sorted, 0.95);
        out["tl." + name + ".max"] = hi;
      },
    };
  }

  function create(opts) {
    opts = opts || {};
    var cfg = {};
    for (var k in DEFAULTS) cfg[k] = opts[k] === undefined ? DEFAULTS[k] : opts[k];

    var now = opts.now || function () { return Date.now(); };
    var send = opts.send || function () {};
    var random = opts.random || Math.random;
    var store = opts.storage || null;
    var enabled = opts.enabled !== false;

    var id = function () {
      var s = "";
      for (var i = 0; i < 4; i++) s += ("0000" + Math.floor(random() * 65536).toString(16)).slice(-4);
      return s;
    };

    // ---- identity ------------------------------------------------------
    // The tab id is per page life; the device id persists, so a device that
    // is consistently slow is visible across reloads and days. Neither is
    // written when diagnostics are off.
    var tabId = id();
    var deviceId = "";
    if (enabled && store) {
      try {
        deviceId = store.getItem(DEVICE_KEY) || "";
        if (!deviceId) {
          deviceId = id();
          store.setItem(DEVICE_KEY, deviceId);
        }
      } catch (e) {
        /* private mode, quota, disabled storage — diagnostics still work */
      }
    }

    // ---- state ---------------------------------------------------------
    var buffer = [];
    var bootAt = now();
    var visible = true;
    var connSeq = 0;

    var winStart = bootAt;
    var winTraffic = false;
    var winVisible = false;
    var lastHeartbeat = bootAt;

    var lastRecvAt = -Infinity; // when output last arrived
    var lastSendAt = -Infinity; // when input last went out
    var stallReported = false;

    // Echo gate: a candidate is a single keystroke that left while the
    // terminal was quiet. A second send before the echo makes the pairing
    // ambiguous, so the candidate is abandoned rather than guessed at.
    var echoAt = -1;
    var echoAmbiguous = false;
    var pendingKey = false;
    var keyAt = -1; // when the pending keystroke was seen, for the input path

    var ring = [];
    var seenErrors = {}; // dedupe key -> {n, attrs}

    var m = {};
    function freshWindow(t) {
      m = {
        input: samples(cfg.sampleMax, random),
        echo: samples(cfg.sampleMax, random),
        render: samples(cfg.sampleMax, random),
        api: samples(cfg.sampleMax, random),
        longtask: samples(cfg.sampleMax, random),
      };
      m.echoUnmatched = 0;
      m.jank = 0;
      m.apiErr = 0;
      m.wsIn = 0;
      m.wsOut = 0;
      m.framesIn = 0;
      m.framesOut = 0;
      winStart = t;
      winTraffic = false;
      winVisible = visible;
      seenErrors = {};
    }
    freshWindow(bootAt);

    // ---- emission ------------------------------------------------------
    function ids() {
      return { tab: tabId, device: deviceId };
    }

    function stamp(attrs) {
      var out = attrs || {};
      out["tl.tab"] = tabId;
      if (deviceId) out["tl.device"] = deviceId;
      if (opts.parent) out["tl.parent"] = opts.parent;
      if (opts.session) out["tl.session"] = opts.session;
      if (opts.role) out["tl.role"] = opts.role;
      if (connSeq) out["tl.conn"] = connSeq;
      return out;
    }

    /**
     * Queue a record. urgent records go out at once rather than waiting for
     * the next tick: an incident is most worth having when the page is in
     * trouble, and HTTP still works when the WebSocket does not — reporting a
     * dropped connection is the case this exists for. Rollups and heartbeats
     * batch normally.
     */
    function emit(name, attrs, urgent) {
      if (!enabled) return;
      buffer.push({ name: name, attrs: stamp(attrs) });
      // Keep the NEWEST records: during a storm the recent ones explain it.
      if (buffer.length > cfg.bufferMax) buffer = buffer.slice(-cfg.bufferMax);
      if (urgent) flush();
    }

    function flush() {
      if (!enabled || !buffer.length) return;
      var batch = { kind: "diag", client: opts.client || "unknown", build: opts.build || "", events: buffer };
      buffer = []; // drop on failure; never retry into a growing buffer
      try {
        send(batch);
      } catch (e) {
        /* diagnostics are never worth surfacing */
      }
    }

    /** The flight recorder, newest last, as the intake expects it. */
    function trace() {
      return ring.length ? ring.slice(-cfg.ringMax) : null;
    }

    function refreshSentinel(t) {
      if (!enabled || !store) return;
      try {
        store.setItem(
          LIVE_KEY,
          JSON.stringify({ tab: tabId, aliveS: Math.round((t - bootAt) / 1000), session: opts.session || "" }),
        );
      } catch (e) {
        /* storage unavailable — death detection degrades, nothing else does */
      }
    }

    // ---- windows -------------------------------------------------------
    function closeWindow(t, partial) {
      // A window reports only if the tab was visible AND saw traffic. An idle
      // or hidden tab is not measured at all — throttled timers and a stopped
      // rAF would distort every number in it.
      if (winVisible && visible && winTraffic) {
        var a = {};
        a["tl.win_s"] = Math.round((t - winStart) / 1000);
        if (partial) a["tl.partial"] = true;
        m.input.into(a, "input");
        m.echo.into(a, "echo");
        m.render.into(a, "render");
        m.api.into(a, "api");
        m.longtask.into(a, "longtask");
        if (m.echoUnmatched) a["tl.echo.unmatched"] = m.echoUnmatched;
        if (m.jank) a["tl.jank.n"] = m.jank;
        if (m.apiErr) a["tl.api.err"] = m.apiErr;
        if (m.wsIn) a["tl.ws.in_b"] = m.wsIn;
        if (m.wsOut) a["tl.ws.out_b"] = m.wsOut;
        if (m.framesIn) a["tl.ws.in_n"] = m.framesIn;
        if (m.framesOut) a["tl.ws.out_n"] = m.framesOut;
        emit("perf.rollup", a);
      }
      // Errors seen this window go out as one record each, carrying how many
      // times they fired — a looping error is one line with n=400.
      for (var key in seenErrors) {
        var rec = seenErrors[key];
        rec.attrs["tl.n"] = rec.n;
        emit("app.exception", rec.attrs);
      }
      freshWindow(t);
    }

    /** Called on an interval. Closes due windows, heartbeats, spots stalls. */
    function tick() {
      try {
        var t = now();

        // A send with no answer past the threshold is a stall, reported once
        // per silence with the events that led into it.
        if (!stallReported && lastSendAt > lastRecvAt && t - lastSendAt >= cfg.stallMs) {
          stallReported = true;
          emit("term.stall", { "tl.ms": Math.round(t - lastSendAt), "tl.trace": trace() }, true);
        }
        // An echo that never arrived is counted, never guessed at.
        if (echoAt >= 0 && t - echoAt > cfg.matchMs) {
          m.echoUnmatched += 1;
          echoAt = -1;
          echoAmbiguous = false;
        }

        if (t - winStart >= cfg.windowMs) closeWindow(t, false);

        // Refresh the sentinel so a tab that is killed leaves behind how long
        // it had been alive. Without this, every death reports zero uptime.
        refreshSentinel(t);

        var quiet = !(visible && winTraffic);
        if (quiet && t - lastHeartbeat >= cfg.heartbeatMs) {
          lastHeartbeat = t;
          emit("app.alive", {
            "tl.state": visible ? "idle" : "hidden",
            "tl.alive_s": Math.round((t - bootAt) / 1000),
          });
        }
        flush();
      } catch (e) {
        /* a broken tick must never take the page with it */
      }
    }

    // ---- measurement inputs --------------------------------------------
    function traffic() {
      winTraffic = true;
    }

    function onKeydown() {
      pendingKey = true;
      keyAt = now();
      traffic();
    }

    /** keydown -> ws.send, the client's own cost. Unconfounded. */
    function onInputLatency(ms) {
      m.input.add(ms);
      traffic();
    }

    /** term.write -> render callback, from the existing flow-control hooks. */
    function onRender(ms) {
      m.render.add(ms);
      traffic();
    }

    function onWsSend(bytes) {
      var t = now();
      m.wsOut += finite(bytes) ? bytes : 0;
      m.framesOut += 1;
      // Open the echo gate only for a lone keystroke leaving a quiet terminal.
      if (pendingKey) {
        // keydown -> ws.send is the client's own cost: main-thread work, key
        // handling, encoding. Unconfounded by anything off-device.
        if (keyAt >= 0) m.input.add(t - keyAt);
        if (echoAt >= 0) {
          echoAmbiguous = true; // a second key before the echo — unpairable
        } else if (t - lastRecvAt >= cfg.quietMs) {
          echoAt = t;
          echoAmbiguous = false;
        }
        pendingKey = false;
        keyAt = -1;
      }
      lastSendAt = t;
      stallReported = false;
      traffic();
    }

    function onWsRecv(bytes) {
      var t = now();
      m.wsIn += finite(bytes) ? bytes : 0;
      m.framesIn += 1;
      if (echoAt >= 0) {
        if (echoAmbiguous || t - echoAt > cfg.matchMs) m.echoUnmatched += 1;
        else m.echo.add(t - echoAt);
        echoAt = -1;
        echoAmbiguous = false;
      }
      lastRecvAt = t;
      traffic();
    }

    function onLongTask(ms) {
      m.longtask.add(ms);
      traffic();
    }

    function onJank() {
      m.jank += 1;
      traffic();
    }

    function onApi(endpoint, ms, status, reqId) {
      m.api.add(ms);
      if (typeof status === "number" && status >= 400) m.apiErr += 1;
      traffic();
      // Never report on the reporting channel: a slow /telemetry POST produced
      // an api.slow record, which was itself POSTed to /telemetry.
      var isSelf = String(endpoint || "").indexOf("/telemetry") !== -1;
      if (!isSelf && finite(ms) && ms >= cfg.slowApiMs) {
        var a = { "tl.ep": String(endpoint || ""), "tl.ms": Math.round(ms) };
        if (typeof status === "number") a["tl.status"] = status;
        if (reqId) a["tl.req"] = String(reqId);
        emit("api.slow", a, true);
      }
    }

    // ---- connections ----------------------------------------------------
    /**
     * The terminal document's own boot, leg by leg. `term.ready` has been in the
     * event catalog all along with no caller, so the exact path this work is
     * about — open a session, get a terminal — had no timing at all: 0 records
     * in 14 days. Legs, not a total, because they fail differently: navigation
     * is the 464 KB document, token is one round trip, paint is xterm.
     */
    function onTermReady(d) {
      d = d || {};
      var a = {};
      if (finite(d.navMs)) a["tl.nav_ms"] = Math.round(d.navMs);
      if (finite(d.ttfbMs)) a["tl.ttfb_ms"] = Math.round(d.ttfbMs);
      if (finite(d.tokenMs)) a["tl.token_ms"] = Math.round(d.tokenMs);
      if (finite(d.paintMs)) a["tl.paint_ms"] = Math.round(d.paintMs);
      if (finite(d.bytes)) a["tl.nav.bytes"] = Math.round(d.bytes);
      if (d.cached === true || d.cached === false) a["tl.nav.cached"] = d.cached;
      if (d.retried === true) a["tl.retried"] = true;
      emit("term.ready", a, true);
    }

    function onConnOpen(d) {
      d = d || {};
      connSeq += 1;
      var a = {};
      if (finite(d.tokenMs)) a["tl.token_ms"] = Math.round(d.tokenMs);
      if (finite(d.handshakeMs)) a["tl.handshake_ms"] = Math.round(d.handshakeMs);
      emit("conn.opened", a, true);
      traffic();
    }

    function onConnDrop(d) {
      d = d || {};
      var a = { "tl.trace": trace() };
      if (typeof d.code === "number") a["tl.code"] = d.code;
      if (finite(d.upS)) a["tl.up_s"] = Math.round(d.upS);
      if (finite(d.downMs)) a["tl.down_ms"] = Math.round(d.downMs);
      if (finite(d.reconnectN)) a["tl.reconnect_n"] = d.reconnectN;
      // A deploy restarts ttyd and drops every open socket. Labelling those
      // keeps deploy churn separable from real instability.
      if (d.reason) a["tl.reason"] = String(d.reason);
      emit("conn.dropped", a, true);
      traffic();
    }

    // ---- failures --------------------------------------------------------
    function onException(err, kind) {
      try {
        if (!err) return;
        var msg = String(err.message || err.reason || err);
        var stack = String(err.stack || "");
        var src = err.source ? String(err.source) : "";
        if (src && err.line !== undefined) src += ":" + err.line + ":" + (err.col === undefined ? 0 : err.col);
        // Dedupe on message + first stack frame: a loop becomes one record.
        var key = msg + "|" + stack.split("\n")[0];
        if (seenErrors[key]) {
          seenErrors[key].n += 1;
          return;
        }
        seenErrors[key] = {
          n: 1,
          attrs: { "tl.msg": msg, "tl.src": src, "tl.stack": stack, "tl.kind": String(kind || "error") },
        };
      } catch (e) {
        /* an error while recording an error is not worth a second one */
      }
    }

    /** Push a raw event into the flight recorder. Geometry and control keys
     *  only — never typed characters. */
    function pushRing(ev) {
      try {
        if (!ev || typeof ev !== "object") return;
        var rec = {};
        for (var k in ev) {
          var v = ev[k];
          var ty = typeof v;
          if (ty === "string" || ty === "number" || ty === "boolean" || v === null) rec[k] = v;
        }
        rec.t = Math.round(now() - bootAt);
        ring.push(rec);
        if (ring.length > cfg.ringMax) ring = ring.slice(-cfg.ringMax);
      } catch (e) {
        /* the recorder must never be the thing that breaks */
      }
    }

    /** Emit one more app.context record — used when a value the boot record
     *  wanted only exists later (nav.load fires after boot, by definition).
     *  Deliberately not `boot()`: that also runs the page-life sentinel and
     *  would report a second life for the same page. */
    function navContext(attrs) {
      if (attrs && typeof attrs === "object") emit("app.context", attrs, true);
    }

    function incident(kind, attrs) {
      var a = attrs && typeof attrs === "object" ? attrs : {};
      a["tl.kind"] = String(kind || "unknown");
      a["tl.trace"] = trace();
      emit("diag.incident", a, true);
    }

    // ---- lifecycle --------------------------------------------------------
    function boot(context) {
      if (!enabled) return;
      // A sentinel that outlived its page life means the previous tab went
      // away without a pagehide: killed rather than closed.
      if (store) {
        try {
          var prev = store.getItem(LIVE_KEY);
          if (prev) {
            var rec = JSON.parse(prev);
            emit(
              "app.died",
              { "tl.prev_tab": rec.tab, "tl.alive_s": rec.aliveS || 0, "tl.session": rec.session || "" },
              true,
            );
          }
          store.setItem(LIVE_KEY, JSON.stringify({ tab: tabId, aliveS: 0, session: opts.session || "" }));
        } catch (e) {
          /* storage unavailable — diagnostics continue without death detection */
        }
      }
      if (context && typeof context === "object") emit("app.context", context, true);
    }

    function setVisible(v) {
      var t = now();
      // Close the window at the visibility edge so a window is never half
      // measured and half not.
      if (visible !== !!v) closeWindow(t, true);
      visible = !!v;
      winVisible = visible;
      lastHeartbeat = t;
    }

    // Focus is deliberately not part of "active" — a terminal rendering a long
    // turn in a background window is a real case worth measuring. Kept so call
    // sites can report it without the state machine acting on it.
    function setFocused() {}

    function close() {
      if (!enabled) return;
      closeWindow(now(), true);
      if (store) {
        try {
          store.removeItem(LIVE_KEY);
        } catch (e) {
          /* nothing left to do if storage is gone */
        }
      }
      flush();
    }

    return {
      ids: ids,
      boot: boot,
      close: close,
      tick: tick,
      flush: flush,
      setVisible: setVisible,
      setFocused: setFocused,
      onKeydown: onKeydown,
      onInputLatency: onInputLatency,
      onRender: onRender,
      onWsSend: onWsSend,
      onWsRecv: onWsRecv,
      onLongTask: onLongTask,
      onJank: onJank,
      onApi: onApi,
      onConnOpen: onConnOpen,
      onTermReady: onTermReady,
      navContext: navContext,
      onConnDrop: onConnDrop,
      onException: onException,
      ring: pushRing,
      incident: incident,
      // introspection, for tests and for a console when something looks wrong
      buffered: function () {
        return buffer.length;
      },
      sampleCount: function (name) {
        return m[name] ? m[name].retained() : 0;
      },
    };
  }

  /** Best-effort byte length of anything that can go over a WebSocket. */
  function sizeOf(data) {
    try {
      if (typeof data === "string") return data.length;
      if (data && typeof data.byteLength === "number") return data.byteLength;
      if (data && typeof data.size === "number") return data.size;
    } catch (e) {
      /* an exotic payload is not worth a throw */
    }
    return 0;
  }

  /**
   * Wrap fetch so every same-origin API call is timed and carries a request id
   * the server echoes back — that pairing is what splits a slow call into
   * network and server time. Call sites are untouched, which matters: the two
   * vanilla surfaces are large hand-written files and each edit to them is a
   * chance to introduce the kind of drift that left term.html calling a
   * function it never defined.
   *
   * Cross-origin calls are left entirely alone: adding a header to one would
   * trigger a CORS preflight that the request did not previously need.
   */
  function instrumentFetch(native, d, timer) {
    var seq = 0;
    var tabPart = d && d.ids ? d.ids().tab : "tab";
    return function (input, init) {
      var url = "";
      try {
        url = typeof input === "string" ? input : input && input.url ? input.url : "";
      } catch (e) {
        /* fall through as cross-origin */
      }
      var sameOrigin = url.charAt(0) === "/" || (url.indexOf("http") !== 0 && url.indexOf("//") !== 0);
      if (!sameOrigin) return native(input, init);

      var reqId, opts, elapsed;
      try {
        seq += 1;
        reqId = tabPart + "-" + seq;
        opts = init ? Object.assign({}, init) : {};
        var headers = new Headers(opts.headers || (typeof input === "object" && input.headers) || {});
        headers.set("X-TL-Req", reqId);
        opts.headers = headers;
        elapsed = timer ? timer : null;
      } catch (e) {
        return native(input, init); // never let bookkeeping cost a request
      }

      var started = elapsed ? 0 : performance.now();
      var took = function () {
        return elapsed ? elapsed() : performance.now() - started;
      };
      var report = function (status) {
        try {
          d.onApi(new URL(url, "http://x").pathname, took(), status, reqId);
        } catch (e) {
          /* diagnostics must never turn a good response into a failure */
        }
      };
      return native(input, opts).then(
        function (res) {
          report(res && typeof res.status === "number" ? res.status : 0);
          return res;
        },
        function (err) {
          report(0); // a network failure has no HTTP status
          throw err;
        },
      );
    };
  }

  /**
   * Wrap WebSocket so connection health and terminal traffic are measured
   * without touching the ttyd protocol code.
   *
   * The statics are copied deliberately: term.html guards every send with
   * `ws.readyState === WebSocket.OPEN`, so a wrapper that dropped OPEN would
   * freeze the terminal rather than merely lose a metric. Every diagnostics
   * call inside is individually guarded for the same reason.
   */
  function instrumentWebSocket(Native, d) {
    function Wrapped(url, protocols) {
      var ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
      var openedAt = Date.now();
      try {
        ws.addEventListener("open", function () {
          try {
            d.onConnOpen({ handshakeMs: Date.now() - openedAt });
          } catch (e) {}
        });
        ws.addEventListener("message", function (e) {
          try {
            d.onWsRecv(sizeOf(e && e.data));
          } catch (err) {}
        });
        ws.addEventListener("close", function (e) {
          try {
            d.onConnDrop({ code: e && e.code, upS: (Date.now() - openedAt) / 1000 });
          } catch (err) {}
        });
        var nativeSend = ws.send;
        ws.send = function (data) {
          try {
            d.onWsSend(sizeOf(data));
          } catch (e) {}
          return nativeSend.call(ws, data);
        };
      } catch (e) {
        /* an un-instrumentable socket is still a working socket */
      }
      return ws;
    }
    try {
      Wrapped.prototype = Native.prototype;
      Wrapped.CONNECTING = Native.CONNECTING;
      Wrapped.OPEN = Native.OPEN;
      Wrapped.CLOSING = Native.CLOSING;
      Wrapped.CLOSED = Native.CLOSED;
    } catch (e) {
      return Native; // if the statics cannot be carried over, do not wrap
    }
    return Wrapped;
  }

  /**
   * Wire a real browser up to a diagnostics instance: the intake transport,
   * localStorage, the visibility and lifecycle edges, global error handlers,
   * long-task observation and the tick interval.
   *
   * Everything here is best-effort. A browser missing PerformanceObserver, or
   * a page where storage throws, loses that signal and keeps the rest.
   */
  function bind(o) {
    o = o || {};
    var url = o.url || "/api/sessions/telemetry";
    var d = create({
      client: o.client,
      role: o.role,
      session: o.session,
      parent: o.parent,
      build: o.build,
      enabled: o.enabled !== false,
      now: function () {
        return performance.now();
      },
      storage: (function () {
        try {
          return window.localStorage;
        } catch (e) {
          return null;
        }
      })(),
      send: function (batch) {
        var body = JSON.stringify(batch);
        // sendBeacon survives a page that is going away; fetch is used while
        // the page is alive so a failure is visible to the caller as a throw.
        if (document.visibilityState === "hidden" && navigator.sendBeacon) {
          navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
          return;
        }
        fetch(url, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: body,
        }).catch(function () {});
      },
    });

    try {
      window.addEventListener("error", function (e) {
        d.onException(
          { message: e.message, source: e.filename, line: e.lineno, col: e.colno, stack: e.error && e.error.stack },
          "onerror",
        );
      });
      window.addEventListener("unhandledrejection", function (e) {
        var r = e.reason || {};
        d.onException({ message: r.message || String(r), stack: r.stack }, "rejection");
      });
      document.addEventListener("visibilitychange", function () {
        d.setVisible(document.visibilityState === "visible");
        if (document.visibilityState === "hidden") d.flush();
      });
      window.addEventListener("pagehide", function () {
        d.close();
      });
      d.setVisible(document.visibilityState === "visible");
    } catch (e) {
      /* an environment without these still measures what it can */
    }

    // Keydown in the capture phase, so the timestamp is taken before xterm's
    // own handler runs and the input-path measurement includes it.
    try {
      window.addEventListener(
        "keydown",
        function () {
          d.onKeydown();
        },
        true,
      );
    } catch (e) {
      /* input latency is lost, everything else still measures */
    }

    // Instrument the platform rather than the call sites.
    if (o.instrument !== false) {
      try {
        window.fetch = instrumentFetch(window.fetch.bind(window), d, null);
      } catch (e) {
        /* an un-wrappable fetch keeps working, unmeasured */
      }
      try {
        window.WebSocket = instrumentWebSocket(window.WebSocket, d);
      } catch (e) {
        /* same: the terminal matters more than the metric */
      }
    }

    // Frame jank: a gap far past a frame budget while the tab is visible means
    // something blocked the main thread. Cheap, and it stops itself when the
    // tab is hidden because rAF stops firing there.
    try {
      var lastFrame = 0;
      var frame = function (ts) {
        if (lastFrame && ts - lastFrame > 100) d.onJank();
        lastFrame = ts;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    } catch (e) {
      /* no rAF, no jank signal */
    }

    try {
      if (typeof PerformanceObserver === "function") {
        new PerformanceObserver(function (list) {
          var entries = list.getEntries();
          for (var i = 0; i < entries.length; i++) d.onLongTask(entries[i].duration);
        }).observe({ entryTypes: ["longtask"] });
      }
    } catch (e) {
      /* longtask is not observable everywhere (notably Safari) */
    }

    // Boot context: how long the page took to load, and what it is running on.
    // Built field by field, and initialised BEFORE the first API call that
    // might not exist: a browser missing one of these should cost that field,
    // not the whole boot record.
    var context = {};
    try {
      var nav = performance.getEntriesByType("navigation")[0];
      if (nav) {
        context["tl.nav.ttfb"] = Math.round(nav.responseStart);
        // These two are read at boot, which is BEFORE the events they name have
        // fired — so they were 0 in every record ever collected. Keep reading
        // them (a bfcache restore or a late boot does have them), and re-emit
        // the context once `load` lands so there is one record per page life
        // that carries a real download duration. That number is the only free
        // throughput estimate available on iOS, where navigator.connection does
        // not exist at all.
        context["tl.nav.dom"] = Math.round(nav.domContentLoadedEventEnd);
        context["tl.nav.load"] = Math.round(nav.loadEventEnd || nav.duration);
        if (!nav.loadEventEnd && typeof window.addEventListener === "function") {
          window.addEventListener(
            "load",
            function () {
              try {
                var late = performance.getEntriesByType("navigation")[0];
                if (!late || !late.loadEventEnd) return;
                d.navContext({
                  "tl.nav.ttfb": Math.round(late.responseStart),
                  "tl.nav.dom": Math.round(late.domContentLoadedEventEnd),
                  "tl.nav.load": Math.round(late.loadEventEnd),
                  "tl.nav.bytes": late.transferSize || 0,
                  "tl.nav.cached": late.transferSize === 0,
                });
              } catch (e) {
                /* one missing context record must never break a page */
              }
            },
            { once: true },
          );
        }
        context["tl.nav.bytes"] = nav.transferSize || 0;
        context["tl.nav.cached"] = nav.transferSize === 0;
      }
      var c = navigator.connection;
      if (c) {
        context["tl.net.type"] = c.effectiveType || "";
        context["tl.net.rtt"] = c.rtt || 0;
        context["tl.net.down"] = c.downlink || 0;
      }
      context["tl.dev.mem"] = navigator.deviceMemory || 0;
      context["tl.dev.cpu"] = navigator.hardwareConcurrency || 0;
      context["tl.dev.dpr"] = window.devicePixelRatio || 1;
      context["tl.dev.w"] = window.screen ? window.screen.width : 0;
      context["tl.dev.h"] = window.screen ? window.screen.height : 0;
      context["tl.dev.plat"] = (navigator.platform || "").slice(0, 40);
      // "" on a current browser; on the oldest device we serve it names what
      // that engine lacks, which is the difference between a working lobby and
      // a screenshot of one.
      context["tl.eng.missing"] = engineGaps(globalThis);
    } catch (e) {
      /* context is a nicety; its absence must not cost the boot record */
    }

    d.boot(context);
    try {
      setInterval(function () {
        d.tick();
      }, 5000);
    } catch (e) {
      /* without a timer, windows close on visibility and close edges only */
    }
    return d;
  }

  return {
    create: create,
    bind: bind,
    engineGaps: engineGaps,
    instrumentFetch: instrumentFetch,
    instrumentWebSocket: instrumentWebSocket,
    DEFAULTS: DEFAULTS,
  };
})();
