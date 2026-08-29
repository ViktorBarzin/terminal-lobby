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

  // ---- byte accounting ---------------------------------------------------
  /**
   * The five feature buckets "Data used" reports, in the order the panel
   * prefers when totals tie. Named after things that could be changed rather
   * than after endpoints, because the number exists to be acted on.
   */
  var NET_BUCKETS = ["term", "app", "text", "files", "api"];


  /**
   * What each message costs on the wire beyond its compressed payload, and
   * which a CompressionStream cannot reproduce.
   *
   * permessage-deflate ends a deflate block per message with a sync flush.
   * CompressionStream has no flush API, so the mirror compresses the window as
   * one continuous block and misses that cost entirely. Measured on real pane
   * content over 3,000 frames: 273,591 bytes with a per-message flush against
   * 208,671 without — a 23.7% under-report, or 21.6 bytes per message.
   *
   * The cost is not a constant; it grows with message size, because ending a
   * larger block early wastes more. Measured per message:
   *
   *     40 B -> 11.3    600 B -> 17.5    4 kB -> 28.2
   *    200 B -> 12.5   1200 B -> 20.7   16 kB -> 29.6
   *
   * Terminal messages measured live average ~780 B (377,080 B over 486 frames;
   * 318,710 over 400), which puts the flush cost near 18 B. From that: less the
   * four-byte tail permessage-deflate strips, plus a two-byte WebSocket frame
   * header at these payload sizes.
   *
   * It is a calibrated estimate, not a measurement. `tl.ws.in_n` carries the
   * message count on the same record, so the correction can be backed out.
   */
  var PER_MESSAGE_WIRE_BYTES = 16;

  /**
   * The same correction for the Text view's stream, which is a different
   * transport and needs its own number.
   *
   * session-events gzips with a per-event sync flush (session-events/sse.go).
   * Measured over 300 events, gzip level 6: 9.5 bytes missing per 200 B event,
   * 14.5 at 1 kB, 26.4 at 5 kB, 25.8 at 20 kB. On top of that each flush is its
   * own HTTP chunk or HTTP/2 DATA frame, roughly 9 bytes, and nothing is
   * stripped the way permessage-deflate strips its tail.
   *
   * 24 sits mid-range for the multi-kilobyte turns this stream mostly carries,
   * where the term is under 1% of the event either way. It is the least precise
   * number in this file, and the one that matters least.
   */
  var SSE_PER_MESSAGE_WIRE_BYTES = 24;

  /**
   * Which bucket a request belongs to, from its path alone.
   *
   * Query strings are stripped deliberately: term.html carries the session name
   * in its query, which is what makes every session a fresh cache entry, and
   * that cost belongs to `app` however many distinct URLs it wears.
   */
  function bucketFor(url) {
    var p = String(url || "");
    try {
      // Accepts an absolute URL or a bare path; the base is never used.
      p = new URL(p, "http://x").pathname;
    } catch (e) {
      var q = p.indexOf("?");
      if (q !== -1) p = p.slice(0, q);
    }
    // Prefixes are the ones frontend-v2/src/lib/config.ts exports. They are
    // repeated here rather than imported because this file is shared verbatim
    // with the two vanilla surfaces and has no module system; the test asserts
    // the two agree, so a prefix that moves fails there rather than silently
    // routing a bucket's traffic somewhere else.
    if (p.indexOf("/events/") === 0 || p.indexOf("/earlier/") === 0) return "text";
    if (p.indexOf("/files/") === 0) return "files";
    // Gallery images and pasted uploads are what people actually see as files;
    // the rest of clipboard-upload's surface is ordinary API chatter.
    if (p.indexOf("/clipboard/img/") === 0 || p.indexOf("/clipboard/upload") === 0) return "files";
    if (p.indexOf("/clipboard/") === 0) return "api";
    if (p.indexOf("/skills") === 0) return "api";
    if (p.indexOf("/api/") === 0) return "api";
    // The app itself: the two documents, their fingerprints, and the assets
    // served alongside them. Everything the page IS, rather than what it asks
    // for once it is running.
    if (
      p === "/" ||
      p.indexOf("/fonts/") === 0 ||
      /\.(html|js|css|woff2?|png|svg|webmanifest)$/.test(p) ||
      p === "/build-id" ||
      p === "/term-build-id"
    ) {
      return "app";
    }
    return "api";
  }

  /**
   * Is this URL a stream the mirror already accounts for, event by event?
   *
   * Only the SSE stream itself. `/earlier/` is an ordinary fetch whose
   * transferSize is a real measurement and belongs in the same bucket.
   */
  function isMirroredStream(url) {
    var p = String(url || "");
    try {
      p = new URL(p, "http://x").pathname;
    } catch (e) {
      var q = p.indexOf("?");
      if (q !== -1) p = p.slice(0, q);
    }
    return p.indexOf("/events/") === 0;
  }

  /**
   * A deflate mirror: an estimate of what a compressed stream actually cost on
   * the wire.
   *
   * WHY THIS IS MODELLED AND NOT MEASURED. ttyd negotiates permessage-deflate
   * with context takeover in both directions, and session-events gzips its SSE
   * with a per-event sync flush. The browser inflates both before any API can
   * see them, and no API reports WebSocket wire bytes at all. Feeding the same
   * bytes through the same algorithm reproduces the server's work closely,
   * including the shared sliding window that makes a redrawn terminal screen
   * collapse so hard. Measured on real pane content shaped as a stream: 13.6x.
   *
   * WHY IT ROTATES. A CompressionStream emits nothing until close() — measured,
   * 435,600 bytes of input produced zero readable output across 200 writes. One
   * mirror per connection would therefore read zero for the life of a socket
   * that never closes. So it is closed and restarted every window, and the
   * result is attributed to whichever window is open when it resolves. Nothing
   * is lost; a window's worth of bytes can land up to a minute late, and at a
   * local midnight at most one window falls on the wrong day.
   *
   * The reset costs accuracy, because the server never resets its context.
   * Measured against a continuous context over the same 3,000-frame stream:
   * 273,591 bytes against 268,833, so rotation overstates by 1.8% — small
   * against the 13.6x it is estimating.
   */
  function mirror(perMessageBytes) {
    /**
     * One compressor's state. A rotation hands a REPLACEMENT over before the
     * outgoing one has finished flushing, and its pump keeps writing while it
     * drains — so each stream owns its counters. A shared counter would have
     * the old pump adding into the new stream's total.
     */
    function open() {
      try {
        if (typeof CompressionStream !== "function") return null;
        var cs = new CompressionStream("deflate-raw");
        var st = { writer: cs.writable.getWriter(), out: 0, in: 0, msgs: 0, dropped: 0 };
        var reader = cs.readable.getReader();
        st.reading = (function pump() {
          return reader.read().then(function (r) {
            if (r.done) return;
            st.out += r.value ? r.value.length : 0;
            return pump();
          });
        })();
        return st;
      } catch (e) {
        return null; // no CompressionStream: the modelled buckets stay at zero
      }
    }

    function bytesOf(data) {
      if (typeof data === "string") return new TextEncoder().encode(data);
      if (data instanceof Uint8Array) return data;
      if (data && typeof data.byteLength === "number" && data.byteLength >= 0) {
        try {
          return new Uint8Array(data);
        } catch (e) {
          return null;
        }
      }
      return null;
    }

    var cur = open();

    return {
      /** Feed the mirror one message, as it was on the wire. A caller that
       *  knows the browser stripped framing passes it back in — the server
       *  compressed it with the payload, so the mirror has to see it too. */
      write: function write(data) {
        if (!cur || !cur.writer) return;
        // A socket left on the default binaryType delivers Blobs, which cannot
        // be read synchronously. sizeOf already counts them, so without this a
        // correct tl.ws.in_b would sit beside a modelled zero — which reads as
        // "the terminal cost nothing" rather than as a gap. Re-entering lands
        // the message in whichever compressor is current, at most one rotation
        // later than its own.
        if (typeof Blob !== "undefined" && data instanceof Blob) {
          try {
            data.arrayBuffer().then(function (buf) {
              write(buf);
            }, function () {});
          } catch (e) {
            /* nothing more to try */
          }
          return;
        }
        var b = bytesOf(data);
        if (!b || !b.length) return;
        // An unawaited write queues the UNCOMPRESSED chunk, so a starved
        // compressor would grow the writable queue without a ceiling. Drop the
        // frame instead: a diagnostic that understates is better than a leak.
        if (typeof cur.writer.desiredSize === "number" && cur.writer.desiredSize <= 0) {
          cur.dropped += 1;
          return;
        }
        cur.in += b.length;
        cur.msgs += 1;
        try {
          // Deliberately not awaited: a diagnostic must never delay the frame
          // the terminal is about to render.
          cur.writer.write(b).catch(function () {});
        } catch (e) {
          /* an un-writable mirror is simply one that stops counting */
        }
      },

      /** Frames dropped to backpressure since the last rotation, so a mirror
       *  that gave up is visible rather than merely low. */
      dropped: function () {
        return cur ? cur.dropped : 0;
      },

      /**
       * Close this compressor, hand a fresh one over, and resolve with what the
       * closed one cost: `out` modelled wire bytes, `in` the decompressed bytes
       * that produced them. The pair is what makes the estimate checkable.
       */
      rotate: function () {
        if (!cur) {
          cur = open();
          return Promise.resolve({ out: 0, in: 0 });
        }
        // Nothing was written, so there is no context worth preserving and
        // nothing to flush. Closing an empty stream still emits two bytes,
        // which would read as traffic on a tab that saw none.
        if (!cur.msgs) return Promise.resolve({ out: 0, in: 0 });

        var old = cur;
        cur = open(); // hand over FIRST: a mirror with no writer drops frames
        var done;
        try {
          done = old.writer.close();
        } catch (e) {
          done = Promise.resolve();
        }
        return Promise.resolve(done)
          .then(function () {
            return old.reading;
          })
          .then(
            function () {
              // Plus the per-message flush cost a CompressionStream cannot emit.
              return { out: old.out + old.msgs * perMessageBytes, in: old.in };
            },
            function () {
              return { out: 0, in: 0 };
            },
          );
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

    // One mirror per compressed stream. They rotate together at each window
    // boundary; `pending` is what lets a test — and a pagehide — wait for the
    // rotation that is in flight.
    // Whether the terminal socket actually negotiated compression. null until a
    // socket opens. The mirror only makes sense when the server compressed;
    // where it did not, the bytes the browser received ARE the wire bytes.
    var wsDeflate = null;

    var termMirror = mirror(PER_MESSAGE_WIRE_BYTES);
    var textMirror = mirror(SSE_PER_MESSAGE_WIRE_BYTES);
    var pending = Promise.resolve();

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
      // Wire bytes per bucket. Kept separate from wsIn, which stays the
      // decompressed figure it has always been so existing panels keep working.
      m.net = { term: 0, app: 0, text: 0, files: 0, api: 0 };
      m.netIn = { term: 0, text: 0 };
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
        for (var i = 0; i < NET_BUCKETS.length; i++) {
          var b = NET_BUCKETS[i];
          if (m.net[b]) a["tl.net." + b + "_b"] = Math.round(m.net[b]);
        }
        // The decompressed input each estimate came from, so the compression
        // ratio the mirror believes is derivable from one record.
        if (m.netIn.term) a["tl.net.term_in_b"] = Math.round(m.netIn.term);
        if (m.netIn.text) a["tl.net.text_in_b"] = Math.round(m.netIn.text);
        // Frames a mirror refused under backpressure. Reported rather than
        // swallowed: a modelled figure that is low because it gave up should
        // not look the same as one that is low because the link was quiet.
        // Records whether the estimate is a model or a measurement, and answers
        // per device whether the edge is stripping compression.
        if (wsDeflate !== null) a["tl.net.term_deflate"] = wsDeflate;
        var termDrop = termMirror.dropped();
        var textDrop = textMirror.dropped();
        if (termDrop) a["tl.net.term_drop"] = termDrop;
        if (textDrop) a["tl.net.text_drop"] = textDrop;
        emit("perf.rollup", a);
      }

      // The device counter is deliberately NOT gated on visibility. A hidden
      // tab that downloaded four megabytes really did spend four megabytes,
      // whatever its throttled timers were doing to the latency numbers.
      var moved = false;
      for (var j = 0; j < NET_BUCKETS.length; j++) {
        if (m.net[NET_BUCKETS[j]] > 0) moved = true;
      }
      if (moved && opts.onWindow) {
        var totals = {};
        for (var k2 = 0; k2 < NET_BUCKETS.length; k2++) {
          totals[NET_BUCKETS[k2]] = Math.round(m.net[NET_BUCKETS[k2]]);
        }
        try {
          opts.onWindow(totals);
        } catch (e) {
          /* a failing store must not cost the rest of the window */
        }
      }
      // Errors seen this window go out as one record each, carrying how many
      // times they fired — a looping error is one line with n=400.
      for (var key in seenErrors) {
        var rec = seenErrors[key];
        rec.attrs["tl.n"] = rec.n;
        emit("app.exception", rec.attrs);
      }
      freshWindow(t);
      rotateMirrors();
    }

    /**
     * Close both mirrors and fold what they cost into the window that is open
     * when they resolve. The lag is bounded by one window and nothing is lost;
     * see mirror() for why a rotation is needed at all.
     */
    function rotateMirrors() {
      pending = Promise.all([termMirror.rotate(), textMirror.rotate()]).then(function (r) {
        if (r[0].out) {
          m.net.term += r[0].out;
          m.netIn.term += r[0].in;
          traffic(); // these bytes are this window's business now
        }
        if (r[1].out) {
          m.net.text += r[1].out;
          m.netIn.text += r[1].in;
          traffic();
        }
      }, function () {});
      return pending;
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

    /**
     * What the socket actually negotiated, read at open.
     *
     * This is not a formality. terminal.viktorbarzin.me is Cloudflare-proxied,
     * and Cloudflare appears to strip permessage-deflate — so a client on
     * mobile data may reach a socket with no compression at all, while one on
     * the LAN resolves past Cloudflare by split-horizon DNS and gets it. That
     * is exactly backwards from where the estimate matters: modelling
     * compression that did not happen would under-report a metered connection
     * by more than a factor of ten.
     */
    function onWsExtensions(ext) {
      wsDeflate = /permessage-deflate/i.test(String(ext || ""));
    }

    function onWsRecv(bytes, data) {
      var t = now();
      m.wsIn += finite(bytes) ? bytes : 0;
      m.framesIn += 1;
      if (wsDeflate === false) {
        // Nothing compressed these, so what arrived is what crossed the link.
        // Plus the frame header, which is on the wire either way.
        if (finite(bytes)) m.net.term += bytes + PER_MESSAGE_WIRE_BYTES;
      } else if (data !== undefined) {
        termMirror.write(data);
      }
      if (echoAt >= 0) {
        if (echoAmbiguous || t - echoAt > cfg.matchMs) m.echoUnmatched += 1;
        else m.echo.add(t - echoAt);
        echoAt = -1;
        echoAmbiguous = false;
      }
      lastRecvAt = t;
      traffic();
    }

    /**
     * One resource the browser finished fetching. `bytes` is transferSize:
     * already post-compression, already including response headers. Zero is a
     * cache hit and counts as nothing, which is correct — no bytes moved.
     */
    function onResource(url, bytes) {
      if (!finite(bytes) || bytes <= 0) return;
      // The Text view's stream is mirrored event by event, and a closed
      // EventSource DOES produce a resource entry — the client closes and
      // reconnects itself on every error, so one arrives per reconnect.
      // Counting both would charge that stream twice.
      if (isMirroredStream(url)) return;
      var b = bucketFor(url);
      m.net[b] += bytes;
      traffic();
    }

    /**
     * One SSE event. The browser strips the framing before handing it over, but
     * the server compressed the framing with the payload — so the mirror is fed
     * the line form session-events actually wrote (sse.go), reconstructed from
     * the event's own id and type.
     */
    function onSseMessage(e) {
      if (!e) return;
      var ev = typeof e === "string" ? { data: e } : e;
      if (ev.data === undefined || ev.data === null) return;
      var wire = "";
      if (ev.lastEventId) wire += "id: " + ev.lastEventId + "\n";
      // Unnamed events go out with no `event:` line at all.
      if (ev.type && ev.type !== "message") wire += "event: " + ev.type + "\n";
      wire += "data: " + ev.data + "\n\n";
      textMirror.write(wire);
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
      onWsExtensions: onWsExtensions,
      onResource: onResource,
      onSseMessage: onSseMessage,
      /** Resolves once the in-flight mirror rotation has been accounted for.
       *  Tests await it; pagehide gives it what time the browser allows. */
      settled: function () {
        return pending;
      },
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
          try {
            // Empty when the edge stripped compression; the modelling decision
            // turns on this.
            d.onWsExtensions(ws.extensions);
          } catch (e) {}
        });
        ws.addEventListener("message", function (e) {
          try {
            // The payload goes through as well as its size: ttyd compresses
            // this stream, so what it cost on the wire has to be modelled from
            // the bytes rather than read off a counter.
            d.onWsRecv(sizeOf(e && e.data), e && e.data);
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
   * Wrap EventSource so the Text view's stream is counted.
   *
   * A long-lived SSE stream produces its Resource Timing entry only when it
   * ends, and the Text view's stream is meant to stay open — so the opening
   * replay, the largest single transfer that view makes, would go uncounted
   * for as long as the session was being read. Counting each event as it
   * arrives is what makes the number live; the mirror is what makes it a wire
   * figure rather than a decompressed one, since session-events gzips.
   */
  function instrumentEventSource(Native, d) {
    function Wrapped(url, init) {
      var es = init === undefined ? new Native(url) : new Native(url, init);
      try {
        var add = es.addEventListener.bind(es);
        var counted = {};
        // `message` fires only for UNNAMED events, and session-events names
        // almost everything it sends: `event: state` for the opening snapshot,
        // `event: back` for the backfill, `event: ready`. Subscribing only to
        // `message` would miss the largest transfer the Text view makes.
        // Rather than hard-code the protocol's names here, mirror whatever the
        // page itself subscribes to.
        var count = function (type) {
          if (counted[type] || type === "open" || type === "error") return;
          counted[type] = true;
          add(type, function (e) {
            try {
              d.onSseMessage(e);
            } catch (err) {}
          });
        };
        count("message");
        es.addEventListener = function (type, fn, opts) {
          try {
            count(type);
          } catch (e) {}
          return add(type, fn, opts);
        };
      } catch (e) {
        /* an un-instrumentable stream is still a working stream */
      }
      return es;
    }
    try {
      Wrapped.prototype = Native.prototype;
      Wrapped.CONNECTING = Native.CONNECTING;
      Wrapped.OPEN = Native.OPEN;
      Wrapped.CLOSED = Native.CLOSED;
    } catch (e) {
      return Native;
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
      // Where a closed window's bytes go. The surface decides: the SPA folds
      // them into this device's store, the terminal iframe relays them to its
      // parent to be folded there.
      onWindow: o.onWindow,
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
      try {
        if (typeof window.EventSource === "function") {
          window.EventSource = instrumentEventSource(window.EventSource, d);
        }
      } catch (e) {
        /* the Text view matters more than its byte count */
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

    // Every resource the page fetched, for the measured half of "Data used".
    // transferSize is already post-compression and already counts response
    // headers, so it needs no modelling — unlike the two streams that do.
    //
    // buffered:true matters: the document's own subresources are fetched before
    // this observer is installed, and without it the app's own weight — the
    // largest measured bucket — would be missing from every page life.
    try {
      if (typeof PerformanceObserver === "function") {
        new PerformanceObserver(function (list) {
          var entries = list.getEntries();
          for (var i = 0; i < entries.length; i++) {
            var e2 = entries[i];
            d.onResource(e2.name, e2.transferSize);
          }
        }).observe({ type: "resource", buffered: true });
      }
    } catch (e) {
      /* without resource timing the measured buckets stay empty */
    }

    // The navigation itself is not a resource entry, and it is the single
    // biggest item in the app bucket: 1.2-1.4 MB on the wire for the SPA and
    // 1.7 MB for term.html.
    //
    // It has to be read AFTER parsing. term.html calls bind() from a
    // parse-blocking inline script, and at that point the navigation entry
    // reports only what has arrived — measured at 300 bytes, headers alone.
    // The SPA is a deferred module and would be correct either way; reading on
    // `load` is right for both.
    try {
      var readNav = function () {
        try {
          var navEntry = performance.getEntriesByType("navigation")[0];
          if (navEntry) d.onResource(location.pathname, navEntry.transferSize);
        } catch (e) {
          /* no navigation timing — the document's own cost goes uncounted */
        }
      };
      if (document.readyState === "complete") readNav();
      else window.addEventListener("load", readNav, { once: true });
    } catch (e) {
      /* without a load event the document's own cost goes uncounted */
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
              // A TASK LATER, not in this handler. loadEventEnd is only filled
              // in once the load event has finished dispatching, so reading it
              // from inside a load listener gives 0 — which is exactly what
              // shipped: the guard below bailed on every page life, and
              // tl.nav.load stayed 0 in all 22 records collected over three
              // hours while looking like a working fix.
              setTimeout(function () {
                try {
                  var late = performance.getEntriesByType("navigation")[0];
                  if (!late || !late.loadEventEnd) return;
                  d.navContext({
                  "tl.nav.ttfb": Math.round(late.responseStart),
                  "tl.nav.dom": Math.round(late.domContentLoadedEventEnd),
                  "tl.nav.load": Math.round(late.loadEventEnd),
                    "tl.nav.bytes": late.transferSize || 0,
                    "tl.nav.cached": late.transferSize === 0,
                    // What the connection tier WOULD read from this load, so a
                    // threshold picked from a dozen samples can be re-checked
                    // against every later one without new machinery. Bytes per
                    // millisecond of download, the same arithmetic
                    // diagnostics/connection.ts does.
                    "tl.nav.bps": (function () {
                      var down = late.responseEnd - late.responseStart;
                      if (!(late.transferSize > 8192) || !(down >= 20)) return 0;
                      return Math.round((late.transferSize / down) * 10) / 10;
                    })(),
                  });
                } catch (e) {
                  /* one missing context record must never break a page */
                }
              }, 0);
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
    bucketFor: bucketFor,
    NET_BUCKETS: NET_BUCKETS,
    engineGaps: engineGaps,
    instrumentFetch: instrumentFetch,
    instrumentWebSocket: instrumentWebSocket,
    instrumentEventSource: instrumentEventSource,
    DEFAULTS: DEFAULTS,
  };
})();
