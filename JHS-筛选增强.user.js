// ==UserScript==
// @name         JHS 筛选增强
// @namespace    local.jhs.filter.plus
// @version      3.6.2
// @description  为 JHS 列表页叠加自定义筛选；「资料库」视图合并 JHS 与本地影子库，支持从详情页按需补齐导演/片商/系列/类别等字段，内置诊断工具。
// @author       tabelr
// @match        *://javdb.com/*
// @match        *://javdb*.com/*
// @match        *://www.javbus.com/*
// @match        *://*javbus*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      javdb.com
// @connect      *.javdb.com
// @run-at       document-idle
// ==/UserScript==

/*
 * 设计要点
 * ------------------------------------------------------------------
 * 1) 不修改 JHS 本体。读 globalThis.storageManager，写 globalThis.stateService.patch。
 * 2) 影子库独立：DB 名 JHS-XMETA，与 JHS 的 JAV-JHS 完全隔离。
 * 3) 筛选不碰卡片 style.display，只用「属性 + CSS !important」隐藏。
 * 4) 零请求采集：评分、评价人数、封面、发行日期全部来自列表页 DOM。
 * 5) 写入边界：JHS 的 record 白名单只有
 *    url / names / publishTime / starId / remark / fc2Source
 *
 * ⚠ 重要：本脚本是 @grant none，运行在页面上下文；JHS 是沙箱模式，
 *    它 @require 的 Tabulator / layer 在沙箱作用域内，页面里访问不到。
 *    所以资料库的表格与弹窗全部自实现，不依赖 JHS 的 UI 库。
 * 3.5.0 界面：设计令牌 + 暗色模式 + 焦点可见性；图墙密度切换、骨架屏、
 *    悬停信息层；筛选已选条件条、数量角标、预设、维度内搜索、折叠；
 *    资料库列隐藏、冻结首列、紧凑密度；删除无创建代码的死 FAB 样式。
 *    注意：图墙与资料库的标题栏此前已统一为 .xm-hd，本次未动其结构。
 * 3.6.0 补齐：partial 结果复核一次；刷新 2 秒节流且墙未开时跳过墙侧刷新；
 *    写入攒批（20 条 / 5 秒）+ 结束强制刷盘；并发 2→3、最小间隔 600→500ms；
 *    失败计数只计找不到 / 硬错误；停止取消进行中请求；搜索结果同运行缓存。
 * 3.6.1 资料库：新增「只看未补齐」筛选（失败过 / DB 无收录 / 解析不全 / 缺字段），
 *    番号旁显示未补齐原因角标；搜不到攒满 3 次后不再进补齐队列，但仍可在此筛选里找到。
 * 3.6.2 修复：改番号 / 单条补齐 / 删除后不再跳回默认排序（reloadRows 会恢复当前排序，
 *    页码超限时自动收回）；资料库标题栏显示版本号，方便确认装的是不是最新版。
 */

(function () {
  'use strict';

  // JHS 的对象挂在页面真实 window 上；申请了 @grant 之后脚本在沙箱里，
  // 必须用 unsafeWindow 才摸得到。拿不到就退回 window（jsdom / 特殊管理器）。
  const UW = (function () {
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow) return unsafeWindow;
    } catch (e) { /* noop */ }
    return window;
  })();

  try {

  /* ==================== 1. 配置 ==================== */

  const ITEM_SEL = '.movie-list .item, .masonry .item';
  const HIDE_ATTR = 'data-xflt';
  const HIDE_VAL = 'hide';
  const STORE_KEY = 'xflt:cond:v1';

  const XDB_NAME = 'JHS-XMETA';
  const XDB_STORE = 'meta';
  const XLS_KEY = 'xm:store:v1';
  const XGM_KEY = 'xm:meta:gm:v1';      // 影子库（跨站共享，走 GM 存储）
  const XSYNC_KEY = 'xm:carflags:v1';   // 两个站点的记录合并表
  const XJELLYFIN_IMPORT_KEY = 'xm:jellyfin-import:v2';
  const LIB_BACKUP_FORMAT = 'jhs-filter-enhanced-library';
  const LIB_BACKUP_VERSION = 1;
  const DB_LOOKUP_VERSION = 2;           // 旧版 DB 未命中记录只复核一次
  const META_PARSE_VERSION = 2;           // 修复解析后，旧的不完整记录最多复核一次
  const XM_VERSION = '3.6.2';            // 界面里显示的版本号（与 @version 保持一致）

  const WRITABLE = ['url', 'names', 'publishTime', 'remark'];
  const STATUS_KEYS = ['favorite', 'downloaded', 'watched', 'blocked'];
  const STAGES = [
    { v: 'pending', t: '待鉴定' },
    { v: 'score3', t: '3分' },
    { v: 'score4', t: '4分' },
    { v: 'score5', t: '5分' },
    { v: 'discarded', t: '淘汰' },
    { v: 'jellyfin', t: '已存 Jellyfin' }
  ];
  const STAGE_VALUES = new Set(STAGES.map(function (x) { return x.v; }));
  const JELLYFIN_CARS = [
    '300MAAN-783','300MIUM-1116','300MIUM-1187','300MIUM-1295','300MIUM-1306','300MIUM-1308','300MIUM-843','300MIUM-903',
    '336KNB-387','336KNB-398','348NTR-055','348NTR-087','348NTR-092','390JAC-220','390JNT-035','390JNT-067','390JNT-118',
    '259LUXU-1688','420HOI-372','459TEN-032','546EROFV-351','567BEAF-220','758REFUCK-206J','857OMG-029','ADN-713-C','ALOG-019','AP-067','AVOP-237','AVSA-328',
    'CAWD-741-C','CAWD-878','CLUB-865','DANDY-276','DANDY-517','DASS-424','DASS-614','DASS-854','DASS-922-C','DDHC-020',
    'DLDSS-141','DLDSS-192','DVMM-137','EKDV-762','FC2-1658698','FC2-737367','FC2-PPV-2643836','FCDSS-027','FLAV-376','FNEW-019',
    'FOCS-272','FPRE-149-C','FSDSS-437','FSDSS-866-C','FUGA-36','GESY-092','GNS-121','GVH-490-C','HAWA-341-C','HEYZO-0683',
    'HEYZO-0733','HJBB-174','HODV-21790','HUNTC-527','IPIT206','IPSE-003','IPX-635-C','IPX-845-C','IPZZ-574-C','JUFE-369',
    'JUFE-604','JUFE-615','JUQ-321-C','JUQ-883','JUQ-953-C','JUR-024-C','JUR-036-C','JUR-403','JUR-422','JUR-473','JUR-723-C',
    'JUR-769','JUR-793','KATU-134','KNB-406','KTB-098-C','KUSE-034','LADYL-005','LULU-159','LULU-198','LUXU-1688',
    'MAAN-1170','MAAN-783','MACB-034','MADM-193','MEYD-970-C','MEYD-975','MFCS-184','MFYD-029-C','MFYD-125','MGTD-025',
    'MIAB-599','MIBB-059','MIDA-126-C','MIDA-198','MIDA-378-C','MIDV-118-C','MIDV-408','MISM-356','MIUM-903','MMC-012',
    'MOGI-083','MOND-294-C','MREC-005','MTALL-137','MTALL-150','N0706','N1443','NACR-647','NHDTA-318','NHDTA-369',
    'NHDTA-380','NHDTA-411-C','NHDTA-511','NHDTA-727','NHDTB-459','NHDTB-525','NHDTB-598','NHDTB-631','NHDTB-772','NHDTB-819',
    'NHDTB-966','NHDTC-03101','NHDTC-041','NHDTC-042','NHDTC-057','NHDTC-113','NHDTC-130','NHDTC-143','NHDTC-186','NHDTC-222',
    'NNPJ-525','NPJS-234','NSFS-353-C','PRED-483','PRED-784','REAL-851','REAL-919','RED-120','RED-155','RED170','ROE-361',
    'ROE-377-C','SAN-390','SDNM-549','SIRO-5462','SIRO-5560','SIRO-5569','SIRO-5705','SKJK-016','SKYHD-059','SNA-033',
    'SONE-286-C','SONE-492','SONE-538-C','SONE-577','SONE-632','SONE-664-C','SONE-679','SONE-712','SONE-728','SONE-756',
    'SONE-771','SONE-894','SSIS-929-C','SSNI-644','STAR-621','STARS-870-C','START-010','START-169','START-291','START-414',
    'START-568','SVMGM-007','SVVRT-048','SW-213','TEK-099','TEN-032','TKWA-267','URE-117','VICD-254','VICD-257-C',
    'WAAA-428','WAAA-576-C','XVSR-623','YMYM-004','YMYM-034','ZMEN-024','S2MBD-050'
  ];
  const stageSyncInFlight = new Set();

  const DEFAULT_COND = {
    state: '', minScore: '', minVotes: '', minYear: '', sort: 'default',
    actor: '', director: '', series: '',
    prefix: '', exPrefix: '', kw: '', exKw: ''
  };

  let cond = Object.assign({}, DEFAULT_COND, loadCond());
  if (!['', 'pending', 'score3', 'score4', 'score5', 'discarded', 'jellyfin'].includes(cond.state)) {
    cond.state = cond.state === 'favorite' ? 'pending' :
      (cond.state === 'normal' ? 'score4' : (cond.state === 'prized' ? 'score5' :
      (cond.state === 'nofavorite' ? 'score4' : '')));
  }

  // 需要影子库才能判定的字段
  const META_FIELDS = ['actor', 'director', 'series'];

  function yearChips() {
    const y = new Date().getFullYear();
    const out = [{ v: '', t: '不限' }];
    for (let i = 0; i < 5; i++) out.push({ v: String(y - i), t: String(y - i) });
    out.push({ v: 'le' + (y - 5), t: '≤' + (y - 5) });
    return out;
  }

  const CHIP_GROUPS = {
    state: [
      { v: '', t: '不限' }, { v: 'pending', t: '待鉴定' }, { v: 'score3', t: '3分' },
      { v: 'score4', t: '4分' }, { v: 'score5', t: '5分' }, { v: 'discarded', t: '淘汰' },
      { v: 'jellyfin', t: '已存 Jellyfin' }
    ],
    minScore: [
      { v: '', t: '不限' }, { v: '3.5', t: '≥3.5' }, { v: '4', t: '≥4.0' },
      { v: '4.3', t: '≥4.3' }, { v: '4.5', t: '≥4.5' }, { v: '4.7', t: '≥4.7' }
    ],
    minVotes: [
      { v: '', t: '不限' }, { v: '10', t: '≥10人' }, { v: '50', t: '≥50人' },
      { v: '100', t: '≥100人' }, { v: '300', t: '≥300人' }
    ],
    sort: [
      { v: 'default', t: '默认' },
      { v: 'scoreDesc', t: '评分 ↓' }, { v: 'scoreAsc', t: '评分 ↑' },
      { v: 'votesDesc', t: '人数 ↓' },
      { v: 'dateDesc', t: '发行 ↓' }, { v: 'dateAsc', t: '发行 ↑' },
      { v: 'addedDesc', t: '加入 ↓' }, { v: 'addedAsc', t: '加入 ↑' }
    ]
  };

  /* ==================== 2. 样式 ==================== */

  const CSS = `  /* ---- 设计令牌（统一语言；改色/改层级只改这里；暗色模式见文件末尾） ---- */
  /* 层级表：遮罩 < 弹窗 < JHS 详情层（约 999999991，须保持在其下方） < 诊断窗 */
  .xm-modal, .xm-mask, #xm-probe, #xm-probe-mask {
    --xm-bg:#fff; --xm-bg-subtle:#f8fafc; --xm-bg-hover:#f2f4f8;
    --xm-text:#1f2733; --xm-muted:#5b6b7c; --xm-faint:#9aa3b0;
    --xm-border:#dfe4ec; --xm-accent:#3b6ea5; --xm-accent-dark:#315f91;
    --xm-accent-bg:#eef4fb; --xm-danger:#b3261e; --xm-danger-border:#eed1d1;
    --xm-danger-bg:#fff8f7; --xm-green:#0f6e56; --xm-green-bg:#e8f5f0;
    --xm-amber:#8a5300; --xm-amber-bg:#fdf0dd; --xm-on-accent:#fff;
    --xm-r-lg:14px;
    --xm-shadow:0 18px 60px rgba(23,37,52,.24);
    --xm-z-mask:900000000; --xm-z-modal:900000001;
    --xm-z-probe-mask:2147482100; --xm-z-probe:2147482101;
  }


  .movie-list .item[${HIDE_ATTR}="${HIDE_VAL}"],
  .masonry   .item[${HIDE_ATTR}="${HIDE_VAL}"] { display: none !important; }
  /* ---- 图墙弹层 ---- */
  .xm-wall-filters { flex:0 0 auto; padding:10px 22px 12px; border-bottom:1px solid var(--xm-border);
      background:var(--xm-bg-subtle); max-height:38vh; overflow-y:auto; }
  .xm-wall-tip { margin-left:auto; font-size:12px; color:var(--xm-muted); }
  .xm-wall-close { flex:0 0 auto; padding:7px 16px; border:1px solid var(--xm-border); border-radius:8px;
      background:var(--xm-bg); color:var(--xm-muted); font-size:13px; cursor:pointer; transition:all .16s ease; }
  .xm-wall-close:hover { border-color:var(--xm-danger); color:var(--xm-danger); background:var(--xm-danger-bg); }
  .xm-wall-sum { font-size:13px; color:var(--xm-muted); }
  .xm-wall-sum b { color:var(--xm-danger); }

  #xflt-panel { font-size:13px; color:var(--xm-text); }

  .xf-dims { display:flex; align-items:center; gap:5px; padding:2px 0 3px; flex-wrap:wrap;
      min-height:26px; }
  .xf-dim { display:inline-block; flex:0 0 auto; padding:2px 11px;
      border:1px solid var(--xm-border) !important; border-radius:12px;
      background:var(--xm-bg) !important; color:var(--xm-muted) !important; font-size:12px; line-height:1.6;
      cursor:pointer; white-space:nowrap; text-decoration:none; }
  .xf-dim:hover { border-color:var(--xm-accent); color:var(--xm-accent); }
  .xf-dim.active { background:var(--xm-text) !important; border-color:var(--xm-text) !important; color:var(--xm-on-accent) !important; }
  .xf-dim.dirty::after { content:'·'; margin-left:3px; color:var(--xm-danger); }
  .xf-dim.active.dirty::after { color:#f5b5b3; }

  .xf-opts { display:flex; align-items:center; gap:5px; margin-top:3px;
      padding:3px 0 2px; flex-wrap:wrap; }
  .xf-opts[hidden] { display:none; }

  .xf-chip { display:inline-block; flex:0 0 auto; padding:1px 9px;
      border:1px solid var(--xm-border) !important; border-radius:11px;
      background:var(--xm-bg) !important; color:var(--xm-text) !important; font-size:11.5px; line-height:1.7;
      cursor:pointer; white-space:nowrap; text-decoration:none; }
  .xf-chip:hover { border-color:var(--xm-accent); color:var(--xm-accent); }
  .xf-chip.on { background:var(--xm-accent) !important; border-color:var(--xm-accent) !important; color:var(--xm-on-accent) !important; }
  .xf-n { font-style:normal; margin-left:5px; color:var(--xm-faint); font-size:10.5px; }
  .xf-chip.on .xf-n { color:rgba(255,255,255,.72); }
  .xf-chip.on:hover { color:var(--xm-on-accent); }

  .xf-in { flex:0 0 auto; padding:2px 8px; border:1px solid var(--xm-border); border-radius:6px;
      background:var(--xm-bg); color:var(--xm-text); font-size:11.5px; width:118px; }
  .xf-in:focus { outline:none; border-color:var(--xm-accent); }
  .xf-in.on { border-color:var(--xm-accent); background:var(--xm-accent-bg); }
  .xf-sep { flex:0 0 auto; width:1px; height:13px; background:var(--xm-border); margin:0 2px; }
  .xf-hint { flex:0 0 auto; color:var(--xm-faint); font-size:11px; }

  .xm-wall-modal { width:96vw; max-width:1920px; height:94vh; border-radius:var(--xm-r-lg); }
  #xm-wall-bd { padding:0 24px; }
  .xm-wall-list { display:grid; grid-template-columns:repeat(5, minmax(0, 1fr));
      gap:24px 20px; padding:22px 0 12px; }
  @media (max-width: 1500px) { .xm-wall-list { grid-template-columns:repeat(4, minmax(0, 1fr)); } }
  @media (max-width: 1050px) { .xm-wall-list { grid-template-columns:repeat(3, minmax(0, 1fr)); } }
  @media (max-width: 680px)  { .xm-wall-list { grid-template-columns:repeat(2, minmax(0, 1fr)); gap:16px 12px; } }
  .xm-wall-list .item { display:block; min-width:0; }
  .xm-stage-tags { display:flex; justify-content:flex-end; flex-wrap:wrap; gap:4px;
      margin-top:5px; min-height:23px; }
  .xm-stage-btn { padding:2px 7px; border:1px solid var(--xm-border); border-radius:11px;
      background:var(--xm-bg); color:var(--xm-muted); font-size:10.5px; line-height:1.35; cursor:pointer; }
  .xm-stage-btn:hover { border-color:var(--xm-accent); color:var(--xm-accent); }
  .xm-stage-btn.on { background:var(--xm-accent); border-color:var(--xm-accent); color:var(--xm-on-accent); }
  .xm-stage-btn[data-stage="score5"].on { background:var(--xm-amber); border-color:var(--xm-amber); }
  .xm-stage-btn[data-stage="discarded"].on { background:#7d5960; border-color:#7d5960; }
  .xm-stage-btn[data-stage="jellyfin"].on { background:var(--xm-green); border-color:var(--xm-green); }
  .xm-meta-with-stage { display:flex !important; align-items:center; justify-content:space-between;
      gap:4px; min-height:23px; }
  .xm-meta-date { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .xm-list-stage-controls { position:static; display:flex; flex:0 0 auto; flex-wrap:wrap;
      justify-content:flex-end; gap:2px; max-width:78%; }
  .xm-list-stage-controls .xm-stage-btn { padding:1px 4px; font-size:9px; line-height:1.2; white-space:nowrap; }
  .xm-list-stage-controls .xm-stage-btn[data-stage="list-watched"].on { background:var(--xm-muted); border-color:var(--xm-muted); }
  .xm-stage-select { max-width:100px; padding:3px 5px; border:1px solid var(--xm-border);
      border-radius:6px; color:var(--xm-text); background:var(--xm-bg); font-size:12px; }
  .xm-stage-inline { display:flex; align-items:center; gap:3px; flex-wrap:nowrap; }
  .xm-stage-inline .xm-stage-btn { padding:3px 5px; font-size:10.5px; }
  .xm-delete-btn { padding:4px 8px; border:1px solid var(--xm-danger-border); border-radius:6px;
      background:var(--xm-bg); color:var(--xm-danger); font-size:11px; cursor:pointer; white-space:nowrap; }
  .xm-delete-btn:hover { background:var(--xm-danger-bg); border-color:var(--xm-danger); }
  .xm-wall-list .item > a { display:block; padding:0 0 5px; border-radius:10px;
      text-decoration:none; color:inherit; transition:transform .18s ease; }
  .xm-wall-list .item > a:hover { transform:translateY(-3px); }
  .xm-wall-list .cover { position:relative; display:block; width:100%; padding-top:140%;
      overflow:hidden; border-radius:9px; background:var(--xm-bg-hover); box-shadow:0 2px 8px rgba(28,42,58,.10); }
  .xm-wall-list .cover img { position:absolute; top:0; left:0; width:100%; height:100%;
      object-fit:cover; display:block; transition:transform .25s ease; }
  .xm-wall-list .item > a:hover .cover img { transform:scale(1.025); }
  .xm-wall-list .video-title { margin-top:10px; font-size:15px; line-height:1.45;
      color:var(--xm-text); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
      overflow:hidden; word-break:break-all; }
  .xm-wall-list .video-title strong { color:var(--xm-danger); margin-right:4px; font-weight:600; }
  .xm-wall-list .meta { margin-top:5px; font-size:12.5px; color:var(--xm-muted); }
  .xm-wall-list .score { margin-top:4px; font-size:13px; color:var(--xm-amber); }
  .xm-wall-list .score .value { font-weight:600; }
  .xm-wall-list .item:hover .video-title { color:var(--xm-accent); }
  .xm-wall-names { display:block; margin-top:4px; font-size:12.5px; line-height:1.45;
      color:var(--xm-amber); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .xm-cover-bad::after { content:'图片加载失败'; position:absolute; left:0; right:0;
      top:50%; transform:translateY(-50%); text-align:center; font-size:11px;
      color:var(--xm-faint); }
  .xm-cover-bad { background:var(--xm-bg-hover); }
  .xm-wall-noimg { display:block; width:100%; padding-top:142%; background:var(--xm-bg-hover); border-radius:4px; }
  .xm-wall-empty { padding:56px 24px; text-align:center; color:var(--xm-muted); font-size:14px; }
  /* 分页器 */
  .xm-pager { display:flex; align-items:center; gap:6px; margin-left:auto; }
  .xm-pg { padding:3px 10px; border:1px solid var(--xm-border); border-radius:6px; background:var(--xm-bg);
      color:var(--xm-muted); font-size:12px; cursor:pointer; line-height:1.5; }
  .xm-pg:hover:not(:disabled) { border-color:var(--xm-accent); color:var(--xm-accent); }
  .xm-pg:disabled { opacity:.38; cursor:default; }
  .xm-pg-mid { font-size:12px; color:var(--xm-muted); white-space:nowrap; }
  .xm-pg-mid input { width:48px; padding:2px 4px; border:1px solid var(--xm-border); border-radius:4px;
      text-align:center; font-size:12px; color:var(--xm-text); }
  .xm-pg-mid input:focus { outline:none; border-color:var(--xm-accent); }
  .xm-pg-info { font-size:11.5px; color:var(--xm-faint); white-space:nowrap; }

  /* 导航栏按钮的激活态 */
  #xmWallBtn.on { background:var(--xm-accent); border-color:var(--xm-accent); color:var(--xm-on-accent); }
  #xflt-clear { margin-left:6px; padding:1px 8px; border:1px solid var(--xm-border); border-radius:10px;
      background:var(--xm-bg); color:var(--xm-muted); font-size:11px; cursor:pointer; }
  #xflt-clear:hover { border-color:var(--xm-danger); color:var(--xm-danger); }

  .xm-score { display:block; margin-top:2px; font-size:11px; line-height:1.2;
              font-weight:400; color:var(--xm-amber); white-space:nowrap; }

  /* ---- 资料库（自包含） ---- */
  /* JHS 详情层使用约 999999991；本脚本的图库与资料库必须低于它。 */
  .xm-mask { position:fixed; top:0; right:0; bottom:0; left:0; background:rgba(15,20,30,.45); z-index:var(--xm-z-mask); }
  .xm-modal { position:fixed; left:50%; top:50%; transform:translate(-50%,-50%);
      width:94vw; max-width:1680px; height:90vh; z-index:var(--xm-z-modal);
      display:flex; flex-direction:column; background:var(--xm-bg); border:1px solid rgba(214,222,232,.9); border-radius:var(--xm-r-lg);
      box-shadow:0 18px 60px rgba(23,37,52,.24); overflow:hidden;
      font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
      color:var(--xm-text); }
  #xm-modal { width:96vw; max-width:1840px; height:92vh; }
  .xm-wall-modal { width:96vw; max-width:1920px; height:94vh; border-radius:var(--xm-r-lg); }
  .xm-hd { flex:0 0 auto; display:flex; align-items:center; gap:12px;
      min-height:58px; box-sizing:border-box; padding:12px 20px; border-bottom:1px solid var(--xm-border);
      background:linear-gradient(180deg,var(--xm-bg) 0%,var(--xm-bg-subtle) 100%); }
  .xm-hd-title { font-size:16px; font-weight:650; letter-spacing:.01em; }
  .xm-hd-count { font-size:12.5px; color:var(--xm-muted); }
  .xm-hd-search { margin-left:auto; width:250px; padding:5px 10px; border:1px solid var(--xm-border);
      border-radius:6px; background:var(--xm-bg-hover); font-size:13px; color:var(--xm-text); }
  .xm-close { flex:0 0 auto; width:28px; height:28px; border:none; border-radius:6px;
      background:var(--xm-bg-hover); color:var(--xm-muted); font-size:18px; line-height:1; cursor:pointer; }
  .xm-close:hover { background:var(--xm-bg-hover); }
  .xm-bd { flex:1 1 auto; min-height:0; overflow:auto; background:var(--xm-bg); }
  .xm-tb { width:100%; min-width:1240px; border-collapse:collapse; font-size:13px; }
  .xm-tb thead th { position:sticky; top:0; z-index:1; background:var(--xm-bg-subtle);
      padding:10px 11px; text-align:left; font-weight:600; font-size:12px;
      color:var(--xm-muted); border-bottom:1px solid var(--xm-border); white-space:nowrap;
      cursor:pointer; user-select:none; }
  .xm-tb thead th.xm-nosort { cursor:default; }
  .xm-tb thead th .xm-arrow { color:var(--xm-accent); margin-left:3px; font-size:10px; }
  .xm-tb tbody td { padding:8px 11px; border-bottom:1px solid var(--xm-border);
      vertical-align:middle; max-width:320px; overflow:hidden; text-overflow:ellipsis; }
  .xm-tb tbody tr:nth-child(even) { background:var(--xm-bg-subtle); }
  .xm-tb tbody tr:hover { background:var(--xm-bg-hover); }
  .xm-thumb { width:36px; height:51px; object-fit:cover; border-radius:3px; display:block; }
  .xm-link { color:var(--xm-text); text-decoration:none; font-weight:600; }
  .xm-link b { color:var(--xm-danger); }
  .xm-link:hover { text-decoration:underline; }
  .xm-badge { display:inline-block; padding:1px 7px; border-radius:10px;
      background:var(--xm-amber-bg); color:var(--xm-amber); font-size:12px; white-space:nowrap; }
  .xm-muted { color:var(--xm-faint); }
  .xm-edit { cursor:text; }
  .xm-edit:hover { box-shadow:inset 0 0 0 1px var(--xm-border); }
  .xm-input { width:100%; box-sizing:border-box; padding:3px 6px; font-size:13px;
      border:1px solid var(--xm-accent); border-radius:4px; background:var(--xm-bg); color:var(--xm-text); }
  .xm-c-cover { width:52px; }
  .xm-c-chk { text-align:center; }
  .xm-chk { width:16px; height:16px; cursor:pointer; accent-color:var(--xm-accent); }
  .xm-ft { flex:0 0 auto; display:flex; align-items:center; justify-content:center;
      gap:12px; padding:12px 18px; border-top:1px solid var(--xm-border); background:var(--xm-bg-subtle); }
  .xm-ft button { padding:6px 16px; border:1px solid var(--xm-border); border-radius:8px;
      background:var(--xm-bg); color:var(--xm-text); font-size:13px; cursor:pointer; transition:all .16s ease; }
  .xm-ft button:hover:not(:disabled) { border-color:var(--xm-accent); color:var(--xm-accent-dark); background:var(--xm-bg-hover); }
  .xm-ft button:disabled { opacity:.45; cursor:default; }
  .xm-ft-page { font-size:12px; color:var(--xm-muted); }
  #xmBtn { cursor:pointer; }

  .xm-bf { margin-left:10px; padding:7px 14px; border:1px solid var(--xm-green); border-radius:8px;
      background:var(--xm-bg); color:var(--xm-green); font-size:12.5px; cursor:pointer; white-space:nowrap; transition:all .16s ease; }
  .xm-bf:hover { background:var(--xm-green-bg); transform:translateY(-1px); }
  .xm-bf.running { background:var(--xm-green); color:var(--xm-on-accent); border-color:var(--xm-green); }
  .xm-bf-info { font-size:12px; color:var(--xm-green); white-space:nowrap; }
  .xm-probe-btn { margin-left:8px; padding:7px 12px; border:1px solid var(--xm-border);
      border-radius:8px; background:var(--xm-bg); color:var(--xm-text); font-size:12px; cursor:pointer; white-space:nowrap; }
  .xm-probe-btn:hover { background:var(--xm-bg-hover); }
  .xm-probe-btn:disabled { opacity:.5; cursor:default; }
  /* 注：右下角悬浮按钮组（.xm-fab）已无任何创建代码，属死样式，本次删除；
     墙与资料库的入口统一走导航栏按钮（#xmWallBtn，带 .on 激活态）。 */
  @media (max-width: 680px) {
    .xm-wall-modal, #xm-modal { width:calc(100vw - 16px); height:calc(100vh - 20px); border-radius:12px; }
    .xm-wall-filters { padding:8px 12px 10px; max-height:34vh; }
    #xm-wall-bd { padding:0 12px; }
    .xm-hd { min-height:52px; gap:8px; padding:9px 12px; }
    .xm-hd-search { width:34vw; min-width:110px; }
    .xm-ft { gap:7px; padding:9px 10px; }
    .xm-ft button { padding:6px 10px; }

  }
  #xm-probe-mask { z-index:var(--xm-z-probe-mask); }
  #xm-probe { z-index:var(--xm-z-probe); width:720px; max-width:92vw; height:70vh; }
  #xm-probe-text { width:100%; height:100%; box-sizing:border-box; padding:10px;
      border:1px solid var(--xm-border); border-radius:6px; background:var(--xm-bg-subtle);
      font-family:ui-monospace,Consolas,monospace; font-size:12px; line-height:1.5;
      color:var(--xm-text); resize:none; }

  /* 列表页瀑布流 */
  .xm-wf { text-align:center; padding:18px 0 28px; font-size:13px; line-height:1.5;
      color:var(--xm-muted); cursor:pointer; user-select:none; }
  .xm-wf:hover { color:var(--xm-accent); }
  .xm-wf--loading { color:var(--xm-accent); }
  .xm-wf--nomore { color:var(--xm-faint); cursor:default; }
  .xm-wf--error { color:var(--xm-danger); }
  .xm-card-line { display:block; margin-top:2px; font-size:11px; line-height:1.4;
      color:var(--xm-amber); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .xm-tag { display:inline-block; padding:0 6px; margin:1px 3px 1px 0; border-radius:8px;
      background:var(--xm-bg-hover); color:var(--xm-muted); font-size:11px; white-space:nowrap; }
  .xm-c-dim { color:var(--xm-faint); font-size:12px; }

  /* ---- 本次新增：已选条件条 / 预设 / 折叠 / 密度 / 骨架屏 / 悬停信息 / 列隐藏 / 列选择器 / 焦点 / 暗色 ---- */

  /* 已选条件条（折叠后仍可见） */
  .xf-active { display:flex; align-items:center; gap:6px; flex-wrap:wrap;
      padding:0 0 6px; }
  .xf-active:empty { display:none; }
  .xf-active-label { flex:0 0 auto; font-size:12px; color:var(--xm-muted); }
  .xf-active-item { display:inline-flex; align-items:center; gap:4px;
      padding:1px 4px 1px 9px; border:1px solid var(--xm-border); border-radius:999px;
      background:var(--xm-accent-bg); color:var(--xm-text); font-size:11.5px; line-height:1.7; white-space:nowrap; }
  .xf-active-x { border:none; background:transparent; color:var(--xm-muted);
      font-size:13px; line-height:1; cursor:pointer; padding:0 2px; }
  .xf-active-x:hover { color:var(--xm-danger); }

  /* 预设行 */
  .xf-presets { display:flex; align-items:center; gap:6px; flex-wrap:wrap;
      margin-top:6px; padding-top:6px; border-top:1px dashed var(--xm-border); }
  .xf-presets:empty { display:none; }
  .xf-preset-label { flex:0 0 auto; font-size:12px; color:var(--xm-muted); }
  .xf-preset { display:inline-flex; align-items:center; gap:4px;
      padding:1px 4px 1px 9px; border:1px solid var(--xm-border); border-radius:999px;
      background:var(--xm-bg); color:var(--xm-text); font-size:11.5px; line-height:1.7; cursor:pointer; white-space:nowrap; }
  .xf-preset:hover { border-color:var(--xm-accent); color:var(--xm-accent); }
  .xf-preset-x { border:none; background:transparent; color:var(--xm-muted);
      font-size:13px; line-height:1; cursor:pointer; padding:0 2px; }
  .xf-preset-x:hover { color:var(--xm-danger); }
  .xf-preset-name { width:110px; padding:2px 8px; border:1px solid var(--xm-border);
      border-radius:6px; background:var(--xm-bg); color:var(--xm-text); font-size:11.5px; }
  .xf-preset-save { padding:2px 9px; border:1px solid var(--xm-border); border-radius:6px;
      background:var(--xm-bg); color:var(--xm-muted); font-size:11.5px; cursor:pointer; }
  .xf-preset-save:hover { border-color:var(--xm-accent); color:var(--xm-accent); }

  /* 维度内搜索 + 选项区滚动（演员/导演/系列） */
  .xf-search { flex:0 0 auto; width:150px; padding:2px 8px; border:1px solid var(--xm-border);
      border-radius:6px; background:var(--xm-bg); color:var(--xm-text); font-size:11.5px; }
  .xf-search:focus { outline:none; border-color:var(--xm-accent); }
  .xf-opts-scroll { max-height:220px; overflow-y:auto; padding-right:4px; }

  /* 维度数量角标（替代原来的小红点） */
  .xf-dim[data-n]::after { content:attr(data-n); margin-left:5px; padding:0 5px;
      border-radius:999px; background:var(--xm-danger); color:var(--xm-on-accent);
      font-size:10px; line-height:1.5; }

  /* 筛选折叠：只隐藏选项区，已选条仍可见 */
  .xm-wall-modal.xm-wall-collapsed #xflt-panel { display:none; }
  .xm-wall-toggle { flex:0 0 auto; padding:7px 12px; border:1px solid var(--xm-border);
      border-radius:8px; background:var(--xm-bg); color:var(--xm-muted); font-size:13px; cursor:pointer; }
  .xm-wall-toggle:hover { border-color:var(--xm-accent); color:var(--xm-accent); }
  .xm-wall-density { flex:0 0 auto; padding:7px 12px; border:1px solid var(--xm-border);
      border-radius:8px; background:var(--xm-bg); color:var(--xm-muted); font-size:13px; cursor:pointer; }
  .xm-wall-density:hover { border-color:var(--xm-accent); color:var(--xm-accent); }
  .xm-wall-density.on { border-color:var(--xm-accent); color:var(--xm-accent); background:var(--xm-accent-bg); }

  /* 图墙紧凑密度：6 列 + 更小字号 */
  .xm-wall-compact .xm-wall-list { grid-template-columns:repeat(6, minmax(0, 1fr)); gap:16px 14px; }
  @media (max-width: 1500px) { .xm-wall-compact .xm-wall-list { grid-template-columns:repeat(5, minmax(0, 1fr)); } }
  @media (max-width: 1050px) { .xm-wall-compact .xm-wall-list { grid-template-columns:repeat(4, minmax(0, 1fr)); } }
  @media (max-width: 680px)  { .xm-wall-compact .xm-wall-list { grid-template-columns:repeat(3, minmax(0, 1fr)); gap:12px 10px; } }
  .xm-wall-compact .xm-wall-list .video-title { font-size:13.5px; }
  .xm-wall-compact .xm-wall-list .meta { font-size:11.5px; }

  /* 封面骨架屏 + 悬停信息层 */
  .xm-wall-list .cover.xm-loading::after { content:''; position:absolute; inset:0;
      background:linear-gradient(100deg, transparent 30%, rgba(255,255,255,.55) 50%, transparent 70%);
      background-size:200% 100%; animation:xm-shimmer 1.2s infinite linear; }
  @keyframes xm-shimmer { from { background-position:200% 0; } to { background-position:-200% 0; } }
  .xm-cover-info { position:absolute; left:0; right:0; bottom:0; padding:14px 10px 6px;
      background:linear-gradient(180deg, transparent, rgba(0,0,0,.62));
      color:#fff; font-size:12px; line-height:1.4; opacity:0; transition:opacity .18s ease;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .xm-wall-list .item > a:hover .xm-cover-info { opacity:1; }

  /* 资料库：冻结首列 */
  .xm-tb th:first-child, .xm-tb td:first-child { position:sticky; left:0; z-index:2;
      background:var(--xm-bg); }
  .xm-tb thead th:first-child { z-index:3; }
  .xm-tb tbody tr:nth-child(even) td:first-child { background:var(--xm-bg-subtle); }

  /* 资料库：列隐藏（列顺序与 LIB_COLS 一致：2 查询番号，3 名称，4 加入时间，5 演员，
     6 评分，7 发行，8 时长，9 导演，10 片商，11 系列，12 类别，13 分类，14 已看，15 备注，16 删除） */
  .xm-tb.xm-hide-lookupCarNum th:nth-child(2), .xm-tb.xm-hide-lookupCarNum td:nth-child(2) { display:none; }
  .xm-tb.xm-hide-title th:nth-child(3), .xm-tb.xm-hide-title td:nth-child(3) { display:none; }
  .xm-tb.xm-hide-createDate th:nth-child(4), .xm-tb.xm-hide-createDate td:nth-child(4) { display:none; }
  .xm-tb.xm-hide-names th:nth-child(5), .xm-tb.xm-hide-names td:nth-child(5) { display:none; }
  .xm-tb.xm-hide-score th:nth-child(6), .xm-tb.xm-hide-score td:nth-child(6) { display:none; }
  .xm-tb.xm-hide-publishTime th:nth-child(7), .xm-tb.xm-hide-publishTime td:nth-child(7) { display:none; }
  .xm-tb.xm-hide-duration th:nth-child(8), .xm-tb.xm-hide-duration td:nth-child(8) { display:none; }
  .xm-tb.xm-hide-director th:nth-child(9), .xm-tb.xm-hide-director td:nth-child(9) { display:none; }
  .xm-tb.xm-hide-maker th:nth-child(10), .xm-tb.xm-hide-maker td:nth-child(10) { display:none; }
  .xm-tb.xm-hide-series th:nth-child(11), .xm-tb.xm-hide-series td:nth-child(11) { display:none; }
  .xm-tb.xm-hide-tags th:nth-child(12), .xm-tb.xm-hide-tags td:nth-child(12) { display:none; }
  .xm-tb.xm-hide-stage th:nth-child(13), .xm-tb.xm-hide-stage td:nth-child(13) { display:none; }
  .xm-tb.xm-hide-watched th:nth-child(14), .xm-tb.xm-hide-watched td:nth-child(14) { display:none; }
  .xm-tb.xm-hide-remark th:nth-child(15), .xm-tb.xm-hide-remark td:nth-child(15) { display:none; }
  .xm-tb.xm-hide-delete th:nth-child(16), .xm-tb.xm-hide-delete td:nth-child(16) { display:none; }

  /* 资料库：列选择器 */
  .xm-col-picker { position:absolute; top:58px; right:12px; z-index:10;
      width:220px; max-height:60vh; overflow-y:auto; padding:8px 10px;
      border:1px solid var(--xm-border); border-radius:10px; background:var(--xm-bg);
      box-shadow:0 10px 30px rgba(23,37,52,.22); }
  .xm-col-picker label { display:flex; align-items:center; gap:8px; padding:4px 2px;
      font-size:12.5px; color:var(--xm-text); cursor:pointer; white-space:nowrap; }
  .xm-col-picker input { accent-color:var(--xm-accent); }
  .xm-col-picker label.xm-col-locked { color:var(--xm-faint); cursor:default; }

  /* 资料库：紧凑密度 */
  .xm-modal.xm-dense .xm-tb { font-size:12px; }
  .xm-modal.xm-dense .xm-tb tbody td { padding:4px 8px; }
  .xm-modal.xm-dense .xm-tb thead th { padding:6px 8px; }
  .xm-modal.xm-dense .xm-thumb { width:30px; height:43px; }
  .xm-density-btn.on { border-color:var(--xm-accent); color:var(--xm-accent); background:var(--xm-accent-bg); }

  /* 键盘焦点可见性（按钮类元素；维度/选项是 span，点击为主，故不设 tabindex） */
  .xm-stage-btn:focus-visible, .xm-pg:focus-visible, .xm-close:focus-visible,
  .xm-wall-close:focus-visible, .xm-wall-toggle:focus-visible, .xm-wall-density:focus-visible,
  .xm-ft button:focus-visible, .xm-delete-btn:focus-visible, .xm-probe-btn:focus-visible,
  .xm-bf:focus-visible, #xflt-clear:focus-visible { outline:2px solid var(--xm-accent); outline-offset:1px; }

  /* 暗色模式：只重定义令牌，其余规则自动跟随 */
  @media (prefers-color-scheme: dark) {
    .xm-modal, .xm-mask, #xm-probe, #xm-probe-mask {
      --xm-bg:#171c23; --xm-bg-subtle:#1e242e; --xm-bg-hover:#252e3a;
      --xm-text:#e6eaf0; --xm-muted:#9aa7b5; --xm-faint:#6b7889;
      --xm-border:#2a3340; --xm-accent:#6aa3d8; --xm-accent-dark:#4a7fb5;
      --xm-accent-bg:#1d2a3a; --xm-danger:#e0685f; --xm-danger-border:#5a2a28;
      --xm-danger-bg:#2e1c1b; --xm-green:#3aa17f; --xm-green-bg:#14352b;
      --xm-amber:#d9a441; --xm-amber-bg:#33270f;
      --xm-shadow:0 18px 60px rgba(0,0,0,.5);
    }
    .xm-wall-list .cover.xm-loading::after { background:linear-gradient(100deg, transparent 30%, rgba(255,255,255,.12) 50%, transparent 70%); background-size:200% 100%; }
  }

  /* 资料库：未补齐筛选按钮与原因角标 */
  #xm-unfilled-btn.on { border-color:var(--xm-accent); color:var(--xm-accent); background:var(--xm-accent-bg); }
  .xm-uf-tag { display:inline-block; margin-left:6px; padding:0 6px; border-radius:999px;
      background:var(--xm-bg-hover); color:var(--xm-muted); font-size:11px; line-height:1.6;
      white-space:nowrap; vertical-align:middle; }
  .xm-uf-tag.xm-uf-fail { background:var(--xm-danger-bg); color:var(--xm-danger); }
  `;

  function ensureStyle() {
    if (document.getElementById('xm-style')) return;
    const s = document.createElement('style');
    s.id = 'xm-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* ==================== 3. 只读数据提取 ==================== */

  function flagsOf(el) {
    try { return JSON.parse(el.getAttribute('data-jhs-flags') || '{}'); }
    catch (e) { return {}; }
  }

  function carNumOf(el) {
    const strong = el.querySelector('.video-title strong');
    if (strong && strong.textContent.trim()) return strong.textContent.trim().toUpperCase();
    const dates = el.querySelectorAll('date');
    for (let i = 0; i < dates.length; i++) {
      const v = (dates[i].textContent || '').trim();
      if (v && !/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(v)) return v.toUpperCase();
    }
    return '';
  }

  function stageButtonsHtml(stage, car, className) {
    return '<div class="' + className + '" data-car="' + esc(car) + '" aria-label="影片分类">' +
      STAGES.map(function (s) {
        return '<button type="button" class="xm-stage-btn' + (stage === s.v ? ' on' : '') +
          '" data-stage="' + s.v + '" title="标记为' + s.t + '" aria-pressed="' +
          (stage === s.v ? 'true' : 'false') + '">' + s.t + '</button>';
      }).join('') + '</div>';
  }

  function explicitCardStage(meta, favorite) {
    const value = meta && meta.stage;
    if (stageMeansWatched(value)) return 'list-watched';
    if (value === 'discarded' || value === 'jellyfin') return value;
    if (meta && meta.homeWatched) return 'list-watched';
    if (value === 'normal' || value === 'prized' || STAGE_VALUES.has(value)) {
      return normalizeStage(value, favorite);
    }
    return favorite ? 'pending' : '';
  }

  function homeStageButtonsHtml(stage, car, className) {
    const options = [
      { v: 'pending', t: '待鉴定' },
      { v: 'list-watched', t: '已看' },
      { v: 'discarded', t: '淘汰' },
      { v: 'jellyfin', t: 'Jellyfin' }
    ];
    return '<div class="' + className + '" data-car="' + esc(car) + '" aria-label="首页影片标签">' +
      options.map(function (item) {
        return '<button type="button" class="xm-stage-btn' + (stage === item.v ? ' on' : '') +
          '" data-stage="' + item.v + '" title="标记为' + item.t + '" aria-pressed="' +
          (stage === item.v ? 'true' : 'false') + '">' + item.t + '</button>';
      }).join('') + '</div>';
  }

  async function decorateListStageControls() {
    const items = document.querySelectorAll(ITEM_SEL);
    if (!items.length) return;
    const mem = await XMeta.loadAll();
    const normalizedMeta = new Map();
    mem.forEach(function (value, key) {
      const normalized = normalizeCarKey(key);
      if (normalized && !normalizedMeta.has(normalized)) normalizedMeta.set(normalized, value);
    });
    items.forEach(function (item) {
      const car = carNumOf(item);
      if (!car) return;
      let controls = item.querySelector('.xm-list-stage-controls');
      const meta = mem.get(car) || normalizedMeta.get(normalizeCarKey(car)) || {};
      const cardFlags = flagsOf(item);
      const stage = explicitCardStage(Object.assign({}, meta, { homeWatched: !!cardFlags.watched }), !!cardFlags.favorite);
      if (controls) {
        controls.setAttribute('data-car', car);
        controls.querySelectorAll('.xm-stage-btn').forEach(function (button) {
          const active = button.getAttribute('data-stage') === stage;
          button.classList.toggle('on', active);
          button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        return;
      }
      let host = item.querySelector('.meta');
      if (!host) {
        host = document.createElement('div');
        host.className = 'meta';
        item.appendChild(host);
      }
      host.classList.add('xm-meta-with-stage');
      const date = document.createElement('span');
      date.className = 'xm-meta-date';
      while (host.firstChild) date.appendChild(host.firstChild);
      host.appendChild(date);
      const wrapper = document.createElement('div');
      wrapper.innerHTML = homeStageButtonsHtml(stage, car, 'xm-list-stage-controls');
      host.appendChild(wrapper.firstElementChild);
    });
  }

  async function handleListStageClick(ev) {
    const button = ev.target && ev.target.closest ? ev.target.closest('.xm-list-stage-controls .xm-stage-btn') : null;
    if (!button) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
    if (ev.type !== 'click' || ev.button !== 0) return;
    const controls = button.closest('.xm-list-stage-controls');
    const card = button.closest('.item');
    const car = (controls && controls.getAttribute('data-car')) || (card && carNumOf(card));
    if (!car) return;
    const buttons = controls ? controls.querySelectorAll('.xm-stage-btn') : [button];
    buttons.forEach(function (item) { item.disabled = true; });
    try {
      let row = await ensureMovieRecord(car, cardRecordSeed(card));
      let fillNote = '';
      try {
        if (bfNeed(row)) await refillOneByRow(row);
      } catch (fillError) {
        fillNote = '（影片已入库，DB资料暂未补齐：' + (fillError && fillError.message ? fillError.message : fillError) + '）';
      }
      const chosen = button.getAttribute('data-stage');
      if (chosen === 'list-watched') {
        const old = findRecordByCar(row.carNum) || row;
        const wasWatched = !!old.watched;
        await patchRecord(row.carNum, { watched: !wasWatched }, null);
        const current = Object.assign({}, old, { watched: !wasWatched });
        await mirrorCarFlags(row.carNum, current);
        await XMeta.saveMany([[row.carNum, {
          carNum: row.carNum,
          homeWatched: !wasWatched,
          homeWatchedUpdatedAt: Date.now()
        }]]);
        row.watched = !wasWatched;
        row.homeWatched = !wasWatched;
      } else {
        await setMovieStage(row.carNum, chosen);
        const shouldBeWatched = chosen === 'jellyfin';
        await patchRecord(row.carNum, { watched: shouldBeWatched }, null);
        await mirrorCarFlags(row.carNum, Object.assign({}, row, { watched: shouldBeWatched }));
        await XMeta.saveMany([[row.carNum, { carNum: row.carNum, homeWatched: shouldBeWatched }]]);
        row.watched = shouldBeWatched;
        row.homeWatched = shouldBeWatched;
      }
      await reloadRows();
      const currentRow = findRecordByCar(row.carNum);
      const currentMeta = await XMeta.loadAll();
      const currentCard = card && flagsOf(card);
      if (currentCard) currentCard.watched = !!(currentRow && currentRow.watched);
      if (card && currentCard) card.setAttribute('data-jhs-flags', JSON.stringify(currentCard));
      const current = currentRow
        ? explicitCardStage(Object.assign({}, currentMeta.get(row.carNum) || {}, { homeWatched: !!currentRow.watched }), currentRow.favorite)
        : chosen;
      buttons.forEach(function (item) {
        const active = item.getAttribute('data-stage') === current;
        item.classList.toggle('on', active);
        item.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      const stageLabel = ({ 'list-watched': '已看', pending: '待鉴定', discarded: '淘汰', jellyfin: 'Jellyfin' })[current] || current;
      toast('已补入资料库并标记为“' + stageLabel + '”' + fillNote);
    } catch (err) {
      toast('分类写入失败：' + (err && err.message ? err.message : err), true);
    } finally {
      buttons.forEach(function (item) { item.disabled = false; });
    }
  }

  function cardRecordSeed(item) {
    if (!item) return {};
    const link = item.matches && item.matches('a[href]') ? item : item.querySelector('a[href]');
    const date = dateOf(item);
    return {
      url: link ? link.href : '',
      publishTime: date ? fmtDate(date) : ''
    };
  }

  async function ensureMovieRecord(carNum, seed) {
    const normalized = normalizeCarKey(carNum);
    let row = LIB.rows.find(function (x) { return normalizeCarKey(x.carNum) === normalized; });
    if (row) return row;
    seed = seed || {};
    if (!seed.url) throw new Error('卡片没有影片链接，无法加入资料库');
    const car = String(carNum || '').trim().toUpperCase();
    await patchRecord(car, { favorite: false }, {
      url: seed.url,
      publishTime: seed.publishTime || ''
    });
    LIB.rows = await loadRows();
    row = LIB.rows.find(function (x) { return normalizeCarKey(x.carNum) === normalized; });
    if (!row) throw new Error('JHS 未能建立影片记录');
    if (LIB.open) { libFilter(); libSort(); libRender(); }
    return row;
  }

  function titleOf(el) {
    const a = el.querySelector('a[title]');
    if (a && a.getAttribute('title')) return a.getAttribute('title').trim();
    const t = el.querySelector('.video-title');
    return t ? t.textContent.trim() : '';
  }

  function dateOf(el) {
    const meta = el.querySelector('.meta');
    if (meta) {
      const m = meta.textContent.trim().match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
      if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    }
    const dates = el.querySelectorAll('date');
    for (let i = 0; i < dates.length; i++) {
      const m = (dates[i].textContent || '').trim().match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
      if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    }
    return null;
  }

  function scoreOf(el) {
    const node = el.querySelector('.score .value, .score');
    const txt = node ? node.textContent.replace(/,/g, '').trim() : '';
    const score = parseFloat(txt) || 0;
    let votes = 0;
    const m = txt.match(/(?:由\s*)?(\d+)\s*人/);
    if (m) votes = parseInt(m[1], 10);
    else {
      const c = el.querySelector('.score .count, .meta .count');
      if (c) votes = parseInt((c.textContent || '').replace(/[^\d]/g, ''), 10) || 0;
    }
    return { score: score, votes: votes };
  }

  function coverOf(el) {
    const img = el.querySelector('.cover img, .photo-frame img, img');
    if (!img) return '';
    const src = ['data-original', 'data-src', 'data-lazy-src', 'src']
      .map(function (name) { return (img.getAttribute(name) || '').trim(); })
      .find(function (value) { return value && value.indexOf('data:') !== 0; }) || '';
    if (!src || src.indexOf('data:') === 0) return '';
    try { return new URL(src, location.href).href; }
    catch (e) { return src; }
  }

  function fmtDate(d) {
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ==================== 4. 判定（作用于数据行） ==================== */

  let xmem = null;           // 影子库映射 carNum -> meta
  let memLoading = false;

  function ensureMem() {
    if (xmem || memLoading) return;
    memLoading = true;
    XMeta.loadAll()
      .then(function (m) { xmem = m; })
      .catch(function () { xmem = new Map(); })
      .then(function () { memLoading = false; apply(); });
  }

  function metaOf(car) {
    if (!xmem || !car) return null;
    return xmem.get(car) || null;
  }

  function splitList(s) {
    return String(s || '').split(/[,，\s]+/)
      .map(x => x.trim().toUpperCase()).filter(Boolean);
  }

  // 人名/系列名里常有空格，不能按空格切
  function splitByComma(s) {
    return String(s || '').split(/[,，、]+/)
      .map(x => x.trim().toUpperCase()).filter(Boolean);
  }

  function stageOf(row) {
    return normalizeStage(row && row.stage, row && row.favorite);
  }

  function normalizeStage(value, favorite) {
    if (value === 'normal') return 'score4';
    if (value === 'prized') return 'score5';
    return STAGE_VALUES.has(value) ? value : (favorite ? 'pending' : 'score4');
  }

  function stageMeansWatched(stage) {
    return stage === 'score3' || stage === 'score4' || stage === 'score5' ||
      stage === 'normal' || stage === 'prized' || stage === 'jellyfin';
  }

  function stateOk(row, want) {
    if (!want) return true;
    return STAGE_VALUES.has(want) ? stageOf(row) === want : true;
  }

  // 原列表卡片的评分（排序用）
  function statOf(el, m) {
    const s = scoreOf(el);
    return {
      score: (m && m.score) || s.score || 0,
      votes: (m && m.votes) || s.votes || 0
    };
  }

  function metaText(m, field) {
    if (!m) return '';
    if (field === 'actor') {
      const arr = Array.isArray(m.actors) ? m.actors : [];
      return (arr.join(' ') + ' ' + (m.names || '')).trim().toUpperCase();
    }
    return String(m[field] || '').trim().toUpperCase();
  }

  let total = 0, kept = 0, noData = 0;

  /**
   * 判断一条记录是否符合当前条件。
   * 入参是 loadRows() 产出的行对象，不再依赖页面 DOM —— 这样才能查全库。
   */
  function matchRow(r) {
    if (!stateOk(r, cond.state)) return false;

    // 番号：包含匹配（不是前缀）—— 只打 123 也能命中 ABCD-123
    const inc = splitList(cond.prefix);
    const exc = splitList(cond.exPrefix);
    if (inc.length || exc.length) {
      const car = String(r.carNum || '').toUpperCase();
      if (inc.length && !inc.some(function (t) { return car.indexOf(t) !== -1; })) return false;
      if (exc.length && exc.some(function (t) { return car.indexOf(t) !== -1; })) return false;
    }

    const kw = splitList(cond.kw);
    const exKw = splitList(cond.exKw);
    if (kw.length || exKw.length) {
      const title = String(r.title || '').toUpperCase();
      if (kw.length && !kw.some(k => title.indexOf(k) !== -1)) return false;
      if (exKw.length && exKw.some(k => title.indexOf(k) !== -1)) return false;
    }

    // 演员 / 导演 / 系列：缺数据时跳过（无法判断，不计入结果）
    const wantMeta = META_FIELDS.filter(f => String(cond[f] || '').trim());
    for (const f of wantMeta) {
      const words = splitByComma(cond[f]);
      const hay = String(f === 'actor' ? (r.names || '') : (r[f] || '')).toUpperCase();
      if (!hay) { noData++; return false; }
      if (!words.some(w => hay.indexOf(w) !== -1)) return false;
    }

    return true;
  }

  /* ==================== 5. 图墙（查全库，渲染在原生列表上方） ==================== */

  const WALL = {
    el: null,
    rows: [],
    page: 1,
    pageSize: 100,
    loading: false
  };

  function ensureRows() {
    if (LIB.rows.length) return true;
    if (WALL.loading) return false;
    if (!UW.storageManager || typeof UW.storageManager.getCarList !== 'function') return false;

    WALL.loading = true;
    loadRows()
      .then(function (r) {
        LIB.rows = r;
        WALL.loading = false;
        apply();
      })
      .catch(function (e) {
        WALL.loading = false;
        console.warn('[JHS+] 读取记录失败', e && e.message ? e.message : e);
      });
    return false;
  }

  // 重新读一遍记录（补齐数据后要让图墙看到新字段）
  async function reloadRows() {
    try {
      LIB.rows = await loadRows();
    } catch (e) {
      console.warn('[JHS+] 重新读取记录失败', e && e.message ? e.message : e);
      return;
    }
    apply();
    // 资料库开着的话顺手刷新，否则表格还停在旧数据上；
    // 必须恢复当前排序，否则改番号 / 单条补齐后表格会跳回默认顺序
    if (LIB.open) {
      libFilter();
      libSort();
      libRender();
    }
  }

  function wallSort(list) {
    const mode = cond.sort || 'default';
    if (mode === 'default') return list;

    const desc = /Desc$/.test(mode);
    const arr = list.slice();
    arr.sort(function (a, b) {
      let x, y;
      if (mode === 'scoreDesc' || mode === 'scoreAsc') { x = a.score || 0; y = b.score || 0; }
      else if (mode === 'votesDesc') { x = a.votes || 0; y = b.votes || 0; }
      else if (mode === 'addedDesc' || mode === 'addedAsc') {
        x = a.createDate || ''; y = b.createDate || '';
      } else { x = a.publishTime || ''; y = b.publishTime || ''; }
      if (x === y) return 0;
      return desc ? (x < y ? 1 : -1) : (x > y ? 1 : -1);
    });
    return arr;
  }

  function apply() {
    ensureMem();
    if (!ensureRows()) return;

    const list = [];
    total = LIB.rows.length;
    noData = 0;
    for (let i = 0; i < LIB.rows.length; i++) {
      if (matchRow(LIB.rows[i])) list.push(LIB.rows[i]);
    }
    kept = list.length;

    WALL.rows = wallSort(list);
    WALL.page = 1;
    wallRender();
    updateSummary();
  }

  function wallCardHtml(r) {
    const title = r.title || '';
    const href = r.url || ('https://javdb.com/search?q=' + encodeURIComponent(r.lookupCarNum || r.carNum) + '&f=all');
    const score = r.score
      ? '<div class="score"><span class="value">' + Number(r.score).toFixed(2) + '分' +
        (r.votes ? ', 由' + r.votes + '人評價' : '') + '</span></div>'
      : '';

    const stage = explicitCardStage({ stage: r.stage, homeWatched: !!r.watched }, r.favorite);
    const stageTags = '<div class="xm-stage-tags" aria-label="影片分类">' + STAGES.map(function (s) {
      return '<button type="button" class="xm-stage-btn' + (stage === s.v ? ' on' : '') +
        '" data-stage="' + s.v + '" title="标记为' + s.t + '" aria-pressed="' +
        (stage === s.v ? 'true' : 'false') + '">' + s.t + '</button>';
    }).join('') + '</div>';

    // 悬停信息层：评分 + 发行日期（封面上有图时才显示）
    const coverInfo = (r.score || r.publishTime)
      ? '<div class="xm-cover-info">' +
        (r.score ? Number(r.score).toFixed(2) + '分' + (r.votes ? ' · ' + r.votes + '人' : '') : '') +
        (r.score && r.publishTime ? ' · ' : '') +
        esc(r.publishTime || '') + '</div>'
      : '';

    return '<div class="item">' +
      '<a href="' + esc(href) + '" data-car="' + esc(r.carNum) +
        '" title="' + esc(title) + '">' +
        '<div class="cover' + (r.cover ? ' xm-loading' : '') + '">' + (r.cover
          ? '<img loading="lazy" data-car="' + esc(r.carNum) + '" src="' + esc(r.cover) + '">' + coverInfo
          : '<div class="xm-wall-noimg">无封面</div>') + '</div>' +
        '<div class="video-title"><strong>' + esc(r.carNum) + '</strong>' + esc(title) + '</div>' +
        '<div class="meta">' + esc(r.publishTime || '') + '</div>' +
        score +
        (r.names ? '<div class="xm-wall-names">' + esc(r.names) + '</div>' : '') +
      '</a>' + stageTags +
    '</div>';
  }

  function wallListEl() {
    return document.getElementById('xm-wall-list');
  }

  function wallInfo() {
    const box = document.getElementById('xm-wall-info');
    if (!box) return;
    if (!WALL.rows.length) {
      box.textContent = total ? '没有匹配的影片' : '读取中…';
      return;
    }
    box.textContent = '共 ' + WALL.rows.length + ' 条';
  }

  function wallPages() {
    return Math.max(1, Math.ceil(WALL.rows.length / WALL.pageSize));
  }

  // 底部分页器：首页 / 上一页 / 页码跳转 / 下一页 / 末页
  function wallPager() {
    const box = document.getElementById('xm-wall-pager');
    if (!box) return;

    if (!WALL.rows.length) { box.innerHTML = ''; return; }

    const pages = wallPages();
    if (WALL.page > pages) WALL.page = pages;
    if (WALL.page < 1) WALL.page = 1;

    box.innerHTML =
      '<button class="xm-pg" data-pg="first" type="button"' +
        (WALL.page <= 1 ? ' disabled' : '') + '>首页</button>' +
      '<button class="xm-pg" data-pg="prev" type="button"' +
        (WALL.page <= 1 ? ' disabled' : '') + '>上一页</button>' +
      '<span class="xm-pg-mid">第 <input id="xm-pg-in" type="text" value="' +
        WALL.page + '" inputmode="numeric"> / ' + pages + ' 页</span>' +
      '<button class="xm-pg" data-pg="next" type="button"' +
        (WALL.page >= pages ? ' disabled' : '') + '>下一页</button>' +
      '<button class="xm-pg" data-pg="last" type="button"' +
        (WALL.page >= pages ? ' disabled' : '') + '>末页</button>' +
      '<span class="xm-pg-info">每页 ' + WALL.pageSize + ' 条</span>';
  }

  function wallGo(page) {
    const pages = wallPages();
    page = Math.min(Math.max(1, page | 0), pages);
    if (page === WALL.page) return;
    WALL.page = page;
    wallRender();
    const bd = document.getElementById('xm-wall-bd');
    if (bd) bd.scrollTop = 0;
  }

  function wallRender() {
    const box = wallListEl();
    if (!box) return;

    if (!WALL.rows.length) {
      box.innerHTML = '<div class="xm-wall-empty">没有符合条件的影片' +
        (noData ? '（另有 ' + noData + ' 条缺演员/导演数据被跳过）' : '') + '</div>';
      wallInfo();
      wallPager();
      return;
    }

    const start = (WALL.page - 1) * WALL.pageSize;
    const part = WALL.rows.slice(start, start + WALL.pageSize);
    box.innerHTML = part.map(wallCardHtml).join('');
    // 封面载入后去掉骨架屏（懒加载图片逐张处理）
    box.querySelectorAll('.cover img').forEach(function (img) {
      const done = function () {
        const c = img.parentNode;
        if (c && c.classList) c.classList.remove('xm-loading');
      };
      if (img.complete && img.naturalWidth) done();
      else {
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
      }
    });
    wallInfo();
    wallPager();
  }

  /* ---- 影片预览框：点卡片弹出，不跳转 ---- */

  // 兼容旧缓存：此前把 thumbs 路径统一改成 covers，部分影片会因此 404。
  function onCoverError(ev) {
    const img = ev.target;
    if (!img || img.tagName !== 'IMG') return;
    if (!img.dataset.xmCoverRetry) {
      const src = img.currentSrc || img.src || '';
      const alternate = src.indexOf('/covers/') !== -1
        ? src.replace('/covers/', '/thumbs/')
        : (src.indexOf('/thumbs/') !== -1 ? src.replace('/thumbs/', '/covers/') : '');
      if (alternate && alternate !== src) {
        img.dataset.xmCoverRetry = '1';
        img.src = alternate;
        return;
      }
    }
    const box = img.parentNode;
    if (!box || !box.classList) return;
    img.style.display = 'none';
    box.classList.add('xm-cover-bad');
    box.classList.remove('xm-loading');
  }

  function findRecordByCar(car) {
    const key = String(car || '').trim().toUpperCase();
    if (!key) return null;
    const rows = Array.isArray(LIB.rows) ? LIB.rows : [];
    return rows.find(function (row) {
      return String(row && row.carNum || '').trim().toUpperCase() === key;
    }) || null;
  }

  let activeJhsDetailLayer = null;

  function closeActiveJhsDetailLayer() {
    if (activeJhsDetailLayer && activeJhsDetailLayer.isConnected) {
      const close = activeJhsDetailLayer.querySelector('.layui-layer-close');
      if (close) close.click();
    }
    activeJhsDetailLayer = null;
  }

  async function openJhsDetailByCar(car) {
    const row = findRecordByCar(car);
    if (!row) {
      console.warn('[JHS+] 找不到影片记录：', car);
      return;
    }
    let target;
    try {
      target = await resolveDetailUrl(row);
    } catch (e) {
      console.warn('[JHS+] DB 详情查找失败，暂时回退到原站链接', e);
      target = { url: row.dbUrl || row.url || '', db: isDbUrl(row.dbUrl || row.url) };
    }
    const detailUrl = String(target && target.url || row.dbUrl || row.url || '').trim();
    if (!detailUrl) {
      console.warn('[JHS+] 影片没有可用的详情页链接：', row.carNum);
      return;
    }

    if (target && target.db) {
      row.url = detailUrl;
      row.dbUrl = detailUrl;
      row.noDb = false;
      XMeta.saveMany([[row.carNum, {
        carNum: row.carNum, dbUrl: detailUrl, noDb: 0,
        dbUrlForLookup: row.lookupCarNum || row.carNum,
        dbLookupVersion: DB_LOOKUP_VERSION
      }]]).catch(function (e) {
        console.warn('[JHS+] 保存 DB 详情地址失败', e);
      });
    }

    // 跨源页面可能拒绝 iframe；转到目标站后由该站的 JHS 加载完整详情组件。
    let targetOrigin = '';
    try { targetOrigin = new URL(detailUrl, location.href).origin; } catch (e) { /* noop */ }
    if (targetOrigin && targetOrigin !== location.origin) {
      closeActiveJhsDetailLayer();
      window.location.assign(detailUrl);
      return;
    }

    // 与 JHS 原生影片卡片保持一致：通过其 openPage 打开完整详情页层，
    // JavDB URL 会由 JHS 附加 jhsCarNum，确保页面关联到正确的收藏记录。
    const jhsUtils = UW.utils || null;
    if (jhsUtils && typeof jhsUtils.openPage === 'function') {
      try {
        closeActiveJhsDetailLayer();
        const existingLayers = new Set(document.querySelectorAll('.layui-layer'));
        jhsUtils.openPage(detailUrl, row.carNum, true, { event: null, newTab: false });
        activeJhsDetailLayer = Array.from(document.querySelectorAll('.layui-layer'))
          .find(function (layer) { return !existingLayers.has(layer) && layer.querySelector('iframe'); }) || null;
        return;
      } catch (e) {
        console.warn('[JHS+] JHS 详情层打开失败，改为打开详情页', e);
      }
    }

    window.location.assign(detailUrl);
  }

  function wallIsOpen() {
    return !!document.getElementById('xm-wall-modal');
  }

  function onWallKey(e) {
    if (e.key !== 'Escape' && e.keyCode !== 27) return;
    closeWall();
  }

  function closeWall() {
    const m = document.getElementById('xm-wall-modal');
    const k = document.getElementById('xm-wall-mask');
    if (m && m.parentNode) m.parentNode.removeChild(m);
    if (k && k.parentNode) k.parentNode.removeChild(k);
    document.removeEventListener('keydown', onWallKey, true);
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
    const btn = document.getElementById('xmWallBtn');
    if (btn) btn.classList.remove('on');
  }

  function openWall() {
    if (wallIsOpen()) { closeWall(); return; }
    ensureStyle();

    // 图墙层级低于 JHS 的影片详情 iframe，打开详情后由 JHS 层覆盖图墙。
    const mask = document.createElement('div');
    mask.className = 'xm-mask';
    mask.id = 'xm-wall-mask';

    const modal = document.createElement('div');
    modal.className = 'xm-modal xm-wall-modal';
    modal.id = 'xm-wall-modal';
    modal.innerHTML =
      '<div class="xm-hd">' +
        '<span class="xm-hd-title">图墙</span>' +
        '<span class="xm-hd-count" id="xm-wall-info"></span>' +
        '<span class="xm-wall-tip">按 ESC 或点空白处也能关</span>' +
        '<button class="xm-wall-density" id="xm-wall-density" type="button">紧凑</button>' +
        '<button class="xm-wall-toggle" id="xflt-collapse" type="button">收起筛选</button>' +
        '<button class="xm-wall-close" id="xm-wall-close" type="button">关闭</button>' +
      '</div>' +
      '<div class="xm-wall-filters">' +
        '<div class="xf-active" id="xflt-active"></div>' +
        '<div id="xflt-panel"></div>' +
      '</div>' +
      '<div class="xm-bd" id="xm-wall-bd">' +
        '<div class="xm-wall-list" id="xm-wall-list"></div>' +
      '</div>' +
      '<div class="xm-ft" id="xm-wall-ft">' +
        '<span id="xflt-summary" class="xm-wall-sum"></span>' +
        '<div class="xm-pager" id="xm-wall-pager"></div>' +
        '<button id="xflt-clear" type="button">清除条件</button>' +
      '</div>';

    document.body.appendChild(mask);
    document.body.appendChild(modal);
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onWallKey, true);

    mask.addEventListener('click', closeWall);
    modal.querySelector('#xm-wall-close').addEventListener('click', closeWall);

    bindPanel(modal.querySelector('#xflt-panel'));

    modal.querySelector('#xflt-clear').addEventListener('click', function () {
      cond = Object.assign({}, DEFAULT_COND);
      XL.dim = '';
      saveCond();
      renderPanel();
      apply();
    });

    // 已选条件条：点 × 清掉对应条件（条在面板外，需单独绑定）
    modal.querySelector('#xflt-active').addEventListener('click', function (ev) {
      const x = ev.target.closest ? ev.target.closest('.xf-active-x') : null;
      if (!x) return;
      clearDim(x.getAttribute('data-k'));
    });

    // 筛选折叠：只收起选项区，已选条仍可见；小屏默认收起
    const collapseBtn = modal.querySelector('#xflt-collapse');
    const setCollapsed = function (c) {
      modal.classList.toggle('xm-wall-collapsed', c);
      collapseBtn.textContent = c ? '展开筛选' : '收起筛选';
    };
    collapseBtn.addEventListener('click', function () {
      setCollapsed(!modal.classList.contains('xm-wall-collapsed'));
    });
    if (window.innerWidth <= 680) setCollapsed(true);

    // 图墙密度（持久化）
    const densityBtn = modal.querySelector('#xm-wall-density');
    const setDensity = function (compact) {
      modal.classList.toggle('xm-wall-compact', compact);
      densityBtn.classList.toggle('on', compact);
      densityBtn.textContent = compact ? '标准' : '紧凑';
      try { localStorage.setItem('xm:walldensity:v1', compact ? 'compact' : ''); } catch (e) { /* ignore */ }
    };
    densityBtn.addEventListener('click', function () {
      setDensity(!modal.classList.contains('xm-wall-compact'));
    });
    try { setDensity(localStorage.getItem('xm:walldensity:v1') === 'compact'); } catch (e) { /* ignore */ }

    // 封面加载失败兜底
    modal.querySelector('#xm-wall-list').addEventListener('error', onCoverError, true);

    // 与 JHS 原生卡片相同，打开完整影片详情页。
    const openWallMovie = function (ev) {
      const stageBtn = ev.target.closest ? ev.target.closest('.xm-stage-btn') : null;
      if (stageBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.type !== 'click' || ev.button !== 0) return;
        const card = stageBtn.closest('.item');
        const link = card && card.querySelector('a[data-car]');
        if (!link) return;
        const car = link.getAttribute('data-car');
        stageBtn.disabled = true;
        setMovieStage(car, stageBtn.getAttribute('data-stage')).catch(function (e) {
          toast('分类写入失败：' + (e && e.message ? e.message : e), true);
        }).finally(function () { stageBtn.disabled = false; });
        return;
      }
      const a = ev.target.closest ? ev.target.closest('.item > a') : null;
      if (!a) return;
      if (ev.type === 'auxclick' && ev.button !== 1) return;
      if (ev.type === 'click' && ev.button !== 0) return;
      ev.preventDefault();
      openJhsDetailByCar(a.getAttribute('data-car'), ev);
    };
    modal.querySelector('#xm-wall-list').addEventListener('click', openWallMovie);
    modal.querySelector('#xm-wall-list').addEventListener('auxclick', openWallMovie);

    const pager = modal.querySelector('#xm-wall-pager');
    pager.addEventListener('click', function (ev) {
      const b = ev.target.closest ? ev.target.closest('.xm-pg') : null;
      if (!b) return;
      const act = b.getAttribute('data-pg');
      if (act === 'first') wallGo(1);
      else if (act === 'prev') wallGo(WALL.page - 1);
      else if (act === 'next') wallGo(WALL.page + 1);
      else if (act === 'last') wallGo(wallPages());
    });
    pager.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      if (!ev.target || ev.target.id !== 'xm-pg-in') return;
      wallGo(parseInt(ev.target.value, 10) || 1);
    });

    renderPanel();
    apply();
    console.log('[JHS+] 图墙已打开，维度 ' +
      document.querySelectorAll('.xf-dim').length + ' 个');
  }

  /* ==================== 5.1 原列表排序（保留） ==================== */

  function boxOf() {
    return document.querySelector('.movie-list') || document.querySelector('.masonry');
  }

  function sortKey(el, mode, m) {
    if (mode === 'scoreDesc' || mode === 'scoreAsc') return statOf(el, m).score;
    if (mode === 'votesDesc') return statOf(el, m).votes;
    if (mode === 'dateDesc' || mode === 'dateAsc') {
      const d = dateOf(el);
      return d ? d.getTime() : 0;
    }
    return 0;
  }

  let sortSig = '';

  function applySort(force) {
    const box = boxOf();
    if (!box) return false;

    const mode = cond.sort || 'default';
    const items = Array.prototype.slice.call(box.querySelectorAll('.item'));
    if (items.length < 2) return false;

    items.forEach(function (el, i) {
      if (!el.hasAttribute('data-xf-idx')) el.setAttribute('data-xf-idx', String(i));
    });

    const list = items.map(function (el, i) {
      const raw = Number(el.getAttribute('data-xf-idx'));
      return {
        el: el,
        key: sortKey(el, mode, metaOf(carNumOf(el))),
        idx: isNaN(raw) ? i : raw
      };
    });

    if (mode === 'default') {
      list.sort(function (a, b) { return a.idx - b.idx; });
    } else {
      const desc = /Desc$/.test(mode);
      list.sort(function (a, b) {
        if (b.key !== a.key) return desc ? b.key - a.key : a.key - b.key;
        return a.idx - b.idx;
      });
    }

    const sig = mode + '|' + list.map(function (x) {
      return x.el.getAttribute('data-xf-idx');
    }).join(',');
    if (!force && sig === sortSig) return false;
    sortSig = sig;

    const frag = document.createDocumentFragment();
    list.forEach(function (x) { frag.appendChild(x.el); });
    box.appendChild(frag);
    return true;
  }

  function activeCount() {
    let n = 0;
    const keys = ['state', 'actor', 'director', 'series',
                  'prefix', 'exPrefix', 'kw', 'exKw'];
    for (const k of keys) {
      if (String(cond[k] == null ? '' : cond[k]).trim()) n++;
    }
    if (String(cond.sort || 'default') !== 'default') n++;
    return n;
  }

  function updateSummary() {
    const box = document.getElementById('xflt-summary');
    if (!box) return;

    const n = activeCount();
    const sorting = String(cond.sort || 'default') !== 'default';

    if (!n && !sorting) {
      box.innerHTML = '全库 <b>' + total + '</b> 条';
      return;
    }

    let s = '筛选出 <b>' + kept + '</b> / ' + total;
    if (sorting) s += ' · 已排序';
    if (noData) s += ' <span class="xf-hint">· 跳过 ' + noData + ' 条缺演员/导演数据</span>';
    box.innerHTML = s;
  }

  /* ==================== 6. 筛选 UI（第一行维度，第二行选项） ==================== */

  // 第一行的维度按钮；keys 是该维度涉及的 cond 字段
  // 评分 / 发行 / 加入共用 cond.sort，因此始终只有一个排序条件生效。
  const DIMS = [
    { k: 'state',    t: '状态', keys: ['state'] },
    { k: 'score',    t: '评分', keys: ['sort'], sortPrefix: 'score' },
    { k: 'year',     t: '发行', keys: ['sort'], sortPrefix: 'date' },
    { k: 'added',    t: '加入', keys: ['sort'], sortPrefix: 'added' },
    { k: 'actor',    t: '演员', keys: ['actor'] },
    { k: 'director', t: '导演', keys: ['director'] },
    { k: 'series',   t: '系列', keys: ['series'] },
    { k: 'prefix',   t: '番号', keys: ['prefix', 'exPrefix'] },
    { k: 'kw',       t: '标题', keys: ['kw', 'exKw'] }
  ];

  const XL = { dim: '' };   // 当前展开的维度

  function dimOf(k) {
    for (let i = 0; i < DIMS.length; i++) if (DIMS[i].k === k) return DIMS[i];
    return null;
  }

  function isEmptyKey(k) {
    return k === 'sort'
      ? String(cond.sort || 'default') === 'default'
      : !String(cond[k] == null ? '' : cond[k]).trim();
  }

  function dimDirty(d) {
    if (d.sortPrefix) {
      const s = String(cond.sort || 'default');
      return s !== 'default' && s.indexOf(d.sortPrefix) === 0;
    }
    return d.keys.some(function (k) { return !isEmptyKey(k); });
  }

  // 该维度当前生效的条件数（用于角标；排序类维度最多 1 个）
  function dimCount(d) {
    if (d.sortPrefix) return dimDirty(d) ? 1 : 0;
    let n = 0;
    d.keys.forEach(function (k) { if (!isEmptyKey(k)) n++; });
    return n;
  }

  function chipHtml(key, chips) {
    return chips.map(function (c) {
      const cur = String(cond[key] == null ? '' : cond[key]);
      return '<span class="xf-chip' + (cur === c.v ? ' on' : '') +
        '" data-k="' + key + '" data-v="' + esc(c.v) + '">' + esc(c.t) + '</span>';
    }).join('');
  }

  function inHtml(key, pre, ph) {
    const val = cond[key] || '';
    return '<span class="xf-hint">' + pre + '</span>' +
      '<input class="xf-in' + (val ? ' on' : '') + '" data-k="' + key +
      '" type="text" autocomplete="off" placeholder="' + esc(ph) +
      '" value="' + esc(val) + '">';
  }

  // 演员 / 导演 / 系列：影子库出现最多的项做 chip，后面跟一个自由输入框
  function metaChips(key, limit) {
    const r = topValues(key, limit);
    const chips = r.list.map(function (it) {
      const on = String(cond[key] || '').toUpperCase() === String(it.v).toUpperCase();
      return '<span class="xf-chip' + (on ? ' on' : '') +
        '" data-k="' + key + '" data-v="' + esc(it.v) + '">' + esc(it.v) +
        '<i class="xf-n">' + it.n + '</i></span>';
    }).join('');

    const val = cond[key] || '';
    const inp = '<input class="xf-in' + (val ? ' on' : '') +
      '" data-k="' + key + '" type="text" autocomplete="off"' +
      ' placeholder="多个用逗号分隔" value="' + esc(val) + '">';

    const tip = r.total
      ? '<span class="xf-hint">共 ' + r.total + ' 个' +
        (r.total > r.list.length ? '，显示前 ' + r.list.length : '') + '</span>'
      : '<span class="xf-hint">还没有数据，先补齐</span>';

    return chips + (chips ? '<span class="xf-sep"></span>' : '') + inp + tip;
  }

  function optsHtml(k) {
    switch (k) {
      case 'state':    return chipHtml('state', CHIP_GROUPS.state);
      case 'score':    return chipHtml('sort', [
                                 { v: 'default', t: '不限' },
                                 { v: 'scoreDesc', t: '倒序 · 高分在前' },
                                 { v: 'scoreAsc', t: '正序 · 低分在前' }
                               ]);
      case 'year':     return chipHtml('sort', [
                                 { v: 'default', t: '不限' },
                                 { v: 'dateDesc', t: '倒序 · 新片在前' },
                                 { v: 'dateAsc', t: '正序 · 老片在前' }
                               ]);
      case 'added':    return chipHtml('sort', [
                                 { v: 'default', t: '不限' },
                                 { v: 'addedDesc', t: '倒序 · 最近加入' },
                                 { v: 'addedAsc', t: '正序 · 最早加入' }
                               ]);
      case 'actor':    return metaChips('actor', 300);
      case 'director': return metaChips('director', 200);
      case 'series':   return metaChips('series', 200);
      case 'prefix':   return inHtml('prefix', '含', '数字或字母，如 001') +
                              '<span class="xf-sep"></span>' +
                              inHtml('exPrefix', '排除', 'VR、FC2');
      case 'kw':       return inHtml('kw', '含', '逗号分隔') +
                              '<span class="xf-sep"></span>' +
                              inHtml('exKw', '排除', '逗号分隔');
      default:         return '';
    }
  }

  // 返回 { list: 前 limit 个, total: 不重复总数 }
  function topValues(field, limit) {
    if (!xmem || !xmem.size) return { list: [], total: 0 };
    const cnt = new Map();
    xmem.forEach(function (m) {
      let vals = [];
      if (field === 'actor') {
        if (Array.isArray(m.actors) && m.actors.length) vals = m.actors.slice();
        else if (m.names) vals = String(m.names).split(/[\s,，]+/);
      } else {
        const v = m[field];
        if (v) vals = [v];
      }
      vals.forEach(function (v) {
        v = String(v || '').trim();
        if (!v || v.length > 20) return;
        cnt.set(v, (cnt.get(v) || 0) + 1);
      });
    });
    const all = Array.from(cnt.entries())
      .sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : 1); });
    return {
      list: all.slice(0, limit).map(function (x) { return { v: x[0], n: x[1] }; }),
      total: all.length
    };
  }

  function dimsHtml() {
    return DIMS.map(function (d) {
      const sortModes = {
        score: ['scoreDesc', 'scoreAsc', '评分'],
        year: ['dateDesc', 'dateAsc', '发行'],
        added: ['addedDesc', 'addedAsc', '加入']
      }[d.k];
      const currentSort = String(cond.sort || 'default');
      const isSortActive = sortModes && currentSort.indexOf(d.sortPrefix) === 0;
      const label = sortModes
        ? sortModes[2] + (isSortActive ? (/Desc$/.test(currentSort) ? ' ↓' : ' ↑') : '')
        : d.t;
      const n = dimCount(d);
      return '<span class="xf-dim' +
        (XL.dim === d.k ? ' active' : '') +
        (dimDirty(d) ? ' dirty' : '') +
        '" data-dim="' + d.k + '"' + (n ? ' data-n="' + n + '"' : '') +
        (sortModes ? ' data-sort="' + d.sortPrefix + '" title="点击排序，再点切换方向"' : '') + '>' + label + '</span>';
    }).join('');
  }

  function renderPanel() {
    const panel = document.getElementById('xflt-panel');
    if (!panel) return;
    ensureMem();
    panel.innerHTML =
      '<div class="xf-dims" id="xf-dims">' + dimsHtml() + '</div>' +
      '<div class="xf-opts" id="xf-opts" hidden></div>' +
      '<div class="xf-presets" id="xf-presets"></div>';
    renderOpts();
    renderPresets();
    renderActiveBar();
  }

  function renderOpts() {
    const box = document.getElementById('xf-opts');
    if (!box) return;
    if (!XL.dim) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = optsHtml(XL.dim);
    // 演员 / 导演 / 系列选项多：加维度内搜索 + 选项区滚动
    const meta = (XL.dim === 'actor' || XL.dim === 'director' || XL.dim === 'series');
    box.classList.toggle('xf-opts-scroll', meta);
    if (meta) {
      const s = document.createElement('input');
      s.className = 'xf-search';
      s.type = 'text';
      s.autocomplete = 'off';
      s.placeholder = '筛选选项…';
      box.insertBefore(s, box.firstChild);
    }
  }

  function paintDims() {
    const box = document.getElementById('xf-dims');
    if (!box) return;
    const btns = box.querySelectorAll('.xf-dim');
    for (let i = 0; i < btns.length; i++) {
      const k = btns[i].getAttribute('data-dim');
      const d = dimOf(k);
      btns[i].classList.toggle('active', XL.dim === k);
      btns[i].classList.toggle('dirty', d ? dimDirty(d) : false);
      const n = d ? dimCount(d) : 0;
      if (n) btns[i].setAttribute('data-n', n);
      else btns[i].removeAttribute('data-n');
    }
    renderActiveBar();
  }

  // 只同步 value 与高亮，不重建 DOM —— 输入框不丢焦点
  function paintOpts() {
    const box = document.getElementById('xf-opts');
    if (!box) return;
    box.querySelectorAll('.xf-chip').forEach(function (b) {
      const k = b.getAttribute('data-k');
      const cur = String(cond[k] == null ? '' : cond[k]);
      b.classList.toggle('on', cur === b.getAttribute('data-v'));
    });
    box.querySelectorAll('.xf-in').forEach(function (inp) {
      const k = inp.getAttribute('data-k');
      const v = String(cond[k] == null ? '' : cond[k]);
      if (inp.value !== v) inp.value = v;
      inp.classList.toggle('on', !!v);
    });
  }

  function paintPanel() {
    paintDims();
    paintOpts();
  }

  // ---- 已选条件条（条在面板外，由 paintDims / renderPanel 刷新） ----
  function activeItems() {
    const items = [];
    const stateTitle = function (v) {
      try {
        const g = CHIP_GROUPS && CHIP_GROUPS.state;
        for (let i = 0; i < g.length; i++) if (g[i].v === v) return g[i].t;
      } catch (e) { /* ignore */ }
      return v;
    };
    if (String(cond.state || '').trim()) items.push({ key: 'state', label: '状态：' + stateTitle(cond.state) });
    const sortMap = {
      scoreDesc: '评分 ↓', scoreAsc: '评分 ↑',
      dateDesc: '发行 ↓', dateAsc: '发行 ↑',
      addedDesc: '加入 ↓', addedAsc: '加入 ↑'
    };
    if (sortMap[cond.sort]) items.push({ key: 'sort', label: sortMap[cond.sort] });
    if (String(cond.actor || '').trim()) items.push({ key: 'actor', label: '演员：' + String(cond.actor).slice(0, 12) });
    if (String(cond.director || '').trim()) items.push({ key: 'director', label: '导演：' + String(cond.director).slice(0, 12) });
    if (String(cond.series || '').trim()) items.push({ key: 'series', label: '系列：' + String(cond.series).slice(0, 12) });
    if (String(cond.prefix || '').trim()) items.push({ key: 'prefix', label: '番号含 ' + String(cond.prefix).slice(0, 12) });
    if (String(cond.exPrefix || '').trim()) items.push({ key: 'exPrefix', label: '番号排除 ' + String(cond.exPrefix).slice(0, 12) });
    if (String(cond.kw || '').trim()) items.push({ key: 'kw', label: '标题含 ' + String(cond.kw).slice(0, 12) });
    if (String(cond.exKw || '').trim()) items.push({ key: 'exKw', label: '标题排除 ' + String(cond.exKw).slice(0, 12) });
    return items;
  }

  function renderActiveBar() {
    const bar = document.getElementById('xflt-active');
    if (!bar) return;
    const items = activeItems();
    bar.innerHTML = items.length
      ? '<span class="xf-active-label">已选：</span>' + items.map(function (it) {
          return '<span class="xf-active-item">' + esc(it.label) +
            '<button type="button" class="xf-active-x" data-k="' + it.key + '" title="清除该条件">×</button></span>';
        }).join('')
      : '';
  }

  // 只清一个条件键（sort 类清回默认），其余走 renderPanel 全量刷新
  function clearDim(key) {
    if (key === 'sort') cond.sort = 'default';
    else cond[key] = '';
    XL.dim = '';
    saveCond();
    renderPanel();
    apply();
  }

  // ---- 预设（存在 localStorage，与条件持久化同一层） ----
  function loadPresets() {
    try {
      const list = JSON.parse(localStorage.getItem('xflt:presets:v1') || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function savePresets(list) {
    try { localStorage.setItem('xflt:presets:v1', JSON.stringify(list)); } catch (e) { /* ignore */ }
  }
  function renderPresets() {
    const box = document.getElementById('xf-presets');
    if (!box) return;
    const list = loadPresets();
    let h = '<span class="xf-preset-label">预设：</span>';
    h += list.map(function (p, i) {
      return '<span class="xf-preset" data-i="' + i + '" title="点击应用该预设">' + esc(p.name || ('预设' + (i + 1))) +
        '<button type="button" class="xf-preset-x" data-i="' + i + '" title="删除该预设">×</button></span>';
    }).join('');
    h += '<input class="xf-preset-name" id="xf-preset-name" type="text" autocomplete="off" placeholder="预设名称">' +
      '<button class="xf-preset-save" id="xf-preset-save" type="button">＋保存当前</button>';
    box.innerHTML = h;
  }

  // 点一下选中，再点同一个就取消（回到「不限 / 默认」）
  function toggleChip(k, v) {
    const cur = String(cond[k] == null ? '' : cond[k]);
    const off = (k === 'sort') ? 'default' : '';
    cond[k] = (v === off || cur === v) ? off : v;
  }

  // 补齐数据会让 chip 候选变多；只在弹层打开且没在输入时重建
  function refreshPanelIfIdle() {
    const panel = document.getElementById('xflt-panel');
    if (!panel) return;
    if (panel.contains(document.activeElement)) return;
    renderPanel();
  }

  // 面板事件：维度切换 + 选项点击 + 输入框
  function bindPanel(panel) {
    if (!panel) return;

    panel.addEventListener('click', function (ev) {
      const t = ev.target;
      if (!t.closest) return;

      // 预设：点 × 删除（先于点名字应用判断，因为 × 在名字标签内）
      const presetX = t.closest('.xf-preset-x');
      if (presetX) {
        const i = parseInt(presetX.getAttribute('data-i'), 10);
        const list = loadPresets();
        if (!isNaN(i) && list[i]) { list.splice(i, 1); savePresets(list); renderPresets(); }
        return;
      }
      const preset = t.closest('.xf-preset');
      if (preset) {
        const i = parseInt(preset.getAttribute('data-i'), 10);
        const list = loadPresets();
        if (!isNaN(i) && list[i]) {
          try { cond = Object.assign({}, DEFAULT_COND, JSON.parse(list[i].cond)); }
          catch (e) { /* ignore */ }
          XL.dim = '';
          saveCond();
          renderPanel();
          apply();
        }
        return;
      }
      // 保存当前条件为预设
      if (t.closest('#xf-preset-save')) {
        const inp = document.getElementById('xf-preset-name');
        const name = (inp && inp.value.trim()) || '';
        const list = loadPresets();
        list.push({ name: name || ('预设' + (list.length + 1)), cond: JSON.stringify(cond) });
        savePresets(list);
        renderPresets();
        if (inp) inp.value = '';
        return;
      }

      // 点维度展开选项，再点同一个收起
      const dim = t.closest('.xf-dim');
      if (dim) {
        const k = dim.getAttribute('data-dim');
        const sortPrefix = dim.getAttribute('data-sort');
        if (sortPrefix) {
          const descMode = sortPrefix === 'score' ? 'scoreDesc' :
            (sortPrefix === 'date' ? 'dateDesc' : 'addedDesc');
          const ascMode = sortPrefix === 'score' ? 'scoreAsc' :
            (sortPrefix === 'date' ? 'dateAsc' : 'addedAsc');
          cond.sort = String(cond.sort || '').indexOf(sortPrefix) === 0
            ? (cond.sort === descMode ? ascMode : descMode)
            : descMode;
          saveCond();
          paintDims();
          apply();
          return;
        }
        XL.dim = (XL.dim === k) ? '' : k;
        paintDims();
        renderOpts();
        return;
      }

      // 点选项：选中 / 取消
      const chipEl = t.closest('.xf-chip');
      if (chipEl) {
        const k = chipEl.getAttribute('data-k');
        toggleChip(k, chipEl.getAttribute('data-v'));
        saveCond();
        paintOpts();
        paintDims();
        apply();
      }
    });

    // 输入框：300ms 防抖
    let inTimer = null;
    panel.addEventListener('input', function (ev) {
      // 维度内搜索：只过滤选项 chip，不动条件
      const search = ev.target.closest ? ev.target.closest('.xf-search') : null;
      if (search) {
        const q = search.value.trim().toLowerCase();
        const box = document.getElementById('xf-opts');
        if (box) box.querySelectorAll('.xf-chip').forEach(function (c) {
          c.style.display = (!q || c.textContent.toLowerCase().indexOf(q) !== -1) ? '' : 'none';
        });
        return;
      }
      const inp = ev.target.closest ? ev.target.closest('.xf-in') : null;
      if (!inp) return;
      cond[inp.getAttribute('data-k')] = inp.value;
      clearTimeout(inTimer);
      inTimer = setTimeout(function () {
        saveCond();
        paintOpts();
        paintDims();
        apply();
      }, 300);
    });
  }

  /* ==================== 7. 筛选条件持久化 ==================== */

  function loadCond() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function saveCond() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(cond)); } catch (e) { /* ignore */ }
  }

  /* ==================== 8. 影子库（JHS-XMETA） ==================== */

  const XMeta = {
    db: null, mode: null, mem: null,

    async init() {
      if (this.mode) return this.mode;

      // 有 GM 存储就用它 —— 这是唯一能跨 javdb / javbus 共享的一层
      if (typeof GM_getValue === 'function' && typeof GM_setValue === 'function') {
        this.mode = 'gm';
        return this.mode;
      }

      if (await this._openIdb()) {
        this.mode = 'idb';
      } else {
        this.mode = 'ls';
      }
      return this.mode;
    },

    async _openIdb() {
      if (this.db) return this.db;
      if (typeof indexedDB === 'undefined') return null;
      try {
        this.db = await new Promise(function (res, rej) {
          const q = indexedDB.open(XDB_NAME);
          q.onupgradeneeded = function () {
            const d = q.result;
            if (!d.objectStoreNames.contains(XDB_STORE)) d.createObjectStore(XDB_STORE);
          };
          q.onsuccess = function () { res(q.result); };
          q.onerror = function () { rej(q.error); };
          q.onblocked = function () { rej(new Error('idb blocked')); };
        });
        return this.db;
      } catch (e) {
        this.db = null;
        return null;
      }
    },

    // 读旧版存储（v2.9 及之前存在 IndexedDB，更早存 localStorage）
    async _loadLegacy() {
      const db = await this._openIdb();
      if (db) {
        try {
          const rows = await new Promise(function (res, rej) {
            const g = db.transaction(XDB_STORE, 'readonly').objectStore(XDB_STORE).getAll();
            g.onsuccess = function () { res(g.result || []); };
            g.onerror = function () { rej(g.error); };
          });
          if (rows.length) return rows;
        } catch (e) { /* 继续试 localStorage */ }
      }
      try {
        const raw = localStorage.getItem(XLS_KEY);
        const obj = raw ? JSON.parse(raw) : {};
        return Object.keys(obj).map(function (k) { return obj[k]; });
      } catch (e) { return []; }
    },

    // 加 Promise 单例，避免并发调用时后完成的把 mem 覆盖成空 Map
    loadAll() {
      if (this.mem) return Promise.resolve(this.mem);
      if (this._loading) return this._loading;

      this._loading = (async () => {
        await this.init();
        let list = [];
        if (this.mode === 'gm') {
          let obj = {};
          try {
            const raw = await GM_getValue(XGM_KEY, '');
            obj = raw ? JSON.parse(raw) : {};
          } catch (e) { obj = {}; }

          // v3.0.0 的错误版本只从 localStorage 迁，导致 IndexedDB 里的历史数据读不到。
          // 现在每次都把旧存储合并进来：GM 为主，缺的字段用旧值补。
          let added = 0, patched = 0;
          try {
            const legacy = await this._loadLegacy();
            for (let i = 0; i < legacy.length; i++) {
              const it = legacy[i];
              if (!it || !it.carNum) continue;
              const cur = obj[it.carNum];
              if (!cur) { obj[it.carNum] = it; added++; continue; }
            if (cur.deleted) continue;
            const lookupChanged = cur.lookupCarNum &&
              normalizeCarKey(cur.lookupCarNum) !== normalizeCarKey(cur.carNum || it.carNum) &&
              normalizeCarKey(cur.dataForLookup || '') !== normalizeCarKey(cur.lookupCarNum);
            const detailFields = new Set(['score', 'votes', 'cover', 'title', 'duration',
              'director', 'maker', 'series', 'tags', 'actors']);
              for (const k in it) {
              if (lookupChanged && detailFields.has(k)) continue;
                if (cur[k] === undefined || cur[k] === '' || cur[k] === null) {
                  cur[k] = it[k];
                  patched++;
                }
              }
            }
          } catch (e) { /* ignore */ }

          if (added || patched) {
            try { await GM_setValue(XGM_KEY, JSON.stringify(obj)); } catch (e) { /* ignore */ }
            console.log('[JHS+] 影子库已合并到跨站存储：新增 ' + added + ' 条，补字段 ' + patched + ' 处');
          }

          list = Object.keys(obj).map(function (k) { return obj[k]; });
        } else if (this.mode === 'idb') {
          try {
            list = await new Promise((res, rej) => {
              const g = this.db.transaction(XDB_STORE, 'readonly').objectStore(XDB_STORE).getAll();
              g.onsuccess = () => res(g.result || []);
              g.onerror = () => rej(g.error);
            });
          } catch (e) { list = []; }
        } else {
          try {
            const raw = localStorage.getItem(XLS_KEY);
            const obj = raw ? JSON.parse(raw) : {};
            list = Object.keys(obj).map(k => obj[k]);
          } catch (e) { list = []; }
        }
        this.mem = new Map();
        for (const it of list) if (it && it.carNum) this.mem.set(it.carNum, it);
        this._loading = null;
        return this.mem;
      })();

      return this._loading;
    },

    // GM 存储是全量覆盖写，多次调用合并成一次
    _scheduleFlush(mem) {
      this._pendingMem = mem;
      if (this._flushTimer) return;
      this._flushTimer = setTimeout(async () => {
        this._flushTimer = null;
        const m = this._pendingMem;
        this._pendingMem = null;
        if (!m) return;
        try {
          const obj = {};
          m.forEach((v, k) => { obj[k] = v; });
          await GM_setValue(XGM_KEY, JSON.stringify(obj));
        } catch (e) { /* ignore */ }
      }, 400);
    },

    // 立即把待刷盘的数据写掉（补齐结束 / 停止时调用，避免关页面丢尾巴）
    async flush() {
      if (this.mode !== 'gm') return;
      if (!this._pendingMem) return;
      if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
      const m = this._pendingMem;
      this._pendingMem = null;
      try {
        const obj = {};
        m.forEach((v, k) => { obj[k] = v; });
        await GM_setValue(XGM_KEY, JSON.stringify(obj));
      } catch (e) { /* ignore */ }
    },

    async saveMany(entries) {
      if (!entries.length) return;
      const mem = await this.loadAll();
      for (const pair of entries) {
        const k = pair[0], v = pair[1];
        mem.set(k, Object.assign({}, mem.get(k), v));
      }
      if (this.mode === 'gm') {
        this._scheduleFlush(mem);
        return;
      }

      if (this.mode === 'idb') {
        try {
          await new Promise((res, rej) => {
            const tx = this.db.transaction(XDB_STORE, 'readwrite');
            const st = tx.objectStore(XDB_STORE);
            for (const pair of entries) st.put(mem.get(pair[0]), pair[0]);
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
            tx.onabort = () => rej(tx.error);
          });
          return;
        } catch (e) { /* 降级 */ }
      }
      try {
        const obj = {};
        mem.forEach((v, k) => { obj[k] = v; });
        localStorage.setItem(XLS_KEY, JSON.stringify(obj));
      } catch (e) { /* ignore */ }
    }
  };

  /* ==================== 9. 采集器（零请求） ==================== */

  let collectSig = '';

  async function collectFromList() {
    const items = document.querySelectorAll(ITEM_SEL);
    if (!items.length) return 0;
    const stored = await XMeta.loadAll();

    const batch = [];
    for (let i = 0; i < items.length; i++) {
      const el = items[i];
      const car = carNumOf(el);
      if (!car) continue;

      const s = scoreOf(el);
      const d = dateOf(el);
      const cover = coverOf(el);

      const rec = { carNum: car, updatedAt: Date.now() };
      if (s.score) rec.score = s.score;
      if (s.votes) rec.votes = s.votes;
      if (d) rec.publishTime = fmtDate(d);
      // 列表页可能是 Bus 的缩略图；已有详情页封面优先保留，避免覆盖 DB 主数据。
      const oldMeta = stored.get(car) || {};
      if (cover && !oldMeta.cover) rec.cover = cover;
      const ttl = titleOf(el);
      if (ttl) rec.title = ttl;

      if (!rec.score && !rec.votes && !rec.publishTime && !rec.cover && !rec.title) continue;
      batch.push([car, rec]);
    }

    if (!batch.length) return 0;

    const sig = batch.map(p => p[0] + ':' + (p[1].score || '') + ':' + (p[1].votes || '')).join(',');
    if (sig === collectSig) return 0;
    collectSig = sig;

    await XMeta.saveMany(batch);
    updateCollectInfo();
    return batch.length;
  }

  function updateCollectInfo() {
    const box = document.getElementById('xm-info');
    if (!box) return;
    const n = XMeta.mem ? XMeta.mem.size : 0;
    box.textContent = n ? '本地已知 ' + n + ' 部影片的评分' : '';
  }

  /* ==================== 10. 回填「鉴定记录」表格 ==================== */

  let decorateTimer = null;

  function scheduleDecorate() {
    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(decorateHistory, 200);
  }

  async function decorateHistory() {
    const rows = document.querySelectorAll('.jhs-history-dialog .tabulator-row');
    if (!rows.length) return;
    const mem = await XMeta.loadAll();
    if (!mem.size) return;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const cell = row.querySelector('[tabulator-field="carNum"]');
      if (!cell) continue;

      const old = cell.querySelector('.xm-score');
      if (old) old.remove();

      const car = (cell.textContent || '').trim().toUpperCase();
      if (!car) continue;

      const m = mem.get(car);
      if (!m) continue;

      const parts = [];
      if (m.score) parts.push(m.score.toFixed(2) + '分');
      if (m.votes) parts.push(m.votes + '人');
      if (!parts.length) continue;

      const badge = document.createElement('span');
      badge.className = 'xm-score';
      badge.textContent = parts.join(' · ');
      cell.appendChild(badge);
    }
  }

  /* ==================== 11. 资料库（自包含渲染） ==================== */

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function jhsReady() {
    return !!(UW.storageManager && typeof UW.storageManager.getCarList === 'function' &&
              UW.stateService && typeof UW.stateService.patch === 'function');
  }

  async function waitForJhs(timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeout || 12000)) {
      if (jhsReady()) return true;
      await sleep(200);
    }
    return false;
  }

  /**
   * 把当前站点的 JHS 记录并进「跨站合并表」，返回 { carNum: {...} }。
   * 合并表存在 GM 存储里，javdb 和 javbus 共用同一份。
   * 状态以「当前站点」为准 —— 你在哪个站操作，就以哪个站为最新。
   */
  async function syncCarFlags(list) {
    const canGm = (typeof GM_getValue === 'function' && typeof GM_setValue === 'function');
    const merged = {};

    if (canGm) {
      try {
        const raw = await GM_getValue(XSYNC_KEY, '');
        Object.assign(merged, raw ? JSON.parse(raw) : {});
      } catch (e) { /* ignore */ }
    }

    let changed = false;
    for (let i = 0; i < list.length; i++) {
      const rec = list[i] || {};
      const car = String(rec.carNum || '').toUpperCase();
      if (!car) continue;

      const old = merged[car] || {};
      if (old.deleted) continue;
      const f = rec.stateFlags || {};
      const of = old.flags || {};

      // 当前站没有这条 → 保留合并表里的；DB 的已看状态优先于 Bus。
      // url 优先保留 DB 的：bus 记录的链接抓不到评分
      const urlNext = isDbUrl(rec.url) ? rec.url : (old.url || rec.url || '');
      const next = {
        carNum: car,
        url: urlNext,
        dbUrl: isDbUrl(urlNext) ? urlNext : (old.dbUrl || ''),
        title: rec.title || old.title || '',
        names: rec.names || old.names || '',
        publishTime: rec.publishTime || old.publishTime || '',
        remark: rec.remark || old.remark || '',
        createDate: rec.createDate || old.createDate || '',
        updateDate: rec.updateDate || old.updateDate || '',
        flags: {
          favorite: !!f.favorite,
          downloaded: !!f.downloaded,
          watched: isDbSite() ? !!f.watched : !!of.watched,
          blocked: !!f.blocked
        },
        updatedAt: Date.now()
      };

      if (!old.carNum || old.url !== next.url || old.names !== next.names ||
          old.publishTime !== next.publishTime ||
          JSON.stringify(old.flags || {}) !== JSON.stringify(next.flags)) {
        changed = true;
      }
      merged[car] = next;
    }

    if (changed && canGm) {
      try { await GM_setValue(XSYNC_KEY, JSON.stringify(merged)); } catch (e) { /* ignore */ }
    }
    return merged;
  }

  async function importJellyfinCollection(options) {
    options = options || {};
    if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') {
      throw new Error('当前脚本管理器没有提供跨站同步存储');
    }
    await XMeta.loadAll();
    const raw = await GM_getValue(XSYNC_KEY, '');
    const merged = raw ? JSON.parse(raw) : {};
    const meta = await XMeta.loadAll();
    const priority = new Map();
    const remember = function (car, rank) {
      const key = String(car || '').trim().toUpperCase();
      const normalized = normalizeCarKey(key);
      if (!key || !normalized || (priority.has(normalized) && priority.get(normalized).rank >= rank)) return;
      priority.set(normalized, { car: key, rank: rank });
    };

    Object.keys(merged).forEach(function (car) {
      const rec = merged[car] || {};
      remember(car, isDbUrl(rec.dbUrl || rec.url) ? 4 : 2);
    });
    meta.forEach(function (rec, car) { remember(car, 1); });
    (await UW.storageManager.getCarList() || []).forEach(function (rec) {
      if (rec && rec.carNum) remember(rec.carNum, isDbUrl(rec.url) ? 5 : 3);
    });

    const stageWrites = [];
    const touched = [];
    let created = 0;
    JELLYFIN_CARS.forEach(function (sourceCar) {
      const normalized = normalizeCarKey(sourceCar);
      const car = (priority.get(normalized) || {}).car || sourceCar;
      const existingKey = Object.keys(merged).find(function (key) {
        return normalizeCarKey(key) === normalizeCarKey(car);
      });
      const old = merged[car] || (existingKey ? merged[existingKey] : {}) || {};
      if (!old.carNum) created++;
      const flags = Object.assign({ favorite: false, downloaded: false, watched: false, blocked: false }, old.flags || {});
      const next = Object.assign({}, old, {
        carNum: car,
        flags: flags,
        updatedAt: Date.now()
      });
      delete next.deleted;
      delete next.deletedAt;
      if (existingKey && existingKey !== car) delete merged[existingKey];
      merged[car] = next;
      const previousMeta = meta.get(car) || (existingKey && meta.get(existingKey)) || {};
      stageWrites.push([car, Object.assign({}, previousMeta, {
        carNum: car, stage: 'jellyfin', stageUpdatedAt: Date.now(), deleted: false, deletedAt: ''
      })]);
      touched.push(car);
    });

    await GM_setValue(XSYNC_KEY, JSON.stringify(merged));
    await XMeta.saveMany(stageWrites);
    if (!options.initializing) {
      await reloadRows();
      if (LIB.open) { libFilter(); libSort(); libRender(); }
      toast('Jellyfin 同步完成：' + touched.length + ' 个番号标为“已存 Jellyfin”，其中新增 ' + created + ' 条。');
    }
    return { imported: touched.length, created: created };
  }

  let jellyfinImportPromise = null;
  async function ensureJellyfinCollectionImported() {
    if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function' || !jhsReady()) return;
    if (jellyfinImportPromise) return jellyfinImportPromise;
    if (await GM_getValue(XJELLYFIN_IMPORT_KEY, false)) return;
    if (jellyfinImportPromise) return jellyfinImportPromise;
    jellyfinImportPromise = importJellyfinCollection({ initializing: true })
      .then(function () { return GM_setValue(XJELLYFIN_IMPORT_KEY, true); })
      .finally(function () { jellyfinImportPromise = null; });
    return jellyfinImportPromise;
  }

  async function mirrorCarFlags(car, flags) {
    if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') return;
    try {
      const raw = await GM_getValue(XSYNC_KEY, '');
      const merged = raw ? JSON.parse(raw) : {};
      const old = merged[car] || {};
      merged[car] = Object.assign({}, old, {
        carNum: car,
        flags: {
          favorite: !!flags.favorite,
          downloaded: !!flags.downloaded,
          watched: isDbSite() ? !!flags.watched : !!((old.flags || {}).watched),
          blocked: !!flags.blocked
        },
        updatedAt: Date.now()
      });
      await GM_setValue(XSYNC_KEY, JSON.stringify(merged));
    } catch (e) { /* 影子同步失败不阻断当前站点操作 */ }
  }

  function isDbSite() {
    return /(^|\.)javdb\d*\.com$/i.test(String(location.hostname || ''));
  }

  async function markCarDeleted(car, deleted) {
    if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') return;
    const raw = await GM_getValue(XSYNC_KEY, '');
    const merged = raw ? JSON.parse(raw) : {};
    const old = merged[car] || { carNum: car };
    if (deleted) merged[car] = Object.assign({}, old, { carNum: car, deleted: true, deletedAt: Date.now() });
    else {
      delete old.deleted;
      delete old.deletedAt;
      merged[car] = old;
    }
    await GM_setValue(XSYNC_KEY, JSON.stringify(merged));
  }

  async function clearDeletedCars(cars) {
    if (typeof GM_getValue === 'function' && typeof GM_setValue === 'function') {
      const raw = await GM_getValue(XSYNC_KEY, '');
      if (raw) {
        const merged = JSON.parse(raw);
        let changed = false;
        cars.forEach(function (car) {
          if (merged[car] && merged[car].deleted) {
            delete merged[car];
            changed = true;
          }
        });
        if (changed) await GM_setValue(XSYNC_KEY, JSON.stringify(merged));
      }
    }
    const mem = await XMeta.loadAll();
    const restore = [];
    cars.forEach(function (car) {
      const meta = mem.get(car);
      if (meta && meta.deleted) restore.push([car, { carNum: car, deleted: false, deletedAt: '' }]);
    });
    if (restore.length) await XMeta.saveMany(restore);
  }

  async function loadRows() {
    const list = await UW.storageManager.getCarList();
    const mem = await XMeta.loadAll();
    const flagsMap = await syncCarFlags(list);

    const out = [];
    const stageMigrations = [];
    const cars = Object.keys(flagsMap);
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      const rec = flagsMap[car] || {};
      if (rec.deleted) continue;
      const m = mem.get(car) || {};
      if (m.deleted) continue;
      const f = rec.flags || {};
      const hasLookupAlias = !!m.lookupCarNum && normalizeCarKey(m.lookupCarNum) !== normalizeCarKey(car);
      const detailMatchesLookup = !hasLookupAlias ||
        normalizeCarKey(m.dataForLookup || '') === normalizeCarKey(m.lookupCarNum);
      const cachedDbUrl = isDbUrl(m.dbUrl) && (!hasLookupAlias ||
        normalizeCarKey(m.dbUrlForLookup) === normalizeCarKey(m.lookupCarNum)) ? m.dbUrl : '';
      const actors = detailMatchesLookup && Array.isArray(m.actors) ? m.actors : [];
      out.push({
        carNum: car,
        lookupCarNum: m.lookupCarNum || car,
        cover: detailMatchesLookup ? (m.cover || '') : '',
        title: detailMatchesLookup ? (m.title || rec.title || '') : '',
        // JHS 的 names 为空时，回落到详情页抓到的演员
        names: rec.names || actors.join(' '),
        actors: actors,
        score: detailMatchesLookup && typeof m.score === 'number' && m.score > 0 ? m.score : null,
        votes: detailMatchesLookup && typeof m.votes === 'number' && m.votes > 0 ? m.votes : null,
        duration: detailMatchesLookup && typeof m.duration === 'number' && m.duration > 0 ? m.duration : null,
        publishTime: rec.publishTime || (detailMatchesLookup ? (m.publishTime || '') : ''),
        director: detailMatchesLookup ? (m.director || '') : '',
        maker: detailMatchesLookup ? (m.maker || '') : '',
        series: detailMatchesLookup ? (m.series || '') : '',
        tags: detailMatchesLookup && Array.isArray(m.tags) ? m.tags.slice() : [],
        // 补齐/跳转一律走 DB 详情页；DB 上没有时才用原站链接
        url: cachedDbUrl || (hasLookupAlias ? '' : (rec.dbUrl || rec.url || '')),
        dbUrl: cachedDbUrl || (hasLookupAlias ? '' : (rec.dbUrl || '')),
        noDb: !!(m.noDb || rec.noDb),
        dbLookupVersion: Number(m.dbLookupVersion) || 0,
        remark: rec.remark || '',
        favorite: !!f.favorite,
        stage: normalizeStage(m.stage, !!f.favorite),
        downloaded: !!f.downloaded,
        watched: !!f.watched,
        blocked: !!f.blocked,
        createDate: rec.createDate || '',
        updateDate: rec.updateDate || '',
        // 已尝试时间与失败次数都要读回，避免重开资料库后重复补齐。
        fetchedAt: Number(m.fetchedAt) || 0,
        dataParseVersion: Number(m.dataParseVersion) || 0,
        failCount: Number(m.failCount) || 0,
        lastFailAt: Number(m.lastFailAt) || 0,
        partial: m.partial ? 1 : 0,
        partialCount: Number(m.partialCount) || 0
      });
      if (m.stage === 'normal' || m.stage === 'prized') {
        stageMigrations.push([car, { carNum: car, stage: normalizeStage(m.stage, !!f.favorite), stageUpdatedAt: Date.now() }]);
      }
    }

    if (stageMigrations.length) await XMeta.saveMany(stageMigrations);

    // 显式分类是跨站共享的主值；进入另一个站点时，把“待鉴定=收藏”写回该站 JHS。
    for (const row of out) {
      if (!STAGE_VALUES.has((mem.get(row.carNum) || {}).stage)) continue;
      const wantedFavorite = row.stage === 'pending';
      if (row.favorite === wantedFavorite) continue;
      stageSyncInFlight.add(row.carNum);
      try {
        await patchRecord(row.carNum, { favorite: wantedFavorite }, null);
        row.favorite = wantedFavorite;
        const flags = flagsMap[row.carNum] && flagsMap[row.carNum].flags || {};
        flags.favorite = wantedFavorite;
        await mirrorCarFlags(row.carNum, flags);
      } catch (e) {
        console.warn('[JHS+] 分类同步收藏标记失败', row.carNum, e && e.message ? e.message : e);
      } finally {
        stageSyncInFlight.delete(row.carNum);
      }
    }
    return out;
  }

  async function setMovieStage(carNum, stage) {
    let car = String(carNum || '').toUpperCase();
    if (!car || !STAGE_VALUES.has(stage)) return;
    if (!jhsReady()) throw new Error('JHS 尚未就绪，无法同步收藏标记');
    let row = LIB.rows.find(function (x) { return x.carNum === car; });
    if (!row) {
      const normalized = normalizeCarKey(car);
      row = LIB.rows.find(function (x) { return normalizeCarKey(x.carNum) === normalized; });
      if (row) car = row.carNum;
    }
    if (!row && UW.storageManager && typeof UW.storageManager.getCarList === 'function') {
      LIB.rows = await loadRows();
      row = LIB.rows.find(function (x) { return x.carNum === car; });
      if (!row) {
        const normalized = normalizeCarKey(car);
        row = LIB.rows.find(function (x) { return normalizeCarKey(x.carNum) === normalized; });
        if (row) car = row.carNum;
      }
    }
    if (!row) throw new Error('找不到影片记录：' + car);

    const favorite = stage === 'pending';
    const watched = stageMeansWatched(stage);
    stageSyncInFlight.add(car);
    try {
      // 待鉴定同步收藏；评分或 Jellyfin 分类同步为已看。
      await patchRecord(car, { favorite: favorite, watched: watched }, null);
      await XMeta.saveMany([[car, {
        carNum: car,
        stage: stage,
        homeWatched: watched,
        stageUpdatedAt: Date.now()
      }]]);
      row.stage = stage;
      row.favorite = favorite;
      row.watched = watched;
      await mirrorCarFlags(car, row);
    } finally {
      stageSyncInFlight.delete(car);
    }
    apply();
    if (LIB.open) { libFilter(); libSort(); libRender(); }
  }

  let stageSyncInstalled = false;
  function installStageSync() {
    if (stageSyncInstalled || !UW.jhsEventBus || typeof UW.jhsEventBus.on !== 'function') return;
    stageSyncInstalled = true;
    UW.jhsEventBus.on('car-state-changed', async function (event) {
      const cars = event && Array.isArray(event.carNums)
        ? event.carNums.map(function (x) { return String(x || '').toUpperCase(); }).filter(Boolean)
        : [];
      if (!cars.length || cars.every(function (car) { return stageSyncInFlight.has(car); })) return;
      try {
        await clearDeletedCars(cars);
        const list = await UW.storageManager.getCarList();
        const wanted = new Set(cars);
        let stageChanged = false;
        for (const rec of list || []) {
          const car = String((rec || {}).carNum || '').toUpperCase();
          if (!wanted.has(car)) continue;
          const flags = rec.stateFlags || {};
          await mirrorCarFlags(car, flags);
          if (stageSyncInFlight.has(car)) continue;
          const row = LIB.rows.find(function (x) { return x.carNum === car; });
          if (!row || row.favorite === !!flags.favorite) continue;
          let stage = row.stage;
          if (flags.favorite) stage = 'pending';
          else if (stage === 'pending') stage = 'score4';
          const changedStage = stage !== row.stage;
          if (changedStage) {
            await XMeta.saveMany([[car, { carNum: car, stage: stage, stageUpdatedAt: Date.now() }]]);
          }
          row.favorite = !!flags.favorite;
          row.stage = stage;
          if (changedStage) stageChanged = true;
        }
        if (stageChanged || LIB.rows.length) await reloadRows();
      } catch (e) {
        console.warn('[JHS+] 收藏状态同步失败', e && e.message ? e.message : e);
      }
    });
  }

  async function patchRecord(carNum, status, record) {
    if (!jhsReady()) throw new Error('JHS 尚未就绪，无法写回');

    const st = {};
    if (status) {
      for (const k of STATUS_KEYS) {
        if (typeof status[k] === 'boolean') st[k] = status[k];
      }
    }
    const rec = {};
    if (record) {
      for (const k of WRITABLE) {
        if (record[k] !== undefined && record[k] !== null && String(record[k]).trim() !== '') {
          rec[k] = String(record[k]).trim();
        }
      }
    }
    return UW.stateService.patch(carNum, st, {
      type: 'xmeta-library-edit',
      record: rec
    });
  }

  function toast(msg, isErr) {
    try {
      if (UW.show && typeof UW.show[isErr ? 'error' : 'success'] === 'function') {
        UW.show[isErr ? 'error' : 'success'](msg);
        return;
      }
    } catch (e) { /* ignore */ }
    console[isErr ? 'error' : 'log']('[资料库]', msg);
  }

  function downloadLibraryBackup() {
    return Promise.resolve().then(async function () {
      const jhsRows = await UW.storageManager.getCarList();
      const meta = await XMeta.loadAll();
      const sync = {};
      try {
        const raw = await GM_getValue(XSYNC_KEY, '');
        Object.assign(sync, raw ? JSON.parse(raw) : {});
      } catch (e) { /* 不影响 JHS 主记录备份 */ }

      const rowsByCar = new Map();
      (jhsRows || []).forEach(function (row) {
        const car = String(row && row.carNum || '').trim().toUpperCase();
        if (car) rowsByCar.set(car, row);
      });
      const cars = new Set();
      LIB.rows.forEach(function (row) { if (row && row.carNum) cars.add(String(row.carNum).toUpperCase()); });
      const records = Array.from(cars).map(function (car) {
        const row = rowsByCar.get(car) || {};
        return {
          carNum: car,
          url: row.url || '', names: row.names || '', publishTime: row.publishTime || '',
          remark: row.remark || '', createDate: row.createDate || '', updateDate: row.updateDate || '',
          stateFlags: Object.assign({ favorite: false, downloaded: false, watched: false, blocked: false }, row.stateFlags || {})
        };
      });
      const normalized = new Set(Array.from(cars).map(normalizeCarKey));
      const metadata = [];
      meta.forEach(function (value, car) {
        if (normalized.has(normalizeCarKey(car)) && value && !value.deleted) metadata.push(Object.assign({}, value, { carNum: car }));
      });
      const syncRecords = {};
      Object.keys(sync).forEach(function (car) {
        if (normalized.has(normalizeCarKey(car)) && sync[car] && !sync[car].deleted) syncRecords[car] = sync[car];
      });
      const payload = {
        format: LIB_BACKUP_FORMAT,
        formatVersion: LIB_BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        records: records,
        metadata: metadata,
        sync: syncRecords
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'JHS-筛选增强-资料库备份-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast('资料库备份已导出，共 ' + records.length + ' 条影片记录。');
    });
  }

  async function importLibraryBackup(file) {
    if (!file) return;
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('备份文件不是有效的 JSON'); }
    if (!data || data.format !== LIB_BACKUP_FORMAT || data.formatVersion !== LIB_BACKUP_VERSION ||
        !Array.isArray(data.records) || !Array.isArray(data.metadata) || !data.sync || typeof data.sync !== 'object') {
      throw new Error('备份格式或版本不受支持；请选择本脚本导出的资料库备份');
    }
    const records = [];
    const seen = new Set();
    data.records.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      const car = String(item.carNum || '').trim().toUpperCase();
      const key = normalizeCarKey(car);
      if (!car || !key || seen.has(key)) return;
      seen.add(key);
      const flags = {};
      STATUS_KEYS.forEach(function (name) { flags[name] = !!(item.stateFlags && item.stateFlags[name]); });
      const record = { carNum: car };
      WRITABLE.concat(['starId', 'fc2Source']).forEach(function (name) {
        if (item[name] != null && String(item[name]).trim()) record[name] = String(item[name]).trim();
      });
      ['createDate', 'updateDate'].forEach(function (name) {
        if (item[name] != null) record[name] = String(item[name]);
      });
      records.push({ carNum: car, flags: flags, record: record });
    });
    if (!records.length) throw new Error('备份中没有可导入的影片记录');
    if (!window.confirm('将从备份合并导入 ' + records.length + ' 条记录。同番号资料会按备份更新，备份中没有的记录会保留。是否继续？')) return;

    const before = new Set((await UW.storageManager.getCarList() || []).map(function (row) {
      return normalizeCarKey(row && row.carNum);
    }).filter(Boolean));
    const groups = new Map();
    records.forEach(function (item) {
      const key = JSON.stringify(item.flags);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    for (const group of groups.values()) {
      await UW.stateService.patch(group.map(function (item) { return item.carNum; }), group[0].flags, {
        type: 'xm-library-backup-import',
        records: group.map(function (item) { return item.record; })
      });
    }

    const meta = await XMeta.loadAll();
    const metaEntries = [];
    data.metadata.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      const car = String(item.carNum || '').trim().toUpperCase();
      if (!car || !seen.has(normalizeCarKey(car))) return;
      const safe = Object.assign({}, item, { carNum: car, deleted: false, deletedAt: '' });
      metaEntries.push([car, safe]);
    });
    if (metaEntries.length) await XMeta.saveMany(metaEntries);

    if (typeof GM_getValue === 'function' && typeof GM_setValue === 'function') {
      const raw = await GM_getValue(XSYNC_KEY, '');
      const merged = raw ? JSON.parse(raw) : {};
      Object.keys(data.sync).forEach(function (car) {
        const item = data.sync[car];
        if (!item || typeof item !== 'object' || !seen.has(normalizeCarKey(car))) return;
        merged[car] = Object.assign({}, merged[car] || {}, item, { carNum: car, deleted: false, deletedAt: '' });
      });
      await GM_setValue(XSYNC_KEY, JSON.stringify(merged));
    }

    LIB.rows = await loadRows();
    apply();
    if (LIB.open) { libFilter(); libSort(); libRender(); }
    const added = records.filter(function (item) { return !before.has(normalizeCarKey(item.carNum)); }).length;
    toast('资料库备份导入完成：' + records.length + ' 条，新增 ' + added + ' 条，其余同番号记录已更新。');
  }

  function chooseLibraryBackup() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', function () {
      const file = input.files && input.files[0];
      if (!file) return;
      importLibraryBackup(file).catch(function (e) {
        toast('资料库备份导入失败：' + (e && e.message ? e.message : e), true);
      });
    }, { once: true });
    input.click();
  }

  const LIB = {
    open: false,
    rows: [],
    view: [],
    page: 1,
    pageSize: 60,
    sortField: 'createDate',
    sortDir: 'desc',
    query: '',
    onlyUnfilled: false
  };

  const LIB_COLS = [
    { key: 'carNum', title: '番号', w: 128 },
    { key: 'lookupCarNum', title: 'DB查询番号（可改）', w: 190 },
    { key: 'title', title: '影片名称', w: 230 },
    { key: 'createDate', title: '加入时间', w: 150 },
    { key: 'names', title: '演员', w: 160, edit: true },
    { key: 'score', title: '评分', w: 104 },
    { key: 'publishTime', title: '发行', w: 104, edit: true },
    { key: 'duration', title: '时长', w: 70 },
    { key: 'director', title: '导演', w: 108 },
    { key: 'maker', title: '片商', w: 108 },
    { key: 'series', title: '系列', w: 108 },
    { key: 'tags', title: '类别', w: 170 },
    { key: 'stage', title: '分类', w: 260 },
    { key: 'watched', title: 'DB已看', w: 76 },
    { key: 'remark', title: '备注', w: 150, edit: true },
    { key: 'delete', title: '删除', w: 70, noSort: true }
  ];

  function libHeadHtml() {
    let h = '<tr>';
    for (const c of LIB_COLS) {
      const sortable = !c.noSort;
      h += '<th data-field="' + c.key + '"' +
           (sortable ? '' : ' class="xm-nosort"') +
           ' style="width:' + c.w + 'px">' + esc(c.title) +
           '<span class="xm-arrow" data-arrow="' + c.key + '"></span></th>';
    }
    return h + '</tr>';
  }

  function dimCell(v) {
    return v ? esc(v) : '<span class="xm-muted">—</span>';
  }

  function addedAtCell(value) {
    if (!value) return '<span class="xm-muted">—</span>';
    const raw = String(value);
    let date = new Date(value);
    if (/^\d{10}$/.test(raw)) date = new Date(Number(raw) * 1000);
    if (/^\d{13}$/.test(raw)) date = new Date(Number(raw));
    return isNaN(date.getTime()) ? esc(raw) : esc(date.toLocaleString('zh-CN', { hour12: false }));
  }

  function tagsCell(arr) {
    if (!arr || !arr.length) return '<span class="xm-muted">—</span>';
    const head = arr.slice(0, 6).map(function (t) {
      return '<span class="xm-tag">' + esc(t) + '</span>';
    }).join('');
    const rest = arr.length > 6
      ? '<span class="xm-c-dim">+' + (arr.length - 6) + '</span>' : '';
    return head + rest;
  }

  function libRowHtml(r) {
    const car = esc(r.carNum);
    const cells = [];

    const i = r.carNum.indexOf('-');
    const head = i > 0 ? r.carNum.slice(0, i) : r.carNum;
    const tail = i > 0 ? r.carNum.slice(i) : '';
    const label = esc(head) + (tail ? '<b>' + esc(tail) + '</b>' : '');
    const uf = unfilledReason(r);
    cells.push('<td><a class="xm-link xm-preview-link" href="#" data-car="' + car + '">' + label + '</a>' +
      (uf ? '<span class="xm-uf-tag' + (uf.fail ? ' xm-uf-fail' : '') + '" title="' + esc(uf.tip) + '">' + esc(uf.text) + '</span>' : '') + '</td>');
    const lookupCar = r.lookupCarNum || r.carNum;
    cells.push('<td><span class="xm-edit" data-field="lookupCarNum" data-val="' + esc(lookupCar) + '" title="点击修改用于 DB 搜索和补齐的番号">' +
      esc(lookupCar) + '</span> <button type="button" class="xm-refill-one" data-car="' + car + '">补齐</button></td>');
    cells.push('<td title="' + esc(r.title) + '">' +
      (r.title ? esc(r.title) : '<span class="xm-muted">未记录</span>') + '</td>');
    cells.push('<td title="' + esc(r.createDate) + '">' + addedAtCell(r.createDate) + '</td>');

    cells.push('<td class="xm-edit" data-field="names" data-val="' + esc(r.names) + '">' +
      (r.names ? esc(r.names) : '<span class="xm-muted">未记录</span>') + '</td>');

    cells.push('<td>' + (r.score
      ? '<span class="xm-badge">' + Number(r.score).toFixed(2) + (r.votes ? ' · ' + r.votes + '人' : '') + '</span>'
      : '<span class="xm-muted">—</span>') + '</td>');

    cells.push('<td class="xm-edit" data-field="publishTime" data-val="' + esc(r.publishTime) + '">' +
      (r.publishTime ? esc(r.publishTime) : '<span class="xm-muted">—</span>') + '</td>');
    cells.push('<td>' + (r.duration ? Number(r.duration) + ' 分钟' : '<span class="xm-muted">—</span>') + '</td>');

    cells.push('<td>' + dimCell(r.director) + '</td>');
    cells.push('<td>' + dimCell(r.maker) + '</td>');
    cells.push('<td>' + dimCell(r.series) + '</td>');
    cells.push('<td>' + tagsCell(r.tags) + '</td>');
    cells.push('<td><div class="xm-stage-inline" aria-label="影片分类" data-car="' + car + '">' +
      STAGES.map(function (s) {
        return '<button type="button" class="xm-stage-btn' + (stageOf(r) === s.v ? ' on' : '') +
          '" data-stage="' + s.v + '" data-car="' + car + '" aria-pressed="' +
          (stageOf(r) === s.v ? 'true' : 'false') + '">' + s.t + '</button>';
      }).join('') + '</div></td>');
    cells.push('<td>' + (r.watched
      ? '<span class="xm-badge">已看</span>'
      : '<span class="xm-muted">未看</span>') + '</td>');

    cells.push('<td class="xm-edit" data-field="remark" data-val="' + esc(r.remark) + '">' +
      (r.remark ? esc(r.remark) : '<span class="xm-muted">—</span>') + '</td>');
    cells.push('<td><button type="button" class="xm-delete-btn" data-car="' + car + '">删除</button></td>');

    return '<tr data-car="' + car + '">' + cells.join('') + '</tr>';
  }

  // 未补齐原因：失败过（含搜不到）/ DB 无收录 / 解析不全 / 还在待补队列
  // 注意：搜不到攒满 3 次后 bfNeed 会返回 false，但 failCount 还在，所以这里仍能找到它们
  function unfilledReason(row) {
    if ((row.failCount || 0) > 0) return { text: '失败×' + row.failCount, tip: '补齐失败过 ' + row.failCount + ' 次（多为 DB 搜不到），可改查询番号后单条补齐', fail: true };
    if (row.noDb) return { text: 'DB无收录', tip: 'JavDB 上没有这条记录', fail: false };
    if (row.partial) return { text: '解析不全', tip: '详情页只解析到一半，下次补齐会复核', fail: false };
    if (bfNeed(row)) return { text: '缺字段', tip: '还在待补队列里', fail: false };
    return null;
  }
  function isUnfilled(row) { return !!unfilledReason(row); }

  function libFilter() {
    const q = LIB.query;
    let view = LIB.rows.slice();
    // 按「筛选管理」的用途，搜索覆盖所有可见字段
    if (q) {
      view = view.filter(function (r) {
        const hay = [
          r.carNum, r.title, r.names, r.remark, r.director, r.maker, r.series, r.duration, r.createDate,
          r.lookupCarNum, (r.tags || []).join(' '), STAGES.find(function (s) { return s.v === stageOf(r); }).t,
          r.watched ? '已看' : '未看'
        ].join(' ').toLowerCase();
        return hay.indexOf(q) !== -1;
      });
    }
    // 只看未补齐：与搜索条件叠加
    if (LIB.onlyUnfilled) view = view.filter(isUnfilled);
    LIB.view = view;
  }

  function libSort() {
    const f = LIB.sortField;
    const dir = LIB.sortDir === 'asc' ? 1 : -1;
    LIB.view = LIB.view.slice().sort(function (a, b) {
      let x = a[f], y = b[f];
      if (typeof x === 'boolean' || typeof y === 'boolean') {
        return (Number(!!x) - Number(!!y)) * dir;
      }
      if (f === 'score') {
        return ((Number(x) || 0) - (Number(y) || 0)) * dir;
      }
      x = String(x == null ? '' : x);
      y = String(y == null ? '' : y);
      return x.localeCompare(y) * dir;
    });
  }

  function libPaintHead() {
    const ths = document.querySelectorAll('.xm-modal .xm-tb thead th');
    for (let i = 0; i < ths.length; i++) {
      const th = ths[i];
      const f = th.getAttribute('data-field');
      const arrow = th.querySelector('.xm-arrow');
      if (!arrow) continue;
      arrow.textContent = (f === LIB.sortField) ? (LIB.sortDir === 'asc' ? '▲' : '▼') : '';
    }
  }

  async function saveLookupCarNum(carNum, value) {
    if (BF.running) throw new Error('批量补齐运行期间不能修改查询番号');
    const car = String(carNum || '').trim().toUpperCase();
    const alias = String(value || '').trim().toUpperCase();
    if (!car || !alias) throw new Error('番号不能为空');
    const row = LIB.rows.find(function (x) { return x.carNum === car; });
    if (!row) throw new Error('找不到原始记录：' + car);
    const storedAlias = normalizeCarKey(alias) === normalizeCarKey(car) ? '' : alias;
    // carNum 仍作为 JHS 主键，单独保存查询别名，避免破坏收藏及其他状态关联。
    await XMeta.saveMany([[car, {
      carNum: car,
      lookupCarNum: storedAlias,
      dataForLookup: '',
      dbUrl: '',
      dbUrlForLookup: '',
      noDb: 0,
      dbLookupVersion: 0,
      fetchedAt: 0,
      dataParseVersion: 0,
      failCount: 0,
      lastFailAt: 0,
      // 切换匹配号后清掉旧详情页字段，避免新记录补不全时仍显示旧番号的内容。
      score: null,
      votes: null,
      cover: '',
      title: '',
      duration: null,
      director: '',
      maker: '',
      series: '',
      tags: [],
      actors: []
    }]]);
    await reloadRows();
  }

  async function deleteLibraryRecord(carNum) {
    const car = String(carNum || '').trim().toUpperCase();
    const row = LIB.rows.find(function (x) { return x.carNum === car; });
    if (!row) throw new Error('找不到记录：' + car);
    const message = '确定删除 ' + car + '？\n\n' +
      '这会删除当前网站的 JHS 记录和增强资料库数据，并在 DB/Bus 合并资料库中隐藏此番号。\n' +
      '另一网站自己的 JHS 原始记录不会被远程删除。';
    if (typeof window.confirm === 'function' && !window.confirm(message)) return false;
    if (!UW.stateService || typeof UW.stateService.remove !== 'function') {
      throw new Error('当前 JHS 版本没有提供安全删除接口');
    }

    await markCarDeleted(car, true);
    try {
      await UW.stateService.remove(car);
      await XMeta.saveMany([[car, { carNum: car, deleted: true, deletedAt: Date.now() }]]);
      await reloadRows();
      return true;
    } catch (e) {
      try { await markCarDeleted(car, false); } catch (e2) { /* keep original error */ }
      throw e;
    }
  }

  function libRender() {
    const tbody = document.getElementById('xm-tbody');
    if (!tbody) return;

    // 页码超限时收回（删记录 / 筛选变少后，停在不存在的页会显示空白）
    const totalPage = Math.max(1, Math.ceil(LIB.view.length / LIB.pageSize));
    if (LIB.page > totalPage) LIB.page = totalPage;
    if (LIB.page < 1) LIB.page = 1;
    const start = (LIB.page - 1) * LIB.pageSize;
    const slice = LIB.view.slice(start, start + LIB.pageSize);
    tbody.innerHTML = slice.map(libRowHtml).join('') ||
      '<tr><td colspan="' + LIB_COLS.length + '" style="padding:24px;text-align:center;color:#b4b2a9">没有记录</td></tr>';

    const pageBox = document.getElementById('xm-page');
    if (pageBox) pageBox.textContent = LIB.page + ' / ' + totalPage;
    const prev = document.getElementById('xm-prev');
    const next = document.getElementById('xm-next');
    if (prev) prev.disabled = LIB.page <= 1;
    if (next) next.disabled = LIB.page >= totalPage;

    const count = document.getElementById('xm-count');
    if (count) count.textContent = '共 ' + LIB.view.length + ' 条';

    libPaintHead();
    updateUnfilledBtn();
  }

  function libStartEdit(td) {
    if (td.querySelector('input')) return;
    const val = td.getAttribute('data-val') || '';
    const tr = td.closest('tr');
    if (!tr) return;
    const car = tr.getAttribute('data-car');
    const field = td.getAttribute('data-field');
    const oldHtml = td.innerHTML;

    const inp = document.createElement('input');
    inp.className = 'xm-input';
    inp.value = val;
    td.innerHTML = '';
    td.appendChild(inp);
    inp.focus();
    inp.select();

    let done = false;
    const finish = async function (commit) {
      if (done) return;
      done = true;
      const nv = inp.value.trim();
      td.innerHTML = oldHtml;
      if (!commit || nv === val.trim() || !nv) return;

      if (field === 'lookupCarNum') {
        const pending = saveLookupCarNum(car, nv);
        lookupSavePromises.set(car, pending);
        try {
          await pending;
          toast('查询番号已更新；点旁边“补齐”即可按新番号抓取 DB 数据');
        } catch (e) {
          toast('查询番号保存失败：' + (e && e.message ? e.message : e), true);
        } finally {
          if (lookupSavePromises.get(car) === pending) lookupSavePromises.delete(car);
        }
        return;
      }

      try {
        const rec = {};
        rec[field] = nv;
        await patchRecord(car, null, rec);
        td.setAttribute('data-val', nv);
        td.textContent = nv;
        const row = LIB.rows.find(function (x) { return x.carNum === car; });
        if (row) row[field] = nv;
        toast('已同步到 JHS：' + car);
      } catch (e) {
        toast('写回失败：' + (e && e.message ? e.message : e), true);
      }
    };

    inp.addEventListener('blur', function () { finish(true); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
  }

  const lookupSavePromises = new Map();

  function libClose() {
    const mask = document.getElementById('xm-mask');
    const modal = document.getElementById('xm-modal');
    if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
    if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
    document.removeEventListener('keydown', libEscHandler);
    LIB.open = false;
  }

  let xmColOutsideBound = false;

  function updateUnfilledBtn() {
    const b = document.getElementById('xm-unfilled-btn');
    if (!b) return;
    const n = LIB.rows.filter(isUnfilled).length;
    b.textContent = '未补齐' + (n ? ' (' + n + ')' : '');
    b.classList.toggle('on', !!LIB.onlyUnfilled);
  }

  // ---- 资料库列隐藏（持久化；列顺序与 LIB_COLS 一致，隐藏靠 CSS nth-child） ----
  function loadHiddenCols() {
    try {
      const list = JSON.parse(localStorage.getItem('xm:libcols:v1') || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function applyLibCols() {
    const tb = document.querySelector('#xm-modal .xm-tb');
    if (!tb) return;
    const hidden = loadHiddenCols();
    LIB_COLS.forEach(function (c) {
      tb.classList.toggle('xm-hide-' + c.key, hidden.indexOf(c.key) !== -1);
    });
  }
  function renderColPicker() {
    const box = document.getElementById('xm-col-picker');
    if (!box) return;
    const hidden = loadHiddenCols();
    let h = '';
    LIB_COLS.forEach(function (c) {
      const locked = c.key === 'carNum';
      h += '<label' + (locked ? ' class="xm-col-locked"' : '') + '>' +
        '<input type="checkbox" data-col="' + c.key + '"' +
        (locked ? ' checked disabled' : (hidden.indexOf(c.key) === -1 ? ' checked' : '')) + '> ' +
        esc(c.title) + (locked ? '（固定）' : '') + '</label>';
    });
    box.innerHTML = h;
    box.querySelectorAll('input[data-col]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        const key = inp.getAttribute('data-col');
        let list = loadHiddenCols();
        if (inp.checked) list = list.filter(function (k) { return k !== key; });
        else if (list.indexOf(key) === -1) list.push(key);
        try { localStorage.setItem('xm:libcols:v1', JSON.stringify(list)); } catch (e) { /* ignore */ }
        applyLibCols();
      });
    });
  }

  function libMount() {
    if (document.getElementById('xm-modal')) return;
    LIB.open = true;

    const mask = document.createElement('div');
    mask.id = 'xm-mask';
    mask.className = 'xm-mask';

    const modal = document.createElement('div');
    modal.id = 'xm-modal';
    modal.className = 'xm-modal';
    modal.innerHTML =
      '<div class="xm-hd">' +
        '<span class="xm-hd-title">资料库</span>' +
        '<span class="xm-hd-count">v' + XM_VERSION + '</span>' +
        '<span class="xm-hd-count" id="xm-count"></span>' +
        '<button class="xm-bf" id="xm-bf" type="button">补齐数据</button>' +
        '<button class="xm-probe-btn" id="xm-export-backup" type="button">导出备份</button>' +
        '<button class="xm-probe-btn" id="xm-import-backup" type="button">导入备份</button>' +
        '<button class="xm-probe-btn" id="xm-jellyfin-import" type="button" title="把本地资料库识别出的 Jellyfin 番号标为已存 Jellyfin">同步 Jellyfin</button>' +
        '<span class="xm-bf-info" id="xm-bf-info"></span>' +
        '<button class="xm-probe-btn" id="xm-probe-btn" type="button">诊断</button>' +
        '<button class="xm-probe-btn" id="xm-col-btn" type="button">列</button>' +
        '<button class="xm-probe-btn xm-density-btn" id="xm-density-btn" type="button">紧凑</button>' +
        '<button class="xm-probe-btn" id="xm-unfilled-btn" type="button">未补齐</button>' +
        '<input class="xm-hd-search" id="xm-search" type="text" placeholder="搜索番号 / 片名 / 演员 / 备注">' +
        '<button class="xm-close" id="xm-close" type="button">×</button>' +
      '</div>' +
      '<div class="xm-col-picker" id="xm-col-picker" hidden></div>' +
      '<div class="xm-bd">' +
        '<table class="xm-tb"><thead>' + libHeadHtml() + '</thead><tbody id="xm-tbody"></tbody></table>' +
      '</div>' +
      '<div class="xm-ft">' +
        '<span class="xm-ft-page" style="margin-left:auto;color:#8a8880;font-size:12px">分类可直接点击；DB查询番号可编辑并单条补齐</span>' +
        '<button id="xm-prev" type="button">上一页</button>' +
        '<span class="xm-ft-page" id="xm-page"></span>' +
        '<button id="xm-next" type="button">下一页</button>' +
      '</div>';

    document.body.appendChild(mask);
    document.body.appendChild(modal);

    mask.addEventListener('click', libClose);
    modal.querySelector('#xm-close').addEventListener('click', libClose);
    modal.querySelector('#xm-bf').addEventListener('click', function () {
      runBackfill().catch(function (e) { toast(String(e), true); });
    });
    modal.querySelector('#xm-export-backup').addEventListener('click', function () {
      downloadLibraryBackup().catch(function (e) { toast('资料库备份导出失败：' + (e && e.message ? e.message : e), true); });
    });
    modal.querySelector('#xm-import-backup').addEventListener('click', chooseLibraryBackup);
    modal.querySelector('#xm-probe-btn').addEventListener('click', function () {
      runProbe();
    });
    modal.querySelector('#xm-jellyfin-import').addEventListener('click', function (e) {
      const button = e.currentTarget;
      button.disabled = true;
      importJellyfinCollection().catch(function (err) {
        toast('Jellyfin 同步失败：' + (err && err.message ? err.message : err), true);
      }).finally(function () { button.disabled = false; });
    });

    // 列选择器 + 紧凑密度（表格每次打开都重建，故每次打开都要重应用）
    modal.querySelector('#xm-col-btn').addEventListener('click', function (ev) {
      ev.stopPropagation();
      const p = document.getElementById('xm-col-picker');
      if (!p) return;
      if (p.hidden) { renderColPicker(); p.hidden = false; }
      else p.hidden = true;
    });
    // 只看未补齐：与搜索框叠加；每次打开默认关闭
    LIB.onlyUnfilled = false;
    modal.querySelector('#xm-unfilled-btn').addEventListener('click', function () {
      LIB.onlyUnfilled = !LIB.onlyUnfilled;
      LIB.page = 1;
      libFilter(); libSort(); libRender();
    });
    modal.querySelector('#xm-density-btn').addEventListener('click', function () {
      const m = document.getElementById('xm-modal');
      const on = m && !m.classList.contains('xm-dense');
      if (m) m.classList.toggle('xm-dense', on);
      const b = document.getElementById('xm-density-btn');
      if (b) { b.classList.toggle('on', on); b.textContent = on ? '标准' : '紧凑'; }
      try { localStorage.setItem('xm:libdensity:v1', on ? 'dense' : ''); } catch (e) { /* ignore */ }
    });
    if (!xmColOutsideBound) {
      xmColOutsideBound = true;
      document.addEventListener('click', function (ev) {
        const p = document.getElementById('xm-col-picker');
        if (!p || p.hidden) return;
        if (ev.target.closest && (ev.target.closest('#xm-col-picker') || ev.target.closest('#xm-col-btn'))) return;
        p.hidden = true;
      });
    }
    applyLibCols();
    try {
      if (localStorage.getItem('xm:libdensity:v1') === 'dense') {
        modal.classList.add('xm-dense');
        const b = document.getElementById('xm-density-btn');
        if (b) { b.classList.add('on'); b.textContent = '标准'; }
      }
    } catch (e) { /* ignore */ }

    const thead = modal.querySelector('thead');
    thead.addEventListener('click', function (e) {
      const th = e.target.closest('th');
      if (!th || th.classList.contains('xm-nosort')) return;
      const f = th.getAttribute('data-field');
      if (!f) return;
      if (LIB.sortField === f) LIB.sortDir = LIB.sortDir === 'asc' ? 'desc' : 'asc';
      else { LIB.sortField = f; LIB.sortDir = 'asc'; }
      LIB.page = 1;
      libSort(); libRender();
    });

    const tbody = modal.querySelector('#xm-tbody');
    const openLibraryMovie = function (e) {
      const preview = e.target.closest('.xm-preview-link');
      if (preview) {
        if (e.type === 'auxclick' && e.button !== 1) return;
        if (e.type === 'click' && e.button !== 0) return;
        e.preventDefault();
        openJhsDetailByCar(preview.getAttribute('data-car'), e);
      }
    };
    tbody.addEventListener('click', openLibraryMovie);
    tbody.addEventListener('auxclick', openLibraryMovie);
    tbody.addEventListener('click', function (e) {
      const td = e.target.closest('.xm-edit');
      if (td) libStartEdit(td);
    });

    tbody.addEventListener('click', async function (e) {
      const btn = e.target.closest('.xm-refill-one');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const car = btn.getAttribute('data-car');
      const pendingSave = lookupSavePromises.get(car);
      if (pendingSave) {
        try { await pendingSave; }
        catch (err) { return; }
      }
      const row = LIB.rows.find(function (x) { return x.carNum === car; });
      if (!row) return;
      btn.disabled = true;
      try {
        await refillOneByRow(row);
        toast('已按“' + (row.lookupCarNum || row.carNum) + '”完成补齐：' + car);
      } catch (err) {
        toast('补齐失败：' + (err && err.message ? err.message : err), true);
      } finally {
        btn.disabled = false;
      }
    });

    tbody.addEventListener('click', async function (e) {
      const stageBtn = e.target.closest('.xm-stage-inline .xm-stage-btn');
      if (!stageBtn) return;
      e.preventDefault();
      e.stopPropagation();
      const car = stageBtn.getAttribute('data-car');
      const buttons = stageBtn.parentNode.querySelectorAll('.xm-stage-btn');
      buttons.forEach(function (button) { button.disabled = true; });
      try {
        await setMovieStage(car, stageBtn.getAttribute('data-stage'));
        toast('已更新分类：' + car);
      } catch (err) {
        toast('分类写入失败：' + (err && err.message ? err.message : err), true);
      } finally {
        buttons.forEach(function (button) { button.disabled = false; });
      }
    });

    tbody.addEventListener('click', async function (e) {
      const button = e.target.closest('.xm-delete-btn');
      if (!button) return;
      e.preventDefault();
      e.stopPropagation();
      const car = button.getAttribute('data-car');
      button.disabled = true;
      try {
        const removed = await deleteLibraryRecord(car);
        if (removed) toast('已删除：' + car);
      } catch (err) {
        toast('删除失败：' + (err && err.message ? err.message : err), true);
      } finally {
        button.disabled = false;
      }
    });

    tbody.addEventListener('change', async function (e) {
      const chk = e.target.closest('.xm-chk');
      if (!chk) return;
      const tr = chk.closest('tr');
      const car = tr.getAttribute('data-car');
      const field = chk.getAttribute('data-field');
      const next = chk.checked;
      chk.disabled = true;
      try {
        const st = {};
        st[field] = next;
        await patchRecord(car, st, null);
        const row = LIB.rows.find(function (x) { return x.carNum === car; });
        if (row) row[field] = next;
        toast((next ? '已标记' : '已取消') + '：' + car);
      } catch (err) {
        chk.checked = !next;
        toast('写回失败：' + (err && err.message ? err.message : err), true);
      } finally {
        chk.disabled = false;
      }
    });

    let searchTimer = null;
    modal.querySelector('#xm-search').addEventListener('input', function (e) {
      const v = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        LIB.query = v.trim().toLowerCase();
        LIB.page = 1;
        libFilter(); libSort(); libRender();
      }, 180);
    });

    modal.querySelector('#xm-prev').addEventListener('click', function () {
      if (LIB.page > 1) { LIB.page--; libRender(); }
    });
    modal.querySelector('#xm-next').addEventListener('click', function () {
      const totalPage = Math.max(1, Math.ceil(LIB.view.length / LIB.pageSize));
      if (LIB.page < totalPage) { LIB.page++; libRender(); }
    });

    document.addEventListener('keydown', libEscHandler);
    bfPaint();
    libRender();
  }

  function libEscHandler(e) {
    if (e.key === 'Escape' && LIB.open) {
      const input = document.activeElement;
      if (input && input.classList && input.classList.contains('xm-input')) return;
      libClose();
    }
  }

  async function openLibrary() {
    if (LIB.open) return;
    if (!jhsReady()) {
      const ok = await waitForJhs(12000);
      if (!ok) { toast('JHS 还没加载完成，请刷新页面后重试', true); return; }
    }
    try { await ensureJellyfinCollectionImported(); }
    catch (err) { console.warn('[JHS+] Jellyfin 自动分类失败', err && err.message ? err.message : err); }
    let rows;
    try { rows = await loadRows(); }
    catch (e) { toast('读取失败：' + (e && e.message ? e.message : e), true); return; }

    LIB.rows = rows;
    LIB.page = 1;
    LIB.query = '';
    libFilter();
    libSort();
    libMount();
  }

  /* ==================== 11.5 详情页补齐（按需发请求） ==================== */

  const DETAIL_LABELS = {
    '番號': 'carNum', '番号': 'carNum',
    '日期': 'releaseDate', '發行日期': 'releaseDate', '发行日期': 'releaseDate',
    '導演': 'director', '导演': 'director',
    '片商': 'maker', '廠商': 'maker', '發行商': 'maker', '发行商': 'maker',
    '系列': 'series',
    '評分': 'rating', '评分': 'rating',
    '類別': 'tags', '类别': 'tags', '標籤': 'tags', '标签': 'tags',
    '演員': 'actors', '演员': 'actors',
    '時長': 'duration', '时长': 'duration'
  };

  function blockValue(block) {
    const clone = block.cloneNode(true);
    const s = clone.querySelector('strong');
    if (s && s.parentNode) s.parentNode.removeChild(s);
    return (clone.textContent || '').replace(/\s+/g, ' ').trim().replace(/^[:：\s]+/, '');
  }

  function parseDetailHtml(html, baseUrl) {
    const out = {};
    let doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); }
    catch (e) { return out; }

    if (/just a moment|attention required/i.test(doc.title || '')) {
      out.__blocked = true;
      return out;
    }

    // 以 <strong> 为锚点，不依赖外层 class（JavDB 改版也不容易失效）
    const seen = {};
    const strongs = doc.querySelectorAll('strong');
    for (let i = 0; i < strongs.length; i++) {
      const st = strongs[i];
      const label = (st.textContent || '').replace(/[:：\s]/g, '');
      const field = DETAIL_LABELS[label];
      if (!field || seen[field]) continue;

      const host = st.parentElement;
      if (!host) continue;

      const links = host.querySelectorAll('a');
      const items = [];
      for (let j = 0; j < links.length; j++) {
        const t = (links[j].textContent || '').trim();
        if (t && items.indexOf(t) === -1) items.push(t);
      }

      if (field === 'carNum') { seen.carNum = 1; continue; }

      if (field === 'rating') {
        // JavDB 的「評分:」字段，值形如「4.5分, 由123人評價」
        const txt = (host.textContent || '').replace(/,/g, '');
        const sm = txt.match(/(\d+(?:\.\d+)?)/);
        if (sm) { out.score = parseFloat(sm[1]); seen.rating = 1; }
        const vm = txt.match(/(\d+)\s*人/);
        if (vm) out.votes = parseInt(vm[1], 10);
      } else if (field === 'actors') {
        if (items.length) { out.actors = items; seen.actors = 1; }
      } else if (field === 'tags') {
        if (items.length) { out.tags = items; seen.tags = 1; }
      } else if (field === 'duration') {
        const m = (host.textContent || '').match(/(\d{1,4})\s*(?:分鐘|分钟|min)/i);
        if (m) { out.duration = parseInt(m[1], 10); seen.duration = 1; }
      } else {
        const v = blockValue(host);
        if (v && v.length <= 200) { out[field] = v; seen[field] = 1; }
      }
    }

    // 评分：优先取带「由N人」的完整文本，避免拿到封面旁的整数
    const nodes = doc.querySelectorAll('.score, .score .value, [class*="score"], [class*="Score"]');
    let full = '';
    let plain = '';
    for (let i = 0; i < nodes.length; i++) {
      const t = (nodes[i].textContent || '').replace(/,/g, '').trim();
      if (!t || t.length > 80) continue;
      if (/由\s*\d+\s*人/.test(t)) { full = t; break; }
      if (!plain && /^\d+(\.\d+)?\s*分?$/.test(t)) plain = t;
    }
    const picked = full || plain;
    if (picked) {
      const v = parseFloat(picked);
      // 不覆盖「評分:」字段拿到的值（那个更准）
      if (v && (!out.score || (v % 1 !== 0 && out.score % 1 === 0))) out.score = v;
      const m = picked.match(/(?:由\s*)?(\d+)\s*人/);
      if (m && !out.votes) out.votes = parseInt(m[1], 10);
    }

    const og = doc.querySelector('meta[property="og:image"]');
    const cov = doc.querySelector('.video-cover, .column-video-cover img, a.bigImage img, .bigImage img');
    let cover = '';
    if (og) cover = og.getAttribute('content') || '';
    if (!cover && cov) cover = cov.getAttribute('src') || cov.getAttribute('data-src') || '';
    if (cover) {
      try { out.cover = new URL(cover, baseUrl || location.href).href; }
      catch (e) { out.cover = cover; }
    }

    const h2 = doc.querySelector('h2.title, .movie-title h2, h2[data-movie-title]');
    if (h2) out.title = (h2.textContent || '').trim();

    // 一个影片字段都没捞到 → 大概率不是详情页
    out.__partial = !out.director && !out.maker && !out.actors && !out.releaseDate && !out.series;

    return out;
  }

  // 诊断：抓一个页面，把结构摘要吐出来（用于定位解析失效）
  async function probe(url) {
    const target = url || (LIB.rows[0] && LIB.rows[0].url);
    if (!target) return { error: '没有可探测的 url' };

    const res = await fetch(target, { credentials: 'include', redirect: 'follow' });
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const out = {
      url: target,
      status: res.status,
      title: (doc.title || '').slice(0, 80),
      htmlLength: html.length,
      panelBlockCount: doc.querySelectorAll('.panel-block').length,
      strongCount: doc.querySelectorAll('strong').length,
      strongTexts: [],
      scoreNodes: [],
      labelHits: {}
    };

    const ss = doc.querySelectorAll('strong');
    for (let i = 0; i < ss.length && i < 40; i++) {
      out.strongTexts.push((ss[i].textContent || '').trim().slice(0, 20));
    }
    const sc = doc.querySelectorAll('[class*="score"], [class*="Score"]');
    for (let i = 0; i < sc.length && i < 12; i++) {
      out.scoreNodes.push({
        cls: String(sc[i].className || '').slice(0, 40),
        text: (sc[i].textContent || '').trim().slice(0, 50)
      });
    }
    ['導演', '导演', '片商', '系列', '類別', '类别', '演員', '演员', '番號', '番号', '日期', '時長'].forEach(function (l) {
      out.labelHits[l] = html.indexOf(l) !== -1;
    });

    // 直接把解析结果也带上，一眼看出能不能解析
    out.parsed = parseDetailHtml(html, target);

    return out;
  }

  function showProbe(text) {
    if (document.getElementById('xm-probe')) return;

    const mask = document.createElement('div');
    mask.id = 'xm-probe-mask';
    mask.className = 'xm-mask';

    const box = document.createElement('div');
    box.id = 'xm-probe';
    box.className = 'xm-modal';
    box.innerHTML =
      '<div class="xm-hd">' +
        '<span class="xm-hd-title">诊断结果</span>' +
        '<span class="xm-hd-count">把整段内容复制发给作者</span>' +
        '<button class="xm-close" id="xm-probe-close" type="button">×</button>' +
      '</div>' +
      '<div class="xm-bd" style="padding:12px">' +
        '<textarea id="xm-probe-text" readonly spellcheck="false"></textarea>' +
      '</div>' +
      '<div class="xm-ft">' +
        '<button id="xm-probe-copy" type="button" style="margin-left:auto">全选并复制</button>' +
      '</div>';

    document.body.appendChild(mask);
    document.body.appendChild(box);

    const ta = box.querySelector('#xm-probe-text');
    ta.value = text;

    const close = function () {
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      if (box.parentNode) box.parentNode.removeChild(box);
    };
    mask.addEventListener('click', close);
    box.querySelector('#xm-probe-close').addEventListener('click', close);
    box.querySelector('#xm-probe-copy').addEventListener('click', function () {
      ta.focus();
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      toast(ok ? '已复制到剪贴板' : '复制失败，请手动 Ctrl+C', !ok);
    });
  }

  async function runProbe() {
    const btn = document.getElementById('xm-probe-btn');
    if (btn) { btn.disabled = true; btn.textContent = '诊断中…'; }
    try {
      const r = await probe();
      showProbe(JSON.stringify(r, null, 2));
    } catch (e) {
      showProbe('诊断失败：' + (e && e.message ? e.message : e) +
        '\n\n可能是第一条记录的 url 打不开。\n' +
        '可以在控制台指定一个确认为详情页的地址再试：\n' +
        '__xmDebug.probe("https://javdb.com/v/xxxxx")');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '诊断'; }
    }
  }

  /* ---- 详情页链接：一律用 JavDB ---- */
  // JavDB 详情页形如 https://javdb.com/v/AbCdE；JavBus 形如 https://www.javbus.com/SSIS-001
  function isDbUrl(u) {
    return /^https?:\/\/(?:[a-z0-9-]+\.)*javdb\d*\.com\/v\//i.test(String(u || ''));
  }

  function sameHost(u) {
    try { return new URL(u, location.href).host === location.host; }
    catch (e) { return false; }
  }

  // 取页面 HTML：同域走 fetch（带 cookie），跨域优先 GM_xmlhttpRequest（绕 CORS）
  async function httpGetHtml(url) {
    if (!sameHost(url) && typeof GM_xmlhttpRequest !== 'function') {
      throw new Error('跨站抓取需要 GM_xmlhttpRequest 权限，请在油猴里重新允许');
    }

    if (typeof GM_xmlhttpRequest === 'function' && !sameHost(url)) {
      return await new Promise(function (res, rej) {
        let abortFn = null;
        const done = function (fn, arg) {
          if (abortFn && BF.aborters) BF.aborters.delete(abortFn);
          fn(arg);
        };
        const req = GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          timeout: BF.timeout,
          onload: function (r) {
            if (r.status === 429 || r.status === 403 || r.status === 503) {
              BF.throttled = true;
              done(rej, new Error('HTTP ' + r.status + '（限流）'));
              return;
            }
            if (r.status >= 400) { done(rej, new Error('HTTP ' + r.status)); return; }
            done(res, r.responseText || '');
          },
          onerror: function () { done(rej, new Error('网络错误')); },
          ontimeout: function () { done(rej, new Error('超时')); },
          onabort: function () { done(rej, new Error('已取消')); }
        });
        // 补齐停止时可取消进行中的跨站请求
        if (req && typeof req.abort === 'function' && BF.aborters) {
          abortFn = function () { try { req.abort(); } catch (e) { /* ignore */ } };
          BF.aborters.add(abortFn);
        }
      });
    }

    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let abortFn = null;
    if (ctrl && BF.aborters) {
      abortFn = function () { try { ctrl.abort(); } catch (e) { /* ignore */ } };
      BF.aborters.add(abortFn);
    }
    const timer = ctrl
      ? setTimeout(function () { try { ctrl.abort(); } catch (e) { /* noop */ } }, BF.timeout)
      : null;
    try {
      const r = await fetch(url, {
        credentials: 'include',
        redirect: 'follow',
        signal: ctrl ? ctrl.signal : undefined
      });
      if (r.status === 429 || r.status === 403 || r.status === 503) {
        BF.throttled = true;
        throw new Error('HTTP ' + r.status + '（限流）');
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } finally {
      if (timer) clearTimeout(timer);
      if (abortFn && BF.aborters) BF.aborters.delete(abortFn);
    }
  }

  // 用番号在 JavDB 搜索，取出 /v/xxx 详情链接。
  // JavBus 的记录（尤其新加的）没有 DB 的 url，只能靠这一步换过去。
  async function findDbUrl(carNum) {
    const car = String(carNum || '').toUpperCase().trim();
    if (!car) return '';

    // 同一次补齐里同一个番号只搜一次
    if (BF.searchCache && BF.searchCache.has(car)) return BF.searchCache.get(car);

    const q = 'https://javdb.com/search?q=' + encodeURIComponent(car) + '&f=all';
    const html = await httpGetHtml(q);
    if (!html) throw new Error('DB 搜索没有返回页面');

    let doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); }
    catch (e) { return ''; }

    const as = doc.querySelectorAll('a[href*="/v/"]');
    for (let i = 0; i < as.length; i++) {
      const href = as[i].getAttribute('href') || '';
      if (!/\/v\//.test(href)) continue;

      const st = as[i].querySelector('strong');
      const txt = st ? String(st.textContent || '').trim().toUpperCase() : '';
      const abs = new URL(href, 'https://javdb.com').href;

      if (normalizeCarKey(txt) === normalizeCarKey(car)) {
        if (BF.searchCache) BF.searchCache.set(car, abs);
        return abs;
      }
    }
    return '';
  }

  // 决定这条记录去哪儿抓：DB 链接直接用，否则先搜出 DB 链接，搜不到才退回原站
  async function resolveDetailUrl(row) {
    if (row.dbUrl && isDbUrl(row.dbUrl)) return { url: row.dbUrl, db: true };
    const lookupCar = row.lookupCarNum || row.carNum;
    const hasAlias = normalizeCarKey(lookupCar) !== normalizeCarKey(row.carNum);
    if (!hasAlias && isDbUrl(row.url)) return { url: row.url, db: true };
    const found = await findDbUrl(lookupCar);
    if (found) return { url: found, db: true };
    // 修改查询番号后不回退到原番号或 Bus，避免补到另一部影片的数据。
    if (hasAlias) return { url: '', db: false };
    return { url: row.url, db: false };
  }

  function normalizeCarKey(value) {
    return String(value || '').normalize('NFKC').trim().toUpperCase()
      .replace(/[‐‑‒–—―﹘﹣－]/g, '-')
      .replace(/[-\s_]+/g, '');
  }

  const BF = {
    running: false, stop: false, paused: false,
    done: 0, fail: 0, partial: 0, total: 0,
    gap: 800,          // 每条之间的间隔（会自动上下调整）
    conc: 3,           // 并发请求数
    timeout: 12000,    // 单条超时
    okStreak: 0, errStreak: 0, throttled: false,
    note: '', startedAt: 0, bg: false, lastPaint: 0
  };

  function bfNeed(row) {
    if (!row.url && !row.lookupCarNum) return false;
    if ((row.failCount || 0) >= 3) return false;      // 找不到 / 硬错误累计 3 次就放弃（网络、超时、限流不计入）
    const recheckOldMiss = !!row.noDb && (Number(row.dbLookupVersion) || 0) < DB_LOOKUP_VERSION;
    const missingMeta = !row.score || !row.names || !row.director || !row.maker || !row.cover || !row.title;
    const recheckOldData = !!row.fetchedAt && (Number(row.dataParseVersion) || 0) < META_PARSE_VERSION && missingMeta;
    if (row.noDb && !recheckOldMiss && !recheckOldData) return false; // DB 无收录且旧数据已复核时不重复
    if (recheckOldMiss) return true;                  // 旧版可能误判，升级后只复核一次
    if (row.partial && (row.partialCount || 0) < 2 && missingMeta) return true;  // 上次只解析到一半，复核一次
    if (row.fetchedAt) {
      // 旧版把“请求成功”误当成“字段齐全”；新解析器只对旧的不完整条目复核一次。
      return recheckOldData;
    }

    if (isDbUrl(row.url)) {
      return !row.score || !row.names || !row.director || !row.maker;
    }

    // Bus 链接：bus 没有评分、字段也不全，缺什么就重抓一次换成 DB 数据。
    // 已经齐了的放过，免得把几千条都排进队列。
    return !row.score || !row.names || !row.director || !row.maker ||
           !row.cover || !row.title;
  }

  function bfEta() {
    const left = Math.max(0, BF.total - BF.done - BF.fail);
    if (!left) return '';
    const perSec = Math.max(0.1, (BF.conc || 1) / ((BF.gap || 800) / 1000));
    const sec = left / perSec;
    const min = Math.ceil(sec / 60);
    if (min < 60) return '剩余约 ' + min + ' 分钟';
    return '剩余约 ' + (min / 60).toFixed(1) + ' 小时';
  }

  function bfPaint() {
    const btn = document.getElementById('xm-bf');
    const info = document.getElementById('xm-bf-info');
    if (btn) {
      btn.textContent = BF.running ? '停止' : '补齐数据';
      if (BF.running) btn.classList.add('running');
      else btn.classList.remove('running');
    }
    if (!info) return;
    if (BF.running) {
      const pct = BF.total ? Math.round(BF.done / BF.total * 100) : 0;
      info.textContent = (BF.bg ? '后台低速 ' : '') +
        BF.done + '/' + BF.total + '（' + pct + '%） · ' + bfEta() +
        (BF.fail ? ' · 失败 ' + BF.fail : '') +
        (BF.note ? ' · ' + BF.note : '');
      return;
    }
    const rest = LIB.rows.filter(bfNeed).length;
    info.textContent = rest
      ? '待补 ' + rest + ' 条 · 约 ' + Math.ceil(rest * BF.gap / BF.conc / 60000) + ' 分钟'
      : (LIB.rows.length ? '已全部补齐' : '');
  }

  function bfMerge(row, meta) {
    if (meta.title) row.title = meta.title;
    // 评分：详情页常只有整数（封面旁那个大数字），不能覆盖已有的精确小数
    if (meta.score) {
      const cur = typeof row.score === 'number' ? row.score : 0;
      if (!cur) row.score = meta.score;
      else if (meta.score % 1 !== 0 && cur % 1 === 0) row.score = meta.score;
    }
    if (meta.votes && !row.votes) row.votes = meta.votes;
    if (meta.cover) row.cover = meta.cover;
    if (meta.publishTime && !row.publishTime) row.publishTime = meta.publishTime;
    if (meta.duration) row.duration = meta.duration;
    if (meta.director) row.director = meta.director;
    if (meta.maker) row.maker = meta.maker;
    if (meta.series) row.series = meta.series;
    if (meta.tags && meta.tags.length) row.tags = meta.tags;
    if (!row.names && meta.actors && meta.actors.length) row.names = meta.actors.join(' ');
  }

  // 抓一条：带超时、限流识别。
  // Bus 来的记录会先用 DB 搜索换成 DB 详情页 —— 以 DB 数据为准。
  async function bfFetchOne(row, opts) {
    const target = await resolveDetailUrl(row);
    if (!target.url) throw new Error('DB 未找到番号“' + (row.lookupCarNum || row.carNum) + '”，请检查查询番号格式');

    const html = await httpGetHtml(target.url);
    const d = parseDetailHtml(html, target.url);
    if (d.__blocked) {
      BF.throttled = true;
      throw new Error('遇到验证页');
    }

    const isPartial = !!d.__partial;
    if (isPartial) {
      BF.partial++;
      console.warn('[资料库] 该页没解析到影片字段，可能不是详情页（下次补齐会复核一次）：', row.carNum, target.url);
    }

    const now = Date.now();
    const rec = { carNum: row.carNum, updatedAt: now, fetchedAt: now, dataParseVersion: META_PARSE_VERSION,
      dataForLookup: row.lookupCarNum || row.carNum,
      failCount: 0, lastFailAt: 0,
      dbLookupVersion: DB_LOOKUP_VERSION };
    if (target.db) {
      rec.dbUrl = target.url;
      rec.dbUrlForLookup = row.lookupCarNum || row.carNum;
      rec.noDb = 0;
    }
    // DB 上搜不到这条（比如只有 bus 才收录的片），记一下，别让它反复进队列
    else rec.noDb = 1;

    const prev = (xmem && xmem.get(row.carNum)) || {};

    // 评分：详情页有时只有整数（封面旁那个大数字），不能把已有的两位小数冲掉
    if (d.score) {
      const cur = typeof prev.score === 'number' ? prev.score : 0;
      if (!cur || (d.score % 1 !== 0 && cur % 1 === 0)) rec.score = d.score;
    }
    if (d.votes && !prev.votes) rec.votes = d.votes;
    if (d.cover) rec.cover = d.cover;
    if (d.releaseDate) rec.publishTime = d.releaseDate;
    if (d.title) rec.title = d.title;
    if (d.duration) rec.duration = d.duration;
    if (d.director) rec.director = d.director;
    if (d.maker) rec.maker = d.maker;
    if (d.series) rec.series = d.series;
    if (d.tags && d.tags.length) rec.tags = d.tags;
    if (d.actors && d.actors.length) rec.actors = d.actors;

    if (isPartial) { rec.partial = 1; rec.partialCount = (prev.partialCount || 0) + 1; }
    else { rec.partial = 0; rec.partialCount = 0; }
    // 批量模式下先攒着，由补齐循环统一写；单条补齐仍立即写
    if (opts && opts.batch) opts.batch.push([row.carNum, rec]);
    else await XMeta.saveMany([[row.carNum, rec]]);
    bfMerge(row, rec);
    if (target.db) row.url = target.url;
    else row.noDb = 1;
    row.fetchedAt = now;
    row.dataParseVersion = META_PARSE_VERSION;
    row.failCount = 0;
    row.lastFailAt = 0;
    row.partial = isPartial ? 1 : 0;
    row.partialCount = isPartial ? ((prev.partialCount || 0) + 1) : 0;
    if (target.db) row.noDb = false;
    row.dbLookupVersion = DB_LOOKUP_VERSION;
    return true;
  }

  async function refillOneByRow(row) {
    if (BF.running) throw new Error('批量补齐正在运行，请等它结束后再单条补齐');
    if (!jhsReady()) throw new Error('JHS 尚未就绪');
    const oldFailCount = row.failCount || 0;
    row.failCount = 0;
    try {
      await bfFetchOne(row);
      await reloadRows();
      bfPaint();
    } catch (e) {
      row.failCount = oldFailCount;
      throw e;
    }
  }

  async function runBackfill() {
    if (BF.running) {
      BF.stop = true;
      // 正在进行的请求也一起取消，不用等最长 12 秒超时
      if (BF.aborters) BF.aborters.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
      return;
    }

    const targets = LIB.rows.filter(bfNeed);
    if (!targets.length) { toast('没有需要补齐的记录'); return; }

    const perSec = Math.max(0.1, BF.conc / (BF.gap / 1000));
    const mins = Math.ceil(targets.length / perSec / 60);

    if (typeof window.confirm === 'function') {
      const ok = window.confirm(
        '共 ' + targets.length + ' 条待补。\n' +
        '并发 ' + BF.conc + ' 路，每条间隔 ' + (BF.gap / 1000) + ' 秒，预计约 ' + mins + ' 分钟。\n' +
        '全部以 JavDB 数据为准：JavBus 链接会先在 JavDB 搜索番号换成 DB 详情页再抓，' +
        '所以会比纯 DB 记录多一步、慢一些。\n' +
        '遇到限流会自动降速；随时可点「停止」，抓过的不会重复抓。\n' +
        '切到后台会变慢（浏览器限制计时器），但不会停。\n\n继续吗？'
      );
      if (!ok) return;
    }

    BF.running = true;
    BF.stop = false;
    BF.paused = false;
    BF.done = 0; BF.fail = 0; BF.partial = 0;
    BF.total = targets.length;
    BF.okStreak = 0; BF.errStreak = 0; BF.throttled = false;
    BF.note = ''; BF.startedAt = Date.now();
    BF.lastPaint = 0;
    BF.aborters = new Set();
    BF.searchCache = new Map();
    bfPaint();

    let cursor = 0;
    const pendingSaves = [];
    let lastSaveAt = Date.now();

    async function worker() {
      while (!BF.stop && cursor < targets.length) {
        const row = targets[cursor++];
        if (!row) break;

        let ok = false;
        let skipGap = false;
        try {
          ok = await bfFetchOne(row, { batch: pendingSaves });
          BF.done++;
          // 攒批写：满 20 条或满 5 秒才写一次，避免每条都全库序列化
          if (pendingSaves.length >= 20 || Date.now() - lastSaveAt >= 5000) {
            const chunk = pendingSaves.splice(0, pendingSaves.length);
            if (chunk.length) { await XMeta.saveMany(chunk); lastSaveAt = Date.now(); }
          }
        } catch (e) {
          BF.fail++;
          console.warn('[资料库] 补齐失败', row.carNum, e && e.message ? e.message : e);

          // 只有找不到 / 硬错误才累计失败次数；网络、超时、限流、取消不计入，
          // 否则瞬时故障攒满 3 次会把记录永久排除
          const msg = e && e.message ? e.message : '';
          const transient = /网络错误|超时|限流|验证页|HTTP 429|HTTP 403|HTTP 503|已取消/.test(msg) ||
            (e && e.name === 'AbortError');
          if (!transient) {
            row.failCount = (row.failCount || 0) + 1;
            try {
              await XMeta.saveMany([[row.carNum, {
                carNum: row.carNum,
                failCount: row.failCount,
                lastFailAt: Date.now()
              }]]);
            } catch (e2) { /* noop */ }
          }

          if (BF.throttled) {
            BF.throttled = false;
            BF.gap = Math.min(8000, Math.round(BF.gap * 1.6));
            BF.note = '限流降速';
            bfPaint();
            await sleep(8000);
            skipGap = true;   // 已经等过 8 秒，不再补一次间隔
          }
        }

        // 自适应调速：连续成功就提速，连续失败就降速
        if (ok) {
          BF.okStreak++; BF.errStreak = 0;
          if (BF.okStreak >= 12 && BF.gap > 500) {
            BF.gap = Math.max(500, Math.round(BF.gap * 0.85));
            BF.okStreak = 0;
            BF.note = '';
          }
        } else {
          BF.errStreak++; BF.okStreak = 0;
          if (BF.errStreak >= 3) {
            BF.gap = Math.min(8000, Math.round(BF.gap * 1.6));
            BF.errStreak = 0;
            BF.note = '失败降速';
          }
        }

        BF.bg = !!document.hidden;
        bfPaint();

        // 刷新节流：最多 2 秒一次；墙没打开时跳过墙侧刷新（只刷表格）
        const nowMs = Date.now();
        if (nowMs - BF.lastPaint >= 2000) {
          BF.lastPaint = nowMs;
          if (LIB.open) libRender();
          if (wallIsOpen()) {
            apply();
            if (cond.sort && cond.sort !== 'default') applySort();
            refreshPanelIfIdle();
          }
        }

        if (!BF.stop && !skipGap) await sleep(BF.gap);
      }
    }

    const workers = [];
    for (let i = 0; i < Math.max(1, BF.conc | 0); i++) workers.push(worker());
    await Promise.all(workers);

    // 收尾：把攒批的写入一次写掉并立即刷盘（停止时也走这里，不丢进度）
    if (pendingSaves.length) await XMeta.saveMany(pendingSaves);
    await XMeta.flush();
    BF.searchCache = null;
    BF.aborters = null;

    BF.running = false;
    BF.bg = false;
    BF.note = '';
    bfPaint();
    await reloadRows();      // 让图墙看到刚补齐的字段
    libRender();
    refreshPanelIfIdle();

    const rest = LIB.rows.filter(bfNeed).length;
    toast('结束：成功 ' + BF.done +
          (BF.fail ? '，失败 ' + BF.fail : '') +
          (BF.partial ? '，' + BF.partial + ' 条疑似非详情页' : '') +
          (rest ? '，还剩 ' + rest + ' 条' : '，已全部补齐'));
  }

  /* ==================== 12. 导航栏按钮 ==================== */

  let navMiss = 0;

  function bindOpenLibrary(btn) {
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      openLibrary().catch(function (e) { toast(String(e), true); });
    });
  }

  // 导航栏一直找不到时的兜底：左下角浮动按钮
  function ensureNavButton() {
    const old = document.getElementById('xmBtn');
    if (old) {
      navMiss = 0;
      // 老版本只建了资料库按钮，补一个图墙
      if (!document.getElementById('xmWallBtn') && old.parentNode) {
        const w = document.createElement('button');
        w.id = 'xmWallBtn';
        w.type = 'button';
        w.className = old.className;
        w.textContent = '图墙';
        w.addEventListener('click', function (ev) {
          ev.preventDefault();
          try {
            openWall();
            w.classList.toggle('on', wallIsOpen());
          } catch (e) { console.error('[JHS+] 打开图墙失败', e); }
        });
        old.parentNode.insertBefore(w, old);
      }
      return;
    }

    // JavDB 用 bulma 的 .navbar-end；JavBus 是 #navbar > div > div > span
    const host = document.querySelector('.navbar-end') ||
                 document.querySelector('.navbar-menu') ||
                 document.querySelector('#navbar > div > div > span') ||
                 document.getElementById('navbar');
    if (!host) { navMiss++; return; }
    navMiss = 0;

    const wrap = document.createElement('div');
    wrap.className = 'navbar-item';

    // 图墙入口：跳到页面上方的图墙
    const wallBtn = document.createElement('button');
    wallBtn.id = 'xmWallBtn';
    wallBtn.type = 'button';
    wallBtn.className = 'jhs-btn navbar-link nav-btn jhs-nav-btn';
    wallBtn.textContent = '图墙';
    wallBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      try {
        openWall();
        wallBtn.classList.toggle('on', wallIsOpen());
      } catch (e) {
        console.error('[JHS+] 打开图墙失败', e);
        wallBtn.classList.remove('on');
        closeWall();
      }
    });
    wrap.appendChild(wallBtn);

    const btn = document.createElement('button');
    btn.id = 'xmBtn';
    btn.type = 'button';
    btn.className = 'jhs-btn navbar-link nav-btn jhs-nav-btn';
    btn.textContent = '资料库';
    bindOpenLibrary(btn);
    wrap.appendChild(btn);

    // 优先贴到「鉴定记录」右边；没有就追加到导航容器末尾
    const anchor = document.getElementById('historyBtn');
    if (anchor && anchor.parentElement) {
      anchor.parentElement.insertAdjacentElement('afterend', wrap);
    } else if (host.appendChild) {
      host.appendChild(wrap);
    }
  }

  /* ==================== 14. 列表页瀑布流（受控加载） ==================== */

  const WF = {
    started: false,
    loading: false,
    hasMore: false,
    nextUrl: null,
    page: 1,
    loaded: 0,
    limit: 300,
    gap: 900,
    container: null,
    loader: null,
    seen: null
  };

  function wfPageNum() {
    const m = location.search.match(/[?&]page=(\d+)/);
    return m ? parseInt(m[1], 10) : 1;
  }

  // JHS 自己的筛选若不在「全部」，新追加的卡片不会被它处理，先暂停加载
  function jhsFilterActive() {
    const a = document.querySelector('#jhs-quick-filter .jhs-segmented__item.active');
    if (!a) return false;
    const k = a.getAttribute('data-jhs-filter');
    return !!k && k !== 'all';
  }

  function wfSet(text, state) {
    if (!WF.loader) return;
    WF.loader.textContent = text;
    WF.loader.className = 'xm-wf' + (state ? ' xm-wf--' + state : '');
  }

  function wfFixImages(root) {
    const imgs = (root || document).querySelectorAll('img[data-src]');
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      if (!img.getAttribute('src')) {
        const ds = img.getAttribute('data-src');
        if (ds) img.setAttribute('src', ds);
      }
    }
  }

  // 用影子库给卡片补一行：评分 · 人数 · 导演
  async function wfDecorate(nodes) {
    const mem = await XMeta.loadAll();
    if (!mem.size) return;
    const list = nodes || document.querySelectorAll('.movie-list .item');
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (el.querySelector('.xm-card-line')) continue;
      const car = carNumOf(el);
      if (!car) continue;
      const m = mem.get(car);
      if (!m) continue;

      const parts = [];
      if (m.score) parts.push(Number(m.score).toFixed(2));
      if (m.votes) parts.push(m.votes + '人');
      if (m.director) parts.push(m.director);
      if (!parts.length) continue;

      const line = document.createElement('div');
      line.className = 'xm-card-line';
      line.textContent = parts.join(' · ');

      const meta = el.querySelector('.meta');
      if (meta && meta.parentNode) meta.insertAdjacentElement('afterend', line);
      else el.appendChild(line);
    }
  }

  function wfSeenInit() {
    WF.seen = new Set();
    const items = WF.container.querySelectorAll('.item');
    for (let i = 0; i < items.length; i++) {
      const c = carNumOf(items[i]);
      if (c) WF.seen.add(c);
    }
  }

  async function wfLoad() {
    if (WF.loading || !WF.hasMore || !WF.nextUrl) return;

    if (jhsFilterActive()) {
      wfSet('当前有筛选条件，切到「全部」后才继续加载', 'error');
      return;
    }

    WF.loading = true;
    wfSet('加载中…', 'loading');

    try {
      await sleep(WF.gap);

      const res = await fetch(WF.nextUrl, { credentials: 'include' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const html = await res.text();

      const doc = new DOMParser().parseFromString(html, 'text/html');
      const nodes = doc.querySelectorAll('.movie-list .item');
      if (!nodes.length) {
        WF.hasMore = false;
        wfSet('没有更多了', 'nomore');
        return;
      }

      const fresh = [];
      let dup = 0;
      for (let i = 0; i < nodes.length; i++) {
        const car = carNumOf(nodes[i]);
        if (!car) continue;
        if (WF.seen.has(car)) { dup++; continue; }
        WF.seen.add(car);
        fresh.push(nodes[i]);
      }

      // 番号大面积重复 = JavDB 已到页尾，返回的是重复内容
      if (!fresh.length || dup >= nodes.length * 0.8) {
        WF.hasMore = false;
        wfSet('已经到底了', 'nomore');
        return;
      }

      for (let i = 0; i < fresh.length; i++) {
        WF.container.appendChild(document.importNode(fresh[i], true));
      }
      WF.page++;
      WF.loaded += fresh.length;

      wfFixImages(WF.container);
      await wfDecorate(fresh);
      collectFromList()
        .then(function () {
          apply();                        // 新卡片立刻套用当前筛选
          if (cond.sort && cond.sort !== 'default') applySort();
        })
        .catch(function () { /* 顺手采集 */ });

      const next = doc.querySelector('.pagination-next');
      WF.nextUrl = next ? next.getAttribute('href') : null;
      WF.hasMore = !!WF.nextUrl;

      if (!WF.hasMore) wfSet('已经到底了 · 共 ' + WF.loaded + ' 条', 'nomore');
      else if (WF.loaded >= WF.limit) wfSet('已加载 ' + WF.loaded + ' 条，点击继续', '');
      else wfSet('继续下滑加载更多 · 已 ' + WF.loaded + ' 条', '');

    } catch (e) {
      wfSet('加载失败，点击重试', 'error');
      console.warn('[JHS+] 瀑布流加载失败', e && e.message ? e.message : e);
    } finally {
      WF.loading = false;
    }
  }

  let wfTick = false;

  function wfOnScroll() {
    if (wfTick) return;
    wfTick = true;
    requestAnimationFrame(function () {
      wfTick = false;
      if (!WF.started || WF.loading || !WF.hasMore || !WF.loader) return;
      if (WF.loaded >= WF.limit) return;
      const r = WF.loader.getBoundingClientRect();
      if (r.top < window.innerHeight + 500) wfLoad();
    });
  }

  function wfStart() {
    if (WF.started) return;
    if (!document.querySelector('.movie-list')) return;

    // JHS 自己已经在这个页面跑瀑布流了，别抢
    if (document.querySelector('.jhs-scroll')) return;

    const box = document.querySelector('.movie-list');
    if (!box.parentNode) return;

    WF.started = true;
    WF.container = box;
    WF.page = wfPageNum();
    WF.loaded = box.querySelectorAll('.item').length;

    const next = document.querySelector('.pagination-next');
    WF.nextUrl = next ? next.getAttribute('href') : null;
    WF.hasMore = !!WF.nextUrl;

    wfSeenInit();

    const el = document.createElement('div');
    el.className = 'xm-wf';
    el.textContent = WF.hasMore
      ? '继续下滑加载更多 · 已 ' + WF.loaded + ' 条'
      : '已经是最后一页';
    if (!WF.hasMore) el.classList.add('xm-wf--nomore');
    el.addEventListener('click', function () {
      if (!WF.hasMore && WF.loader.classList.contains('xm-wf--error')) {
        WF.hasMore = true;
        wfLoad();
      } else if (WF.hasMore && !WF.loading) {
        wfLoad();
      }
    });
    box.parentNode.insertBefore(el, box.nextSibling);
    WF.loader = el;

    wfFixImages(document);
    wfDecorate();
    window.addEventListener('scroll', wfOnScroll, { passive: true });
  }

  /* ==================== 13. 启动 ==================== */

  let timer = null;

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      ensureStyle();
      ensureNavButton();
      if (document.querySelector(ITEM_SEL)) {
        // 两站都采集列表数据；首页分类按钮只放在 DB 卡片上。
        collectFromList().then(function () {
          return isDbSite() ? decorateListStageControls() : undefined;
        })
          .catch(function () { /* 静默 */ });
      }
      if (document.querySelector('.jhs-history-dialog')) scheduleDecorate();
    }, 150);
  }

  function boot() {
    ensureStyle();
    console.log('[JHS+] v3.4.3 loaded @ ' + location.host);

    waitForJhs(12000).then(async function (ready) {
      if (!ready) return;
      installStageSync();
      try { await ensureJellyfinCollectionImported(); }
      catch (e) { console.warn('[JHS+] Jellyfin 自动分类失败', e && e.message ? e.message : e); }
      schedule();
    });

    schedule();

    // 只在 DB 列表处理分类按钮，BUS 页不注入也不监听这组卡片按钮。
    if (isDbSite()) document.addEventListener('click', handleListStageClick, true);

    const mo = new MutationObserver(function () {
      schedule();
    });
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-jhs-flags', 'data-jhs-recent']
    });

    // 导航栏按钮：常驻守护，每 2 秒检查一次。
    // JHS / JavDB 会重渲染导航栏，按钮被吃掉后必须能自己回来。
    ensureNavButton();
    setInterval(function () {
      try { ensureNavButton(); } catch (e) { /* noop */ }
    }, 2000);

  }

  function status() {
    return {
      version: '3.4.3',
      url: location.href,
      navbarEnd: !!document.querySelector('.navbar-end'),
      navbarMenu: !!document.querySelector('.navbar-menu'),
      historyBtn: !!document.getElementById('historyBtn'),
      xmBtn: !!document.getElementById('xmBtn'),
      fab: !!document.getElementById('xmFab'),
      quickFilter: !!document.getElementById('jhs-quick-filter'),
      items: document.querySelectorAll(ITEM_SEL).length,
      jhsReady: jhsReady(),
      storeMode: XMeta.mode,
      storeSize: XMeta.mem ? XMeta.mem.size : 0,
      libRows: LIB.rows.length,
      bfPending: LIB.rows.filter(bfNeed).length,
      bfGap: BF.gap,
      bfConc: BF.conc,
      bfRunning: BF.running,
      noData: noData,
      kept: kept,
      total: total,
      dimOpen: XL.dim,
      wallCards: WALL.rows.length,
      wallPage: WALL.page,
      withCover: LIB.rows.filter(function (r) { return !!r.cover; }).length,
      withActor: LIB.rows.filter(function (r) { return !!r.names; }).length
    };
  }

  window.__xmDebug = {
    loadRows: loadRows,
    patchRecord: patchRecord,
    openLibrary: openLibrary,
    closeLibrary: libClose,
    collect: collectFromList,
    store: XMeta,
    lib: LIB,
    jhsReady: jhsReady,
    parseDetail: parseDetailHtml,
    isDbUrl: isDbUrl,
    resolveDetailUrl: resolveDetailUrl,
    bfNeed: bfNeed,
    probe: probe,
    backfill: runBackfill,
    bf: BF,
    wf: WF,
    cond: function () { return Object.assign({}, cond); },
    setCond: function (patch) {
      Object.assign(cond, patch || {});
      // 自动展开第一个有条件的维度，方便看到当前筛的是什么
      let first = '';
      for (let i = 0; i < DIMS.length; i++) {
        if (dimDirty(DIMS[i])) { first = DIMS[i].k; break; }
      }
      XL.dim = first;
      saveCond();
      renderPanel();
      paintPanel();
      apply();
    },
    wall: WALL,
    reload: reloadRows,
    // 看某个字段有多少不重复值，判断「标签不全」是截断还是数据本来就少
    metaStats: function (field) {
      const f = field || 'actor';
      const cnt = new Map();
      const mem = xmem || new Map();
      mem.forEach(function (m) {
        let arr = [];
        if (f === 'actor') {
          arr = (Array.isArray(m.actors) && m.actors.length)
            ? m.actors
            : (m.names ? String(m.names).split(/[\s,，]+/) : []);
        } else {
          const v = m[f];
          if (v) arr = [v];
        }
        arr.forEach(function (v) {
          v = String(v || '').trim();
          if (!v) return;
          cnt.set(v, (cnt.get(v) || 0) + 1);
        });
      });
      const list = Array.from(cnt.entries()).sort(function (a, b) { return b[1] - a[1]; });
      return { field: f, records: mem.size, unique: list.length, top: list.slice(0, 30) };
    },
    sort: applySort,
    renderPanel: renderPanel,
    // 清掉「抓过」标记，让所有记录重新进待补队列（字段解析规则改过之后用）
    resetFetched: async function () {
      const mem = await XMeta.loadAll();
      const batch = [];
      mem.forEach(function (v, k) {
        if (v.fetchedAt || v.dataParseVersion || v.failCount || v.noDb) {
          batch.push([k, { carNum: k, fetchedAt: 0, dataParseVersion: 0, failCount: 0, lastFailAt: 0, noDb: 0, dbLookupVersion: 0 }]);
        }
      });
      if (batch.length) await XMeta.saveMany(batch);
      LIB.rows.forEach(function (r) {
        r.fetchedAt = 0; r.dataParseVersion = 0; r.failCount = 0; r.lastFailAt = 0; r.noDb = false; r.dbLookupVersion = 0;
      });
      bfPaint();
      return batch.length;
    },
    // 打开 / 关闭图墙（导航栏按钮也走这里）
    openWall: openWall,
    closeWall: closeWall,
    mount: function () {
      openWall();
      return {
        open: wallIsOpen(),
        panel: !!document.getElementById('xflt-panel'),
        cards: WALL.rows.length,
        page: WALL.page,
        libRows: LIB.rows.length
      };
    },
    status: status
  };

  boot();

  } catch (err) {
    // 任何未被捕获的启动错误，直接画在页面上，不依赖控制台
    try {
      var box = document.createElement('div');
      box.textContent = 'JHS 增强启动出错：' +
        (err && err.message ? err.message : String(err));
      box.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
        'background:#c62828;color:#fff;padding:12px 16px;font:14px system-ui,sans-serif;' +
        'white-space:pre-wrap;box-shadow:0 2px 12px rgba(0,0,0,.4);';
      document.body.appendChild(box);
    } catch (e2) { /* noop */ }
  }
})();
