/**
 * Minimal YAML parser — only meant for reading docker-compose and Spring application.yml, not completeness.
 *
 * Supports: nested maps, lists, maps inside list items, trailing comments, quotes, inline arrays/maps,
 * booleans/numbers/null, `|` `>` block text, `---` document separators.
 * Does not support (rare in real projects): anchors/aliases `&x` `*x`, multi-document merging, complex tags.
 *
 * Design stance: **read what you can, warn on the rest and keep going**; never fail a whole file over one odd line.
 */

function stripComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (quote === '"' && char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index);
  }
  return line;
}

/** Find the colon of `key:` (must be followed by a space or end of line), skipping colons inside quotes */
function findKeySeparator(content) {
  let quote = null;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quote) {
      if (quote === '"' && char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ':' && (index === content.length - 1 || /\s/.test(content[index + 1]))) return index;
  }
  return -1;
}

function splitInline(text, separator = ',') {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      current += char;
      if (quote === '"' && char === '\\') {
        current += text[index + 1] ?? '';
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '[' || char === '{') depth += 1;
    if (char === ']' || char === '}') depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function unquote(text) {
  const value = String(text ?? '').trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

export function parseScalar(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return splitInline(inner).map((item) => parseScalar(item));
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    const inner = text.slice(1, -1).trim();
    const object = {};
    if (!inner) return object;
    for (const part of splitInline(inner)) {
      const at = findKeySeparator(part);
      if (at === -1) continue;
      object[unquote(part.slice(0, at))] = parseScalar(part.slice(at + 1));
    }
    return object;
  }
  if (/^"(?:[^"\\]|\\.)*"$/.test(text) || /^'(?:[^']|'')*'$/.test(text)) return unquote(text);
  if (/^(true|yes|on)$/i.test(text)) return true;
  if (/^(false|no|off)$/i.test(text)) return false;
  if (/^(null|~)$/i.test(text)) return null;
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d*\.\d+$/.test(text)) return Number.parseFloat(text);
  return text;
}

const BLOCK_SCALAR_RE = /^[|>][+-]?\d*$/;

/** Split YAML text into an "indent + key/value / list item" token stream; block text is consumed here */
function tokenize(text) {
  const warnings = [];
  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);
  const tokens = [];

  for (let index = 0; index < lines.length; index += 1) {
    const original = lines[index];
    const withoutComment = stripComment(original);
    if (!/\S/.test(withoutComment)) continue;

    const indentMatch = withoutComment.match(/^[ \t]*/) ?? [''];
    let indentText = indentMatch[0];
    if (indentText.includes('\t')) {
      warnings.push(`line ${index + 1}: indent uses a tab (YAML requires spaces), treated as 2 spaces`);
      indentText = indentText.replace(/\t/g, '  ');
    }
    const indent = indentText.length;
    const content = withoutComment.slice(indentMatch[0].length).trimEnd();
    if (!content || /^---$/.test(content) || /^\.\.\.$/.test(content)) continue;

    if (content === '-' || content.startsWith('- ')) {
      tokens.push({ type: 'item', indent, valueRaw: content === '-' ? '' : content.slice(2).trim(), line: index + 1 });
      continue;
    }

    const at = findKeySeparator(content);
    if (at === -1) {
      // Lines without ": " are usually a continuation of the previous block; skip quietly, but flag ones with a colon
      if (content.includes(':') && !content.startsWith('#')) {
        warnings.push(`line ${index + 1}: cannot parse (missing ": "): ${content.slice(0, 40)}`);
      }
      continue;
    }

    const key = unquote(content.slice(0, at));
    let valueRaw = content.slice(at + 1).trim();

    if (BLOCK_SCALAR_RE.test(valueRaw)) {
      const style = valueRaw.startsWith('>') ? '>' : '|';
      const keepChomp = valueRaw.includes('-');
      const blockLines = [];
      let cursor = index + 1;
      let blockIndent = -1;
      while (cursor < lines.length) {
        const rawLine = lines[cursor];
        if (!/\S/.test(rawLine)) {
          blockLines.push('');
          cursor += 1;
          continue;
        }
        const lineIndent = (rawLine.match(/^[ \t]*/) ?? [''])[0].replace(/\t/g, '  ').length;
        if (lineIndent <= indent) break;
        if (blockIndent === -1) blockIndent = lineIndent;
        blockLines.push(rawLine.slice(Math.min(blockIndent, lineIndent)));
        cursor += 1;
      }
      index = cursor - 1;
      const joined = style === '>' ? blockLines.join(' ').replace(/\s+/g, ' ').trim() : blockLines.join('\n').replace(/\s+$/, '');
      tokens.push({ type: 'pair', indent, key, valueRaw: joined, line: index + 1, block: true });
      if (keepChomp) continue;
      continue;
    }

    tokens.push({ type: 'pair', indent, key, valueRaw, line: index + 1 });
  }
  return { tokens, warnings };
}

function parseBlock(tokens, startIndex, indent, ctx = { anchors: new Map() }) {
  const first = tokens[startIndex];
  if (!first || first.indent < indent) return [null, startIndex];

  if (first.type === 'item') {
    const list = [];
    let index = startIndex;
    while (index < tokens.length && tokens[index].indent === indent && tokens[index].type === 'item') {
      const token = tokens[index];
      if (!token.valueRaw) {
        const nextToken = tokens[index + 1];
        if (nextToken && nextToken.indent > indent) {
          const [child, next] = parseBlock(tokens, index + 1, nextToken.indent, ctx);
          list.push(child);
          index = next;
        } else {
          list.push(null);
          index += 1;
        }
        continue;
      }
      const at = findKeySeparator(token.valueRaw);
      if (at !== -1 && !token.valueRaw.startsWith('[') && !token.valueRaw.startsWith('{')) {
        // `- key: value` → object; deeper-indented pairs in the same item also belong to it
        const object = { [unquote(token.valueRaw.slice(0, at))]: parseScalar(token.valueRaw.slice(at + 1)) };
        index += 1;
        const nextToken = tokens[index];
        if (nextToken && nextToken.indent > indent && nextToken.type === 'pair') {
          const [child, next] = parseBlock(tokens, index, nextToken.indent, ctx);
          if (child && typeof child === 'object' && !Array.isArray(child)) Object.assign(object, child);
          index = next;
        }
        list.push(object);
        continue;
      }
      list.push(parseScalar(token.valueRaw));
      index += 1;
    }
    return [list, index];
  }

  const map = {};
  let index = startIndex;
  while (index < tokens.length && tokens[index].indent === indent && tokens[index].type === 'pair') {
    const token = tokens[index];
    if (token.block) {
      map[token.key] = token.valueRaw;
      index += 1;
      continue;
    }
    // Anchor on a mapping: `default: &default`
    const anchor = /^&([A-Za-z_][A-Za-z0-9_-]*)$/.exec(token.valueRaw ?? '');
    if (anchor) {
      const nextToken = tokens[index + 1];
      let child = null;
      if (nextToken && nextToken.indent > indent) {
        [child, index] = parseBlock(tokens, index + 1, nextToken.indent, ctx);
      } else {
        index += 1;
      }
      ctx.anchors.set(anchor[1], child);
      map[token.key] = child;
      continue;
    }
    // Merge key: `<<: *default`
    if (token.key === '<<') {
      const merge = /^\*([A-Za-z_][A-Za-z0-9_-]*)$/.exec(token.valueRaw ?? '');
      if (merge && ctx.anchors.has(merge[1])) {
        const source = ctx.anchors.get(merge[1]);
        if (source && typeof source === 'object' && !Array.isArray(source)) Object.assign(map, source);
      }
      index += 1;
      continue;
    }
    if (!token.valueRaw) {
      const nextToken = tokens[index + 1];
      if (nextToken && nextToken.indent > indent) {
        const [child, next] = parseBlock(tokens, index + 1, nextToken.indent, ctx);
        map[token.key] = child;
        index = next;
      } else {
        map[token.key] = null;
        index += 1;
      }
      continue;
    }
    // Alias value: `key: *default`
    const alias = /^\*([A-Za-z_][A-Za-z0-9_-]*)$/.exec(token.valueRaw);
    map[token.key] = alias && ctx.anchors.has(alias[1]) ? ctx.anchors.get(alias[1]) : parseScalar(token.valueRaw);
    index += 1;
  }
  return [map, index];
}

export function parseYaml(text) {
  const { tokens, warnings } = tokenize(text);
  if (!tokens.length) return { data: {}, warnings };
  const [data] = parseBlock(tokens, 0, tokens[0].indent);
  return { data: data ?? {}, warnings };
}

/** application.properties / *.properties */
export function parseProperties(text) {
  const data = {};
  const warnings = [];
  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);
  let pending = '';
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (/^\s*[#!]/.test(line)) continue;
    if (/\\\s*$/.test(line)) {
      pending += line.replace(/\\\s*$/, '');
      continue;
    }
    line = pending + line;
    pending = '';
    const trimmed = line.trim();
    if (!trimmed) continue;
    const at = trimmed.search(/[=:]/);
    if (at === -1) {
      warnings.push(`line ${index + 1}: missing = or :, skipped`);
      continue;
    }
    const key = trimmed.slice(0, at).trim();
    const value = trimmed.slice(at + 1).trim();
    if (key) data[key] = value;
  }
  return { data, warnings };
}

/** Flatten a nested object into a dotted a.b.c table (arrays stay as leaf values) */
export function flattenPaths(data, prefix = '', out = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
  for (const [key, value] of Object.entries(data)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flattenPaths(value, full, out);
    else out[full] = value;
  }
  return out;
}

/** Look up by a.b.c, accepting both nested and already-flat keys */
export function getPath(data, dottedPath) {
  if (!data || typeof data !== 'object') return undefined;
  const flat = flattenPaths(data);
  return Object.prototype.hasOwnProperty.call(flat, dottedPath) ? flat[dottedPath] : undefined;
}
