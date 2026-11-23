// The one branded layout every HACA Forge email uses (docs/EMAIL.md).
//
// Table-based with inline CSS so it renders the same in Gmail, Outlook, Apple Mail and phone apps.
// Every color is set explicitly (text and the surface under it), so dark-mode clients that invert or
// keep colors never show light text on a transparent background. Content is described as blocks, and
// each block renders both the HTML and the plain-text version, so the two never drift apart.
// All text passed in is escaped here; templates never build raw HTML from user data.

// Neutrals from docs/UI.md: ink #0B0B0D, body text #1B1F27, muted #586170, canvas #DDE2EB, card #F3F5F9.
export const COLORS = {
  page: '#F3F5F9',
  card: '#FFFFFF',
  ink: '#0B0B0D',
  text: '#1B1F27',
  muted: '#586170',
  border: '#DDE2EB',
  well: '#F3F5F9',
  buttonText: '#FFFFFF',
};

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace";

export const FOOTER_ACCOUNT_LINE = "You're receiving this because you have a HACA Forge account.";
export const FOOTER_ORG = 'Haris & Co Academy';

/** Escape text for HTML element content and quoted attribute values. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A link target that is safe to put in an email: absolute http(s) URLs as they are, app paths
 * ("/work/123") joined to the app URL, anything else (javascript:, data:, garbage) dropped.
 */
export function absoluteUrl(url, appUrl) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/') && !raw.startsWith('//')) return `${String(appUrl || '').replace(/\/+$/, '')}${raw}`;
  return '';
}

/** Collapse whitespace and line breaks: subjects and single-line values. */
export function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Escaped text with line breaks kept as <br>. */
function multiline(value) {
  return escapeHtml(String(value ?? '').trim()).replace(/\r?\n/g, '<br>');
}

const P = `margin:0 0 16px 0;font-family:${FONT};font-size:15px;line-height:24px;color:${COLORS.text};`;

// ---- Blocks ---------------------------------------------------------------------------------------

function renderBlock(block) {
  switch (block.type) {
    case 'paragraph':
      return {
        html: `<p style="${P}">${multiline(block.text)}</p>`,
        text: String(block.text ?? '').trim(),
      };
    case 'small':
      return {
        html: `<p style="margin:0 0 12px 0;font-family:${FONT};font-size:13px;line-height:20px;color:${COLORS.muted};">${multiline(block.text)}</p>`,
        text: String(block.text ?? '').trim(),
      };
    case 'code': {
      const code = oneLine(block.code);
      return {
        html:
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px 0;">` +
          `<tr><td align="center" bgcolor="${COLORS.well}" style="background-color:${COLORS.well};border:1px solid ${COLORS.border};border-radius:12px;padding:20px 12px;">` +
          `<span style="font-family:${MONO};font-size:34px;line-height:40px;font-weight:700;letter-spacing:10px;color:${COLORS.ink};">${escapeHtml(code)}</span>` +
          `</td></tr></table>`,
        text: `    ${code.split('').join(' ')}`,
      };
    }
    case 'details': {
      const rows = (block.rows || []).filter(([, value]) => oneLine(value));
      return {
        html:
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;border-top:1px solid ${COLORS.border};">` +
          rows
            .map(
              ([label, value]) =>
                `<tr>` +
                `<td valign="top" width="38%" style="padding:10px 12px 10px 0;border-bottom:1px solid ${COLORS.border};font-family:${FONT};font-size:13px;line-height:20px;color:${COLORS.muted};">${escapeHtml(label)}</td>` +
                `<td valign="top" style="padding:10px 0;border-bottom:1px solid ${COLORS.border};font-family:${FONT};font-size:14px;line-height:20px;font-weight:600;color:${COLORS.text};">${multiline(value)}</td>` +
                `</tr>`
            )
            .join('') +
          `</table>`,
        text: rows.map(([label, value]) => `${label}: ${oneLine(value)}`).join('\n'),
      };
    }
    case 'note': {
      const label = block.label ? `<strong style="color:${COLORS.ink};">${escapeHtml(block.label)}</strong><br>` : '';
      return {
        html:
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;">` +
          `<tr><td bgcolor="${COLORS.well}" style="background-color:${COLORS.well};border-left:3px solid ${COLORS.ink};border-radius:6px;padding:14px 16px;font-family:${FONT};font-size:14px;line-height:22px;color:${COLORS.text};">` +
          `${label}${multiline(block.text)}</td></tr></table>`,
        text: `${block.label ? `${block.label}\n` : ''}${String(block.text ?? '').trim()}`,
      };
    }
    default:
      throw new Error(`Unknown email block type: ${block.type}`);
  }
}

function renderButton(button) {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px 0;">` +
    `<tr><td align="center" bgcolor="${COLORS.ink}" style="background-color:${COLORS.ink};border-radius:8px;">` +
    `<a href="${escapeHtml(button.url)}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:700;color:${COLORS.buttonText};text-decoration:none;border-radius:8px;background-color:${COLORS.ink};">${escapeHtml(button.label)}</a>` +
    `</td></tr></table>`
  );
}

function renderSecondary(link) {
  return (
    `<p style="margin:0 0 8px 0;font-family:${FONT};font-size:13px;line-height:20px;color:${COLORS.muted};">` +
    `${escapeHtml(link.label)}<br>` +
    `<a href="${escapeHtml(link.url)}" target="_blank" style="color:${COLORS.ink};text-decoration:underline;word-break:break-all;">${escapeHtml(link.url)}</a>` +
    `</p>`
  );
}

// ---- Layout ---------------------------------------------------------------------------------------

/**
 * Render a full email.
 * @param {object} o
 * @param {string} o.preheader   hidden inbox preview line
 * @param {string} o.title
 * @param {string} [o.intro]     short line under the title
 * @param {Array}  [o.blocks]    content blocks: paragraph | small | code | details | note
 * @param {{label:string,url:string}} [o.button]     at most one primary button
 * @param {{label:string,url:string}} [o.secondary]  optional secondary link
 * @param {boolean} [o.notification]  notification emails also link to notification settings
 * @param {string} o.appUrl      FRONTEND_URL
 * @param {string} [o.logoUrl]   PNG logo; the text wordmark when empty
 * @returns {{html:string, text:string}}
 */
export function renderLayout({ preheader, title, intro, blocks = [], button, secondary, notification = false, appUrl, logoUrl }) {
  const app = String(appUrl || '').replace(/\/+$/, '');
  const buttonUrl = button ? absoluteUrl(button.url, app) : '';
  const secondaryUrl = secondary ? absoluteUrl(secondary.url, app) : '';
  const settingsUrl = notification ? `${app}/settings?tab=notifications` : '';
  const rendered = blocks.map(renderBlock);

  const wordmark = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="HACA FORGE" height="28" style="display:block;height:28px;width:auto;border:0;outline:none;text-decoration:none;">`
    : `<span style="font-family:${FONT};font-size:16px;line-height:20px;font-weight:800;letter-spacing:4px;color:${COLORS.ink};">HACA FORGE</span>`;

  const footerLink = (url, label) =>
    `<a href="${escapeHtml(url)}" target="_blank" style="color:${COLORS.muted};text-decoration:underline;">${escapeHtml(label)}</a>`;

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(title)}</title>
<style>
  body { margin:0 !important; padding:0 !important; width:100% !important; }
  a { color:${COLORS.ink}; }
  @media only screen and (max-width:620px) {
    .hf-card { width:100% !important; }
    .hf-pad { padding-left:24px !important; padding-right:24px !important; }
  }
</style>
</head>
<body bgcolor="${COLORS.page}" style="margin:0;padding:0;background-color:${COLORS.page};color:${COLORS.text};">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:${COLORS.page};">${escapeHtml(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.page}" style="background-color:${COLORS.page};">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" class="hf-card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
<tr><td class="hf-pad" style="padding:0 40px 20px 40px;">${wordmark}</td></tr>
<tr><td bgcolor="${COLORS.card}" style="background-color:${COLORS.card};border:1px solid ${COLORS.border};border-radius:16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td class="hf-pad" style="padding:36px 40px 20px 40px;">
<h1 style="margin:0 0 12px 0;font-family:${FONT};font-size:22px;line-height:30px;font-weight:800;letter-spacing:-0.2px;color:${COLORS.ink};">${escapeHtml(title)}</h1>
${intro ? `<p style="${P}color:${COLORS.muted};">${multiline(intro)}</p>` : ''}
${rendered.map((r) => r.html).join('\n')}
${buttonUrl ? renderButton({ label: button.label, url: buttonUrl }) : ''}
${secondaryUrl ? renderSecondary({ label: secondary.label, url: secondaryUrl }) : ''}
</td></tr>
</table>
</td></tr>
<tr><td class="hf-pad" style="padding:24px 40px 0 40px;font-family:${FONT};font-size:12px;line-height:18px;color:${COLORS.muted};">
<p style="margin:0 0 8px 0;color:${COLORS.muted};">${escapeHtml(FOOTER_ACCOUNT_LINE)}${settingsUrl ? ` ${footerLink(settingsUrl, 'Notification settings')}` : ''}</p>
<p style="margin:0;color:${COLORS.muted};">${escapeHtml(FOOTER_ORG)} &middot; ${footerLink(app, app.replace(/^https?:\/\//, ''))}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;

  const textParts = ['HACA FORGE', '', title];
  if (intro) textParts.push('', String(intro).trim());
  for (const r of rendered) textParts.push('', r.text);
  if (buttonUrl) textParts.push('', `${button.label}: ${buttonUrl}`);
  if (secondaryUrl) textParts.push('', `${secondary.label}`, secondaryUrl);
  textParts.push('', '--', FOOTER_ACCOUNT_LINE);
  if (settingsUrl) textParts.push(`Notification settings: ${settingsUrl}`);
  textParts.push(FOOTER_ORG, app);

  return { html, text: `${textParts.join('\n')}\n` };
}
