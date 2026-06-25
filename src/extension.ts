import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';

// ── Types ────────────────────────────────────────────────────────────────────

interface EcoLogitsImpacts {
  gwp: number;
  wcf: number;
  energy: number;
  adpe: number;
  pe: number;
}

interface ApiImpactValue {
  min: number;
  max: number;
}

interface ApiResponse {
  impacts?: {
    gwp?: { value?: ApiImpactValue };
    wcf?: { value?: ApiImpactValue };
    energy?: { value?: ApiImpactValue };
    adpe?: { value?: ApiImpactValue };
    pe?: { value?: ApiImpactValue };
  };
}

// ── Model resolution (mirrors ecologits-bar.sh logic) ───────────────────────

const KNOWN_MODELS = new Set([
  'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5',
  'claude-opus-4-1', 'claude-opus-4-0',
  'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4-0',
  'claude-haiku-4-5',
]);

const FAMILY_LATEST: Record<string, string> = {
  opus:   'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5',
};

function resolveModel(rawModel: string): string {
  const norm = rawModel
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')  // strip trailing [1m] context-window variant
    .replace(/-\d{8}$/, '');     // strip trailing -YYYYMMDD date
  if (KNOWN_MODELS.has(norm)) return norm;
  for (const [family, latest] of Object.entries(FAMILY_LATEST)) {
    if (norm.includes(family)) return latest;
  }
  return 'claude-opus-4-8'; // fallback: safest overestimate
}

// ── Transcript helpers ───────────────────────────────────────────────────────

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Claude Code names project dirs by replacing every '/' in the workspace path
// with '-', yielding e.g. /home/user/myproj → -home-user-myproj.
function projectDirName(workspacePath: string): string {
  return workspacePath.replace(/\//g, '-');
}

function getClaudeProjectDir(workspacePath: string): string {
  return path.join(CLAUDE_PROJECTS_DIR, projectDirName(workspacePath));
}

function getMostRecentJSONL(projectDir: string): string | null {
  try {
    const entries = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const full = path.join(projectDir, f);
        return { file: full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return entries.length > 0 ? entries[0].file : null;
  } catch {
    return null;
  }
}

function getMostRecentJSONLGlobally(): string | null {
  try {
    let best: { file: string; mtime: number } | null = null;
    for (const entry of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
      const projectDir = path.join(CLAUDE_PROJECTS_DIR, entry);
      try {
        if (!fs.statSync(projectDir).isDirectory()) continue;
        for (const f of fs.readdirSync(projectDir)) {
          if (!f.endsWith('.jsonl')) continue;
          const full = path.join(projectDir, f);
          const mtime = fs.statSync(full).mtimeMs;
          if (!best || mtime > best.mtime) best = { file: full, mtime };
        }
      } catch { /* skip inaccessible dirs */ }
    }
    return best?.file ?? null;
  } catch {
    return null;
  }
}

// The active workspace project dir, falling back to the dir of the globally
// most-recent JSONL when no workspace is open.
function getActiveProjectDir(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    const d = getClaudeProjectDir(folders[0].uri.fsPath);
    if (fs.existsSync(d)) return d;
  }
  const t = getMostRecentJSONLGlobally();
  return t ? path.dirname(t) : null;
}

// ── Read strategies (one per mode) ───────────────────────────────────────────

// lastUse — only the most recent assistant response.
function readLastUse(): { tokens: number; model: string } {
  const transcript = (() => {
    const d = getActiveProjectDir();
    return d ? getMostRecentJSONL(d) : getMostRecentJSONLGlobally();
  })();
  if (!transcript) return { tokens: 0, model: '' };
  try {
    const lines = fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]) as {
          message?: { model?: string; usage?: { output_tokens?: number } };
        };
        const t = obj?.message?.usage?.output_tokens;
        if (t) return { tokens: t, model: obj?.message?.model ?? '' };
      } catch { /* skip */ }
    }
  } catch { /* file gone */ }
  return { tokens: 0, model: '' };
}

// workspace — cumulative across every session JSONL in the project dir.
function readWorkspace(): { tokens: number; model: string } {
  const projectDir = getActiveProjectDir();
  if (!projectDir) return { tokens: 0, model: '' };
  let total = 0;
  let model = '';
  try {
    for (const f of fs.readdirSync(projectDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const { tokens, model: m } = readTranscript(path.join(projectDir, f));
      total += tokens;
      if (!model && m) model = m;
    }
  } catch { /* dir gone */ }
  return { tokens: total, model };
}

// allTime — cumulative across every project, with mtime-based caching so only
// changed files are re-read on each refresh.
const allTimeCache = new Map<string, { mtime: number; tokens: number; model: string }>();

function readAllTime(): { tokens: number; model: string } {
  let total = 0;
  let model = '';
  try {
    for (const proj of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
      const projDir = path.join(CLAUDE_PROJECTS_DIR, proj);
      try {
        if (!fs.statSync(projDir).isDirectory()) continue;
        for (const f of fs.readdirSync(projDir)) {
          if (!f.endsWith('.jsonl')) continue;
          const full = path.join(projDir, f);
          try {
            const mtime = fs.statSync(full).mtimeMs;
            const cached = allTimeCache.get(full);
            if (cached && cached.mtime === mtime) {
              total += cached.tokens;
              if (!model && cached.model) model = cached.model;
            } else {
              const { tokens: t, model: m } = readTranscript(full);
              allTimeCache.set(full, { mtime, tokens: t, model: m });
              total += t;
              if (!model && m) model = m;
            }
          } catch { /* file gone */ }
        }
      } catch { /* dir gone */ }
    }
  } catch { /* projects dir missing */ }
  return { tokens: total, model };
}

// Sum output_tokens and detect the model from a session JSONL transcript.
function readTranscript(transcriptPath: string): { tokens: number; model: string } {
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    let tokens = 0;
    let model = '';
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as {
          message?: { model?: string; usage?: { output_tokens?: number } };
        };
        const usage = obj?.message?.usage;
        if (usage?.output_tokens) tokens += usage.output_tokens;
        if (!model && obj?.message?.model) model = obj.message.model;
      } catch { /* skip malformed lines */ }
    }
    return { tokens, model };
  } catch {
    return { tokens: 0, model: '' };
  }
}

// ── EcoLogits API call ───────────────────────────────────────────────────────

function mid(range: ApiImpactValue): number {
  return (range.min + range.max) / 2;
}

async function fetchEcoLogits(
  tokens: number,
  model: string,
  zone: string,
  apiUrl: string,
): Promise<EcoLogitsImpacts | null> {
  return new Promise(resolve => {
    const body = JSON.stringify({
      provider: 'anthropic',
      model_name: model,
      output_token_count: tokens,
      electricity_mix_zone: zone,
    });

    let url: URL;
    try { url = new URL(apiUrl); } catch { resolve(null); return; }

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? '443' : '80'),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data) as ApiResponse;
          const i = json?.impacts;
          if (i?.gwp?.value && i?.wcf?.value && i?.energy?.value && i?.adpe?.value && i?.pe?.value) {
            resolve({
              gwp:    mid(i.gwp.value),
              wcf:    mid(i.wcf.value),
              energy: mid(i.energy.value),
              adpe:   mid(i.adpe.value),
              pe:     mid(i.pe.value),
            });
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
    });

    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ── Auto-scaling formatters (mirrors ecologits-bar.sh) ───────────────────────

function fmtGwp(v: number): string {
  if (!v || v <= 0) return '0';
  if (v >= 1) return `${v.toFixed(2)} kgCO₂eq`;
  if (v >= 0.001) { const g = v * 1000; return `${g >= 10 ? g.toFixed(0) : g.toFixed(1)} gCO₂eq`; }
  return `${(v * 1e6).toFixed(0)} mgCO₂eq`;
}

function fmtWcf(v: number): string {
  if (!v || v <= 0) return '0';
  if (v >= 1) return `${v.toFixed(2)} L`;
  const ml = v * 1000;
  if (ml >= 10) return `${ml.toFixed(0)} mL`;
  if (ml >= 1)  return `${ml.toFixed(1)} mL`;
  return `${ml.toFixed(2)} mL`;
}

function fmtEnergy(v: number): string {
  if (!v || v <= 0) return '0';
  if (v >= 1) return `${v.toFixed(2)} kWh`;
  const wh = v * 1000;
  if (wh >= 10) return `${wh.toFixed(0)} Wh`;
  if (wh >= 1)  return `${wh.toFixed(1)} Wh`;
  return `${(v * 1e6).toFixed(0)} mWh`;
}

function fmtAdpe(v: number): string {
  if (!v || v <= 0) return '0';
  if (v >= 1)       return `${v.toFixed(2)} kgSbeq`;
  if (v >= 0.001)   return `${(v * 1000).toFixed(1)} gSbeq`;
  const mg = v * 1e6;
  if (mg >= 10) return `${mg.toFixed(0)} mgSbeq`;
  if (mg >= 1)  return `${mg.toFixed(1)} mgSbeq`;
  return `${(v * 1e9).toFixed(0)} µgSbeq`;
}

function fmtPe(v: number): string {
  if (!v || v <= 0) return '0';
  if (v >= 1) return `${v.toFixed(2)} MJ`;
  if (v >= 0.001) { const kj = v * 1000; return `${kj >= 10 ? kj.toFixed(0) : kj.toFixed(1)} kJ`; }
  return `${(v * 1e6).toFixed(0)} J`;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderMetric(
  key: string,
  impacts: EcoLogitsImpacts | null,
  resolvedModel: string,
): string {
  switch (key) {
    case 'gwp':    return `🔥 ${impacts ? fmtGwp(impacts.gwp)     : '0'}`;
    case 'wcf':    return `💧 ${impacts ? fmtWcf(impacts.wcf)     : '0'}`;
    case 'energy': return `⚡ ${impacts ? fmtEnergy(impacts.energy) : '0'}`;
    case 'adpe':   return `⛏ ${impacts ? fmtAdpe(impacts.adpe)   : '0'}`;
    case 'pe':     return `🛢 ${impacts ? fmtPe(impacts.pe)       : '0'}`;
    case 'model':  return `🤖 ${resolvedModel.replace(/^claude-/, '')}`;
    default:       return '';
  }
}

const MODE_SUFFIX: Record<string, string> = {
  lastUse:   '· last',
  workspace: '· ws',
  allTime:   '· all',
};

const MODE_TOOLTIP: Record<string, string> = {
  lastUse:   'Last response only — click to change mode',
  workspace: 'This workspace, all sessions — click to change mode',
  allTime:   'All time, all projects — click to change mode',
};

const MODES = ['lastUse', 'workspace', 'allTime'] as const;
type Mode = typeof MODES[number];

function buildStatusText(
  impacts: EcoLogitsImpacts | null,
  resolvedModel: string,
  metrics: string[],
  mode: Mode,
): string {
  const parts = metrics.map(k => renderMetric(k, impacts, resolvedModel)).filter(Boolean);
  const metricsText = parts.join(' | ') || '🌱 EcoLogits';
  return `${metricsText}  ${MODE_SUFFIX[mode] ?? ''}`.trimEnd();
}

// ── Extension entry point ────────────────────────────────────────────────────

let watcher: fs.FSWatcher | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.command = 'ecologits.cycleMode';
  statusBar.text = '🌱 EcoLogits';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Mutable state
  let currentTokens = 0;
  let currentResolvedModel = '';
  let currentImpacts: EcoLogitsImpacts | null = null;
  let inflightKey = '';

  function cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('ecologits');
  }

  function currentMode(): Mode {
    const m = cfg().get<string>('mode') ?? 'workspace';
    return (MODES as readonly string[]).includes(m) ? m as Mode : 'workspace';
  }

  function metrics(): string[] {
    return (cfg().get<string>('metrics') || 'gwp wcf energy').trim().split(/\s+/);
  }

  function repaint(): void {
    const mode = currentMode();
    statusBar.text = buildStatusText(currentImpacts, currentResolvedModel, metrics(), mode);
    statusBar.tooltip = MODE_TOOLTIP[mode];
  }

  // Pick the right read function for the active mode.
  function readForMode(): { tokens: number; model: string } {
    switch (currentMode()) {
      case 'lastUse':   return readLastUse();
      case 'allTime':   return readAllTime();
      default:          return readWorkspace();
    }
  }

  async function refresh(): Promise<void> {
    const { tokens, model: rawModel } = readForMode();

    const modelCfg = cfg().get<string>('model') || 'auto';
    const resolvedModel = modelCfg === 'auto'
      ? (rawModel ? resolveModel(rawModel) : 'claude-opus-4-8')
      : modelCfg;

    currentResolvedModel = resolvedModel;

    if (tokens === 0) {
      currentImpacts = null;
      repaint();
      return;
    }

    const key = `${tokens}:${resolvedModel}`;
    if (key === inflightKey) return;
    if (tokens === currentTokens && resolvedModel === currentResolvedModel && currentImpacts) return;

    currentTokens = tokens;
    inflightKey = key;

    const zone   = cfg().get<string>('zone')   || 'WOR';
    const apiUrl = cfg().get<string>('api')    || 'https://api.ecologits.ai/v1beta/estimations';

    const impacts = await fetchEcoLogits(tokens, resolvedModel, zone, apiUrl);

    if (inflightKey === key) {
      if (impacts) currentImpacts = impacts;
      inflightKey = '';
    }
    repaint();
  }

  let debounce: NodeJS.Timeout | null = null;

  function scheduleRefresh(): void {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => refresh().catch(() => undefined), 300);
  }

  // Cycle through modes on status bar click; reset state so the new mode's
  // token count triggers a fresh API call even if the number is the same.
  const cycleCmd = vscode.commands.registerCommand('ecologits.cycleMode', () => {
    const next = MODES[(MODES.indexOf(currentMode()) + 1) % MODES.length];
    cfg().update('mode', next, vscode.ConfigurationTarget.Global).then(() => {
      currentTokens = 0;
      currentImpacts = null;
      inflightKey = '';
      scheduleRefresh();
    }, () => undefined);
  });
  context.subscriptions.push(cycleCmd);

  function startWatching(): void {
    watcher?.close();
    watcher = null;
    scheduleRefresh();

    // allTime watches the whole projects tree; other modes watch only the
    // workspace project dir (falling back to the full tree if not found).
    const mode = currentMode();
    let watchDir: string | null = null;
    let recursive = false;

    if (mode !== 'allTime') {
      const d = getActiveProjectDir();
      if (d) watchDir = d;
    }

    if (!watchDir && fs.existsSync(CLAUDE_PROJECTS_DIR)) {
      watchDir = CLAUDE_PROJECTS_DIR;
      recursive = true;
    }

    if (watchDir) {
      try {
        watcher = fs.watch(watchDir, { recursive }, scheduleRefresh);
      } catch { /* inotify limit or recursive unsupported — poll covers it */ }
    }
  }

  startWatching();

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => startWatching()),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('ecologits')) return;
      // Mode change: rewire the watcher and force a fresh read.
      if (e.affectsConfiguration('ecologits.mode')) {
        currentTokens = 0;
        currentImpacts = null;
        inflightKey = '';
        startWatching();
      } else {
        repaint();
      }
    }),
  );

  // Fallback poll — fs.watch can miss events on some Linux setups.
  const poll = setInterval(scheduleRefresh, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });
  context.subscriptions.push({ dispose: () => { watcher?.close(); watcher = null; } });
}

export function deactivate(): void {
  watcher?.close();
  watcher = null;
}
