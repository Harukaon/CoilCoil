# Claude Code 2.1.302：精选原代码证据

本文件只展示安装产物中已有源码的 AST 格式化结果，没有变量重命名或语义重构。代码块不包含外围 imports；不能直接作为独立模块执行。位置与 hash 均基于格式化之前的原始源码。

二进制 SHA-256：`5262ce9de86243fed0d21edc39b271555d56780d0112e2b194439fe1c6662d37`。提取与复核方式见 [README](../README.md)。

## chunk-hqtnbrjd.js

### `y3e`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`220964961`
- 原始代码字节数：`156`
- 原始代码 SHA-256：`275915d308d5db7897d3c4708b783e6a67298eba5eb035a54c03d4fb29ffee0f`

```javascript
function y3e(e) {
  if (e.systemPromptSnapshot === !1) return !1;
  return e.systemPromptSnapshot === !0 || a.CLAUDE_CODE_SESSION_KIND === "bg" || a.CLAUDE_CODE_REMOTE || !ZIe();
}
```

### `EMn`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`220965117`
- 原始代码字节数：`42`
- 原始代码 SHA-256：`3c432e14ae775d21e97cff9e2d23c568c40a4d4471287dea826e763d31e2ef3b`

```javascript
function EMn(e) {
  return an(e.join("\x00"));
}
```

### `cwt`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`221072464`
- 原始代码字节数：`156`
- 原始代码 SHA-256：`af4bee54476d439f02c304c4ace31b5647b6bfbdb5f043f944a2c22d56d3f125`

```javascript
function cwt() {
  return !rS(vb()).refused && !we() && !a.CCR_SESSION_PROFILE && !Rt() && Xn() && Sp() && !a.ANTHROPIC_UNIX_SOCKET && gy() && kt() && sn("allow_cache_keepalive");
}
```

### `pwt`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`221072673`
- 原始代码字节数：`111`
- 原始代码 SHA-256：`d1a0ba5426d9773a3cf01a01d77ee6aeff655c3aa98aa135f2354c8fddc33c65`

```javascript
function pwt(e, n) {
  return e?.ttl === "1h" && e.reason === "subscriber" && cwt() && !(n && ($L() || ha().isUsingOverage === !0));
}
```

### `mwt`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`221072960`
- 原始代码字节数：`898`
- 原始代码 SHA-256：`ecc7f064d0319992a4be15048e28976707ac1578627168cd9cec608f5fb7eb65`

```javascript
function mwt(e, {
  isMainLoopRequest: n,
  continuesPrefix: r,
  cacheTtl: s
}) {
  {
    let h = n || r,
      y = void 0,
      b = !1;
    try {
      if (n) {
        let H = vb(),
          K = tet(),
          V = H.header;
        y = V?.chainReleaseCount === K ? V : {
          chainReleaseCount: K,
          isSent: !1
        };
        let Q = y !== V;
        if (H.header = y, Q) {
          if (UBr(e, VI), H.armed !== void 0) Gk(H, "chain_released");
        } else if (!y.isSent) vg(e, VI);
        if (!fm(e, VI)) {
          let _e = pwt(s, Q),
            ke = _e && K3() !== void 0;
          if (b = Q && ke, !ke) {
            if (vg(e, VI), _e && !Q) zk("off for this chain: flag off", "warn");
          } else if (Q && fwt(H)) rS(H).missingRecordCount = 0, vg(e, VI), zk("off for this chain: no records", "warn"), AO("bad", "records_missing");else _N(e, VI);
        }
        y.isSent = fv(e, VI);
      }
    } catch (H) {
      if (y?.isSent ?? fv(e, VI)) _N(e, VI);else vg(e, VI);
      ZT("header_decision_failed", H);
    }
    let w = !1;
    if (h && fv(e, VI)) {
      try {
        w = !rS(vb()).refused && gy();
      } catch (H) {
        ZT("header_gate_failed", H);
      }
      if (!w && y !== void 0) y.isSent = !1, vg(e, VI);
    }
    if (b) zk(`header ${w ? "on" : "off"} for this chain`);
    if (w && y !== void 0) PNe(q3);
    return w;
  }
  return !1;
}
```

### `Ono`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`221079624`
- 原始代码字节数：`559`
- 原始代码 SHA-256：`747d771f7b63f945ce560afccd2a9dfc17886f8483c91616c843d3f1609c7800`

```javascript
async function Ono(e, n, r) {
  let {
      client: s
    } = e,
    h = Date.now();
  if (s === void 0 || h - s.builtAt >= Rno) {
    if (s = {
      value: await JU({
        maxRetries: 0,
        model: e.clientOptions.model,
        source: "cache_touch",
        agentContext: Cl(),
        credentials: e.clientOptions.credentials,
        storageV5: e.clientOptions.storageV5
      }),
      builtAt: h
    }, !n.aborted) e.client = s;
  }
  if (n.aborted || Date.now() >= r || X3(e) !== void 0) return !1;
  KXe(wd(e.clientOptions.model));
  try {
    await s.value.post(bno, {
      body: {
        request_id: e.requestId
      },
      headers: {
        "anthropic-beta": ZF([Oke, VI]).join(",")
      },
      signal: n,
      maxRetries: 0
    });
  } catch (y) {
    throw e.client = void 0, y;
  }
  return !0;
}
```

### `Lno`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`221083539`
- 原始代码字节数：`1463`
- 原始代码 SHA-256：`5707daf5269d16f5e3a7f8e332862c3ea4777a97bbb7effae839a4d0e8838894`

```javascript
async function Lno(e, n) {
  let {
    armed: r
  } = e;
  if (r === void 0) return;
  let s = r.stream === "open";
  try {
    let h = X3(r);
    if (h !== void 0) {
      Gk(e, h);
      return;
    }
    let y = K3();
    if (y === void 0) {
      Gk(e, "flag_off");
      return;
    }
    if (r.isResumed && !y.resumeTouches) {
      Gk(e, "resume_touches_off");
      return;
    }
    let b = y.inFlightWindowMinutes !== void 0 && Ano(e.run) ? Math.max(y.activityWindowMinutes, y.inFlightWindowMinutes) : y.activityWindowMinutes,
      w = uwt(e.lastEventAt, n, b * 60000);
    if (r.stream !== "open" && n - r.recordRenewedAt >= rwt) {
      e.lapsedRequestIds.add(r.requestId), Gk(e, w ? "entry_lapsed" : "record_expired"), swt(e, n);
      return;
    }
    if (!w || r.touch !== void 0 || n < rS(e).skipTouchesUntil) return;
    let H = r.stream === "open" ? 1 / 0 : Date.now() + q3 - (n - r.recordRenewedAt),
      {
        next: K
      } = e;
    if (K !== void 0 && K.touch === void 0 && n + vNe - r.recordRenewedAt < rwt) {
      if (await Ino(e, K, n), e.armed !== r || r.touch !== void 0 || n < rS(e).skipTouchesUntil) return;
    }
    if (!(await xNe(r, H)) || e.armed !== r) return;
    ANe(e, r, n);
  } catch (h) {
    if (h instanceof INe || e.armed !== r) return;
    if (r.accountEpoch !== gS()) {
      Gk(e, "account_changed");
      return;
    }
    if (h instanceof Mt && (h.status === 400 || h.status === 403) && !ine(h)) {
      Yae(e, h.status === 400 ? "touch_bad_request" : "touch_refused");
      return;
    }
    let y = CNe(h);
    if (zk(`touch failed: ${y} ${r.requestId}`), y === "touch_not_found" && s) return;
    if (MNe(e, h, y, r.touchIntervalMs, n), y === "touch_rate_limited") {
      r.wasRateLimited = !0;
      return;
    }
    if (y === "touch_error" && r.lastTouch !== y) Y3(h);
    if (r.lastTouch = y, y === "touch_not_found" || y === "touch_route_not_found") {
      if (r.notFoundCount += 1, r.notFoundCount >= wno) Gk(e, y), swt(e, n);
    }
  }
}
```

### `sse`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`221589090`
- 原始代码字节数：`83`
- 原始代码 SHA-256：`53b1782cc8cab0ce475f319193d2a71060546fe0d0d2d16e652d9818b5522f48`

```javascript
function sse(e, n, r) {
  return _te(yr().markdownFiles, `${e}:${Ste(n)}`, () => Gbo(e, n, r));
}
```

### `F7o`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`223074539`
- 原始代码字节数：`34`
- 原始代码 SHA-256：`7409256b3220d0f7e6151b9970566331f58c27f88eb3d4ce31b013359be3a969`

```javascript
function F7o(e) {
  return u5e(e, o5e);
}
```

### `u5e`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`223074573`
- 原始代码字节数：`100`
- 原始代码 SHA-256：`7a37271993101d07b6279b8355560aba56fa936ae3f582735e1be34ee15a4327`

```javascript
function u5e(e, n) {
  return e !== void 0 && n.some(r => r.endsWith("*") ? e.startsWith(r.slice(0, -1)) : e === r);
}
```

### `aQ`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`223074673`
- 原始代码字节数：`76`
- 原始代码 SHA-256：`67d59876417432a59acf0bfc8563988e72a239d05fe1f60e9f47cd23afc3b644`

```javascript
function aQ(e) {
  return a.CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL === "5m" ? "5m" : e;
}
```

### `_tn`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`223074749`
- 原始代码字节数：`524`
- 原始代码 SHA-256：`8d752d3113dd2416f73075d007b91c727f05945e0f71c34872566579014bac8c`

```javascript
function _tn(e, n, r = !1) {
  if (a.FORCE_PROMPT_CACHING_5M) return {
    ttl: "5m",
    reason: "force_5m_env"
  };
  let s = F7o(e),
    h = s ? a.CLAUDE_CODE_PROMPT_CACHE_TTL : a.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL;
  if (h !== void 0) return {
    ttl: h,
    reason: "env"
  };
  let y = ut(),
    b = s ? y.promptCacheTtl : y.subagentPromptCacheTtl;
  if (b !== void 0) return {
    ttl: b,
    reason: "setting"
  };
  if (n !== void 0 && !(n === "1h" && r)) return {
    ttl: n,
    reason: "agent_frontmatter"
  };
  if (a.ENABLE_PROMPT_CACHING_1H || Pe() === "bedrock" && a.ENABLE_PROMPT_CACHING_1H_BEDROCK) return {
    ttl: "1h",
    reason: "enable_1h_env"
  };
  return;
}
```

### `Eco`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`223362091`
- 原始代码字节数：`370`
- 原始代码 SHA-256：`d3020957ca9bcb748acfa0a5188f923face33153ff30d70570b3aca3455831e1`

```javascript
class Eco {
  urls = new tc({
    maxSize: pcr,
    ttl: jAo()
  });
  domainChecks = new tc({
    max: 128,
    ttl: 300000
  });
  targetFailures = new tc({
    max: 1024,
    ttl: 300000
  });
  setUrl(e, n, r) {
    this.urls.set(e, n, {
      size: Math.max(1, r)
    }), setTimeout(s => s.deref()?.purgeStale(), Math.min(this.urls.ttl + 1, Nu), new WeakRef(this.urls)).unref();
  }
  clear() {
    this.urls.clear(), this.domainChecks.clear(), this.targetFailures.clear();
  }
}
```

### `rpr`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`223466100`
- 原始代码字节数：`185`
- 原始代码 SHA-256：`c0cb78115f83f59d74cfc4307c17288b6a3a9a39cc6114995d751db8c1db3d27`

```javascript
function rpr(e) {
  if (a.MCP_DISCOVERY_CACHE === !1) return "env-disabled";
  let n = e.killSwitch?.();
  if (n === !1) return "kill-switch";
  if (a.MCP_DISCOVERY_CACHE !== !0 && n !== !0) return "not-enabled";
  return;
}
```

### `ctt`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`224118469`
- 原始代码字节数：`182`
- 原始代码 SHA-256：`2b79dab24f9090e2e114a95caa2db62f56c5e7614385433fb6c37b69314127bb`

```javascript
function ctt(e, n) {
  if (e.type === "text") {
    if (typeof e.text !== "string" || e.text === "") return !1;
    return !n || e.text.trim() !== "";
  }
  return e.type !== "thinking" && e.type !== "redacted_thinking" && !fV(e);
}
```

### `aTn`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`224119153`
- 原始代码字节数：`1498`
- 原始代码 SHA-256：`1b3b6c083190f16f284ab14c148a8c2aed47fa8ab4a2c81ae0f7089bfd4c3be3`

```javascript
function aTn({
  messages: e,
  enablePromptCaching: n,
  skipCacheWrite: r,
  forkPointUuid: s,
  canMarkApiSystem: h,
  forkCachePin: y,
  whitespaceTextUnstampable: b,
  topLevelCacheControl: w,
  isForkPinStepBackEnabled: H,
  divergesAtMessageId: K,
  parentReplyId: V,
  tailAuditTerms: Q = MKr
}) {
  let _e = jt => iTn(jt, b),
    ke = jt => jt.type === "api_system" || jt.type === "user" && jt.ephemeral === !0 || !_e(jt),
    Se = jt => {
      let Ht = jt;
      while (Ht >= 0 && ke(e[Ht])) Ht--;
      return Ht;
    },
    be = Se(e.length - 1);
  if (r) be = Se(be - 1);
  let Re = (jt, Ht) => {
      let Gt = e[jt];
      return Gt !== void 0 && Gt.type === "api_system" && !Gt.ephemeral && !e.slice(Ht + 1, jt).some(Kt => Kt.type === "user" && Kt.ephemeral === !0) && typeof Gt.message.content === "string" && Gt.message.content.trim() !== "";
    },
    Ce = e.length - 1,
    Ie = Re(Ce, be),
    De = h && n && !r && be >= 0 && Ie ? Ce : be,
    Ge = new Set();
  if (De >= 0) Ge.add(De);
  let Xe = !1,
    tt = K === void 0 || !n ? -1 : e.findIndex(jt => jt.type === "assistant" && jt.message.id === K),
    ot = V === void 0 || !n ? -1 : e.findIndex(jt => jt.type === "assistant" && jt.message.id === V),
    vt = tt >= 0 ? tt : ot,
    st = vt <= 0 || w ? -1 : Se(vt - 1),
    mt = h && st >= 0 && Re(vt - 1, st) ? vt - 1 : st,
    Dt = mt >= 0 && mt < De;
  if (Dt) Ge.add(mt);
  if (y && !w && !Dt) {
    if (s) {
      let jt = e.findLastIndex(Ht => Ht.uuid === s);
      if (jt >= 0 && jt <= be) {
        let Ht = r && jt === be && H() ? Se(jt - 1) : _e(e[jt]) ? jt : Se(jt - 1);
        if (Ht >= 0) Ge.add(Ht), Xe = !0;
      }
    } else if (!r) {
      let jt = Se(be - 1);
      if (jt >= 0) Ge.add(jt), Xe = !0;
    }
  }
  let gt = () => IKr({
    messages: e,
    firstTailIndex: n && De >= 0 ? De + 1 : 0,
    cachingOn: n,
    skipCacheWrite: r,
    canMarkApiSystem: h,
    terms: Q,
    whitespaceTextUnstampable: b
  });
  return {
    markerIndices: Ge,
    forkPointPinned: Xe,
    parentPromptEndMarked: ot === vt && Ge.has(mt),
    auditTail: gt
  };
}
```

### `Lse`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`224216655`
- 原始代码字节数：`477`
- 原始代码 SHA-256：`984cab6d360185c0091425d448b1883b322d10e91ab7cdbf0da549f3ab6404fb`

```javascript
function Lse(e) {
  if (a.DISABLE_PROMPT_CACHING) return !1;
  if (a.DISABLE_PROMPT_CACHING_HAIKU && Ke(e, {
    identity: !0
  }) === Ke(u1(), {
    identity: !0
  })) return !1;
  if (a.DISABLE_PROMPT_CACHING_HAIKU && lht()) {
    let n = VE();
    if (n !== et() && e === n) return !1;
  }
  if (a.DISABLE_PROMPT_CACHING_SONNET) {
    let n = Lm();
    if (e === n) return !1;
  }
  if (a.DISABLE_PROMPT_CACHING_OPUS) {
    let n = Vg();
    if (e === n) return !1;
  }
  if (a.DISABLE_PROMPT_CACHING_FABLE) {
    if (mle(e) || lke(e)) return !1;
  }
  if (a.DISABLE_PROMPT_CACHING_MYTHOS) {
    if (y$t(e)) return !1;
  }
  return !0;
}
```

### `A4`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`224217132`
- 原始代码字节数：`98`
- 原始代码 SHA-256：`59bfe576e9eee6bfe35b307a041c4a4581ab076865d22e12e09350743a86c1d6`

```javascript
function A4({
  scope: e,
  ttl: n
} = {}) {
  return {
    type: "ephemeral",
    ...(n && {
      ttl: n
    }),
    ...(e === "global" && {
      scope: e
    })
  };
}
```

### `fSe`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`224217230`
- 原始代码字节数：`483`
- 原始代码 SHA-256：`b5cfccd0556f05f912bc7b23bc3de1d46098256dc59204da6c63a8b3ff23ce34`

```javascript
function fSe(e, {
  agentCacheTtlOverride: n,
  ignoreOverage: r = !1,
  mainThreadModel: s
} = {}) {
  let h = kt(),
    y = h && !r && ha().isUsingOverage === !0,
    b = _tn(e, n, y);
  if (b !== void 0) return b;
  if (!h || y) return {
    ttl: "5m",
    reason: "default"
  };
  let w = V6o();
  if (w === null) w = k("tengu_prompt_cache_1h_config", {
    allowlist: [...o5e]
  }).allowlist ?? [], K6o(w);
  if (!u5e(e, w)) return {
    ttl: "5m",
    reason: "default"
  };
  if (s !== void 0 && lGo(VU, s) && k("tengu_tidy_frost", !1)) return {
    ttl: "5m",
    reason: "live_5m_cache"
  };
  return {
    ttl: "1h",
    reason: "subscriber"
  };
}
```

### `qVr`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`224219740`
- 原始代码字节数：`411`
- 原始代码 SHA-256：`26da14376478efb800bcab966bb161d31fe6213b50b84213520a2fd6c1013d88`

```javascript
function qVr(e, n = !1, r, s) {
  if (n) if (typeof e.message.content === "string") return {
    role: "user",
    content: [{
      type: "text",
      text: e.message.content,
      ...(r && {
        cache_control: A4({
          ttl: s
        })
      })
    }]
  };else {
    let h = uRn(e.message.content);
    return {
      role: "user",
      content: h.map((y, b) => ({
        ...y,
        ...(b === h.length - 1 ? r ? {
          cache_control: A4({
            ttl: s
          })
        } : {} : {})
      }))
    };
  }
  return {
    role: "user",
    content: Array.isArray(e.message.content) ? uRn(e.message.content) : e.message.content
  };
}
```

### `KVr`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`224220465`
- 原始代码字节数：`385`
- 原始代码 SHA-256：`b0f3b4f2350d4602cd374b269e396a64b49afdedd47abf3d5ad2657b0d3ab5b9`

```javascript
function KVr(e, n = !1, r, s, h) {
  if (n) if (typeof e.message.content === "string") return {
    role: "assistant",
    content: [{
      type: "text",
      text: e.message.content,
      ...(r && {
        cache_control: A4({
          ttl: s
        })
      })
    }]
  };else return {
    role: "assistant",
    content: e.message.content.map((y, b) => ({
      ...y,
      ...(b === e.message.content.length - 1 && ctt(y, h) ? r ? {
        cache_control: A4({
          ttl: s
        })
      } : {} : {})
    }))
  };
  return {
    role: "assistant",
    content: e.message.content
  };
}
```

### `RYr`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`224362883`
- 原始代码字节数：`223`
- 原始代码 SHA-256：`5b6d6a592379036063aea9aa58784d931ec6551940f2f59711b6086f31a2a511`

```javascript
function RYr(e, n, r) {
  return YRo(e, {
    skipGlobalCacheForSystemPrompt: r?.skipGlobalCacheForSystemPrompt
  }).map(s => ({
    type: "text",
    text: s.text,
    ...(n && s.cacheScope !== null && {
      cache_control: A4({
        scope: s.cacheScope,
        ttl: r?.cacheTtl
      })
    })
  }));
}
```

## chunk-2bb0j573.js

### `YRo`

- 原始文件：`000216272108.js`
- 二进制绝对字节起点：`216452387`
- 原始代码字节数：`1568`
- 原始代码 SHA-256：`3df1ab57116ea4898a5029395982a7210669f6bba688aced6b68b1fccd45650d`

```javascript
function YRo(e, r) {
  let n = g7(),
    s = e.findIndex(D => D === tO);
  if (n && r?.skipGlobalCacheForSystemPrompt && s === -1) {
    if (!r?.skipTelemetry) i("tengu_sysprompt_using_tool_based_cache", {
      promptBlockCount: e.length
    });
    let D,
      T,
      O,
      R = [];
    for (let Y of e) {
      if (!Y) continue;
      if (Y === tO) continue;
      if (Y.startsWith(BYe)) D = Y;else if (ys.has(Y)) T = Y;else if (Y === Psn) O = Y;else R.push(Y);
    }
    let I = [];
    if (D) I.push({
      text: D,
      cacheScope: null
    });
    if (T) I.push({
      text: T,
      cacheScope: "org"
    });
    if (O && D && T) I.push({
      text: O,
      cacheScope: null
    });
    let H = R.join(`

`);
    if (H) I.push({
      text: H,
      cacheScope: "org"
    });
    return I;
  }
  if (n) {
    if (s !== -1) {
      let D,
        T,
        O,
        R = [],
        I = [];
      for (let W = 0; W < e.length; W++) {
        let V = e[W];
        if (!V || V === tO) continue;
        if (V.startsWith(BYe)) D = V;else if (ys.has(V)) T = V;else if (V === Psn) O = V;else if (W < s) R.push(V);else I.push(V);
      }
      let H = [];
      if (D) H.push({
        text: D,
        cacheScope: null
      });
      if (T) H.push({
        text: T,
        cacheScope: null
      });
      if (O && D && T) H.push({
        text: O,
        cacheScope: null
      });
      let Y = R.join(`

`);
      if (Y) H.push({
        text: Y,
        cacheScope: "global"
      });
      let K = I.join(`

`);
      if (K) H.push({
        text: K,
        cacheScope: "org"
      });
      if (!r?.skipTelemetry) i("tengu_sysprompt_boundary_found", {
        blockCount: H.length,
        staticBlockLength: Y.length,
        dynamicBlockLength: K.length
      });
      return H;
    } else if (!r?.skipTelemetry) i("tengu_sysprompt_missing_boundary_marker", {
      promptBlockCount: e.length
    });
  }
  let h,
    b,
    y,
    w = [];
  for (let D of e) {
    if (!D || D === tO) continue;
    if (D.startsWith(BYe)) h = D;else if (ys.has(D)) b = D;else if (D === Psn) y = D;else w.push(D);
  }
  let E = [];
  if (h) E.push({
    text: h,
    cacheScope: null
  });
  if (b) E.push({
    text: b,
    cacheScope: "org"
  });
  if (y && h && b) E.push({
    text: y,
    cacheScope: null
  });
  let P = w.join(`

`);
  if (P) E.push({
    text: P,
    cacheScope: "org"
  });
  return E;
}
```

## chunk-y4acz95y.js

### `Wne`

- 原始文件：`000212145401.js`
- 二进制绝对字节起点：`212162874`
- 原始代码字节数：`815`
- 原始代码 SHA-256：`74c918290edd19482986fbc88a815fb714ad8ba8f82e56845e1038a4048e7f05`

```javascript
function Wne(e, i = 300000, s) {
  let n = o => typeof i === "function" ? i(o) : i,
    r = new Map(),
    h = new Map(),
    l = async (...o) => {
      let a = _(o),
        f = r.get(a);
      if (f && s && !s(f.value, f.timestamp)) {
        if (f.refreshPromise) return f.refreshPromise;
        r.delete(a), f = void 0;
      }
      let d = Date.now();
      if (!f) {
        let g = h.get(a);
        if (g) return g;
        let u = e(...o);
        h.set(a, u);
        try {
          let w = await u;
          if (h.get(a) === u) r.set(a, {
            value: w,
            timestamp: Date.now(),
            refreshing: !1,
            lifetimeMs: n(w)
          });
          return w;
        } finally {
          if (h.get(a) === u) h.delete(a);
        }
      }
      if (f && d - f.timestamp > f.lifetimeMs && !f.refreshing) {
        f.refreshing = !0;
        let g = f,
          u = e(...o);
        return g.refreshPromise = u, u.then(w => {
          if (r.get(a) === g) r.set(a, {
            value: w,
            timestamp: Date.now(),
            refreshing: !1,
            lifetimeMs: n(w)
          });
        }).catch(w => {
          if (t(String(w), {
            level: "error"
          }), r.get(a) === g) r.delete(a);
        }), f.value;
      }
      return r.get(a).value;
    };
  return l.cache = {
    clear: () => {
      r.clear(), h.clear();
    }
  }, l;
}
```

### `cM`

- 原始文件：`000212145401.js`
- 二进制绝对字节起点：`212163689`
- 原始代码字节数：`282`
- 原始代码 SHA-256：`ea09e7e1986c6f8f6d59d6fcba1ad296e23c285314fdb3e5de17b76ca5be9fd2`

```javascript
function cM(e, i, s = 100) {
  let n = new tc({
      max: s
    }),
    r = (...h) => {
      let l = i(...h),
        o = n.get(l);
      if (o !== void 0) return o;
      let a = e(...h);
      return n.set(l, a), a;
    };
  return r.cache = {
    clear: () => n.clear(),
    size: () => n.size,
    delete: h => n.delete(h),
    get: h => n.peek(h),
    has: h => n.has(h),
    set: (h, l) => void n.set(h, l)
  }, r;
}
```

### `RZe`

- 原始文件：`000212145401.js`
- 二进制绝对字节起点：`212164152`
- 原始代码字节数：`263`
- 原始代码 SHA-256：`c5137a99797a823cdfcba1c5b7a6effe23c21dfa5b58777be73d8a772f8408c7`

```javascript
function RZe(e, i, s) {
  let n = s?.maxSize ?? G,
    r = new Map();
  P.add(r);
  function h(...l) {
    let o = i ? i(...l) : l[0],
      a = r.get(o);
    if (a) return a;
    let f = e(...l);
    if (r.size >= n) r.delete(r.keys().next().value);
    return r.set(o, f), f.catch(() => {
      if (r.get(o) === f) r.delete(o);
    }), f;
  }
  return h.cache = r, h;
}
```

## chunk-m64kn9jd.js

### `sR`

- 原始文件：`000216918272.js`
- 二进制绝对字节起点：`216920221`
- 原始代码字节数：`140`
- 原始代码 SHA-256：`db8f8e826f0b451358dfd57634c1fbf5365872d5239a218a615a18e08ea14323`

```javascript
function sR(e) {
  if ((e.offset ?? 1) > 1 || e.isPartialView) return !1;
  if (e.limit === void 0) return !0;
  return e.content !== "" && Ut(e.content, `
`) + 1 < e.limit;
}
```

### `RX`

- 原始文件：`000216918272.js`
- 二进制绝对字节起点：`216920361`
- 原始代码字节数：`69`
- 原始代码 SHA-256：`7b26f1ba27cb701d25cde14e2cad037dd922d64272b0e61f2fa80281a6b21648`

```javascript
function RX(e) {
  return e !== void 0 && sR(e) && !e.contentNotInModelContext;
}
```

### `jU`

- 原始文件：`000216918272.js`
- 二进制绝对字节起点：`216920430`
- 原始代码字节数：`94`
- 原始代码 SHA-256：`24a68e97e5e2a71df87f77cde8f1fbbc6f3f469f98a035e02c6622f51b7ba137`

```javascript
function jU(e, n) {
  if (e.contentHash !== void 0) return e.contentHash === Mxr(n);
  return e.content === n;
}
```

### `C`

- 原始文件：`000216918272.js`
- 二进制绝对字节起点：`216920846`
- 原始代码字节数：`1150`
- 原始代码 SHA-256：`2965fb66dcfaa6abb4e6843c01a79cc9d2e2d56b0788ed24772fd5cea38a7c9a`

```javascript
class C {
  keepsReadBaselines;
  cache;
  constructor(e, n, r = !1) {
    this.keepsReadBaselines = r;
    this.cache = new tc({
      max: e,
      maxSize: n,
      sizeCalculation: o => Math.max(1, Buffer.byteLength(o.content))
    });
  }
  get(e) {
    return this.cache.get(b(e));
  }
  set(e, n) {
    let r = b(e),
      o = this.cache.get(r),
      i = n.keepContent ?? o?.keepContent,
      s = n.contentHash ?? Mxr(n.content),
      a = n.contentLength ?? n.content.length,
      c = n.content !== "" || n.contentHash === void 0,
      l = !(this.keepsReadBaselines || UX()) ? void 0 : c && !n.contentFromTranscript && sR(n) ? x(n.content) : n.readBaseline ?? (s === o?.contentHash ? o?.readBaseline : void 0),
      d = i && n.content === "" && s === o?.contentHash && o.content ? o.content : n.content,
      u = i || Buffer.byteLength(d) <= N ? d : "";
    return this.cache.set(r, {
      ...n,
      keepContent: i,
      contentHash: s,
      contentLength: a,
      content: u,
      readBaseline: l
    }), this;
  }
  has(e) {
    return this.cache.has(b(e));
  }
  delete(e) {
    return this.cache.delete(b(e));
  }
  clear() {
    this.cache.clear();
  }
  get size() {
    return this.cache.size;
  }
  get max() {
    return this.cache.max;
  }
  get maxSize() {
    return this.cache.maxSize;
  }
  get calculatedSize() {
    return this.cache.calculatedSize;
  }
  keys() {
    return this.cache.keys();
  }
  entries() {
    return this.cache.entries();
  }
  dump() {
    return this.cache.dump();
  }
  load(e) {
    this.cache.load(e);
  }
}
```

### `rae`

- 原始文件：`000216918272.js`
- 二进制绝对字节起点：`216922139`
- 原始代码字节数：`200`
- 原始代码 SHA-256：`d3d4cf16dfd434c8dc015717995e7b39ccf89baae31034db07ae2d2b4114686b`

```javascript
function rae(e, n) {
  let r = gw(e.max, e.maxSize),
    o = e.dump();
  if (n?.stripSeededFromContext) {
    for (let i of o) if (i[1].value?.seededFromContext) i[1].value = {
      ...i[1].value,
      seededFromContext: !1
    };
  }
  return r.load(o), r;
}
```

## chunk-d81b6wth.js

### `CH`

- 原始文件：`000216095555.js`
- 二进制绝对字节起点：`216098122`
- 原始代码字节数：`87`
- 原始代码 SHA-256：`c749ee4d2be902ec6db2ccde3f99a9b7518fc4db9b9adf7158d0ef26209349b2`

```javascript
function CH(e) {
  let n = Bun.hash(_(e));
  return typeof n === "bigint" ? Number(n & 0xffffffffn) : n;
}
```

### `E`

- 原始文件：`000216095555.js`
- 二进制绝对字节起点：`216098320`
- 原始代码字节数：`1682`
- 原始代码 SHA-256：`035a04697b7fba62887fef659226036ea82bfbafef178854109a839c5b1b8e56`

```javascript
function E(e, n) {
  if (typeof e === "string") {
    n.push("s", String(e.length), e.slice(0, 32), e.slice(-32));
    return;
  }
  switch (e.type) {
    case "text":
    case "image":
    case "document":
    case "search_result":
    case "thinking":
    case "redacted_thinking":
    case "tool_use":
    case "tool_result":
    case "tool_reference":
    case "server_tool_use":
    case "web_search_tool_result":
    case "web_fetch_tool_result":
    case "advisor_tool_result":
    case "code_execution_tool_result":
    case "bash_code_execution_tool_result":
    case "text_editor_code_execution_tool_result":
    case "tool_search_tool_result":
    case "mcp_tool_use":
    case "mcp_tool_result":
    case "mcp_tool_listing":
    case "container_upload":
    case "compaction":
    case "fallback":
    case "browser_state":
      break;
    default:
      {
        let s = e;
        break;
      }
  }
  if (n.push(e.type), "text" in e && typeof e.text === "string") n.push("t", String(e.text.length), e.text.slice(0, 32), e.text.slice(-32));
  if ("thinking" in e && typeof e.thinking === "string") n.push("k", String(e.thinking.length));
  if ("id" in e && typeof e.id === "string") n.push("i", e.id);
  if ("tool_use_id" in e && typeof e.tool_use_id === "string") n.push("u", e.tool_use_id);
  if ("name" in e && typeof e.name === "string") n.push("n", e.name);
  if ("input" in e && e.input !== void 0) n.push("p", _(e.input));
  if ("source" in e && e.source && typeof e.source === "object") {
    let s = e.source;
    if (n.push("m", String(s.type ?? ""), String(s.media_type ?? "")), typeof s.data === "string") n.push(String(s.data.length));
  }
  let r = "content" in e ? e.content : void 0;
  if (Array.isArray(r)) {
    n.push("[", String(r.length));
    for (let s of r) E(s, n);
    n.push("]");
  } else if (typeof r === "string") n.push("c", String(r.length), r.slice(0, 32), r.slice(-32));
  for (let [s, u] of Object.entries(e)) {
    if (Q.has(s) || u === void 0) continue;
    let d = typeof u === "string" ? u : _(u);
    n.push(s, d.length > 256 ? `len:${d.length}` : d);
  }
}
```

### `pLs`

- 原始文件：`000216095555.js`
- 二进制绝对字节起点：`216100013`
- 原始代码字节数：`451`
- 原始代码 SHA-256：`7f968c1e07aca119eb7ecbc726990e8a322b821dde9ed9190ba2e00196a89229`

```javascript
function pLs(e) {
  return e.map(n => {
    if ((n.type === "api_system" || n.type === "user") && n.ephemeral) return jYe;
    let r = [n.message.role];
    if (n.type === "api_system" && n.outputConfig !== void 0) {
      let d = n.outputConfig.timing;
      r.push(`oc:${n.outputConfig.effort ?? ""}${d ? `:${d.now}` : ""}`);
    }
    let s = n.message.content;
    if (Array.isArray(s)) {
      r.push(String(s.length));
      for (let d of s) E(d, r);
    } else E(s, r);
    let u = Bun.hash(r.join("|"));
    return typeof u === "bigint" ? Number(u & 0xffffffffn) : u;
  });
}
```

### `R6n`

- 原始文件：`000216095555.js`
- 二进制绝对字节起点：`216100489`
- 原始代码字节数：`152`
- 原始代码 SHA-256：`0ab4e7875844b2ac19b06cb4fda47891042ae294e5e1b0f0e191811877d0a4ce`

```javascript
function R6n(e) {
  if ((e?.cache_creation?.ephemeral_5m_input_tokens ?? 0) > 0) return "5m";
  return (e?.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0 ? "1h" : void 0;
}
```

### `QAo`

- 原始文件：`000216095555.js`
- 二进制绝对字节起点：`216100655`
- 原始代码字节数：`89`
- 原始代码 SHA-256：`f0ad3845a859af85ac8c35a65b524d5829b04618da8662eacd880b853e39abe4`

```javascript
function QAo(e, n) {
  return !n && (e.startsWith("repl_main_thread") || e === "sdk" || e === "compact");
}
```

### `A`

- 原始文件：`000216095555.js`
- 二进制绝对字节起点：`216101554`
- 原始代码字节数：`2542`
- 原始代码 SHA-256：`e00b9a1f28118a8e64fe145e65d1545c2b67d4a7cb536046d5551acd3acbb47e`

```javascript
class A {
  entries = [];
  requests = 0;
  hits = 0;
  misses = 0;
  expectedRebuilds = 0;
  coldStarts = 0;
  cacheReadTokens = 0;
  cacheCreationTokens = 0;
  inputTokens = 0;
  missRecacheTokens = 0;
  lastMissAt = null;
  lastMissAttribution = null;
  missCauses = {};
  pendingAttribution = null;
  dropExpectedAt = null;
  touchedAt = null;
  touch(e) {
    if (this.entries.length > 0) this.touchedAt = Math.max(this.touchedAt ?? 0, e);
  }
  expectDrop(e) {
    this.dropExpectedAt = e;
  }
  attribute(e) {
    this.pendingAttribution = e;
  }
  record(e) {
    let n = this.entries.at(-1) ?? null,
      r = this.dropExpectedAt;
    this.dropExpectedAt = null;
    let s = this.pendingAttribution;
    this.pendingAttribution = null;
    let u = r !== null && n !== null && e.at - Math.max(n.at, this.touchedAt ?? 0) < x[n.ttl],
      d,
      p = this.cacheReadTokens + this.cacheCreationTokens > 0 || e.cacheReadTokens + e.cacheCreationTokens > 0;
    if (n === null) d = "cold";else if (!p) d = "uncached";else if (n.cacheReadTokens + n.cacheCreationTokens === 0 && e.cacheReadTokens + e.cacheCreationTokens > 0) d = "cold";else {
      let g = n.inputTokens + n.cacheReadTokens + n.cacheCreationTokens,
        K = e.inputTokens + e.cacheReadTokens + e.cacheCreationTokens,
        T = Math.min(g, K),
        Z = T - e.cacheReadTokens;
      d = e.cacheReadTokens < T * 0.95 && Z >= X ? u ? "expected" : "miss" : "hit";
    }
    let y = e.cacheCreationTokens === 0 && n !== null ? n.ttl : e.ttl,
      h = d === "miss" && s !== null ? {
        ...e,
        ttl: y,
        outcome: d,
        attribution: s
      } : {
        ...e,
        ttl: y,
        outcome: d
      };
    if (this.entries.push(h), this.entries.length > J) this.entries.shift();
    switch (this.requests++, this.cacheReadTokens += e.cacheReadTokens, this.cacheCreationTokens += e.cacheCreationTokens, this.inputTokens += e.inputTokens, d) {
      case "hit":
        this.hits++;
        break;
      case "miss":
        this.misses++, this.missRecacheTokens += e.cacheCreationTokens, this.lastMissAt = e.at, this.lastMissAttribution = s;
        for (let g of s?.causes ?? []) this.missCauses[g] = (this.missCauses[g] ?? 0) + 1;
        break;
      case "expected":
        this.expectedRebuilds++;
        break;
      case "cold":
        this.coldStarts++;
        break;
      case "uncached":
        break;
    }
    return h;
  }
  summary(e) {
    let n = this.cacheReadTokens + this.cacheCreationTokens + this.inputTokens,
      r = this.entries.at(-1) ?? null,
      s = x[r?.ttl ?? "5m"],
      u = this.cacheReadTokens + this.cacheCreationTokens > 0,
      d = r !== null && r.cacheReadTokens + r.cacheCreationTokens > 0,
      p = r !== null ? Math.max(r.at, this.touchedAt ?? 0) : 0;
    return {
      requests: this.requests,
      hits: this.hits,
      misses: this.misses,
      expectedRebuilds: this.expectedRebuilds,
      coldStarts: this.coldStarts,
      hitRatio: n > 0 ? this.cacheReadTokens / n : null,
      cacheWriteTokens: this.cacheCreationTokens,
      missRecacheTokens: this.missRecacheTokens,
      lastMissAt: this.lastMissAt,
      lastMissAttribution: this.lastMissAttribution,
      missCauses: {
        ...this.missCauses
      },
      lastRequest: r,
      cachingObserved: u,
      lastActivityAt: r !== null ? p : null,
      expiresAt: r !== null && d ? p + s : null,
      warm: r !== null && d && e - p < s
    };
  }
}
```

## chunk-ck4jw7jw.js

### `_6n`

- 原始文件：`000216970082.js`
- 二进制绝对字节起点：`217028578`
- 原始代码字节数：`44`
- 原始代码 SHA-256：`96a750faa7e830990f4275df849f0e65ac8b7382a7963319ba06ceb52ddb5be8`

```javascript
function _6n(e, n) {
  return n < e * 0.95 && e - n >= LAo;
}
```

### `Ms`

- 原始文件：`000216970082.js`
- 二进制绝对字节起点：`217028834`
- 原始代码字节数：`108`
- 原始代码 SHA-256：`13f7affdb4c60863d2252ee75080fa4694f75a7e322f77e3dec65e535b194efe`

```javascript
function Ms(e) {
  return e.map(n => {
    if (!("cache_control" in n)) return n;
    let {
      cache_control: s,
      ...r
    } = n;
    return r;
  });
}
```

### `Vs`

- 原始文件：`000216970082.js`
- 二进制绝对字节起点：`217029166`
- 原始代码字节数：`935`
- 原始代码 SHA-256：`7c95ce991c4bbc8931b9cdf2b36d94cf5558cc3fb91b564e8aac164af4c046d7`

```javascript
function Vs(e, n) {
  return {
    systemPromptChanged: n.systemHash !== e.systemHash,
    toolSchemasChanged: n.toolsHash !== e.toolsHash,
    modelChanged: n.model !== e.model,
    fastModeChanged: n.fastMode !== e.fastMode,
    cacheControlChanged: n.cacheControlHash !== e.cacheControlHash,
    globalCacheStrategyChanged: n.globalCacheStrategy !== e.globalCacheStrategy,
    betasChanged: n.betas.length !== e.betas.length || n.betas.some((s, r) => s !== e.betas[r]),
    autoModeChanged: n.autoModeActive !== e.autoModeActive,
    overageChanged: n.isUsingOverage !== e.isUsingOverage,
    cacheDiagnosisChanged: n.cacheDiagnosis !== e.cacheDiagnosis,
    effortChanged: n.effortValue !== e.effortValue,
    thinkingModeChanged: e.thinkingMode !== "" && n.thinkingMode !== "" && n.thinkingMode !== e.thinkingMode,
    thinkingDisplayChanged: e.thinkingMode !== "" && n.thinkingMode === e.thinkingMode && n.thinkingDisplay !== e.thinkingDisplay,
    extraBodyChanged: n.extraBodyHash !== e.extraBodyHash,
    deferLoadingPresenceChanged: n.anyDeferLoading !== e.anyDeferLoading
  };
}
```

### `yt`

- 原始文件：`000216970082.js`
- 二进制绝对字节起点：`217038079`
- 原始代码字节数：`62`
- 原始代码 SHA-256：`37554665cc5129973abef9ef745bb2bd57b829044b8f403ea5af9832c02dddbf`

```javascript
function yt(e, n) {
  return e.findIndex((s, r) => s !== jYe && n[r] !== s);
}
```

### `Esn`

- 原始文件：`000216970082.js`
- 二进制绝对字节起点：`217109292`
- 原始代码字节数：`530`
- 原始代码 SHA-256：`71ddc951b7d759e94e99b4a855671b03568b9dafe5c682e939341f739f385783`

```javascript
function Esn(e, n, s) {
  if (n.size === 0) return [...e];
  return e.map(r => {
    if (r.type !== "user" || !Array.isArray(r.message.content)) return r;
    let h = !1,
      y = r.message.content.map(b => {
        if (!Rd(b) || b.type !== "tool_result" || !n.has(b.tool_use_id)) return b;
        let w = Array.isArray(b.content) && b.content.some(A => Rd(A) && (A.type === "image" || A.type === "document")),
          v = w ? St : s?.get(b.tool_use_id) ?? St,
          R = !w && !v.startsWith(Tt) && yl(b.content) ? `${Tt}${v}` : v;
        if (b.content === R) return b;
        return h = !0, {
          ...b,
          content: R
        };
      });
    return h ? {
      ...r,
      message: {
        ...r.message,
        content: y
      }
    } : r;
  });
}
```

### `MDs`

- 原始文件：`000216970082.js`
- 二进制绝对字节起点：`217109822`
- 原始代码字节数：`708`
- 原始代码 SHA-256：`690772c4e90e8f126db525d60adbe6e0cf2fcd65484cc026c3247e58861bb816`

```javascript
async function MDs(e, n, s) {
  let {
    keepSet: r,
    tokensSaved: h,
    candidates: y
  } = zAo(e, s.keepRecent);
  if (h < w6n) return null;
  let b = new Set(y.map(R => R.tool_use_id)),
    w = new Map();
  for (let R of y) {
    let A = R.content ? await s.persist?.(R.content, R.tool_use_id) : null;
    w.set(R.tool_use_id, A ?? St);
  }
  let v = Esn(e, b, w);
  if (n !== void 0 && Qo(n) === "main") HX("tool_result_clear");
  if (i("tengu_time_based_microcompact", {
    toolsCleared: b.size,
    toolsKept: r.size,
    keepRecent: s.keepRecent,
    tokensSaved: h,
    trigger: S("context_hint")
  }), g("compact_micro_keep_recent"), t(`[KEEP-RECENT MC] context_hint trigger, cleared ${b.size} tool results (~${h} tokens), kept last ${r.size}`), xLt(), n) _t(n, s.agentId);
  return {
    messages: v,
    tokensSaved: h,
    clearedIds: b,
    clearedContent: w
  };
}
```

## chunk-2jyw98bz.js

### `oE`

- 原始文件：`000214885527.js`
- 二进制绝对字节起点：`215285253`
- 原始代码字节数：`1759`
- 原始代码 SHA-256：`77cfc72f4064600703f3320df813e91818bda244b382df71df181b742385b5ea`

```javascript
class oE {
  byKey = new Map();
  sentFromRecordByKey = new Map();
  mcpKeys = new Map();
  mcpKeysByTool = new Map();
  mcpKeysWeight = 0;
  maxMcpKeysWeight = XU;
  generation = 0;
  get(e) {
    let n = this.byKey.get(e);
    if (n !== void 0) this.noteMcpKeyUsed(e);
    return n;
  }
  stamp() {
    return this.generation;
  }
  register(e, n, r) {
    if (r === this.generation) this.byKey.set(this.noteMcpKeyUsed(e, n.description?.length ?? 0), n);
  }
  getSentFromRecord(e) {
    let n = this.sentFromRecordByKey.get(e);
    if (n !== void 0) this.noteMcpKeyUsed(e);
    return n;
  }
  setSentFromRecord(e, n) {
    this.sentFromRecordByKey.set(this.noteMcpKeyUsed(e), n);
  }
  setMaxMcpKeysWeight(e) {
    this.maxMcpKeysWeight = e, this.dropMcpKeysPastBounds(new Set());
  }
  noteMcpKeyUsed(e, n) {
    let r = this.mcpKeys.get(e);
    if (r === void 0) {
      let h = JU(e);
      if (h === void 0) return e;
      r = {
        key: e,
        tool: h,
        weight: 0
      };
    }
    if (r.weight === 0 || n !== void 0) {
      let h = e.length + qU + (n ?? 0);
      this.mcpKeysWeight += h - r.weight, r.weight = h;
    }
    this.mcpKeys.delete(r.key), this.mcpKeys.set(r.key, r);
    let s = this.mcpKeysByTool.get(r.tool) ?? new Set();
    return s.delete(r), s.add(r), this.mcpKeysByTool.set(r.tool, s), this.dropMcpKeysPastBounds(s), r.key;
  }
  dropMcpKeysPastBounds(e) {
    for (let n of e) {
      if (e.size <= YU) break;
      this.dropMcpKey(n);
    }
    if (this.mcpKeysWeight <= this.maxMcpKeysWeight) return;
    for (let n of this.mcpKeys.values()) {
      if (this.mcpKeysWeight <= this.maxMcpKeysWeight || this.mcpKeys.size === 1) break;
      this.dropMcpKey(n);
    }
  }
  dropMcpKey(e) {
    this.mcpKeys.delete(e.key), this.mcpKeysWeight -= e.weight;
    let n = this.mcpKeysByTool.get(e.tool);
    if (n?.delete(e), n?.size === 0) this.mcpKeysByTool.delete(e.tool);
    this.byKey.delete(e.key), this.sentFromRecordByKey.delete(e.key);
  }
  get size() {
    return this.byKey.size;
  }
  invalidateAll() {
    this.byKey.clear(), this.sentFromRecordByKey.clear(), this.mcpKeys.clear(), this.mcpKeysByTool.clear(), this.mcpKeysWeight = 0, this.generation += 1;
  }
  dropInFlightComposes() {
    this.generation += 1;
  }
}
```

## chunk-sp5b4hyj.js

### `nb`

- 原始文件：`000213173673.js`
- 二进制绝对字节起点：`213261202`
- 原始代码字节数：`80`
- 原始代码 SHA-256：`a0f229fe3f43517856165a7820ad28012b63161ed006f8ff43272437f4fad679`

```javascript
function nb(e) {
  let n = tf().rootByPath;
  if (n.peek(e) === cJ) n.delete(e);
  return _r(e);
}
```

### `bSt`

- 原始文件：`000213173673.js`
- 二进制绝对字节起点：`213261478`
- 原始代码字节数：`322`
- 原始代码 SHA-256：`6a4ff15260700dc9c8d77266afdfa1841d5e479e35af77b464ae40eee133e68c`

```javascript
function bSt(e) {
  let n = $n(ge(e)),
    r = tf();
  for (let i of [r.rootByPath, r.canonicalRootByRoot, r.remoteSlugByRoot, r.monorepoRuledOutByRoot, r.monorepoVerdictByDir, r.gitDirByCwd, r.markersByRoot, r.repositoryByCwd, r.repoClassByCanonicalRoot, r.wcRootByPath, r.wcWorktreesByRoot]) for (let o of [...i.keys()]) if (Xm(n, $n(ge(o)))) i.delete(o);
}
```

## chunk-8ggzypv6.js

### `Ke`

- 原始文件：`000231119882.js`
- 二进制绝对字节起点：`231127140`
- 原始代码字节数：`69`
- 原始代码 SHA-256：`88be683700268a6948a36c5b492404f1df7e9403aeb18d51cbe6405b31d920fa`

```javascript
function Ke() {
  let e = a.MCP_DISCOVERY_CACHE_STRIKES;
  return e && e > 0 ? e : Ct;
}
```

### `Dt`

- 原始文件：`000231119882.js`
- 二进制绝对字节起点：`231127688`
- 原始代码字节数：`89`
- 原始代码 SHA-256：`7cf5ed9c66eee8ed5bfe7f64c5ef11fd9f0c08d48d2c5e9a4e9b0905c0d34e73`

```javascript
function Dt() {
  let e = a.MCP_DISCOVERY_CACHE_TTL_S;
  return Math.min((e && e > 0 ? e : vt) * 1000, ze());
}
```

### `ze`

- 原始文件：`000231119882.js`
- 二进制绝对字节起点：`231127777`
- 原始代码字节数：`91`
- 原始代码 SHA-256：`7a88d48be674d78dfa4846b9025045fc1345f2f4e19dd26f730355234aae9ebb`

```javascript
function ze() {
  let e = a.MCP_DISCOVERY_CACHE_MAX_STALE_S;
  return Math.min(e && e > 0 ? e : St, Et) * 1000;
}
```

### `NTn`

- 原始文件：`000231119882.js`
- 二进制绝对字节起点：`231147824`
- 原始代码字节数：`540`
- 原始代码 SHA-256：`2ad06c8b78082d8f595c14d27fd5e37f762c12a61a8c756cc7f31f32eac6370d`

```javascript
async function NTn(e, r) {
  let n;
  try {
    n = await It(e, r);
  } catch {
    return async () => {};
  }
  if (n === void 0) return async () => {};
  try {
    return await L().mkdir(O(), Ve), await cl(n, {
      realpath: !1,
      retries: 0,
      stale: 60000,
      onCompromised: i => re(e, `discovery-cache: refresh lock compromised, skipping refresh: ${i}`)
    });
  } catch (i) {
    let s = i instanceof Error ? i.message : String(i);
    if (i?.code === "ELOCKED" || s.includes("already being held")) {
      re(e, "discovery-cache: refresh lock held elsewhere, skipping");
      return;
    }
    return re(e, `discovery-cache: lock error, proceeding: ${s}`), async () => {};
  }
}
```

## chunk-207g0kar.js

### `ps`

- 原始文件：`000229613536.js`
- 二进制绝对字节起点：`229649051`
- 原始代码字节数：`1474`
- 原始代码 SHA-256：`b41c422ac9770d9a29263fa409c18744235b09663272a1c78222186be791c234`

```javascript
async function ps(e, o, n, r) {
  let {
      session: u
    } = n,
    s = {
      userContext: e,
      systemContext: o,
      announced: {},
      workerTools: void 0,
      sections: [],
      instructions: void 0,
      refreshReason: "session_start",
      bare: n.options.bareFork === !0,
      carriesContext: Object.keys(e).length > 0 || Object.keys(o).length > 0,
      rendering: void 0
    };
  if (n.options.bareFork) return s;
  let f = Dc(r.messages) ?? Uc(r.messages);
  if (f === "inline") return _a(s);
  try {
    let T = e.claudeMd === void 0 ? void 0 : await Dgr(u, W() ? n.storageV5 : void 0, W() ? n.credentials : void 0),
      C = n.options.managedInstructionsOnly ? T?.filter(H => H.type === "Managed") : T,
      h = {
        ...e
      },
      v = {
        ...o
      },
      M = {};
    for (let H of yMn) {
      let X = h[H] ?? v[H];
      if (X) M[H] = X;
      delete h[H], delete v[H];
    }
    delete h.currentDate;
    let P = s8e() ? h.workerToolsContext : void 0;
    if (P !== void 0) delete h.workerToolsContext;
    delete v.currentDate;
    let R;
    if (h.claudeMd !== void 0 && C !== void 0) R = Hus(C), delete h.claudeMd;else if (h.claudeMd === "") delete h.claudeMd;
    let {
        cacheBreaker: I,
        ...G
      } = v,
      B = [...Object.entries(h), ...Object.entries(G)].filter(([, H]) => H !== "").map(([H, X]) => ({
        name: H,
        text: X
      }));
    return {
      userContext: {},
      systemContext: I === void 0 ? {} : {
        cacheBreaker: I
      },
      announced: M,
      workerTools: P,
      sections: B,
      instructions: R,
      refreshReason: sms(u) ?? "session_start",
      bare: !1,
      carriesContext: s.carriesContext,
      rendering: "announced"
    };
  } catch (T) {
    if (l(T), Lc(T, r.querySource, f === "announced" ? "none" : "inline", r.afterCompaction === !0), f === "announced") {
      let {
        cacheBreaker: C
      } = o;
      return {
        ...s,
        userContext: {},
        systemContext: C === void 0 ? {} : {
          cacheBreaker: C
        },
        bare: !0,
        rendering: "announced"
      };
    }
    return _a(s);
  }
}
```

### `mm`

- 原始文件：`000229613536.js`
- 二进制绝对字节起点：`229727853`
- 原始代码字节数：`2239`
- 原始代码 SHA-256：`1336042826ae2b921b282724aecdf226e9f91322f2005c3e21db9428184e8566`

```javascript
function mm(e, o, {
  resumeActive: n,
  stamp: r,
  inheritedReminderFold: u,
  inheritedWireShape: s,
  inheritedEchoWireToolInputs: f,
  contextRendering: T,
  turnSections: C,
  ...h
}) {
  let v = {
    systemPrompt: o,
    toolDescriptions: void 0,
    toolEntries: void 0,
    toolServers: void 0,
    recordedCliPrefix: void 0,
    recordedWireShape: void 0,
    record: void 0,
    source: "live_unrecorded",
    snapshotHash: void 0
  };
  try {
    if (!y3e(h.options)) return v;
    let M = lbe(e, h.options),
      P = M !== void 0 && wMn(e),
      R = M !== void 0 && !P && !n && Xo(h) && Qo(h.querySource) === "main" ? qs.owedPrompt(M, o, C) : void 0,
      I = R !== void 0,
      G = P || I,
      B = R ?? o;
    if (M && (!G || n || !Xo(h))) {
      let se = !G && !n && Xo(h),
        _e = se && M.reminderFold === void 0 && HRt() ? zl(!0, u?.()) : void 0,
        Ue = se && M.echoWireToolInputs === void 0 && Z8t() ? Jl(!0, f?.()) : void 0,
        L = se && M.contextRendering === void 0 && B8t() ? Zl(!0, T) : void 0,
        A = M.reminderFold ?? _e,
        Re = M.echoWireToolInputs ?? Ue,
        xe = M.contextRendering ?? L;
      return {
        systemPrompt: M.systemPrompt,
        toolDescriptions: M.toolDescriptions,
        toolEntries: M.toolEntries,
        toolServers: M.toolServers,
        recordedCliPrefix: M.cliPrefix,
        recordedWireShape: M.wireShape,
        record: _e !== void 0 || Ue !== void 0 || L !== void 0 ? en({
          type: "prompt_snapshot",
          systemPrompt: [...M.systemPrompt],
          ...(M.toolDescriptions.size > 0 && {
            tools: bMn(M)
          }),
          ...(M.cliPrefix !== void 0 && {
            cliPrefix: M.cliPrefix
          }),
          ...(A !== void 0 && {
            reminderFold: A
          }),
          ...j8t(M.wireShape),
          ...(Re !== void 0 && {
            echoWireToolInputs: Re
          }),
          ...(xe !== void 0 && {
            contextRendering: xe
          })
        }, r) : void 0,
        source: "from_snapshot",
        snapshotHash: M.systemPromptHash
      };
    }
    if (n || !Xo(h)) return v;
    let H = M?.reminderFold ?? (HRt() ? zl(M !== void 0, u?.()) : void 0),
      X = M?.wireShape ?? Gio(s?.()),
      re = M?.echoWireToolInputs ?? (Z8t() ? Jl(M !== void 0, f?.()) : void 0),
      ie = M?.contextRendering ?? (B8t() ? Zl(M !== void 0, T) : void 0);
    return {
      systemPrompt: B,
      toolDescriptions: M?.toolDescriptions,
      toolEntries: M?.toolEntries,
      toolServers: M?.toolServers,
      recordedCliPrefix: M?.cliPrefix,
      recordedWireShape: X,
      record: en({
        type: "prompt_snapshot",
        systemPrompt: [...B],
        ...(M !== void 0 && M.toolDescriptions.size > 0 && {
          tools: bMn(M)
        }),
        ...(M?.cliPrefix !== void 0 && {
          cliPrefix: M.cliPrefix
        }),
        ...(H !== void 0 && {
          reminderFold: H
        }),
        ...j8t(X),
        ...(re !== void 0 && {
          echoWireToolInputs: re
        }),
        ...(ie !== void 0 && {
          contextRendering: ie
        })
      }, r),
      source: "live_recorded",
      snapshotHash: EMn(B),
      atRenderPoint: I || P && M !== void 0 && !ed([...B], [...M.systemPrompt]),
      ...(I && {
        rewritten: I
      })
    };
  } catch (M) {
    return l(M), v;
  }
}
```

## 补充：schema 构造、消息映射、写入保护与 token 计数

### `G$e` — `chunk-hqtnbrjd.js`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`221570891`
- 原始代码字节数：`918`
- 原始代码 SHA-256：`91843618e51cfb0e11c0e5e72e1baca6465266349ee0491b2ec750a963128a8f`

```javascript
async function G$e(e, n, r, s) {
  if (de()) return null;
  e = $Ot(tBe(e));
  let h = HOt(n);
  return VHe(e, h, async () => {
    try {
      let y = ple(r ?? et()),
        b = Ite(y),
        w = FOt(e);
      if (wd(y) === "bedrock") return cbo({
        model: FI(y),
        configuredModel: y,
        messages: e,
        tools: h,
        betas: b.filter(_e => SUt.has(_e)),
        containsThinking: w
      });
      let K = await JU({
          maxRetries: 1,
          model: y,
          source: "count_tokens",
          toolNames: BVn(h, e),
          agentContext: Cl(),
          credentials: s?.credentials
        }),
        V = b.filter(_e => SUt.has(_e)),
        Q = await K.beta.messages.countTokens({
          model: FI(y),
          messages: e.length > 0 ? e : [{
            role: "user",
            content: "foo"
          }],
          tools: h,
          ...O0e(V),
          ...(w && {
            thinking: YHe(y)
          })
        });
      if (typeof Q.input_tokens !== "number") return null;
      return Q.input_tokens;
    } catch (y) {
      if (t(`countTokens API call failed: ${y instanceof Error ? y.message : String(y)}`, {
        level: "error"
      }), Br() && y instanceof Mt && y.status === 501) return dbo(e, n, s?.credentials).catch(b => (t(`gateway sample count failed: ${String(b)}`, {
        level: "error"
      }), null));
      return null;
    }
  });
}
```

### `I$o` — `chunk-hqtnbrjd.js`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`222127402`
- 原始代码字节数：`342`
- 原始代码 SHA-256：`aa610031a76765bc00bb6a90c35479cdfd45adf0f8198b6c266d116abb0d332b`

```javascript
async function I$o({
  fullFilePath: e,
  ioPath: n,
  diskContent: r,
  lastRead: s,
  preReadGuard: h,
  readBaseline: y,
  servedOn: b,
  readNotAutoAllowed: w
}) {
  if (!s || s.isPartialView) {
    if (!s && !QGt(e) && !h && !w()) {
      if (y !== void 0 && !BIe(y, GS(r))) throw new O7(Oxr(b));
      return;
    }
    throw new O7(mcn);
  }
  if (!((await dk(n)) > s.timestamp)) return;
  if (sR(s) && jU(s, GS(r))) return;
  throw new O7(wUt);
}
```

### `A$` — `chunk-hqtnbrjd.js`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`222220401`
- 原始代码字节数：`3982`
- 原始代码 SHA-256：`6ba14584cf03fdeed9391e5b078b2ad1d5e7fdb1b5b469fcff5b456f9e6998c5`

```javascript
async function A$(e, n) {
  let h = Pe(),
    y = mqt(),
    b = wo => qF(n.querySource) ? nq(wo) : wo(),
    w = n.model,
    H = w !== void 0 ? b(() => y.modelConfig(w)) : void 0,
    K = b(() => Jee(w)),
    V = b(() => zj(K)),
    Q = w !== void 0 && b(() => o4n(w)),
    _e = e === Li && !ZIe() ? b(() => Fhe()) : void 0,
    ke = qF(n.querySource) ? "K:" : "",
    Se = V ? "L:" : "",
    be = h === "vertex" && H?.eagerInputStreaming?.vertex || h === "bedrock" && H?.eagerInputStreaming?.bedrock ? "F:" : "",
    Re = n.tools.some(wo => Et(wo, ho)) ? "S:" : "",
    Ce = Q ? "X:" : "",
    Ie = Et(e, An) ? Yi() ? "C1:" : _V() ? "CL:" : "C0:" : "",
    De = Et(e, Bd) ? PE(n.tools) ? "A1:" : "A0:" : "",
    Ge = Et(e, Jo) && Ggr(n.tools) ? "DP:" : "",
    Xe = Et(e, ht) ? gr() === "pro" ? "P1:" : "P0:" : "",
    tt = Et(e, ht) ? PE(n.tools) : void 0,
    ot = tt === void 0 ? "" : tt ? "AC1:" : "AC0:",
    vt = V && Xe !== "" ? b(() => pIr(K)) : void 0,
    st = vt === !0 ? "D:" : "",
    mt = !ZIe() && (Et(e, ht) || Et(e, Jo) || Et(e, Qe) || Et(e, We) || Et(e, Pr) || Et(e, ho) || Et(e, Si) || Et(e, au)) ? b(() => yae(K)) : void 0,
    Dt = mt === !0 ? "R:" : "",
    gt = Et(e, qi) ? Hie() ? "M1:" : "M0:" : "",
    jt = Et(e, ht) ? HFe() ? "E1:" : "E0:" : "",
    Ht = Et(e, ht) ? Bgr(n.querySource)?.whenToUse : void 0,
    Gt = Ht === void 0 ? "" : Ht === "" ? "X0:" : "X1:",
    Kt = Et(e, yl) ? kt() ? "W1:" : "W0:" : "",
    Yt = "",
    Dn = Et(e, cn) ? import.meta.require("/$bunfs/root/chunk-hqjbm6nx.js").artifactCorePromptCacheKeyBit(n.tools) : "",
    tn = Et(e, pr) ? n.tools.some(wo => Et(wo, cn)) ? "WA1:" : "WA0:" : "",
    zn = Et(e, T8e) ? n.tools.some(wo => Et(wo, U1e)) ? "PS1:" : "PS0:" : "",
    Kn = import.meta.require("/$bunfs/root/chunk-3z5p3fkt.js").inboxSurfaceCacheKeyBit(e, n.tools),
    dn = n.withoutToolDescribeHooks ? "H:" : "",
    on = n.loadedThroughToolSearch === !0 && e.isMcp === !0 ? "LT:" : "",
    un = (n.byValueListing !== void 0 ? `V${n.byValueListing}:` : "") + dn + on + ke + Se + be + Re + Ce + Ie + De + Ge + Xe + ot + st + Dt + gt + jt + Gt + Kt + Dn + tn + zn + Kn + ("inputJSONSchema" in e && e.inputJSONSchema ? `${e.name}:${y.schemaKey(e.inputJSONSchema)}` : e.name),
    Un = bBo(e, n, {
      cacheKey: un,
      structuredOutputs: Q,
      provider: h,
      cfg: H,
      serializer: y
    }),
    so = Un ?? s0e.get(un);
  if (!so) {
    let wo = s0e.stamp(),
      ko = vt === !0 ? b(ihe) : void 0,
      qo = dqt(e, {
        remoteToolForwarding: await lqe([e])
      });
    if (tt === !1 && !("inputJSONSchema" in e && e.inputJSONSchema)) {
      let Mo = qo.properties;
      if (typeof Mo === "object" && Mo !== null && "name" in Mo && typeof Mo.name === "object" && Mo.name !== null) qo = {
        ...qo,
        properties: {
          ...Mo,
          name: {
            ...Mo.name,
            description: $Ro
          }
        }
      };
    }
    let zo = await _Bo(e, {
        ...n,
        model: K,
        leanPrompt: V,
        bashFirstTrimmed: _e,
        delegationCostsFirst: vt,
        delegationCostsFirstText: ko,
        leanRewrite: mt
      }),
      yo = e.isMcp ? zo : rxe(zo, n.querySource),
      Ao = n.enginePlacement === "deferred",
      Ko = n.withoutToolDescribeHooks ? {
        description: yo,
        isDeferred: Ao
      } : await gQs(e, yo, Ao);
    if (!n.withoutToolDescribeHooks && n.byValueListing === void 0) {
      let Rr = Ko.isDeferred !== Ao ? Ko.isDeferred : void 0;
      AWs(e.name, Rr);
    }
    if (so = {
      name: e.name,
      description: Ko.description,
      input_schema: qo
    }, Q) {
      if (e.strict === !0) {
        let Mo = NTr(qo);
        if (Mo.ok) so.strict = !0, so.input_schema = Mo.schema;else t(`Tool ${e.name} has strict: true but its schema is not strict-compatible (${Mo.reason}); sending non-strict`, {
          level: "warn"
        });
      } else if (e.strictInputJSONSchema && k("tengu_structured_output_strict", !1)) so.strict = !0, so.input_schema = e.strictInputJSONSchema;
    }
    let No = s0e.getSentFromRecord(un);
    if (No ? No.eager_input_streaming : gqt(h, H)) so.eager_input_streaming = !0;
    s0e.register(un, so, wo);
  }
  let Jn = n.recordedEntry,
    no = Jn !== void 0 && Jn.strict === !0 === (so.strict === !0);
  if (Jn !== void 0 && Un === void 0) SBo(y, so, Jn, no, {
    mcpTool: e.isMcp === !0,
    artifactFamily: QF(e)
  });
  let yn = n.isRedescribed === !0 && pQs(e.name),
    io = {
      name: so.name,
      description: yn ? so.description : Jn?.description ?? n.recordedDescription ?? so.description,
      input_schema: no ? Jn.input_schema : so.input_schema,
      ...(so.strict && {
        strict: !0
      }),
      ...(so.eager_input_streaming && {
        eager_input_streaming: !0
      })
    };
  if (n.deferLoading) io.defer_loading = !0;
  if (n.cacheControl) io.cache_control = n.cacheControl;
  if (e.name === Xu && Wvr()) io.citations = {
    enabled: !0
  };
  if (C1()) {
    let wo = !Non(),
      ko = new Set(["name", "description", "input_schema", "cache_control", ...(wo ? ["defer_loading"] : [])]),
      qo = Object.keys(io).filter(zo => !ko.has(zo));
    if (qo.length > 0) return y.logStripOnce(qo), {
      name: io.name,
      description: io.description,
      input_schema: io.input_schema,
      ...(io.cache_control && {
        cache_control: io.cache_control
      }),
      ...(wo && io.defer_loading && {
        defer_loading: !0
      })
    };
  }
  return io;
}
```

### `_fn` — `chunk-hqtnbrjd.js`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`223459937`
- 原始代码字节数：`293`
- 原始代码 SHA-256：`219a1047fecf254e71e4cf02284e028a3007551075e5fcd5b8d10adc65cd1129`

```javascript
class _fn {
  #e = new tc({
    max: Yfr
  });
  #t = new Map();
  run(e, n) {
    let r = this.#e.get(e);
    if (r !== void 0) return Promise.resolve(r);
    let s = this.#t.get(e);
    if (s !== void 0) return s;
    let h = n().then(y => {
      if (typeof y === "number" && y > 0) this.#e.set(e, y);
      return y;
    }).finally(() => {
      this.#t.delete(e);
    });
    return this.#t.set(e, h), h;
  }
}
```

### `jpr` — `chunk-hqtnbrjd.js`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`223533638`
- 原始代码字节数：`375`
- 原始代码 SHA-256：`6825028b2cc8f3b224130202797a93a5de5726d5ba7d5c6042cb8f731c58e2dd`

```javascript
function jpr(e, n, r) {
  let s = et(),
    h = yh(s),
    y = (K, V) => {
      let Q = 0;
      for (let _e of K) Q += HK(_e.content, h);
      if (V.length > 0) Q += Oft(_(V), "json") + qK;
      return Q;
    };
  if (e === "summary") {
    let K = async (V, Q) => y(V, Q);
    return {
      count: K,
      countTranscript: K
    };
  }
  let b = (K, V) => G$e(K, V, s, {
      credentials: r
    }),
    w = kfn.of(n),
    H = _([FI(s), Ite(s)]);
  return {
    count: ipn((K, V) => w.run(it(H + _([K, V])), () => b(K, V)), y),
    countTranscript: ipn(b, y)
  };
}
```

### `Vwn` — `chunk-hqtnbrjd.js`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`224039433`
- 原始代码字节数：`8714`
- 原始代码 SHA-256：`6eba74967c8f0517016dc631361e9a7b380659fa16634ff6dc1222fad5d7cb9d`

```javascript
async function Vwn({
  messages: e,
  summaryRequest: n,
  appState: r,
  context: s,
  preCompactTokenCount: h,
  cacheSafeParams: y,
  stripNonEssential: b = !1,
  onResponseLength: w,
  thinkingStripPlan: H,
  advisorStripPlan: K,
  compactionRequestKind: V
}) {
  let Q = !b && k("tengu_compact_cache_prefix", !0),
    _e = H2(s.onCompactEvent),
    ke = SRe(w, s.onCompactEvent);
  try {
    if (Q) try {
      let Dt = await UA({
          promptMessages: [n],
          cacheSafeParams: y,
          canUseTool: Tet(),
          querySource: "compact",
          forkLabel: "compact",
          maxTurns: 1,
          compactionRequestKind: V,
          apiAttemptsLeft: s.compactionApiAttemptsLeft,
          thinkingStripPlan: H,
          advisorStripPlan: K,
          fallbackModel: RRe(y.model ?? s.options.mainLoopModel, s.options.fallbackModel),
          skipCacheWrite: !0,
          skipTranscript: !0,
          onStreamDelta: ke,
          overrides: {
            abortController: s.abortController,
            onRetryStatus: s.onRetryStatus
          }
        }),
        gt = y_(Dt.messages),
        jt = yRe(Dt.messages),
        Ht = N(Dt.messages, Gt => Gt.type === "assistant" && !Gt.isApiErrorMessage);
      if (gt && jt && !gt.isApiErrorMessage) {
        if (!jt.startsWith(aU)) i("tengu_compact_cache_sharing_success", {
          preCompactTokenCount: h,
          outputTokens: Dt.totalUsage.output_tokens,
          cacheReadInputTokens: Dt.totalUsage.cache_read_input_tokens,
          cacheCreationInputTokens: Dt.totalUsage.cache_creation_input_tokens,
          cacheHitRate: Dt.totalUsage.cache_read_input_tokens > 0 ? Dt.totalUsage.cache_read_input_tokens / (Dt.totalUsage.cache_read_input_tokens + Dt.totalUsage.cache_creation_input_tokens + Dt.totalUsage.input_tokens) : 0,
          forkAssistantMessageCount: Ht
        });
        return {
          response: hRe(Dt.messages) ?? gt,
          mediaStripped: !1
        };
      }
      if (s.abortController.signal.aborted) throw Error(YI);
      if (gt && s.compactionApiAttemptsLeft?.count === 0) return {
        response: gt,
        mediaStripped: !1
      };
      t(`Compact cache sharing: no text in response, falling back. Response: ${_(gt)}`, {
        level: "warn"
      }), i("tengu_compact_cache_sharing_fallback", {
        reason: S("no_text_response"),
        preCompactTokenCount: h,
        lastAssistantKind: rqr(gt),
        assistantTextLength: jt?.length ?? 0,
        forkAssistantMessageCount: Ht,
        stopReason: pe(gt?.isApiErrorMessage && gt.message.stop_reason !== "refusal" ? void 0 : gt?.message.stop_reason ?? void 0),
        assistantErrorKind: pe(gt?.error ?? void 0)
      });
    } catch (Dt) {
      if (s.abortController.signal.aborted || wP(Dt, YI)) throw Error(YI);
      l(Dt), i("tengu_compact_cache_sharing_fallback", {
        reason: S("error"),
        preCompactTokenCount: h
      });
    }
    let be = !b && (await E_r(s.options.mainLoopModel, s.options.tools, async () => r.toolPermissionContext, s.options.agentDefinitions.activeAgents, "compact", s.credentials)) ? Ei([Vw, xhr, ...s.options.tools.filter(Dt => Dt.isMcp)], "name") : [Vw],
      Re = [...ri(e), n],
      Ce = ERe(b ? nqr(Re) : Re),
      Ie = b ? oqr(Ce) : Ce,
      De = y.model ?? s.options.mainLoopModel,
      Ge = s.agentId === void 0;
    if ($Fe(De, s.requestDialog)) {
      let Dt = lge();
      if (Dt === null) {
        let gt = lz();
        if (Ge) m("model_fable_consent", gt ? "compact_no_model_fallback_env" : "compact_no_allowed_fallback");
        if (gt) throw Error("Compaction unavailable: CLAUDE_CODE_NO_MODEL_FALLBACK is set and model substitution is disabled \xB7 unset it to allow the swap");
        throw new x(`Compaction unavailable: your model policy only allows ${R_(De)}, which requires usage credits \xB7 /model to set it up`, "Compaction unavailable: model policy only allows Fable, which requires usage credits");
      }
      if (Ge) p("model_fable_consent", "compact_substituted");
      De = Dt;
    }
    let Xe = RRe(De, s.options.fallbackModel),
      tt = age(De, Xe),
      ot = 0,
      vt,
      st,
      mt;
    while (!0) {
      let Dt = vt ?? tt[ot],
        gt = PSr(tt, ot, Dt),
        jt = !1,
        Ht,
        Gt = st;
      st = void 0;
      let Kt = mt;
      mt = void 0;
      let Yt = xSr({
          currentModel: Dt,
          alreadyUsed: vt !== void 0,
          declined: !1,
          inCascadeEpisode: !1,
          cascadeNext: void 0,
          suppressionAlreadyLogged: !0,
          requestDialog: s.requestDialog,
          isMainThread: Ge,
          consumerLacksDialogCapability: !0,
          preferenceQuestionPending: !1,
          serverDefaultFallbacksEnabled: () => !1,
          selfTargetDefaultFallbacksEnabled: () => !1,
          sticky: Ws(),
          threadedRequest: !1
        }).visibleModel,
        Dn = [];
      s.onCompactEvent?.({
        type: "stream_mode",
        mode: "requesting"
      }), w?.({
        type: "response_length",
        op: "reset"
      });
      try {
        let tn = QIt(Re),
          zn = jw(Re),
          dn = aIt({
            messages: wT(Ie, b ? [] : s.options.tools, void 0, {
              echoWireToolInputs: zn,
              echoApiBlockOrder: _v(),
              thinkingStripPlan: H,
              advisorStripPlan: K,
              reminderFold: tn
            }),
            systemPrompt: bi(["You are a helpful AI assistant tasked with summarizing conversations."]),
            thinkingConfig: GYe(s),
            tools: b ? [] : be,
            signal: s.abortController.signal,
            options: {
              async getToolPermissionContext() {
                return s.getAppState().toolPermissionContext;
              },
              model: Dt,
              withoutToolDescribeHooks: s.options.settingsHooksOff,
              reminderFold: tn,
              echoWireToolInputs: zn,
              fallbackModel: tt[ot + 1],
              accessFallbackModel: gt,
              refusalFallbackModel: Yt,
              refusalFallbackModelLane: "visible",
              fallbackCreditLaneArmed: Yt !== void 0,
              fallbackCreditCode: Gt?.code,
              fallbackCreditMintModel: Gt?.mintModel,
              fallbackCreditMintRequestId: Gt?.mintRequestId,
              fallbackStampFromModel: Kt?.fromModel,
              fallbackStampCategory: Kt?.category,
              fallbackStampTrigger: Kt?.trigger,
              fallbackStampOriginalRequestId: Kt?.originalRequestId,
              toolChoice: void 0,
              isNonInteractiveSession: s.options.isNonInteractiveSession,
              hasAppendSystemPrompt: !!s.options.appendSystemPrompt,
              querySource: "compact",
              compactionRequestKind: V,
              apiAttemptsLeft: s.compactionApiAttemptsLeft,
              agents: s.options.agentDefinitions.activeAgents,
              mcpTools: [],
              agentContext: s.agentContext,
              credentials: s.credentials,
              storageV5: s.storageV5,
              stickyBetas: uC(Ws()),
              proactivityLevel: A5(s),
              effortValue: mh(s),
              effortSetAsideByHold: Nsn(s),
              turnEffort: cy(s.permissionLayers),
              refusalFallbackEffort: Kt?.effort ?? void 0,
              enablePromptCaching: !1,
              promptTooLongIsHandled: !0,
              onRetryStatus: s.onRetryStatus
            }
          })[Symbol.asyncIterator](),
          on = await dn.next();
        while (!on.done) {
          let un = on.value;
          if (un.type === "stream_event") {
            if (un.event.type === "content_block_start" && un.event.content_block.type === "text") jt = !0;
            ke?.(un);
          }
          if (un.type === "assistant") Dn.push(un);
          if (un.type === "model_fallback_triggered") throw un.error;
          if (un.type === "fallback_request") {
            Ht = un;
            try {
              await dn.return(void 0);
            } catch (Un) {
              t(`Compact: refused summarizer stream threw on return: ${d(Un)}`, {
                level: "warn"
              });
            }
            break;
          }
          on = await dn.next();
        }
        if (Ht !== void 0) {
          let un = Ht.fallbackModel;
          if ($Fe(un, s.requestDialog)) {
            let Un = lge(),
              so = Un !== null && ike(tt[0], Un);
            if (Un === null || so) {
              if (Ge) m("model_fable_consent", so ? "compact_refusal_fallback_shrinks_window" : "compact_refusal_no_allowed_fallback");
              if (so) throw Error("Compaction unavailable: the only model allowed after this refusal has a smaller context window \xB7 retry, or /model to change models");
              throw new x(`Compaction unavailable: your model policy only allows ${R_(un)}, which requires usage credits \xB7 /model to set it up`, "Compaction unavailable: model policy only allows Fable, which requires usage credits");
            }
            if (Ge) p("model_fable_consent", "compact_substituted");
            un = Un;
          }
          if (vt = un, st = Ht.creditCode !== null ? {
            code: Ht.creditCode,
            mintModel: Dt,
            mintRequestId: Ht.requestId ?? void 0
          } : void 0, mt = {
            fromModel: Ht.originalModel,
            category: Ht.apiRefusalCategory ?? void 0,
            trigger: Ht.trigger,
            originalRequestId: Ht.requestId ?? void 0,
            effort: Ht.refusedEffort.carry
          }, i("tengu_refusal_fallback_triggered", {
            original_model: wt(Dt),
            fallback_model: wt(vt),
            trigger: c(Ht.trigger),
            request_id: ye(Ht.requestId),
            prompt_skipped_reason: c(NVn({
              requestDialog: s.requestDialog,
              isMainThread: Ge,
              silentAttempt: !1,
              consumerLacksDialogCapability: !0
            }) ?? "no_dialog_host"),
            api_refusal_category: Ht.apiRefusalCategory ? c(Ame(Ht.apiRefusalCategory)) : void 0,
            route_matched: Ht.routeMatched != null ? c(Ht.routeMatched) : void 0,
            has_api_refusal_explanation: Boolean(Ht.apiRefusalExplanation),
            credit_minted: Ht.creditCode !== null,
            ...Xsn(Ht.refusedEffort),
            querySource: S("compact"),
            queryChainId: ye(s.queryTracking?.chainId) ?? S(""),
            queryDepth: s.queryTracking?.depth ?? -1
          }), t("Compact: refusal fallback triggered, retrying summarization on the fallback model", {
            level: "warn"
          }), s.abortController.signal.aborted) throw Error(YI);
          continue;
        }
        let qn = Dn.at(-1);
        if (qn) {
          if (vt !== void 0 && !qn.isApiErrorMessage) g("refusal_fallback");
          return {
            response: qn.isApiErrorMessage ? qn : hRe(Dn) ?? qn,
            mediaStripped: !0
          };
        }
        if (s.abortController.signal.aborted) throw Error(YI);
        throw t(`Compact streaming failed. hasStartedStreaming=${jt}`, {
          level: "error"
        }), i("tengu_compact_failed", {
          reason: S("no_streaming_response"),
          preCompactTokenCount: h,
          hasStartedStreaming: jt,
          promptCacheSharingEnabled: Q
        }), Error(Uet);
      } catch (tn) {
        if (ISr(gt, tn)) tt.push(gt);
        let zn = tt[ot + 1];
        if (zn !== void 0 && $Fe(zn, s.requestDialog)) {
          let Kn = lge() ?? void 0;
          if (zn = Kn !== void 0 && !ike(tt[0], Kn) ? Kn : void 0, zn !== void 0) tt[ot + 1] = zn;
        }
        if (tn instanceof qM && zn !== void 0) {
          if (lz()) Xln();
          g("model_fallback"), i("tengu_model_fallback_triggered", {
            original_model: wt(tn.originalModel),
            fallback_model: wt(zn),
            chain_index: ot + 1,
            query_source: S("compact"),
            reason: c(tn.reason),
            entrypoint: S("cli"),
            queryChainId: ye(s.queryTracking?.chainId) ?? S(""),
            queryDepth: s.queryTracking?.depth ?? -1
          }), t(`Compact: model fallback triggered (${tn.reason}), retrying summarization on the fallback model`, {
            level: "warn"
          }), ot++, vt = void 0;
          continue;
        }
        if (tn instanceof qM && tn.reason === "model_blocked") throw new C4(TSr(tn, Yo(tn.originalModel)));
        throw tn;
      }
    }
  } finally {
    _e();
  }
}
```

### `TYr` — `chunk-hqtnbrjd.js`

- 原始文件：`000220845554.js`
- 二进制绝对字节起点：`224360621`
- 原始代码字节数：`2019`
- 原始代码 SHA-256：`1dc17c2f79770737f5f32c49e16278305997717fa059d04e8023a549e47d733e`

```javascript
function TYr(e, n, r, s = !1, h, y = !1, b = Pe(), w = !1, H = !1, K = !1, V, Q, _e, ke = !1, Se = !0, be) {
  let Re = C1(),
    Ce = a.CLAUDE_CODE_SIMULATE_PROXY_USAGE,
    Ie = !y && !Re && !Ce,
    De = _v(),
    Ge = !w && iIt(),
    Xe = aTn({
      messages: e,
      enablePromptCaching: n,
      skipCacheWrite: s,
      forkPointUuid: h,
      canMarkApiSystem: Ie,
      forkCachePin: Ge || ke && !w,
      whitespaceTextUnstampable: De,
      topLevelCacheControl: H,
      isForkPinStepBackEnabled: () => Ge && rTn(),
      divergesAtMessageId: w ? void 0 : Q,
      parentReplyId: be?.isMarkWanted === !0 && !w ? be.parentReplyId : void 0,
      tailAuditTerms: {
        proxyDemoted: y,
        experimentalBetasDisabled: Re,
        simulateProxyUsage: Ce,
        skipMessageCacheMarkers: _e?.skipMessageCacheMarkers ?? !1
      }
    }),
    {
      markerIndices: tt,
      forkPointPinned: ot,
      parentPromptEndMarked: vt,
      auditTail: st
    } = Xe;
  if (_e !== void 0) try {
    _e.report(st());
  } catch (gt) {
    l(gt);
  }
  if (Se) i("tengu_api_cache_breakpoints", {
    totalMessageCount: e.length,
    cachingEnabled: n,
    skipCacheWrite: s,
    forkPointPinned: ot,
    markerCount: tt.size,
    ...(be !== void 0 && !w && {
      querySource: Zo(be.querySource),
      ...(be.isMarkWanted && {
        parentPromptEndMarked: vt
      })
    })
  });
  let mt;
  try {
    mt = MEn(e, K);
  } catch (gt) {
    l(gt);
  }
  let Dt = (mt?.messages ?? e).map((gt, jt) => {
    let Ht = tt.has(jt);
    if (gt.type === "user") return qVr(gt, Ht, n, r);
    if (gt.type === "api_system") {
      let Gt = Ht && n && Ie,
        Kt = gt.ephemeralSuffix ? [{
          type: "text",
          text: gt.ephemeralSuffix
        }] : [];
      if (gt.toolAdditions && gt.toolAdditions.length > 0 || gt.toolRemovals && gt.toolRemovals.length > 0) return {
        role: "system",
        content: [...Iks(gt.message.content, gt.toolAdditions ?? [], Gt ? A4({
          ttl: r
        }) : void 0, gt.toolRemovals ?? [], gt.toolDefinitions), ...Kt],
        ...(gt.outputConfig && {
          output_config: gt.outputConfig
        })
      };
      let Yt = xO(gt.message.content, gt.ephemeralSuffix ?? "");
      return {
        role: "system",
        content: Gt ? [{
          type: "text",
          text: gt.message.content,
          cache_control: A4({
            ttl: r
          })
        }, ...Kt] : Yt || [],
        ...(gt.outputConfig && {
          output_config: gt.outputConfig
        })
      };
    }
    return KVr(gt, Ht, n, r, De);
  });
  if (mt !== void 0) try {
    let gt = OEn(Dt, mt);
    return V?.push(...gt.wireIndexOf), gt.wire;
  } catch (gt) {
    l(gt);
    let jt = mt.dropBase,
      Ht = [];
    return Dt.forEach((Gt, Kt) => {
      if (V?.push(Ht.length), !jt.has(Kt)) Ht.push(Gt);
    }), V?.push(Ht.length), Ht;
  }
  return V?.push(...Dt.keys(), Dt.length), Dt;
}
```

### `g7` — `chunk-2jyw98bz.js`

- 原始文件：`000214885527.js`
- 二进制绝对字节起点：`215273881`
- 原始代码字节数：`105`
- 原始代码 SHA-256：`e233adb5627144cd31b5a6ac4d8400c5bfbd9831d4bd3ce1ac2806ddc2cd7e1b`

```javascript
function g7() {
  if (!gy()) return !1;
  if (!Pi()) return !1;
  let e = Pe();
  return e === "firstParty" || e === "anthropicAws";
}
```\n