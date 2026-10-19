import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { getNotesDirectory } from '../agent/tools.js';

const LINES_PER_PAGE = 60;
export const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB
export const MAX_FILE_SIZE_BYTES = MAX_FILE_BYTES;
const MAX_SCAN_DEPTH = 2;
const MAX_SCANNED_FILES = 200;

const ALLOWED_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.log',
  '.env',
  '.pdf',
  '.conf',
  '.ini',
  '.toml'
]);

const SKIPPED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  'dist',
  'build',
  '.cache',
  '.npm',
  '.ssh',
  '.gnupg'
]);

const VAULT_LOCKED_PATTERNS = [
  /(?:^|[\\/])\.ssh(?:[\\/]|$)/i,
  /(?:^|[\\/])id_rsa(?:\b|$)/i,
  /(?:^|[\\/])id_ed25519(?:\b|$)/i,
  /(?:^|[\\/])id_ecdsa(?:\b|$)/i,
  /(?:^|[\\/])id_dsa(?:\b|$)/i,
  /(?:^|[\\/])authorized_keys(?:\b|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(?:^|[\\/])etc[\\/](?:shadow|gshadow|sudoers)(?:[\\/]|$)/i,
  /(?:^|[\\/])mcp_config\.json$/i,
  /(?:^|[\\/])\.gnupg(?:[\\/]|$)/i,
  /(?:^|[\\/])\.aws[\\/]credentials$/i
];

/**
 * Invariant INV-EXT-02 (3-Zone Filesystem Privacy Shield):
 * Inspects a requested path and blocks `..` path traversal or access to sensitive vault/key files.
 */
export function isPathProtectedOrTraversed(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') {
    return { blocked: false };
  }

  const raw = targetPath.trim();
  if (!raw) {
    return { blocked: false };
  }

  const normalizedSlashes = raw.replace(/\\/g, '/');

  // 1. Check for path traversal (`..` segments or encoded traversal)
  if (
    /(?:^|\/)\.\.(?:\/|$)/.test(normalizedSlashes) ||
    raw.includes('..') ||
    /%2e%2e/i.test(raw)
  ) {
    return {
      blocked: true,
      reason: 'PATH_TRAVERSAL'
    };
  }

  // 2. Check for sensitive key/credential vault files
  for (const pattern of VAULT_LOCKED_PATTERNS) {
    if (pattern.test(normalizedSlashes) || pattern.test(raw)) {
      return {
        blocked: true,
        reason: 'VAULT_LOCKED'
      };
    }
  }

  return { blocked: false };
}

/**
 * Invariant INV-EXT-02:
 * Redacts `KEY=value` secret assignments (e.g. API_KEY=..., TOKEN=..., PASSWORD=..., SECRET=...)
 * to `KEY=[REDACTED]` so secret values are never exposed in prompt context or tool responses.
 */
export function redactEnvSecrets(text) {
  if (typeof text !== 'string' || !text) {
    return '';
  }

  return text
    .replace(
      /\b([A-Za-z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|PRIVATE_KEY|CLIENT_SECRET|AUTH_KEY|WEBHOOK_SECRET|SIGNING_SECRET|CREDENTIAL|ACCESS_KEY|BEARER|DATABASE_URL|PGPASSWORD|REDIS_PASSWORD|JWT_SECRET|ENCRYPTION_KEY|_KEY)[A-Za-z0-9_]*)\s*=\s*([^\r\n#]+)/gi,
      '$1=[REDACTED]'
    )
    .replace(
      /\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      '[REDACTED]'
    );
}

/**
 * Ensure the SQLite table for page-anchored memories (`companion_fs_page_memories`) exists.
 */
export function ensureKruschFsTables() {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS companion_fs_page_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      page_number INTEGER DEFAULT 1,
      page_hash TEXT NOT NULL,
      category TEXT DEFAULT 'annotation',
      note TEXT NOT NULL,
      quoted_sentence TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Compute a deterministic 16-char SHA-256 page hash for drift detection.
 */
export function computePageHash(pageText) {
  return crypto
    .createHash('sha256')
    .update(String(pageText ?? ''), 'utf-8')
    .digest('hex')
    .slice(0, 16);
}

function isAllowedFile(filePath) {
  const base = path.basename(filePath);
  if (isPathProtectedOrTraversed(filePath).blocked) {
    return false;
  }
  if (base === '.env' || base.startsWith('.env.')) {
    return true;
  }
  const ext = path.extname(base).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

function isRealPathWithinDirs(realTarget, candidateDirs = []) {
  if (!realTarget || !Array.isArray(candidateDirs) || candidateDirs.length === 0) {
    return false;
  }
  for (const dir of candidateDirs) {
    if (!dir) continue;
    let realDir;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      realDir = path.resolve(dir);
    }
    const rel = path.relative(realDir, realTarget);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}

/**
 * Read readable text from a supported local file (including basic text extraction from PDF buffers).
 * Enforces MAX_FILE_BYTES (2 MB) before reading and verifies symlinks/realpaths do not escape candidateDirs.
 */
export function readFileTextSafely(filePath, candidateDirs = null) {
  const lstat = fs.lstatSync(filePath);
  const realTarget = fs.realpathSync(filePath);

  if (
    isPathProtectedOrTraversed(String(filePath)).blocked ||
    isPathProtectedOrTraversed(realTarget).blocked ||
    !isAllowedFile(realTarget)
  ) {
    throw new Error(`Access denied by KruschFS 3-Zone Privacy Shield: ${filePath}`);
  }

  const effectiveDirs =
    Array.isArray(candidateDirs) && candidateDirs.length > 0
      ? candidateDirs
      : lstat.isSymbolicLink()
        ? resolveCandidateDirectories()
        : null;

  if (effectiveDirs && !isRealPathWithinDirs(realTarget, effectiveDirs)) {
    throw new Error(`Symlink or target path escapes allowed KruschFS directories: ${filePath}`);
  }

  const stat = fs.statSync(realTarget);
  if (!stat.isFile()) {
    throw new Error(`Target is not a regular file: ${filePath}`);
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(
      `File size (${stat.size} bytes) exceeds maximum allowed limit of ${MAX_FILE_BYTES} bytes`
    );
  }

  const ext = path.extname(realTarget).toLowerCase();
  const buf = fs.readFileSync(realTarget);

  if (ext === '.pdf') {
    const rawLatin = buf.toString('latin1');
    const textLiterals = [];
    const literalRegex = /\(([^()\\]{2,})\)/g;
    let match;
    while ((match = literalRegex.exec(rawLatin)) !== null) {
      const cleaned = match[1].replace(/[^\x20-\x7E\n\r\t]/g, '').trim();
      if (cleaned.length >= 2) {
        textLiterals.push(cleaned);
      }
    }
    if (textLiterals.length > 0) {
      return textLiterals.join('\n');
    }
    return buf
      .toString('utf-8')
      .replace(/[^\x20-\x7E\n\r\t]/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  return buf.toString('utf-8');
}

/**
 * Split file content into logical 60-line pages with SHA-256 pageHash and section headings.
 */
export function paginateFileContent(rawText, linesPerPage = LINES_PER_PAGE) {
  const normalized = String(rawText ?? '').replace(/\r\n/g, '\n');
  const allLines = normalized.split('\n');
  if (allLines.length === 0) {
    allLines.push('');
  }

  const pages = [];
  const totalPages = Math.max(1, Math.ceil(allLines.length / linesPerPage));

  for (let i = 0; i < totalPages; i++) {
    const pageNumber = i + 1;
    const startIdx = i * linesPerPage;
    const pageLines = allLines.slice(startIdx, startIdx + linesPerPage);
    const startLine = startIdx + 1;
    const endLine = startIdx + pageLines.length;
    const pageText = pageLines.join('\n');
    const pageHash = computePageHash(pageText);

    const headingLine = pageLines.find(l => /^#{1,6}\s+.+/.test(l.trim()));
    const sectionTitle = headingLine
      ? headingLine.trim().replace(/^#{1,6}\s+/, '').trim()
      : `Page ${pageNumber} (Lines ${startLine}-${endLine})`;

    pages.push({
      pageNumber,
      startLine,
      endLine,
      lineCount: pageLines.length,
      sectionTitle,
      pageHash,
      pageText
    });
  }

  return {
    totalLines: allLines.length,
    totalPages: pages.length,
    pages
  };
}

function resolveCandidateDirectories({ notesDir, searchDirs } = {}) {
  if (Array.isArray(searchDirs) && searchDirs.length > 0) {
    return searchDirs
      .map(d => String(d || '').trim())
      .filter(d => d && !isPathProtectedOrTraversed(d).blocked && fs.existsSync(d));
  }
  if (typeof searchDirs === 'string' && searchDirs.trim()) {
    const single = searchDirs.trim();
    return !isPathProtectedOrTraversed(single).blocked && fs.existsSync(single) ? [single] : [];
  }

  const defaultDirs = [
    notesDir || process.env.COMPANION_NOTES_DIR || getNotesDirectory(),
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'Downloads')
  ];

  const seen = new Set();
  const existing = [];
  for (const dir of defaultDirs) {
    if (!dir) continue;
    const resolved = path.resolve(dir);
    if (!seen.has(resolved) && fs.existsSync(resolved)) {
      try {
        if (fs.statSync(resolved).isDirectory()) {
          seen.add(resolved);
          existing.push(resolved);
        }
      } catch {
        // Ignore inaccessible directories
      }
    }
  }
  return existing;
}

function collectCandidateFiles(rootDirs, maxDepth = MAX_SCAN_DEPTH) {
  const results = [];
  const seenPaths = new Set();

  function walk(currentDir, depth, baseRoot) {
    if (results.length >= MAX_SCANNED_FILES || depth > maxDepth) {
      return;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= MAX_SCANNED_FILES) break;
      const fullPath = path.join(currentDir, entry.name);

      if (isPathProtectedOrTraversed(fullPath).blocked) {
        continue;
      }

      if (entry.isDirectory()) {
        if (SKIPPED_DIR_NAMES.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        walk(fullPath, depth + 1, baseRoot);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        try {
          const realTarget = fs.realpathSync(fullPath);
          if (
            isPathProtectedOrTraversed(realTarget).blocked ||
            !isRealPathWithinDirs(realTarget, rootDirs) ||
            !isAllowedFile(realTarget)
          ) {
            continue;
          }
          if (seenPaths.has(realTarget)) continue;

          const stat = fs.statSync(realTarget);
          if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
            seenPaths.add(realTarget);
            results.push({
              filePath: realTarget,
              fileName: entry.name,
              relativePath: path.relative(baseRoot, realTarget),
              rootDir: baseRoot,
              sizeBytes: stat.size,
              mtimeIso: stat.mtime.toISOString()
            });
          }
        } catch {
          // Skip unreadable or broken symlinks/files
        }
      }
    }
  }

  for (const rootDir of rootDirs) {
    walk(rootDir, 0, rootDir);
  }

  return results;
}

export function resolveTargetFile(rawFilePath, candidateDirs = [], candidateFiles = []) {
  const cleaned = String(rawFilePath || '').trim();
  if (!cleaned || isPathProtectedOrTraversed(cleaned).blocked) return null;

  const effectiveDirs =
    Array.isArray(candidateDirs) && candidateDirs.length > 0
      ? candidateDirs
      : resolveCandidateDirectories();

  // 1. If an absolute path was passed, strictly require its realpath to reside inside candidateDirs and pass isAllowedFile
  if (path.isAbsolute(cleaned)) {
    if (!fs.existsSync(cleaned)) return null;
    try {
      const realTarget = fs.realpathSync(cleaned);
      if (
        !isPathProtectedOrTraversed(realTarget).blocked &&
        isRealPathWithinDirs(realTarget, effectiveDirs) &&
        isAllowedFile(realTarget) &&
        fs.statSync(realTarget).isFile()
      ) {
        return realTarget;
      }
    } catch {
      return null;
    }
    return null;
  }

  // 2. Check if relative path resolves directly inside one of candidateDirs
  for (const dir of effectiveDirs) {
    const candidate = path.resolve(dir, cleaned);
    if (!isPathProtectedOrTraversed(candidate).blocked && fs.existsSync(candidate)) {
      try {
        const realTarget = fs.realpathSync(candidate);
        if (
          !isPathProtectedOrTraversed(realTarget).blocked &&
          isRealPathWithinDirs(realTarget, effectiveDirs) &&
          isAllowedFile(realTarget) &&
          fs.statSync(realTarget).isFile()
        ) {
          return realTarget;
        }
      } catch {
        // continue
      }
    }
  }

  // 3. Match by basename or relative path in scanned candidate files
  const lowerCleaned = cleaned.toLowerCase();
  const baseCleaned = path.basename(cleaned).toLowerCase();
  const matched =
    candidateFiles.find(f => f.filePath.toLowerCase() === lowerCleaned) ||
    candidateFiles.find(f => f.fileName.toLowerCase() === baseCleaned) ||
    candidateFiles.find(f => f.fileName.toLowerCase().includes(baseCleaned.replace(/\.md$/i, '')));

  if (!matched) return null;
  try {
    const realMatched = fs.realpathSync(matched.filePath);
    if (
      !isPathProtectedOrTraversed(realMatched).blocked &&
      isRealPathWithinDirs(realMatched, effectiveDirs) &&
      isAllowedFile(realMatched)
    ) {
      return realMatched;
    }
  } catch {
    return null;
  }
  return null;
}

function getMemoriesForFile(database, resolvedPath, rawInputPath = '') {
  const baseName = path.basename(resolvedPath);
  const rows = database
    .prepare(
      `
      SELECT * FROM companion_fs_page_memories
      WHERE file_path = ? OR file_path = ? OR file_path LIKE ?
      ORDER BY page_number ASC, id ASC
    `
    )
    .all(resolvedPath, String(rawInputPath || '').trim(), `%${baseName}`);
  return rows;
}

/**
 * Opt-in KruschFS Local Document, PDF & Multi-Node Fleet Page Explorer (`krusch_fs_explorer`).
 */
export const KRUSCH_FS_EXTENSION_TOOL = {
  name: 'krusch_fs_explorer',
  category: 'filesystem_bridge',
  extensionId: 'krusch-fs-bridge',
  description:
    'Opt-in KruschFS Local Document, PDF & Multi-Node Fleet Page Explorer: search ~/Documents, ~/Downloads, and local vault notes, inspect page_tree Table of Contents, read bounded pages with SHA-256 drift detection, or pin page-anchored memories (with 3-Zone Privacy Shield).',
  parameters: {
    action: 'string (REQUIRED: "search" | "locate" | "page_tree" | "read_page" | "remember_on_page")',
    query: 'string (Search query or glob pattern for search/locate)',
    filePath: 'string (Target file path or note filename for page_tree, read_page, or remember_on_page)',
    pageNumber: 'number (1-based logical page number, default: 1)',
    note: 'string (Page-anchored operational note or summary for remember_on_page)',
    node: 'string (Target homelab node, default: "local")'
  },
  required: ['action'],
  async execute(args = {}, { notesDir, searchDirs } = {}) {
    ensureKruschFsTables();
    const action = String(args?.action || 'search').toLowerCase().trim();
    const node = String(args?.node || 'local').trim() || 'local';
    const database = getDb();

    // Enforce 3-Zone Privacy Shield on filePath and query if path-like
    if (args?.filePath !== undefined && args?.filePath !== null && String(args.filePath).trim() !== '') {
      const shield = isPathProtectedOrTraversed(String(args.filePath));
      if (shield.blocked) {
        return {
          ok: false,
          blocked: true,
          reason: shield.reason,
          tool: 'krusch_fs_explorer',
          actionType: `krusch_fs_${action}`,
          summary: `🛡️ **3-Zone Privacy Shield Blocked (${shield.reason})**: Access to \`${args.filePath}\` is strictly prohibited.`
        };
      }
    }

    if (args?.query && (String(args.query).includes('..') || isPathProtectedOrTraversed(String(args.query)).blocked)) {
      const shield = isPathProtectedOrTraversed(String(args.query));
      if (shield.blocked) {
        return {
          ok: false,
          blocked: true,
          reason: shield.reason,
          tool: 'krusch_fs_explorer',
          actionType: `krusch_fs_${action}`,
          summary: `🛡️ **3-Zone Privacy Shield Blocked (${shield.reason})**: Query \`${args.query}\` was blocked by the filesystem privacy shield.`
        };
      }
    }

    const candidateDirs = resolveCandidateDirectories({ notesDir, searchDirs });
    const candidateFiles = collectCandidateFiles(candidateDirs);

    // 1. LOCATE
    if (action === 'locate') {
      const rawPattern = String(args?.query || args?.pattern || '*').trim();
      const regexStr =
        '^' +
        rawPattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.') +
        '$';
      const globRegex = new RegExp(regexStr, 'i');
      const lowerSub = rawPattern.replace(/[*?]/g, '').toLowerCase();

      const matchedFiles = candidateFiles.filter(f => {
        if (rawPattern === '*' || !rawPattern) return true;
        return (
          globRegex.test(f.fileName) ||
          globRegex.test(f.relativePath) ||
          (lowerSub && f.fileName.toLowerCase().includes(lowerSub)) ||
          (lowerSub && f.relativePath.toLowerCase().includes(lowerSub))
        );
      });

      const summaryLines = matchedFiles
        .slice(0, 15)
        .map(f => `- \`${f.fileName}\` (${f.sizeBytes} B) — \`${f.filePath}\``);

      return {
        ok: true,
        tool: 'krusch_fs_explorer',
        actionType: 'krusch_fs_locate',
        summary:
          matchedFiles.length > 0
            ? `🗂️ **KruschFS Locate (${matchedFiles.length} files on \`${node}\`)**:\n${summaryLines.join('\n')}`
            : `🗂️ **KruschFS Locate**: No files matching \`${rawPattern}\` found on \`${node}\`.`,
        data: {
          pattern: rawPattern,
          node,
          count: matchedFiles.length,
          files: matchedFiles
        }
      };
    }

    // 2. SEARCH
    if (action === 'search') {
      const rawQuery = String(args?.query || '').trim();
      const queryLower = rawQuery.toLowerCase();
      const queryTokens = queryLower.split(/\s+/).filter(Boolean);

      const matches = [];
      for (const fileMeta of candidateFiles) {
        let rawContent = '';
        try {
          rawContent = readFileTextSafely(fileMeta.filePath, candidateDirs);
        } catch {
          continue;
        }

        const { pages, totalPages } = paginateFileContent(rawContent);
        const fileMemories = getMemoriesForFile(database, fileMeta.filePath);

        for (const page of pages) {
          const haystack = `${fileMeta.fileName}\n${page.sectionTitle}\n${page.pageText}`.toLowerCase();
          let score = 0;
          if (!rawQuery) {
            score = 1;
          } else {
            if (haystack.includes(queryLower)) score += 5;
            for (const tok of queryTokens) {
              if (haystack.includes(tok)) score += 2;
            }
          }

          const pageMemories = fileMemories
            .filter(m => Number(m.page_number) === page.pageNumber)
            .map(m => ({
              id: m.id,
              pageNumber: m.page_number,
              pageHash: m.page_hash,
              category: m.category,
              note: redactEnvSecrets(m.note),
              isDrifted: m.page_hash !== page.pageHash,
              driftStatus: m.page_hash !== page.pageHash ? 'STALE_DRIFT' : 'VALID'
            }));

          for (const pm of pageMemories) {
            if (rawQuery && pm.note.toLowerCase().includes(queryLower)) {
              score += 4;
            }
          }

          if (score > 0) {
            const redactedSnippet = redactEnvSecrets(page.pageText).slice(0, 360);
            matches.push({
              filePath: fileMeta.filePath,
              fileName: fileMeta.fileName,
              pageNumber: page.pageNumber,
              totalPages,
              startLine: page.startLine,
              endLine: page.endLine,
              sectionTitle: page.sectionTitle,
              pageHash: page.pageHash,
              score,
              snippet: redactedSnippet,
              pageMemories,
              isDrifted: pageMemories.some(m => m.isDrifted),
              driftStatus: pageMemories.some(m => m.isDrifted) ? 'STALE_DRIFT' : 'VALID'
            });
          }
        }
      }

      matches.sort((a, b) => b.score - a.score);
      const topMatches = matches.slice(0, 10);
      const summaryLines = topMatches.map(
        m =>
          `- **\`${m.fileName}\`** (Page ${m.pageNumber}/${m.totalPages} • \`${m.pageHash}\` • ${m.driftStatus}): ${m.snippet.replace(/\s+/g, ' ').slice(0, 140)}`
      );

      return {
        ok: true,
        tool: 'krusch_fs_explorer',
        actionType: 'krusch_fs_search',
        summary:
          topMatches.length > 0
            ? `🔍 **KruschFS Search Results for "${rawQuery || '*'}" (${topMatches.length} hits on \`${node}\`)**:\n${summaryLines.join('\n')}`
            : `🔍 **KruschFS Search**: No pages matched "${rawQuery}" across scanned vaults on \`${node}\`.`,
        data: {
          query: rawQuery,
          node,
          count: topMatches.length,
          results: topMatches
        }
      };
    }

    // 3. PAGE_TREE
    if (action === 'page_tree') {
      const targetInput = String(args?.filePath || args?.query || '').trim();
      if (!targetInput) {
        return {
          ok: false,
          tool: 'krusch_fs_explorer',
          actionType: 'krusch_fs_page_tree',
          summary: 'Parameter "filePath" is required for page_tree.'
        };
      }

      const resolvedPath = resolveTargetFile(targetInput, candidateDirs, candidateFiles);
      if (!resolvedPath) {
        return {
          ok: false,
          tool: 'krusch_fs_explorer',
          actionType: 'krusch_fs_page_tree',
          summary: `File "${targetInput}" was not found in allowed KruschFS directories.`
        };
      }

      let rawText = '';
      try {
        rawText = readFileTextSafely(resolvedPath, candidateDirs);
      } catch (err) {
        return {
          ok: false,
          tool: 'krusch_fs_explorer',
          actionType: 'krusch_fs_page_tree',
          summary: `Cannot read "${targetInput}": ${err.message}`
        };
      }
      const { totalLines, totalPages, pages } = paginateFileContent(rawText);
      const fileMemories = getMemoriesForFile(database, resolvedPath, targetInput);

      const tocPages = pages.map(p => {
        const mems = fileMemories.filter(m => Number(m.page_number) === p.pageNumber);
        const hasDriftedMemory = mems.some(m => m.page_hash !== p.pageHash);
        return {
          pageNumber: p.pageNumber,
          sectionTitle: p.sectionTitle,
          startLine: p.startLine,
          endLine: p.endLine,
          lineCount: p.lineCount,
          pageHash: p.pageHash,
          memoryCount: mems.length,
          hasDriftedMemory,
          driftStatus: hasDriftedMemory ? 'STALE_DRIFT' : 'VALID'
        };
      });

      const tocSummary = tocPages
        .map(
          p =>
            `- **Page ${p.pageNumber}** (\`L${p.startLine}-L${p.endLine}\` • hash \`${p.pageHash}\`): ${p.sectionTitle} (${p.memoryCount} memories, ${p.driftStatus})`
        )
        .join('\n');

      return {
        ok: true,
        tool: 'krusch_fs_explorer',
        actionType: 'krusch_fs_page_tree',
        summary: `📑 **KruschFS Page Tree for \`${path.basename(resolvedPath)}\`** (${totalPages} page(s), ${totalLines} lines):\n${tocSummary}`,
        data: {
          filePath: resolvedPath,
          fileName: path.basename(resolvedPath),
          node,
          totalLines,
          totalPages,
          pages: tocPages
        }
      };
    }

    // 4. READ_PAGE
    if (action === 'read_page') {
      const targetInput = String(args?.filePath || args?.query || '').trim();
      if (!targetInput) {
        return {
          ok: false,
          tool: 'krusch_fs_explorer',
          actionType: 'krusch_fs_read_page',
          summary: 'Parameter "filePath" is required for read_page.'
        };
      }

      const resolvedPath = resolveTargetFile(targetInput, candidateDirs, candidateFiles);
      if (!resolvedPath) {
        return {
          ok: false,
          tool: 'krusch_fs_explorer',
          actionType: 'krusch_fs_read_page',
          summary: `File "${targetInput}" was not found in allowed KruschFS directories.`
        };
      }

      let rawText = '';
      try {
        rawText = readFileTextSafely(resolvedPath, candidateDirs);
      } catch (err) {
        return {
          ok: false,
          tool: 'krusch_fs_explorer',
          actionType: 'krusch_fs_read_page',
          summary: `Cannot read "${targetInput}": ${err.message}`
        };
      }
      const { totalLines, totalPages, pages } = paginateFileContent(rawText);
      const requestedPageNum = Math.max(1, parseInt(args?.pageNumber, 10) || 1);
      const page = pages.find(p => p.pageNumber === requestedPageNum) || pages[pages.length - 1];

      const redactedContent = redactEnvSecrets(page.pageText);
      const fileMemories = getMemoriesForFile(database, resolvedPath, targetInput);
      const pageMemories = fileMemories
        .filter(m => Number(m.page_number) === page.pageNumber)
        .map(m => {
          const drifted = m.page_hash !== page.pageHash;
          return {
            id: m.id,
            filePath: m.file_path,
            pageNumber: m.page_number,
            storedPageHash: m.page_hash,
            currentPageHash: page.pageHash,
            category: m.category,
            note: redactEnvSecrets(m.note),
            quotedSentence: redactEnvSecrets(m.quoted_sentence || ''),
            createdAt: m.created_at,
            isDrifted: drifted,
            driftStatus: drifted ? 'STALE_DRIFT' : 'VALID'
          };
        });

      const isDrifted = pageMemories.some(m => m.isDrifted);
      const driftStatus = isDrifted ? 'STALE_DRIFT' : 'VALID';

      return {
        ok: true,
        tool: 'krusch_fs_explorer',
        actionType: 'krusch_fs_read_page',
        summary: `📖 **KruschFS Page ${page.pageNumber}/${totalPages} of \`${path.basename(resolvedPath)}\`** (\`L${page.startLine}-L${page.endLine}\` • hash \`${page.pageHash}\` • \`${driftStatus}\`):\n\n${redactedContent}`,
        data: {
          filePath: resolvedPath,
          fileName: path.basename(resolvedPath),
          node,
          pageNumber: page.pageNumber,
          totalPages,
          totalLines,
          startLine: page.startLine,
          endLine: page.endLine,
          sectionTitle: page.sectionTitle,
          pageHash: page.pageHash,
          content: redactedContent,
          pageText: redactedContent,
          isDrifted,
          driftStatus,
          pageMemories
        }
      };
    }

    // 5. REMEMBER_ON_PAGE
    if (action === 'remember_on_page') {
      const targetInput = String(args?.filePath || '').trim();
      const rawNote = String(args?.note || args?.content || '').trim();
      const pageNumber = Math.max(1, parseInt(args?.pageNumber, 10) || 1);
      const category = String(args?.category || 'annotation').trim() || 'annotation';

      if (!targetInput || !rawNote) {
        return {
          ok: false,
          tool: 'krusch_fs_explorer',
          actionType: 'krusch_fs_remember_on_page',
          summary: 'Both "filePath" and "note" are required for remember_on_page.'
        };
      }

      const existingTarget = resolveTargetFile(targetInput, candidateDirs, candidateFiles);
      if (!existingTarget && path.isAbsolute(targetInput)) {
        return {
          ok: false,
          blocked: true,
          reason: 'OUTSIDE_ALLOWED_DIRS',
          tool: 'krusch_fs_explorer',
          actionType: 'krusch_fs_remember_on_page',
          summary: `🛡️ **3-Zone Privacy Shield Blocked (OUTSIDE_ALLOWED_DIRS)**: Path \`${targetInput}\` is outside allowed KruschFS directories.`
        };
      }

      const resolvedPath =
        existingTarget ||
        path.resolve(candidateDirs[0] || getNotesDirectory(), path.basename(targetInput));

      const shield = isPathProtectedOrTraversed(resolvedPath);
      if (shield.blocked || !isAllowedFile(resolvedPath)) {
        return {
          ok: false,
          blocked: true,
          reason: shield.reason || 'DISALLOWED_EXTENSION',
          tool: 'krusch_fs_explorer',
          actionType: 'krusch_fs_remember_on_page',
          summary: `🛡️ **3-Zone Privacy Shield Blocked (${shield.reason || 'DISALLOWED_EXTENSION'})**: Cannot anchor memory on protected path \`${targetInput}\`.`
        };
      }

      let pageHash = computePageHash('');
      let quotedSentence = String(args?.quotedSentence || '').trim();

      if (fs.existsSync(resolvedPath)) {
        const rawText = readFileTextSafely(resolvedPath, candidateDirs);
        const { pages } = paginateFileContent(rawText);
        const targetPage = pages.find(p => p.pageNumber === pageNumber) || pages[0];
        if (targetPage) {
          pageHash = targetPage.pageHash;
          if (!quotedSentence) {
            const firstNonEmpty = targetPage.pageText
              .split('\n')
              .map(l => l.trim())
              .find(Boolean);
            quotedSentence = firstNonEmpty ? redactEnvSecrets(firstNonEmpty).slice(0, 160) : '';
          }
        }
      }

      const safeNote = redactEnvSecrets(rawNote);
      const stmt = database.prepare(`
        INSERT INTO companion_fs_page_memories (file_path, page_number, page_hash, category, note, quoted_sentence)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const info = stmt.run(resolvedPath, pageNumber, pageHash, category, safeNote, quotedSentence);

      return {
        ok: true,
        tool: 'krusch_fs_explorer',
        actionType: 'krusch_fs_remember_on_page',
        summary: `📌 **Pinned Page Memory (#${info.lastInsertRowid})** on \`${path.basename(resolvedPath)}\` (Page ${pageNumber} • hash \`${pageHash}\`):\n> ${safeNote}`,
        data: {
          id: Number(info.lastInsertRowid),
          filePath: resolvedPath,
          fileName: path.basename(resolvedPath),
          node,
          pageNumber,
          pageHash,
          category,
          note: safeNote,
          quotedSentence,
          isDrifted: false,
          driftStatus: 'VALID'
        }
      };
    }

    return {
      ok: false,
      tool: 'krusch_fs_explorer',
      actionType: `krusch_fs_${action}`,
      summary: `Unsupported krusch_fs_explorer action "${action}". Valid actions: search, locate, page_tree, read_page, remember_on_page.`
    };
  }
};
