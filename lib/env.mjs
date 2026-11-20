/**
 * .env file parser (read-only). No third-party packages; handles the common forms:
 *   KEY=value
 *   export KEY="value with # and spaces"
 *   KEY='literal ${NOT_EXPANDED}'
 *   KEY=`a\nb`
 *   KEY=value # trailing comment
 *   KEY=${OTHER}/suffix
 *
 * Results keep **line numbers**, so `dbcli list` / `dbcli env` can report which file and line
 * a value came from; when something breaks, an agent can pinpoint it instead of guessing.
 */

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Parse the value of one line: quotes, escapes, trailing comments */
function parseValue(raw, { expand, lookup, warnings, lineNo }) {
  let text = raw.trim();
  if (!text) return '';

  if (text.startsWith('"')) {
    let out = '';
    let index = 1;
    let closed = false;
    while (index < text.length) {
      const char = text[index];
      if (char === '\\' && index + 1 < text.length) {
        const next = text[index + 1];
        const map = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', $: '$' };
        out += map[next] ?? next;
        index += 2;
        continue;
      }
      if (char === '"') {
        closed = true;
        index += 1;
        break;
      }
      out += char;
      index += 1;
    }
    if (!closed) warnings.push(`line ${lineNo}: unclosed double quote, treating the rest of the line as the value`);
    const rest = text.slice(index).trim();
    if (rest && !rest.startsWith('#')) warnings.push(`line ${lineNo}: extra content after the closing quote, ignored: ${rest}`);
    return expand ? expandVars(out, lookup, warnings) : out;
  }

  if (text.startsWith("'")) {
    const end = text.indexOf("'", 1);
    if (end === -1) {
      warnings.push(`line ${lineNo}: unclosed single quote, treating the rest of the line as the value`);
      return text.slice(1);
    }
    const rest = text.slice(end + 1).trim();
    if (rest && !rest.startsWith('#')) warnings.push(`line ${lineNo}: extra content after the closing quote, ignored: ${rest}`);
    return text.slice(1, end);
  }

  // Unquoted: ` #` starts a comment; a # inside the value is kept
  const commentAt = text.search(/(^|[ \t])#/);
  if (commentAt >= 0) text = text.slice(0, commentAt).trim();
  return expand ? expandVars(text, lookup, warnings) : text;
}

/** Expand ${VAR} / $VAR; leave unknown names untouched and record a warning (never silent) */
export function expandVars(text, lookup, warnings = []) {
  return String(text).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
    const name = braced ?? bare;
    const value = lookup(name);
    if (value === undefined) {
      warnings.push(`variable ${name} is not defined, keeping the original text ${match}`);
      return match;
    }
    return value;
  });
}

/**
 * @param {string} text file contents
 * @param {object} [options]
 * @param {Map<string,string>} [options.prior] higher-priority variables (used for expansion)
 * @param {Map<string,string>} [options.processEnv] process environment (expansion fallback)
 * @returns {{vars: Map<string,{value:string,line:number}>, warnings: string[]}}
 */
export function parseDotenv(text, { prior = new Map(), processEnv = process.env } = {}) {
  const vars = new Map();
  const warnings = [];
  const lookup = (name) => {
    if (vars.has(name)) return vars.get(name).value;
    if (prior.has(name)) return typeof prior.get(name) === 'object' ? prior.get(name).value : prior.get(name);
    return processEnv?.[name];
  };

  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    const lineNo = index + 1;
    // Trailing backslash continues the line (use a quoted \n to embed a newline in a value)
    while (/\\\s*$/.test(line) && index + 1 < lines.length) {
      line = `${line.replace(/\\\s*$/, '')}${lines[index + 1]}`;
      index += 1;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^---$/.test(trimmed)) continue;

    let body = trimmed;
    if (/^export\s+/i.test(body)) body = body.replace(/^export\s+/i, '');

    const eq = body.indexOf('=');
    if (eq === -1) {
      // `KEY: value` is YAML/properties syntax; not accepted here, but do not stay silent
      if (/^[A-Za-z_][A-Za-z0-9_.]*\s*:\s*\S/.test(body)) {
        warnings.push(`line ${lineNo}: looks like YAML/properties syntax (KEY: value); .env uses KEY=value`);
      }
      continue;
    }
    const key = body.slice(0, eq).trim();
    if (!KEY_RE.test(key)) {
      warnings.push(`line ${lineNo}: invalid variable name (${key || '(empty)'}), skipped`);
      continue;
    }
    const rawValue = body.slice(eq + 1);
    const value = parseValue(rawValue, { expand: true, lookup, warnings, lineNo });
    if (vars.has(key)) {
      warnings.push(`line ${lineNo}: ${key} is defined more than once, the later value wins`);
    }
    vars.set(key, { value, line: lineNo });
  }

  return { vars, warnings };
}

/** Read and parse a file; returns null when it does not exist (no throw, discovery must tolerate gaps) */
export async function readEnvFile(file, options = {}) {
  const fs = await import('node:fs/promises');
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return null;
    throw error;
  }
  const { vars, warnings } = parseDotenv(text, options);
  return { path: file, vars, warnings };
}
