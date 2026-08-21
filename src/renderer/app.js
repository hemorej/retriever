(function () {
  const { createApp, reactive, ref, computed, onMounted, onUnmounted, nextTick, watch } = Vue;

  // ---------- helpers ----------
  // Fixed column count for the main grid — the thumbnail-size slider changes
  // row height, not column count, matching the design's fixed 6-up layout.
  const GRID_COLS = 6;
  const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff']);
  function isImagePath(p) {
    const i = p.lastIndexOf('.');
    return i !== -1 && IMAGE_EXTENSIONS.has(p.slice(i).toLowerCase());
  }
  function basename(p) { const parts = p.split('/'); return parts[parts.length - 1]; }
  function dirname(p) { const parts = p.split('/'); parts.pop(); return parts.join('/'); }
  function extname(p) { const b = basename(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i + 1).toLowerCase(); }
  function stripExt(p) { const b = basename(p); const i = b.lastIndexOf('.'); return i <= 0 ? b : b.slice(0, i); }
  function uid(prefix) { return prefix + Math.random().toString(36).slice(2, 9); }
  function fileUrl(p) { return 'file://' + p.split('/').map(encodeURIComponent).join('/'); }
  function fmtBytes(n) {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }
  function fmtDate(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  function fmtElapsed(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s} second${s === 1 ? '' : 's'} ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
    const h = Math.round(m / 60);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  function isTypingTarget(el) {
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  const TAGS = [
    { name: 'select', className: 't-select', var: 'var(--tag-select)' },
    { name: 'reject', className: 't-reject', var: 'var(--tag-reject)' },
    { name: 'maybe', className: 't-maybe', var: 'var(--tag-maybe)' },
    { name: 'published', className: 't-published', var: 'var(--tag-published)' },
  ];
  const TAG_BY_KEY = { 1: 'select', 2: 'reject', 3: 'maybe', 4: 'published' };
  function tagMeta(name) { return TAGS.find((t) => t.name === name) || { className: '', var: '#888' }; }

  // ---------- small shared components ----------
  const AppMark = {
    props: { size: { type: Number, default: 18 }, fill: { type: String, default: '#c9a24d' } },
    template: `<span :style="{
      display: 'inline-block', width: size + 'px', height: size + 'px', flex: 'none',
      backgroundColor: fill,
      WebkitMaskImage: 'url(./icon.png)', maskImage: 'url(./icon.png)',
      WebkitMaskSize: 'contain', maskSize: 'contain',
      WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
      WebkitMaskPosition: 'center', maskPosition: 'center',
    }"></span>`,
  };

  const Toast = {
    props: { message: String },
    template: `<transition name="toast">
      <div v-if="message" style="position:fixed;left:50%;bottom:38px;transform:translateX(-50%);background:rgba(32,32,34,.97);border:1px solid #3c3c3f;color:#e6e4e2;font-size:12px;padding:9px 14px;border-radius:7px;box-shadow:0 12px 30px -10px rgba(0,0,0,.7);z-index:100;font-family:Geist,system-ui,sans-serif">{{ message }}</div>
    </transition>`,
  };

  const TreeNode = {
    name: 'TreeNode',
    props: { node: Object, depth: { type: Number, default: 0 }, activePath: String },
    emits: ['select'],
    data() { return { open: this.depth < 2 }; },
    computed: {
      childList() { return Array.from(this.node.children.values()).sort((a, b) => a.name.localeCompare(b.name)); },
    },
    template: `
      <div>
        <div class="tree-row" :class="{ current: node.path === activePath }" :style="{ paddingLeft: (8 + depth * 14) + 'px' }" @click="$emit('select', node.path)">
          <span class="disclosure" v-if="childList.length" @click.stop="open = !open">{{ open ? '▾' : '▸' }}</span>
          <span class="disclosure" v-else></span>
          <span class="name">{{ node.name }}</span>
          <span class="count">{{ node.count }}</span>
        </div>
        <template v-if="open">
          <tree-node v-for="c in childList" :key="c.path" :node="c" :depth="depth + 1" :active-path="activePath" @select="$emit('select', $event)"></tree-node>
        </template>
      </div>`,
  };

  const ContextMenu = {
    props: { x: Number, y: Number, isGroup: Boolean, canGroup: Boolean },
    emits: ['action', 'close'],
    template: `
      <div class="context-menu" :style="{ left: x + 'px', top: y + 'px' }" @click.stop @contextmenu.prevent>
        <div class="item primary" @click="$emit('action', 'open-photoshop')"><span>Open in Photoshop</span></div>
        <div class="item" @click="$emit('action', 'rename')"><span>Rename…</span><span class="hint">↩</span></div>
        <div class="item" @click="$emit('action', 'duplicate')"><span>Duplicate</span><span class="hint">⌘D</span></div>
        <div class="sep"></div>
        <div class="item" @click="$emit('action', 'move')"><span>Move to…</span><span class="hint">›</span></div>
        <div class="item" @click="$emit('action', 'copy')"><span>Copy to…</span><span class="hint">›</span></div>
        <div class="item" @click="$emit('action', 'tag')"><span>Tag</span><span class="hint">›</span></div>
        <div class="sep"></div>
        <div class="item" :class="{ disabled: !canGroup }" @click="$emit('action', 'group')"><span>Group selection</span><span class="hint">⌘G</span></div>
        <div class="item" @click="$emit('action', 'rotate')"><span>Rotate</span><span class="hint">[ ]</span></div>
        <div class="item" @click="$emit('action', 'strip-metadata')"><span>Remove all metadata</span></div>
        <div class="sep"></div>
        <div class="item" @click="$emit('action', 'reveal')"><span>Reveal in Finder</span></div>
      </div>`,
  };

  const TagMenu = {
    props: { x: Number, y: Number },
    emits: ['pick', 'close'],
    data() { return { tags: TAGS }; },
    template: `
      <div class="context-menu" style="width:150px" :style="{ left: x + 'px', top: y + 'px' }" @click.stop>
        <div class="item" v-for="t in tags" :key="t.name" @click="$emit('pick', t.name)">
          <span style="display:flex;align-items:center;gap:8px"><span :style="{ width: '8px', height: '8px', borderRadius: '2px', background: t.var, display: 'inline-block' }"></span>{{ t.name }}</span>
        </div>
        <div class="sep"></div>
        <div class="item" @click="$emit('pick', null)"><span>Clear tags</span><span class="hint">0</span></div>
      </div>`,
  };

  const FilterPanel = {
    props: { filters: Object, counts: Object, totalShown: Number, totalAll: Number },
    emits: ['apply', 'reset', 'close'],
    data() { return { tags: TAGS }; },
    methods: {
      toggleTag(name) {
        this.filters.tags.has(name) ? this.filters.tags.delete(name) : this.filters.tags.add(name);
      },
      toggleType(t) {
        this.filters.types.has(t) ? this.filters.types.delete(t) : this.filters.types.add(t);
      },
    },
    template: `
      <div class="filter-panel">
        <div class="fp-head">
          <span class="title">Filter</span>
          <span class="count">{{ totalShown }} of {{ totalAll }}</span>
          <span class="reset" @click="$emit('reset')">Reset</span>
        </div>
        <div class="fp-body">
          <div class="fp-section">
            <div class="fp-section-label">Tags</div>
            <div>
              <div v-for="t in tags" :key="t.name" class="fp-check-row" :class="{ active: filters.tags.has(t.name) }" @click="toggleTag(t.name)">
                <span class="checkbox" :class="{ checked: filters.tags.has(t.name) }">✓</span>
                <span :style="{ width: '8px', height: '8px', borderRadius: '2px', background: t.var, display: 'inline-block' }"></span>
                {{ t.name }}
                <span style="margin-left:auto;font-size:10px;color:#8f8c89;font-family:'Geist Mono',ui-monospace,monospace">{{ counts.byTag[t.name] || 0 }}</span>
              </div>
            </div>
            <div class="fp-match-row">
              <span class="pill-toggle" :class="{ on: filters.tagMatch === 'any' }" @click="filters.tagMatch = 'any'">any</span>
              <span class="pill-toggle" :class="{ on: filters.tagMatch === 'all' }" @click="filters.tagMatch = 'all'">all</span>
              <span>· match</span>
            </div>
          </div>
          <div class="fp-section">
            <div class="fp-section-label">File type</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              <span v-for="(n, ext) in counts.byType" :key="ext" class="type-chip" :class="{ on: filters.types.has(ext) }" @click="toggleType(ext)">{{ ext }} {{ n }}</span>
            </div>
          </div>
          <div class="fp-section">
            <div class="fp-section-label">Resolution</div>
            <div class="res-row">
              <input class="res-field" v-model="filters.minRes" placeholder="any">
              <span style="color:#63605e">to</span>
              <input class="res-field" v-model="filters.maxRes" placeholder="any">
            </div>
          </div>
          <div class="fp-section">
            <div class="fp-section-label">Other</div>
            <div>
              <div class="fp-check-row compact" @click="filters.groupedOnly = !filters.groupedOnly">
                <span class="checkbox" :class="{ checked: filters.groupedOnly }">✓</span>Grouped items only
              </div>
              <div class="fp-check-row compact" @click="filters.hasGps = !filters.hasGps">
                <span class="checkbox" :class="{ checked: filters.hasGps }">✓</span>Has GPS metadata
              </div>
              <div class="fp-check-row compact" @click="filters.untaggedOnly = !filters.untaggedOnly">
                <span class="checkbox" :class="{ checked: filters.untaggedOnly }">✓</span>Untagged only
              </div>
              <div class="fp-check-row compact" @click="filters.includeSubfolders = !filters.includeSubfolders">
                <span class="checkbox" :class="{ checked: filters.includeSubfolders }">✓</span>Include subfolders
              </div>
            </div>
          </div>
          <div class="fp-footer">
            <div class="btn-accent-block" @click="$emit('apply')">Apply</div>
            <div class="btn-ghost" @click="$emit('close')">Close</div>
          </div>
        </div>
      </div>`,
  };

  const MassRenameDialog = {
    props: { files: Array, folderLabel: String },
    emits: ['close', 'rename'],
    data() {
      return {
        literal: 'renamed', startAt: 1, separator: '_', caseMode: 'lower',
        useCounter: true, useCaptureDate: false, useDimensions: false, useOriginalName: false, useFolder: false,
      };
    },
    mounted() {
      // Capture date and dimensions are lazily fetched (same as the info strip /
      // viewer do) so the preview table can show real values, not placeholders.
      for (const f of this.files) {
        if (!f.info) window.retriever.getFileInfo(f.path).then((info) => { if (info) f.info = info; });
        if (!f.dims) {
          const img = new Image();
          img.onload = () => { f.dims = { w: img.naturalWidth, h: img.naturalHeight }; };
          img.src = fileUrl(f.path);
        }
      }
    },
    methods: {
      captureDateStr(f) {
        if (!f.info || !f.info.mtimeMs) return '….-..-..';
        const d = new Date(f.info.mtimeMs);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      },
      dimensionsStr(f) { return f.dims ? `${f.dims.w}x${f.dims.h}` : '…x…'; },
      folderName(f) { const parts = f.path.split('/'); return parts[parts.length - 2] || ''; },
      focusLiteral() { this.$refs.literalInput?.focus(); },
    },
    computed: {
      previews() {
        return this.files.map((f, i) => {
          const ext = extname(f.path) ? '.' + extname(f.path) : '';
          const parts = [];
          if (this.literal) parts.push(this.literal);
          if (this.useCaptureDate) parts.push(this.captureDateStr(f));
          if (this.useDimensions) parts.push(this.dimensionsStr(f));
          if (this.useOriginalName) parts.push(stripExt(f.name));
          if (this.useFolder) parts.push(this.folderName(f));
          if (this.useCounter) parts.push(String(this.startAt + i).padStart(3, '0'));
          let base = parts.join(this.separator) || stripExt(f.name);
          if (this.caseMode === 'lower') base = base.toLowerCase();
          if (this.caseMode === 'upper') base = base.toUpperCase();
          return { old: f.name, next: base + ext, file: f };
        });
      },
    },
    template: `
      <div class="overlay" @mousedown.self="$emit('close')">
        <div class="dialog" style="width:720px">
          <div class="dialog-head">
            <span class="title">Rename {{ files.length }} file{{ files.length === 1 ? '' : 's' }}</span>
            <span class="meta">{{ folderLabel }}</span>
            <span class="close" @click="$emit('close')">×</span>
          </div>
          <div class="dialog-body">
            <div style="display:flex;flex-direction:column;gap:7px">
              <div class="fp-section-label">Pattern</div>
              <div class="pattern-field">
                <input ref="literalInput" v-model="literal" style="background:transparent;border:none;outline:none;color:#f0cf72;font:11.5px 'Geist Mono',ui-monospace,monospace;width:120px" />
                <template v-if="useCaptureDate"><span class="dot">·</span><span class="pattern-token" title="click to remove" @click="useCaptureDate = false">{capture:yyyy-mm-dd}</span></template>
                <template v-if="useDimensions"><span class="dot">·</span><span class="pattern-token" title="click to remove" @click="useDimensions = false">{dimensions}</span></template>
                <template v-if="useOriginalName"><span class="dot">·</span><span class="pattern-token" title="click to remove" @click="useOriginalName = false">{original name}</span></template>
                <template v-if="useFolder"><span class="dot">·</span><span class="pattern-token" title="click to remove" @click="useFolder = false">{folder}</span></template>
                <template v-if="useCounter"><span class="dot">·</span><span class="pattern-token" title="click to remove" @click="useCounter = false">{counter:{{ String(startAt).padStart(3,'0') }}}</span></template>
                <span class="caret"></span>
              </div>
              <div class="token-palette">
                <span class="token-pill" @click="focusLiteral">+ text</span>
                <span class="token-pill" :class="{ active: useCounter }" @click="useCounter = !useCounter">+ counter</span>
                <span class="token-pill" :class="{ active: useCaptureDate }" @click="useCaptureDate = !useCaptureDate">+ capture date</span>
                <span class="token-pill" :class="{ active: useOriginalName }" @click="useOriginalName = !useOriginalName">+ original name</span>
                <span class="token-pill" :class="{ active: useFolder }" @click="useFolder = !useFolder">+ folder</span>
                <span class="token-pill" :class="{ active: useDimensions }" @click="useDimensions = !useDimensions">+ dimensions</span>
              </div>
            </div>
            <div class="opts-row">
              <span>Start at <input class="v" v-model.number="startAt" style="width:34px;background:transparent;border:none;outline:none" /></span>
              <span>Separator <input class="v" v-model="separator" style="width:20px;background:transparent;border:none;outline:none" /></span>
              <span>Case
                <select v-model="caseMode" style="background:#232325;color:#e6e4e2;border:none;border-radius:4px;font:inherit">
                  <option value="lower">lower</option><option value="upper">upper</option><option value="keep">keep</option>
                </select>
              </span>
              <span class="push">Extension unchanged</span>
            </div>
            <div class="rename-table">
              <div class="head"><span>current</span><span></span><span>new</span></div>
              <div class="row" v-for="p in previews" :key="p.file.path">
                <span class="old">{{ p.old }}</span><span class="arrow">→</span><span class="new">{{ p.next }}</span>
              </div>
            </div>
          </div>
          <div class="dialog-footer">
            <span class="note">Renames on disk. Undo with ⌘Z.</span>
            <div class="actions">
              <div class="btn ghost" @click="$emit('close')">Cancel</div>
              <div class="btn accent" @click="$emit('rename', previews)">Rename {{ files.length }}</div>
            </div>
          </div>
        </div>
      </div>`,
  };

  const CleanupDialog = {
    props: { files: Array, groupLabel: String },
    emits: ['close', 'strip'],
    data() {
      return { exif: true, gps: true, iptc: true, thumbs: false, icc: false, keepCopy: true };
    },
    template: `
      <div class="overlay" @mousedown.self="$emit('close')">
        <div class="dialog" style="width:520px">
          <div class="dialog-head">
            <span class="title">Remove metadata</span>
            <span class="meta">{{ groupLabel }}</span>
            <span class="close" @click="$emit('close')">×</span>
          </div>
          <div class="dialog-body">
            <div style="display:flex;flex-direction:column;gap:5px">
              <div class="fp-section-label">Will be removed</div>
              <div class="md-list">
                <div class="md-row" @click="exif = !exif"><span class="checkbox" :class="{ checked: exif }">✓</span>EXIF — camera, lens, exposure<span class="count">{{ files.length }} files</span></div>
                <div class="md-row" @click="gps = !gps"><span class="checkbox" :class="{ checked: gps }">✓</span>GPS location<span class="count">{{ files.length }} files</span></div>
                <div class="md-row" @click="iptc = !iptc"><span class="checkbox" :class="{ checked: iptc }">✓</span>IPTC — creator, copyright, captions<span class="count">{{ files.length }} files</span></div>
                <div class="md-row" @click="thumbs = !thumbs"><span class="checkbox" :class="{ checked: thumbs }">✓</span>Embedded thumbnails<span class="count">{{ files.length }} files</span></div>
                <div class="md-row" @click="icc = !icc"><span class="checkbox" :class="{ checked: icc }">✓</span>ICC color profile<span class="count danger">affects color</span></div>
              </div>
            </div>
            <div class="hairline"></div>
            <div style="display:flex;flex-direction:column;gap:5px">
              <div class="fp-section-label">Kept</div>
              <div class="md-kept-note">Pixels, orientation, and Retriever's own tags and groups — those live in Retriever's catalog, not in the file.</div>
            </div>
            <div class="md-keep-copy" @click="keepCopy = !keepCopy">
              <span class="checkbox" :class="{ checked: keepCopy }">✓</span>Keep an untouched copy in <span style="font-family:'Geist Mono',ui-monospace,monospace">_originals/</span>
            </div>
          </div>
          <div class="dialog-footer">
            <span class="note">Writes to the files on disk.</span>
            <div class="actions">
              <div class="btn ghost" @click="$emit('close')">Cancel</div>
              <div class="btn danger" @click="$emit('strip', { exif, gps, iptc, thumbs, icc, keepCopy })">Strip {{ files.length }} files</div>
            </div>
          </div>
        </div>
      </div>`,
  };

  const ShortcutsSheet = {
    data() {
      return {
        cols: [
          { label: 'Navigate', rows: [
            ['↑ ↓ ← →', 'move selection'], ['↵', 'open fit-width'], ['esc', 'back to grid'],
            ['⌘T', 'new tab'], ['⌘1–9', 'go to tab'], ['⌘⌥←', 'parent folder'],
            ['⌘F', 'search filenames'], ['⌘L', 'filter panel'],
          ]},
          { label: 'Select & group', rows: [
            ['⌘A', 'select all'], ['⇧click', 'extend'], ['⌘click', 'add / remove'],
            ['⌘G', 'group selection'], ['⌘⇧G', 'ungroup'], ['→', 'expand group'],
            ['←', 'collapse group'], ['⌘⌥G', 'add to group'],
          ]},
          { label: 'Tag & sort', rows: [
            ['1', 'select'], ['2', 'reject'], ['3', 'maybe'], ['4', 'published'], ['0', 'clear tags'],
            ['⌘⌥1', 'sort by name'], ['⌘⌥2', 'sort by date'], ['⌘⌥3', 'sort by size'],
          ]},
          { label: 'Files', rows: [
            ['[ ]', 'rotate ccw / cw'], ['⌘R', 'rename…'], ['⌘⇧R', 'mass rename…'], ['⌘D', 'duplicate'],
            ['⌘⌥M', 'move to…'], ['⌘⌥C', 'copy to…'], ['⌘⌫', 'strip metadata'], ['⌘⇧O', 'reveal in Finder'],
          ]},
        ],
      };
    },
    template: `
      <div class="overlay" style="align-items:flex-start;padding-top:10vh">
        <div class="dialog shortcuts-sheet" style="width:880px">
          <div class="shortcuts-head">
            <app-mark :size="17" fill="#e6b422"></app-mark>
            <span class="title">Keyboard shortcuts</span>
            <span class="meta">hold ⌘/ · release to dismiss</span>
            <div class="shortcuts-search"><span>search shortcuts</span></div>
          </div>
          <div class="shortcuts-grid">
            <div class="sc-col" v-for="c in cols" :key="c.label">
              <div class="sc-col-label">{{ c.label }}</div>
              <div class="sc-rows">
                <div class="sc-row" v-for="r in c.rows" :key="r[1]"><span class="sc-key">{{ r[0] }}</span>{{ r[1] }}</div>
              </div>
            </div>
          </div>
          <div class="shortcuts-footer">
            <span>⌘Z undo — covers renames, moves, rotations and strips</span>
            <span class="push">⌘, preferences</span>
          </div>
        </div>
      </div>`,
  };

  // ---------- root app ----------
  const App = {
    components: { AppMark, Toast, ContextMenu, TagMenu, FilterPanel, MassRenameDialog, CleanupDialog, ShortcutsSheet },
    setup() {
      const state = reactive({
        tabs: [{ id: uid('tab'), rootDir: null, watching: false, label: 'Untitled' }],
        activeTabId: null,
        files: reactive(new Map()),
        groups: [],
        expandedGroups: reactive(new Set()),
        rotations: reactive({}),
        selection: [],
        folderFilter: null,
        viewMode: 'grid',
        thumbSize: 140,
        search: '',
        sortMode: 'date',
        sortDir: 'desc',
        filterPanelOpen: false,
        filters: reactive({
          tags: new Set(), tagMatch: 'any', types: new Set(),
          minRes: '', maxRes: '', groupedOnly: false, hasGps: false, untaggedOnly: false, includeSubfolders: false,
        }),
        contextMenu: reactive({ open: false, x: 0, y: 0, targetPath: null, isGroup: false, groupId: null }),
        tagMenu: reactive({ open: false, x: 0, y: 0 }),
        renameDialogOpen: false,
        cleanupDialogOpen: false,
        shortcutsHeld: false,
        inlineRenamePath: null,
        inlineRenameValue: '',
        indexing: reactive({ active: false, seen: 0 }),
        permissionDenied: reactive({ active: false, path: '', message: '' }),
        receipt: reactive({ line1: 'fsevents · —', line2: '', amber: false }),
        toastMessage: '',
        undoStack: [],
        now: Date.now(),
        hasIndexedOnce: false,
      });

      let toastTimer = null;
      function toast(msg) {
        state.toastMessage = msg;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { state.toastMessage = ''; }, 2600);
      }

      setInterval(() => { state.now = Date.now(); }, 1000);

      const activeTab = computed(() => state.tabs.find((t) => t.id === state.activeTabId) || state.tabs[0]);
      const watchingCount = computed(() => state.tabs.filter((t) => t.watching).length);

      state.homeDir = '';
      window.retriever.getHomeDir().then((d) => { state.homeDir = d; });
      function shortenPath(p) {
        if (!p) return '';
        return state.homeDir && p.startsWith(state.homeDir) ? '~' + p.slice(state.homeDir.length) : p;
      }

      // ---------- fs event handling ----------
      // Chokidar's initial scan can emit thousands of 'add' events back to
      // back (a whole library, not just live changes). Applying each one as
      // its own reactive mutation + Vue re-render is what makes that hang the
      // renderer, so incoming events are queued and applied in one batch per
      // tick instead of one Vue update per file.
      let eventQueue = [];
      let flushScheduled = false;
      function queueFsEvent(evt) {
        eventQueue.push(evt);
        if (!flushScheduled) {
          flushScheduled = true;
          setTimeout(flushFsEvents, 50);
        }
      }
      function flushFsEvents() {
        flushScheduled = false;
        const batch = eventQueue;
        eventQueue = [];
        for (const evt of batch) applyFsEvent(evt);
      }
      function isNew(f) {
        return state.hasIndexedOnce && f.addedAt && (state.now - f.addedAt) < 3000;
      }
      function applyFsEvent(evt) {
        if (evt.type === 'added') {
          if (!isImagePath(evt.filePath)) return;
          if (!state.hasIndexedOnce && !state.indexing.active) { state.indexing.active = true; state.indexing.seen = 0; }
          state.indexing.seen += 1;
          state.files.set(evt.filePath, {
            path: evt.filePath, name: basename(evt.filePath), dir: dirname(evt.filePath),
            tags: [], lost: false, lostAt: null, addedAt: Date.now(),
            info: null, dims: null,
          });
          state.receipt.line1 = 'fsevents · just now';
          state.receipt.line2 = '+1 added';
          state.receipt.amber = false;
        } else if (evt.type === 'removed') {
          state.files.delete(evt.filePath);
          state.receipt.line1 = 'fsevents · just now';
          state.receipt.line2 = '−1 removed';
        } else if (evt.type === 'lost') {
          const f = state.files.get(evt.filePath);
          if (f) { f.lost = true; f.lostAt = Date.now(); }
          state.receipt.line1 = 'fsevents · just now';
          state.receipt.line2 = '−1 moved';
        } else if (evt.type === 'moved') {
          const prev = state.files.get(evt.from);
          const meta = prev || { path: evt.filePath, tags: [], addedAt: Date.now(), info: null, dims: null };
          state.files.delete(evt.from);
          meta.path = evt.filePath;
          meta.name = basename(evt.filePath);
          meta.dir = dirname(evt.filePath);
          meta.lost = false;
          meta.lostAt = null;
          state.files.set(evt.filePath, meta);
          const i = state.selection.indexOf(evt.from);
          if (i !== -1) state.selection[i] = evt.filePath;
          state.receipt.line1 = 'fsevents · just now';
          state.receipt.line2 = '+1 moved';
        } else if (evt.type === 'ready') {
          state.indexing.active = false;
          state.hasIndexedOnce = true;
        } else if (evt.type === 'error') {
          state.permissionDenied.active = /EACCES|EPERM|permission/i.test(evt.message || evt.code || '');
          state.permissionDenied.path = activeTab.value.rootDir || '';
          state.permissionDenied.message = evt.message || 'Permission denied';
          state.receipt.amber = true;
          state.receipt.line1 = 'fsevents · error';
          state.receipt.line2 = evt.code || 'watch failed';
        }
      }
      window.retriever.onFsEvent(queueFsEvent);

      async function beginWatch(rootDir) {
        eventQueue = [];
        state.files.clear();
        state.groups = [];
        state.expandedGroups.clear();
        state.selection = [];
        state.folderFilter = rootDir;
        state.viewMode = 'grid';
        state.permissionDenied.active = false;
        state.indexing.active = true;
        state.indexing.seen = 0;
        state.hasIndexedOnce = false;
        for (const t of state.tabs) t.watching = false;
        const tab = activeTab.value;
        tab.rootDir = rootDir;
        tab.watching = true;
        tab.label = basename(rootDir) || rootDir;
      }

      async function chooseFolder() {
        const dir = await window.retriever.chooseFolder();
        if (dir) await beginWatch(dir);
      }
      async function useDefaultFolder() {
        const dir = (state.homeDir || await window.retriever.getHomeDir()) + '/Pictures';
        await window.retriever.watchFolder(dir);
        await beginWatch(dir);
      }

      // ---------- derived collections ----------
      const groupMembership = computed(() => {
        const m = new Map();
        for (const g of state.groups) for (const p of g.memberPaths) m.set(p, g.id);
        return m;
      });
      const groupById = computed(() => new Map(state.groups.map((g) => [g.id, g])));

      const allFiles = computed(() => Array.from(state.files.values()));

      const tagCounts = computed(() => {
        const c = { select: 0, reject: 0, maybe: 0, published: 0 };
        for (const f of allFiles.value) for (const t of f.tags) if (c[t] !== undefined) c[t] += 1;
        return c;
      });
      const typeCounts = computed(() => {
        const c = {};
        for (const f of allFiles.value) { const e = extname(f.path); if (e) c[e] = (c[e] || 0) + 1; }
        return c;
      });

      const visibleFiles = computed(() => {
        let list = allFiles.value;
        if (state.folderFilter) {
          list = list.filter((f) => f.dir === state.folderFilter ||
            (state.filters.includeSubfolders && f.dir.startsWith(state.folderFilter + '/')));
        }
        if (state.search.trim()) {
          const q = state.search.trim().toLowerCase();
          list = list.filter((f) => f.name.toLowerCase().includes(q));
        }
        if (state.filters.types.size) list = list.filter((f) => state.filters.types.has(extname(f.path)));
        if (state.filters.tags.size) {
          list = list.filter((f) => state.filters.tagMatch === 'all'
            ? [...state.filters.tags].every((t) => f.tags.includes(t))
            : [...state.filters.tags].some((t) => f.tags.includes(t)));
        }
        if (state.filters.untaggedOnly) list = list.filter((f) => f.tags.length === 0);
        if (state.filters.groupedOnly) list = list.filter((f) => groupMembership.value.has(f.path));
        return list;
      });

      const sortedFiles = computed(() => {
        const list = [...visibleFiles.value];
        const dir = state.sortDir === 'asc' ? 1 : -1;
        list.sort((a, b) => {
          if (state.sortMode === 'name') return a.name.localeCompare(b.name) * dir;
          return (a.addedAt - b.addedAt) * dir;
        });
        return list;
      });

      const gridEntries = computed(() => {
        const entries = [];
        const seen = new Set();
        for (const f of sortedFiles.value) {
          const gid = groupMembership.value.get(f.path);
          if (gid) {
            if (state.expandedGroups.has(gid) || seen.has(gid)) continue;
            seen.add(gid);
            const g = groupById.value.get(gid);
            entries.push({ type: 'group', group: g, cover: state.files.get(g.keyPath) || f });
          } else {
            entries.push({ type: 'file', file: f });
          }
        }
        return entries;
      });

      const expandedGroupList = computed(() => state.groups.filter((g) => state.expandedGroups.has(g.id)));

      // ---------- grid virtualization ----------
      // Folders with tens of thousands of files used to hang the renderer by
      // mounting one Vue-reactive tile per file. Instead we mount only the
      // rows overlapping the scroll viewport (plus overscan) and keep the
      // rest of the grid's height alive with a single sizer element placed
      // at the true last row/column via CSS grid explicit placement — the
      // scrollbar and scroll math behave exactly as if every tile existed.
      const GRID_OVERSCAN_ROWS = 4;
      const gridAreaEl = ref(null);
      const gridScrollTop = ref(0);
      const gridViewportHeight = ref(600);
      const tileRowExtra = ref(30); // measured: tile height beyond the thumbnail itself
      let gridScrollQueued = false;
      function onGridScroll(e) {
        if (gridScrollQueued) return;
        gridScrollQueued = true;
        requestAnimationFrame(() => {
          gridScrollQueued = false;
          if (gridAreaEl.value) gridScrollTop.value = gridAreaEl.value.scrollTop;
        });
      }
      function measureTileRowExtra() {
        const tile = document.querySelector('.tile-grid .tile');
        if (!tile) return;
        const extra = tile.offsetHeight - state.thumbSize;
        if (extra > 0 && Math.abs(extra - tileRowExtra.value) > 1) tileRowExtra.value = extra;
      }
      const gridRowHeight = computed(() => state.thumbSize + tileRowExtra.value);
      const gridRowStride = computed(() => gridRowHeight.value + 16); // 16 = .tile-grid row gap
      const gridTotalRows = computed(() => Math.ceil(gridEntries.value.length / GRID_COLS));
      const gridStartRow = computed(() => Math.max(0, Math.floor(gridScrollTop.value / gridRowStride.value) - GRID_OVERSCAN_ROWS));
      const gridEndRow = computed(() => Math.min(
        gridTotalRows.value,
        Math.ceil((gridScrollTop.value + gridViewportHeight.value) / gridRowStride.value) + GRID_OVERSCAN_ROWS,
      ));
      const gridStartIndex = computed(() => gridStartRow.value * GRID_COLS);
      const renderedEntries = computed(() => gridEntries.value.slice(gridStartIndex.value, gridEndRow.value * GRID_COLS));
      function tileGridPosition(offset) {
        const idx = gridStartIndex.value + offset;
        return { gridColumn: (idx % GRID_COLS) + 1, gridRow: Math.floor(idx / GRID_COLS) + 1 };
      }

      function ensureRowVisible(path) {
        const idx = gridEntries.value.findIndex((e) => (e.type === 'file' ? e.file.path : e.group.keyPath) === path);
        if (idx === -1 || !gridAreaEl.value) return;
        const row = Math.floor(idx / GRID_COLS);
        const top = row * gridRowStride.value;
        const bottom = top + gridRowHeight.value;
        const el = gridAreaEl.value;
        if (top < el.scrollTop) el.scrollTop = Math.max(0, top - 8);
        else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight + 8;
      }

      let gridResizeObserver = null;

      const navOrder = computed(() => {
        const order = [];
        for (const e of gridEntries.value) order.push(e.type === 'group' ? e.group.keyPath : e.file.path);
        for (const g of expandedGroupList.value) for (const p of g.memberPaths) order.push(p);
        return order;
      });

      const activePath = computed(() => state.selection[state.selection.length - 1] || null);
      const activeFile = computed(() => (activePath.value ? state.files.get(activePath.value) : null));
      const activeGroupId = computed(() => (activePath.value ? groupMembership.value.get(activePath.value) : null));

      const systemState = computed(() => {
        if (!activeTab.value.watching) return 'no-folder';
        if (state.permissionDenied.active) return 'permission-denied';
        if (state.indexing.active) return 'indexing';
        if (state.files.size === 0) return 'no-photos';
        if (sortedFiles.value.length === 0) return 'filtered-empty';
        return null;
      });

      // ---------- selection ----------
      function selectSingle(p) { state.selection = [p]; }
      function selectToggle(p) {
        const i = state.selection.indexOf(p);
        if (i === -1) state.selection.push(p); else state.selection.splice(i, 1);
      }
      function selectRange(p) {
        const order = navOrder.value;
        const last = state.selection[state.selection.length - 1];
        const a = order.indexOf(last);
        const b = order.indexOf(p);
        if (a === -1 || b === -1) { selectSingle(p); return; }
        const [lo, hi] = a < b ? [a, b] : [b, a];
        state.selection = order.slice(lo, hi + 1);
      }
      function onTileClick(e, p) {
        if (e.metaKey) selectToggle(p);
        else if (e.shiftKey) selectRange(p);
        else selectSingle(p);
      }
      function selectAll() { state.selection = [...navOrder.value]; }

      // ---------- tags ----------
      async function applyTagToSelection(name) {
        const targets = state.selection.length ? state.selection : [];
        for (const p of targets) {
          const f = state.files.get(p);
          if (!f) continue;
          const prevTags = [...f.tags];
          const res = await window.retriever.tagFile(p, name);
          f.tags = res.tags;
          state.undoStack.push({ type: 'tags', path: p, prevTags });
        }
      }
      async function clearTagsForSelection() {
        for (const p of state.selection) {
          const f = state.files.get(p);
          if (!f) continue;
          const prevTags = [...f.tags];
          await window.retriever.clearTags(p);
          f.tags = [];
          state.undoStack.push({ type: 'tags', path: p, prevTags });
        }
      }
      function pickFromTagMenu(name) {
        state.tagMenu.open = false;
        if (name) applyTagToSelection(name); else clearTagsForSelection();
      }

      // ---------- rotation ----------
      function rotateSelection(delta) {
        for (const p of state.selection) {
          const prev = state.rotations[p] || 0;
          state.rotations[p] = (prev + delta + 360) % 360;
          state.undoStack.push({ type: 'rotate', path: p, prevDeg: prev });
        }
      }

      // ---------- grouping ----------
      function groupSelection() {
        if (state.selection.length < 2) { toast('Select two or more files to group them.'); return; }
        const key = state.selection[0];
        const name = stripExt(key) + '_seq';
        state.groups.push({ id: uid('grp'), name, memberPaths: [...state.selection], keyPath: key });
      }
      function ungroup(gid) {
        const i = state.groups.findIndex((g) => g.id === gid);
        if (i !== -1) { state.expandedGroups.delete(gid); state.groups.splice(i, 1); }
      }
      function toggleExpand(gid) {
        state.expandedGroups.has(gid) ? state.expandedGroups.delete(gid) : state.expandedGroups.add(gid);
      }
      function addSelectionToGroup(gid) {
        const g = groupById.value.get(gid);
        if (!g) return;
        for (const p of state.selection) if (!g.memberPaths.includes(p)) g.memberPaths.push(p);
      }

      // ---------- file ops ----------
      async function duplicateFiles(paths) {
        for (const p of paths) {
          try { await window.retriever.duplicateFile(p); } catch (e) { toast(e.message); }
        }
      }
      async function openInExternalEditor(p) {
        if (!p) return;
        try { await window.retriever.openInExternalEditor(p); } catch (e) { toast(e.message); }
      }
      async function stripMetadataForSelection(options) {
        const paths = [...state.selection]; // plain array — see moveOrCopySelection for why
        state.cleanupDialogOpen = false;
        if (!paths.length) return;
        try {
          const results = await window.retriever.stripMetadata(paths, options);
          const skipped = results.filter((r) => r.skipped).length;
          const done = results.length - skipped;
          let msg = `Stripped metadata from ${done} file${done === 1 ? '' : 's'}`;
          if (skipped) msg += ` · ${skipped} unsupported format${skipped === 1 ? '' : 's'} skipped`;
          toast(msg);
        } catch (e) { toast(e.message); }
      }
      async function moveOrCopySelection(mode) {
        // Spread to a plain array — state.selection is a Vue reactive Proxy,
        // and Electron's IPC structured-clone can't serialize that directly.
        const paths = [...(state.selection.length ? state.selection : (state.contextMenu.targetPath ? [state.contextMenu.targetPath] : []))];
        if (!paths.length) return;
        const destDir = await window.retriever.chooseDestinationFolder();
        if (!destDir) return;
        try {
          const result = mode === 'move' ? await window.retriever.moveFiles(paths, destDir) : await window.retriever.copyFiles(paths, destDir);
          toast(`${mode === 'move' ? 'Moved' : 'Copied'} ${result.length} file${result.length === 1 ? '' : 's'} to ${destDir}`);
        } catch (e) { toast(e.message); }
      }
      function startInlineRename(p) {
        state.inlineRenamePath = p;
        state.inlineRenameValue = stripExt(p);
      }
      async function commitInlineRename() {
        const p = state.inlineRenamePath;
        if (!p) return;
        const f = state.files.get(p);
        const ext = extname(p) ? '.' + extname(p) : '';
        const newName = state.inlineRenameValue.trim() + ext;
        state.inlineRenamePath = null;
        if (!f || !newName || newName === f.name) return;
        try {
          await window.retriever.renameFile(p, newName);
        } catch (e) {
          toast(e.message);
        }
      }
      function cancelInlineRename() { state.inlineRenamePath = null; }

      async function revealInFinder(p) { await window.retriever.revealInFinder(p); }

      // ---------- context menu ----------
      function openFileContextMenu(e, p) {
        e.preventDefault();
        if (!state.selection.includes(p)) selectSingle(p);
        state.contextMenu.open = true;
        state.contextMenu.x = Math.min(e.clientX, window.innerWidth - 236);
        state.contextMenu.y = Math.min(e.clientY, window.innerHeight - 320);
        state.contextMenu.targetPath = p;
      }
      function handleContextAction(action) {
        const p = state.contextMenu.targetPath;
        state.contextMenu.open = false;
        switch (action) {
          case 'open-photoshop': openInExternalEditor(p); break;
          case 'rename': startInlineRename(p); break;
          case 'duplicate': duplicateFiles(state.selection.length ? state.selection : [p]); break;
          case 'move': moveOrCopySelection('move'); break;
          case 'copy': moveOrCopySelection('copy'); break;
          case 'tag': state.tagMenu.open = true; state.tagMenu.x = state.contextMenu.x + 10; state.tagMenu.y = state.contextMenu.y + 10; break;
          case 'group': groupSelection(); break;
          case 'rotate': rotateSelection(90); break;
          case 'strip-metadata': state.cleanupDialogOpen = true; break;
          case 'reveal': revealInFinder(p); break;
        }
      }

      // ---------- viewer ----------
      function openViewer(p) { selectSingle(p); state.viewMode = 'viewer'; }
      function backToGrid() { state.viewMode = 'grid'; }
      function stepViewer(delta) {
        const order = navOrder.value;
        const i = order.indexOf(activePath.value);
        if (i === -1) return;
        const next = order[(i + delta + order.length) % order.length];
        if (next) selectSingle(next);
      }

      // ---------- file info (lazy) ----------
      async function ensureFileInfo(f) {
        if (!f || f.info || f.lost) return;
        f.info = await window.retriever.getFileInfo(f.path) || {};
      }
      function onImageLoad(f, e) {
        if (!f) return;
        if (!f.dims) f.dims = { w: e.target.naturalWidth, h: e.target.naturalHeight };
        ensureFileInfo(f);
      }

      // ---------- tabs ----------
      function selectTab(id) { state.activeTabId = id; }
      function addTab() {
        const t = { id: uid('tab'), rootDir: null, watching: false, label: 'Untitled' };
        state.tabs.push(t);
        state.activeTabId = t.id;
      }
      function closeTab(id) {
        if (state.tabs.length === 1) return;
        const i = state.tabs.findIndex((t) => t.id === id);
        state.tabs.splice(i, 1);
        if (state.activeTabId === id) state.activeTabId = state.tabs[Math.max(0, i - 1)].id;
      }

      state.activeTabId = state.tabs[0].id;

      // ---------- folder tree ----------
      const folderTree = computed(() => {
        if (!activeTab.value.watching || !activeTab.value.rootDir) return null;
        const root = { name: basename(activeTab.value.rootDir) || activeTab.value.rootDir, path: activeTab.value.rootDir, children: new Map(), count: 0 };
        for (const f of allFiles.value) {
          root.count += 1;
          let rel = f.dir === activeTab.value.rootDir ? '' : f.dir.slice(activeTab.value.rootDir.length).replace(/^\/+/, '');
          let node = root;
          let curPath = activeTab.value.rootDir;
          if (rel) {
            for (const seg of rel.split('/')) {
              curPath += '/' + seg;
              if (!node.children.has(seg)) node.children.set(seg, { name: seg, path: curPath, children: new Map(), count: 0 });
              node = node.children.get(seg);
              node.count += 1;
            }
          }
        }
        return root;
      });
      function selectFolder(p) { state.folderFilter = p; }

      // ---------- undo ----------
      async function undo() {
        const action = state.undoStack.pop();
        if (!action) { toast('Nothing to undo.'); return; }
        if (action.type === 'tags') {
          const f = state.files.get(action.path);
          if (f) {
            await window.retriever.clearTags(action.path);
            for (const t of action.prevTags) await window.retriever.tagFile(action.path, t);
            f.tags = action.prevTags;
          }
        } else if (action.type === 'rotate') {
          state.rotations[action.path] = action.prevDeg;
        }
      }

      // ---------- keyboard ----------
      function onKeydown(e) {
        if (e.key === '/' && e.metaKey) { e.preventDefault(); state.shortcutsHeld = true; return; }
        if (state.inlineRenamePath) {
          if (e.key === 'Enter') { commitInlineRename(); }
          if (e.key === 'Escape') { cancelInlineRename(); }
          return;
        }
        if (isTypingTarget(document.activeElement) && e.key !== 'Escape' && !(e.metaKey && e.key.toLowerCase() === 'f')) return;

        if (e.key === 'Escape') {
          if (state.shortcutsHeld) state.shortcutsHeld = false;
          else if (state.contextMenu.open) state.contextMenu.open = false;
          else if (state.tagMenu.open) state.tagMenu.open = false;
          else if (state.renameDialogOpen) state.renameDialogOpen = false;
          else if (state.cleanupDialogOpen) state.cleanupDialogOpen = false;
          else if (state.filterPanelOpen) state.filterPanelOpen = false;
          else if (state.viewMode === 'viewer') backToGrid();
          return;
        }
        if (e.key === 'Enter' && activePath.value && state.viewMode === 'grid') { openViewer(activePath.value); return; }

        const order = navOrder.value;
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
          e.preventDefault();
          const cur = order.indexOf(activePath.value);
          const delta = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -GRID_COLS : GRID_COLS;
          const next = order[Math.min(Math.max(cur + delta, 0), order.length - 1)] || order[0];
          if (next) {
            selectSingle(next);
            if (state.viewMode === 'grid') ensureRowVisible(next);
          }
          return;
        }

        if (e.metaKey && e.key === 'a') { e.preventDefault(); selectAll(); return; }
        if (e.metaKey && e.key.toLowerCase() === 'f') { e.preventDefault(); nextTick(() => document.getElementById('search-input')?.focus()); return; }
        if (e.metaKey && e.key.toLowerCase() === 'l') { e.preventDefault(); state.filterPanelOpen = !state.filterPanelOpen; return; }
        if (e.metaKey && e.key.toLowerCase() === 't') { e.preventDefault(); addTab(); return; }
        if (e.metaKey && e.key === 'g' && e.shiftKey) { e.preventDefault(); if (activeGroupId.value) ungroup(activeGroupId.value); return; }
        if (e.metaKey && e.altKey && e.key.toLowerCase() === 'g') { e.preventDefault(); if (activeGroupId.value) addSelectionToGroup(activeGroupId.value); return; }
        if (e.metaKey && e.key === 'g') { e.preventDefault(); groupSelection(); return; }
        if (e.metaKey && e.key.toLowerCase() === 'r' && e.shiftKey) { e.preventDefault(); if (state.selection.length) state.renameDialogOpen = true; return; }
        if (e.metaKey && e.key.toLowerCase() === 'r') { e.preventDefault(); if (activePath.value) startInlineRename(activePath.value); return; }
        if (e.metaKey && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateFiles(state.selection); return; }
        if (e.metaKey && e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); toast('Parent folder navigation isn’t available — choose a folder to change roots.'); return; }
        if (e.metaKey && e.altKey && e.key.toLowerCase() === 'm') { e.preventDefault(); moveOrCopySelection('move'); return; }
        if (e.metaKey && e.altKey && e.key.toLowerCase() === 'c') { e.preventDefault(); moveOrCopySelection('copy'); return; }
        if (e.metaKey && e.key === 'Backspace') { e.preventDefault(); if (state.selection.length) state.cleanupDialogOpen = true; return; }
        if (e.metaKey && e.key.toLowerCase() === 'o' && e.shiftKey) { e.preventDefault(); if (activePath.value) revealInFinder(activePath.value); return; }
        if (e.metaKey && e.key === 'z') { e.preventDefault(); undo(); return; }
        if (e.metaKey && e.key === ',') { e.preventDefault(); toast('Preferences aren’t implemented in this pass.'); return; }
        if (e.metaKey && e.altKey && ['1', '2', '3'].includes(e.key)) {
          e.preventDefault();
          state.sortMode = e.key === '1' ? 'name' : 'date';
          return;
        }
        if (e.metaKey && /^[1-9]$/.test(e.key)) {
          e.preventDefault();
          const idx = Number(e.key) - 1;
          if (state.tabs[idx]) selectTab(state.tabs[idx].id);
          return;
        }
        if (!e.metaKey && ['1', '2', '3', '4'].includes(e.key)) { applyTagToSelection(TAG_BY_KEY[e.key]); return; }
        if (!e.metaKey && e.key === '0') { clearTagsForSelection(); return; }
        if (e.key === '[') { rotateSelection(-90); return; }
        if (e.key === ']') { rotateSelection(90); return; }
      }
      function onKeyup(e) {
        if (e.key === 'Meta' || e.key === '/') state.shortcutsHeld = false;
      }

      onMounted(() => {
        window.addEventListener('keydown', onKeydown);
        window.addEventListener('keyup', onKeyup);
        window.addEventListener('click', () => { state.contextMenu.open = false; state.tagMenu.open = false; });

        // .grid-area only exists in the DOM while state.viewMode === 'grid' —
        // its template ref goes null across a grid<->viewer switch, so the
        // observer has to be re-attached (not just created once at mount).
        gridResizeObserver = new ResizeObserver(() => {
          if (gridAreaEl.value) gridViewportHeight.value = gridAreaEl.value.clientHeight;
        });
        watch(gridAreaEl, (el, prevEl) => {
          if (prevEl) gridResizeObserver.unobserve(prevEl);
          if (el) { gridViewportHeight.value = el.clientHeight; gridResizeObserver.observe(el); }
        }, { immediate: true });
        watch(() => [state.thumbSize, renderedEntries.value.length], () => nextTick(measureTileRowExtra), { immediate: true });
      });
      onUnmounted(() => {
        window.removeEventListener('keydown', onKeydown);
        window.removeEventListener('keyup', onKeyup);
        if (gridResizeObserver) gridResizeObserver.disconnect();
      });

      // ---------- thumb size slider ----------
      function onSliderPointerDown(e) {
        const track = e.currentTarget;
        function move(ev) {
          const rect = track.getBoundingClientRect();
          const pct = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
          state.thumbSize = Math.round(90 + pct * (220 - 90));
        }
        move(e);
        function up() { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); }
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }

      return {
        state, activeTab, watchingCount, shortenPath, fileUrl, fmtBytes, fmtDate, fmtElapsed,
        TAGS, tagMeta, extname, basename, stripExt,
        chooseFolder, useDefaultFolder, beginWatch,
        groupMembership, groupById, allFiles, tagCounts, typeCounts, visibleFiles, sortedFiles,
        gridEntries, renderedEntries, expandedGroupList, navOrder, activePath, activeFile, activeGroupId, systemState, isNew,
        gridAreaEl, onGridScroll, tileGridPosition, gridRowHeight, gridTotalRows,
        onTileClick, selectSingle, selectAll,
        applyTagToSelection, clearTagsForSelection, pickFromTagMenu,
        rotateSelection, groupSelection, ungroup, toggleExpand, addSelectionToGroup,
        duplicateFiles, startInlineRename, commitInlineRename, cancelInlineRename, revealInFinder,
        moveOrCopySelection, stripMetadataForSelection, openInExternalEditor,
        openFileContextMenu, handleContextAction,
        openViewer, backToGrid, stepViewer, ensureFileInfo,
        selectTab, addTab, closeTab, folderTree, selectFolder,
        undo, onSliderPointerDown, toast, onImageLoad,
      };
    },
    template: `
    <div class="app-window">
      <!-- title bar -->
      <div class="titlebar">
        <div class="traffic-lights"><span class="traffic-light tl-red"></span><span class="traffic-light tl-yellow"></span><span class="traffic-light tl-green"></span></div>
        <div class="brand"><app-mark :size="18"></app-mark><span class="brand-name">Retriever</span></div>
        <div class="tabstrip">
          <div v-for="t in state.tabs" :key="t.id" class="tab" :class="{ active: t.id === state.activeTabId }" @click="selectTab(t.id)">
            <span v-if="t.watching" class="tab-dot"></span>
            <span class="tab-label">{{ state.viewMode === 'viewer' && t.id === state.activeTabId && activeFile ? (t.label + ' — ' + activeFile.name) : t.label }}</span>
            <span class="tab-close" @click.stop="closeTab(t.id)">×</span>
          </div>
          <div class="tab-add" @click="addTab">+</div>
        </div>
        <div class="watch-indicator" :class="{ amber: state.receipt.amber }">
          <span class="dot-glow" :class="{ amber: state.receipt.amber }"></span>
          <span>{{ watchingCount === 0 ? 'not watching' : ('watching ' + watchingCount + ' folder' + (watchingCount === 1 ? '' : 's')) }}</span>
        </div>
      </div>

      <!-- GRID MODE -->
      <template v-if="state.viewMode === 'grid'">
        <div class="toolbar">
          <div class="breadcrumb">
            <template v-if="activeTab.rootDir">
              <template v-for="(seg, i) in shortenPath(activeTab.rootDir).split('/').filter(Boolean)" :key="i">
                <span class="sep" v-if="i > 0">/</span>
                <span :class="i === shortenPath(activeTab.rootDir).split('/').filter(Boolean).length - 1 ? 'current' : ''">{{ seg }}</span>
              </template>
            </template>
            <span v-else style="color:#5f5c5a">no folder selected</span>
          </div>
          <div class="vdivider"></div>
          <div class="chip-row">
            <div class="chip"><span @click="rotateSelection(-90)">↺</span><span>Rotate</span><span @click="rotateSelection(90)">↻</span></div>
            <div class="chip" :class="{ accent: state.selection.length >= 2 }" @click="groupSelection">Group {{ state.selection.length }}</div>
            <div class="chip" @click.stop="state.tagMenu.open = true; state.tagMenu.x = 190; state.tagMenu.y = 74">Tag ▾</div>
            <div class="chip" :class="{ disabled: state.selection.length !== 1 }" @click="startInlineRename(activePath)">Rename…</div>
            <div class="chip" :class="{ disabled: !state.selection.length }" @click="state.cleanupDialogOpen = true">Clean metadata</div>
          </div>
          <div class="spacer"></div>
          <div class="search-field">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="#6e6b68" stroke-width="1.6"><circle cx="6.6" cy="6.6" r="4.4"/><path d="M10 10l3.4 3.4"/></svg>
            <input id="search-input" v-model="state.search" placeholder="search filenames" />
          </div>
          <div class="chip" @click="state.filterPanelOpen = !state.filterPanelOpen">Filter <span class="chip-count" v-if="state.filters.tags.size + state.filters.types.size">{{ state.filters.tags.size + state.filters.types.size }}</span></div>
          <div class="chip" @click="state.sortMode = state.sortMode === 'name' ? 'date' : 'name'">Sort: {{ state.sortMode === 'name' ? 'Name' : 'Date' }} <span @click.stop="state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc'">{{ state.sortDir === 'asc' ? '↑' : '↓' }}</span></div>
          <div class="size-slider-group">
            <svg width="10" height="10" viewBox="0 0 12 12" fill="#6e6b68" @click="state.thumbSize = 90"><rect x="0" y="0" width="5" height="5"/><rect x="7" y="0" width="5" height="5"/><rect x="0" y="7" width="5" height="5"/><rect x="7" y="7" width="5" height="5"/></svg>
            <div class="size-slider" @mousedown="onSliderPointerDown">
              <div class="fill" :style="{ width: (((state.thumbSize - 90) / 130) * 100) + '%' }"></div>
              <div class="knob" :style="{ left: (((state.thumbSize - 90) / 130) * 100) + '%' }"></div>
            </div>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="#6e6b68" @click="state.thumbSize = 220"><rect x="0" y="0" width="14" height="14"/></svg>
          </div>
        </div>

        <div class="body-split">
          <!-- tree -->
          <div class="tree">
            <div class="tree-label">Places</div>
            <div class="tree-rows" v-if="folderTree">
              <tree-node :node="folderTree" :active-path="state.folderFilter || activeTab.rootDir" @select="selectFolder"></tree-node>
            </div>
            <div class="tree-rows" v-else><div class="tree-row dim" style="cursor:default">no folder watched</div></div>
            <div class="tree-label">Tags</div>
            <div class="tree-rows">
              <div v-for="t in TAGS" :key="t.name" class="tree-row" :class="{ 'tag-current': state.filters.tags.has(t.name) }"
                   @click="state.filters.tags.has(t.name) ? state.filters.tags.delete(t.name) : state.filters.tags.add(t.name)">
                <span class="tree-swatch" :style="{ background: t.var }"></span><span class="name">{{ t.name }}</span>
                <span class="count">{{ tagCounts[t.name] }}</span>
              </div>
            </div>
            <div class="tree-receipt" :class="{ amber: state.receipt.amber }">
              <div>{{ state.receipt.line1 }}</div>
              <div class="delta">{{ state.receipt.line2 }}</div>
            </div>
          </div>

          <!-- grid / system states -->
          <div class="grid-area" ref="gridAreaEl" @scroll="onGridScroll" :style="{ '--cols': 6, '--thumb-h': state.thumbSize + 'px' }" @click="state.contextMenu.open = false">

            <template v-if="systemState === 'no-folder'">
              <div class="state-pane">
                <div class="state-caption">No folder chosen</div>
                <div class="state-body">
                  <app-mark :size="34" fill="#3a3733"></app-mark>
                  <div class="state-title">Point Retriever at a folder</div>
                  <div class="state-copy">It watches everything inside it from then on. No import step.</div>
                  <div class="state-actions">
                    <div class="btn-accent-block" style="flex:none;padding:6px 12px" @click="chooseFolder">Choose folder…</div>
                    <div class="btn-ghost" @click="useDefaultFolder">Use ~/Pictures</div>
                  </div>
                </div>
              </div>
            </template>

            <template v-else-if="systemState === 'permission-denied'">
              <div class="state-pane">
                <div class="state-caption">Permission denied</div>
                <div class="state-body tight">
                  <div class="danger-banner">macOS won't let Retriever read this folder</div>
                  <div class="state-copy hl">{{ state.permissionDenied.path }}</div>
                  <div class="state-copy">Grant access under Privacy &amp; Security → Files and Folders. The watch resumes on its own.</div>
                  <div class="state-actions" style="margin-top:auto">
                    <div class="btn-accent-block" style="flex:none;padding:6px 12px" @click="window.retriever.openPrivacySettings()">Open settings</div>
                    <div class="btn-ghost" @click="chooseFolder">Retry</div>
                  </div>
                </div>
              </div>
            </template>

            <template v-else-if="systemState === 'indexing'">
              <div class="state-pane">
                <div class="state-caption">First index · thumbnails decoding</div>
                <div class="state-body tight">
                  <div class="mini-grid">
                    <div class="mini-cell" v-for="i in 4" :key="i">
                      <img v-if="allFiles[i-1]" :src="fileUrl(allFiles[i-1].path)" />
                    </div>
                  </div>
                  <div class="progress-row">
                    <div class="progress-labels"><span>indexing…</span><span>{{ state.indexing.seen }} found</span></div>
                    <div class="progress-track"><div class="progress-fill" style="right:38%"></div></div>
                  </div>
                  <div class="state-copy">Browsing works now — thumbnails fill in behind you.</div>
                </div>
              </div>
            </template>

            <template v-else-if="systemState === 'no-photos'">
              <div class="state-pane">
                <div class="state-caption">Folder has no photos</div>
                <div class="state-body">
                  <div class="state-title">Nothing here yet</div>
                  <div class="state-copy">This folder doesn't hold any photos Retriever reads yet.</div>
                  <div class="state-live-line"><span style="width:6px;height:6px;border-radius:50%;background:#7ac47a;display:inline-block"></span>watching — drop files in and they appear</div>
                  <div class="drop-target-full">drop photos here</div>
                </div>
              </div>
            </template>

            <template v-else-if="systemState === 'filtered-empty'">
              <div class="state-pane">
                <div class="state-caption">Filtered to nothing</div>
                <div class="state-body">
                  <div class="state-title">0 of {{ allFiles.length }} match</div>
                  <div style="display:flex;flex-wrap:wrap;gap:6px;font-size:11px;font-family:'Geist Mono',ui-monospace,monospace">
                    <span class="filter-chip" v-for="t in state.filters.tags" :key="t">tag: {{ t }}</span>
                    <span class="filter-chip" v-for="ty in state.filters.types" :key="ty">type: {{ ty }}</span>
                    <span class="filter-chip" v-if="state.search">name: {{ state.search }}</span>
                  </div>
                  <div class="state-copy">Try removing a filter to bring files back.</div>
                  <div class="state-actions">
                    <div class="btn-ghost" @click="state.filters.tags.clear(); state.filters.types.clear(); state.filters.untaggedOnly = false; state.filters.groupedOnly = false; state.search = ''">Clear filters</div>
                    <div class="btn-ghost" @click="state.filterPanelOpen = true">Edit filter</div>
                  </div>
                </div>
              </div>
            </template>

            <template v-else>
              <div class="filter-line" v-if="state.filters.tags.size || state.filters.types.size || state.search">
                <span class="label">filter:</span>
                <span class="filter-chip" v-for="t in state.filters.tags" :key="t">tag: {{ t }}</span>
                <span class="filter-chip" v-for="ty in state.filters.types" :key="ty">type: {{ ty }}</span>
                <span>· {{ sortedFiles.length }} of {{ allFiles.length }} shown</span>
              </div>

              <div class="tile-grid" :style="{ '--row-h': gridRowHeight + 'px' }">
                <template v-for="(entry, i) in renderedEntries" :key="entry.type === 'group' ? entry.group.id : entry.file.path">

                  <div v-if="entry.type === 'file'" class="tile" :style="tileGridPosition(i)" :class="{ selected: state.selection.includes(entry.file.path), new: isNew(entry.file) }"
                       @click="onTileClick($event, entry.file.path)" @dblclick="openViewer(entry.file.path)"
                       @contextmenu="openFileContextMenu($event, entry.file.path)">
                    <div class="tile-thumb">
                      <img loading="lazy" :src="fileUrl(entry.file.path)" :style="{ transform: 'rotate(' + (state.rotations[entry.file.path] || 0) + 'deg)' }" />
                    </div>
                    <div v-if="state.inlineRenamePath === entry.file.path" class="tile-rename" @click.stop>
                      <input v-model="state.inlineRenameValue" @keydown.enter="commitInlineRename" @keydown.esc="cancelInlineRename" @blur="commitInlineRename" autofocus />
                    </div>
                    <div v-else class="tile-name">
                      <span v-if="isNew(entry.file)" class="new-flag">new</span>
                      <span v-else-if="entry.file.tags[0]" class="swatch" :style="{ background: tagMeta(entry.file.tags[0]).var }"></span>
                      <span class="fname">{{ entry.file.name }}</span>
                    </div>
                  </div>

                  <div v-else class="tile" :style="tileGridPosition(i)" @click="onTileClick($event, entry.group.keyPath)" @contextmenu="openFileContextMenu($event, entry.group.keyPath)">
                    <div class="tile-stack">
                      <div class="layer layer1"></div>
                      <div class="layer layer2"></div>
                      <div class="front"><img v-if="entry.cover" :src="fileUrl(entry.cover.path)" /></div>
                      <div class="stack-pill" @click.stop="toggleExpand(entry.group.id)">▸ {{ entry.group.memberPaths.length }}</div>
                    </div>
                    <div class="tile-group-name">{{ entry.group.name }} ⌗</div>
                  </div>

                </template>

                <!-- Explicit rows for auto-flowing content below the virtualized
                     tiles: without a fixed grid-row, CSS grid would drop these
                     into whatever earlier row is currently unoccupied (i.e. any
                     scrolled-past virtualized row), not visually below the grid. -->
                <div class="group-band" v-for="(g, gi) in expandedGroupList" :key="g.id" :style="{ gridRow: gridTotalRows + 1 + gi, gridColumn: '1 / -1' }">
                  <div class="group-band-head">
                    <span>▾ group "{{ g.name }}" · {{ g.memberPaths.length }} items</span>
                    <span class="actions">
                      <span @click="toggleExpand(g.id)">collapse</span>
                      <span @click="addSelectionToGroup(g.id)">add selection</span>
                      <span @click="ungroup(g.id)">ungroup</span>
                    </span>
                  </div>
                  <div class="tile-grid" style="--thumb-h:104px; --row-h:auto">
                    <template v-for="p in g.memberPaths" :key="p">
                      <div v-if="state.files.get(p)" class="tile"
                           :class="{ selected: state.selection.includes(p) }" @click="onTileClick($event, p)" @dblclick="openViewer(p)">
                        <div class="tile-thumb"><img :src="fileUrl(p)" /></div>
                        <div class="tile-name"><span class="fname">{{ state.files.get(p).name }}</span></div>
                      </div>
                    </template>
                  </div>
                </div>

                <div class="grid-sizer" :style="{ gridColumn: 1, gridRow: gridTotalRows + 1 + expandedGroupList.length }"></div>
              </div>
            </template>

            <context-menu v-if="state.contextMenu.open" :x="state.contextMenu.x" :y="state.contextMenu.y"
                           :can-group="state.selection.length >= 2" @action="handleContextAction"></context-menu>
            <tag-menu v-if="state.tagMenu.open" :x="state.tagMenu.x" :y="state.tagMenu.y" @pick="pickFromTagMenu" @click.stop></tag-menu>
          </div>

          <filter-panel v-if="state.filterPanelOpen" :filters="state.filters" :counts="{ byTag: tagCounts, byType: typeCounts }"
                         :total-shown="sortedFiles.length" :total-all="allFiles.length"
                         @apply="state.filterPanelOpen = false" @reset="state.filters.tags.clear(); state.filters.types.clear(); state.filters.untaggedOnly = false; state.filters.groupedOnly = false; state.filters.hasGps = false; state.filters.minRes = ''; state.filters.maxRes = ''"
                         @close="state.filterPanelOpen = false"></filter-panel>
        </div>

        <!-- info strip -->
        <div class="info-strip" v-if="activeFile">
          <div class="info-thumb"><img :src="fileUrl(activeFile.path)" @load="onImageLoad(activeFile, $event)" /></div>
          <div class="info-main">
            <div class="info-head">
              <span class="info-name">{{ activeFile.name }}</span>
              <span class="info-path">{{ shortenPath(activeFile.dir) }}</span>
              <span class="tag-pills">
                <span v-for="t in activeFile.tags" :key="t" class="tag-pill" :class="tagMeta(t).className">{{ t }}</span>
                <span class="tag-pill add-tag" @click.stop="state.tagMenu.open = true; state.tagMenu.x = 300; state.tagMenu.y = 250">+ tag</span>
              </span>
            </div>
            <div class="meta-grid">
              <div><div class="meta-label">dimensions</div><div class="meta-value">{{ activeFile.dims ? (activeFile.dims.w + ' × ' + activeFile.dims.h) : '—' }}</div></div>
              <div><div class="meta-label">size</div><div class="meta-value">{{ fmtBytes(activeFile.info && activeFile.info.size) }}</div></div>
              <div><div class="meta-label">format</div><div class="meta-value">{{ extname(activeFile.path).toUpperCase() }}</div></div>
              <div><div class="meta-label">modified</div><div class="meta-value">{{ fmtDate(activeFile.info && activeFile.info.mtimeMs) }}</div></div>
              <div><div class="meta-label">group</div><div class="meta-value accent">{{ activeGroupId ? (groupById.get(activeGroupId).name + ' (' + groupById.get(activeGroupId).memberPaths.length + ')') : '—' }}</div></div>
            </div>
          </div>
          <div class="info-actions">
            <div class="info-btn">All metadata ▾</div>
            <div class="info-btn danger" @click="state.cleanupDialogOpen = true">Remove all metadata</div>
            <div class="info-btn" @click="revealInFinder(activeFile.path)">Reveal in Finder</div>
          </div>
        </div>

        <!-- status bar -->
        <div class="statusbar">
          <span>{{ sortedFiles.length }} items · {{ state.selection.length }} selected</span>
          <span>{{ state.groups.length }} groups</span>
          <span class="live"><span class="live-dot" :class="{ amber: state.receipt.amber }"></span>{{ activeTab.watching ? (state.receipt.amber ? 'watch interrupted' : 'live') : 'idle' }}</span>
          <span>⌘/ shortcuts</span>
        </div>
      </template>

      <!-- VIEWER MODE -->
      <template v-else>
        <div class="toolbar">
          <div class="chip" @click="backToGrid">← Back to grid <span style="color:#7d7a77;font-family:'Geist Mono',ui-monospace,monospace">esc</span></div>
          <div class="vdivider"></div>
          <div class="chip accent">Fit width</div>
          <div class="chip">Fit screen</div>
          <div class="chip">100%</div>
          <div class="chip"><span @click="rotateSelection(-90)">↺</span> Rotate <span @click="rotateSelection(90)">↻</span></div>
          <div class="chip" @click.stop="state.tagMenu.open = true; state.tagMenu.x = 300; state.tagMenu.y = 60">Tag ▾</div>
          <div class="chip" @click="openInExternalEditor(activePath)">Open in Photoshop</div>
          <div class="spacer"></div>
          <span style="font-family:'Geist Mono',ui-monospace,monospace;color:#8f8c89">{{ navOrder.indexOf(activePath) + 1 }} / {{ navOrder.length }}</span>
          <div style="display:flex;gap:2px">
            <div class="chip" style="width:26px;justify-content:center;padding:0" @click="stepViewer(-1)">‹</div>
            <div class="chip" style="width:26px;justify-content:center;padding:0" @click="stepViewer(1)">›</div>
          </div>
        </div>

        <div class="body-split">
          <div class="tree">
            <div class="tree-label">Places</div>
            <div class="tree-rows" v-if="folderTree">
              <tree-node :node="folderTree" :active-path="state.folderFilter || activeTab.rootDir" @select="selectFolder"></tree-node>
            </div>
            <div class="tree-receipt"><div>{{ state.receipt.line1 }}</div><div class="delta">{{ state.receipt.line2 }}</div></div>
          </div>

          <template v-if="activeFile && activeFile.lost">
            <div class="grid-area">
              <div class="state-pane">
                <div class="state-caption">Selected file vanished</div>
                <div class="state-body tight">
                  <div class="hatched-well">moved or deleted on disk</div>
                  <div class="state-copy">
                    <span class="hl">{{ activeFile.name }}</span> left this folder {{ fmtElapsed(activeFile.lostAt) }}.
                    <template v-if="groupMembership.get(activeFile.path)"> Its tags and its place in <span class="accent">{{ groupById.get(groupMembership.get(activeFile.path)).name }}</span> are held for 30 days.</template>
                    <template v-else> Its tags are held for 30 days.</template>
                  </div>
                  <div class="state-actions" style="margin-top:auto">
                    <div class="btn-ghost" @click="window.retriever.openFolder(activeFile.path)">Find it</div>
                    <div class="btn-ghost" @click="state.files.delete(activeFile.path); backToGrid()">Forget</div>
                  </div>
                </div>
              </div>
            </div>
          </template>
          <template v-else-if="activeFile">
            <div class="viewer-body">
              <div class="viewer-stage">
                <img :src="fileUrl(activeFile.path)" :style="{ transform: 'rotate(' + (state.rotations[activeFile.path] || 0) + 'deg)' }" @load="onImageLoad(activeFile, $event)" />
              </div>
              <div class="filmstrip">
                <div class="filmstrip-cell" v-for="p in navOrder" :key="p" :class="{ current: p === activePath }" @click="selectSingle(p)">
                  <img v-if="state.files.get(p)" :src="fileUrl(p)" />
                </div>
              </div>
            </div>
          </template>

          <tag-menu v-if="state.tagMenu.open" :x="state.tagMenu.x" :y="state.tagMenu.y" @pick="pickFromTagMenu" @click.stop></tag-menu>
        </div>

        <div class="info-strip" style="height:112px" v-if="activeFile && !activeFile.lost">
          <div style="display:flex;flex-direction:column;gap:6px;min-width:250px">
            <div class="info-name">{{ activeFile.name }}</div>
            <div class="info-path">{{ shortenPath(activeFile.dir) }}</div>
            <div class="tag-pills" style="margin-left:0">
              <span v-for="t in activeFile.tags" :key="t" class="tag-pill" :class="tagMeta(t).className">{{ t }}</span>
            </div>
          </div>
          <div class="meta-grid cols-4">
            <div><div class="meta-label">dimensions</div><div class="meta-value">{{ activeFile.dims ? (activeFile.dims.w + ' × ' + activeFile.dims.h) : '—' }}</div></div>
            <div><div class="meta-label">size</div><div class="meta-value">{{ fmtBytes(activeFile.info && activeFile.info.size) }}</div></div>
            <div><div class="meta-label">modified</div><div class="meta-value">{{ fmtDate(activeFile.info && activeFile.info.mtimeMs) }}</div></div>
            <div><div class="meta-label">orientation</div><div class="meta-value">{{ state.rotations[activeFile.path] ? ('rotated ' + state.rotations[activeFile.path] + '° cw') : 'as shot' }}</div></div>
          </div>
        </div>
        <div class="statusbar">
          <span>{{ navOrder.indexOf(activePath) + 1 }} of {{ navOrder.length }}</span>
          <span class="live"><span class="live-dot"></span>live</span>
          <span>⌘/ shortcuts</span>
        </div>
      </template>

      <mass-rename-dialog v-if="state.renameDialogOpen" :files="state.selection.map(p => state.files.get(p)).filter(Boolean)"
                           :folder-label="shortenPath(activeTab.rootDir)"
                           @close="state.renameDialogOpen = false"
                           @rename="async (previews) => { for (const p of previews) { try { await window.retriever.renameFile(p.file.path, p.next); } catch (e) { toast(e.message); } } state.renameDialogOpen = false }"></mass-rename-dialog>

      <cleanup-dialog v-if="state.cleanupDialogOpen" :files="state.selection.map(p => state.files.get(p)).filter(Boolean)"
                      :group-label="activeGroupId ? ('group “' + groupById.get(activeGroupId).name + '” · ' + state.selection.length + ' files') : (state.selection.length + ' files')"
                      @close="state.cleanupDialogOpen = false"
                      @strip="stripMetadataForSelection"></cleanup-dialog>

      <shortcuts-sheet v-if="state.shortcutsHeld"></shortcuts-sheet>

      <toast :message="state.toastMessage"></toast>
    </div>`,
  };

  const app = createApp(App);
  app.component('tree-node', TreeNode);
  app.mount('#app');
})();
