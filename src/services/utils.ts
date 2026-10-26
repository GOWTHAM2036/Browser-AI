/**
 * Utility functions for the Aria Browser
 */

/**
 * Normalizes a URL string, adding https:// if missing and handling search queries.
 */
export function normalizeUrl(url: string, defaultSearchEngine: string = 'duckduckgo'): string {
  let formattedUrl = url.trim();
  
  // Already has a protocol
  if (/^https?:\/\//i.test(formattedUrl) || /^aria:\/\//i.test(formattedUrl) || /^file:\/\//i.test(formattedUrl)) {
    return formattedUrl;
  }

  // Looks like a domain (has a dot, no spaces)
  if (formattedUrl.includes('.') && !formattedUrl.includes(' ')) {
    return `https://${formattedUrl}`;
  }

  // Fallback to search query
  const query = encodeURIComponent(formattedUrl);
  if (defaultSearchEngine === 'google') return `https://www.google.com/search?q=${query}`;
  if (defaultSearchEngine === 'brave') return `https://search.brave.com/search?q=${query}`;
  return `https://duckduckgo.com/?q=${query}`;
}

/**
 * Extracts and cleans JSON from a string that might contain markdown code fences or comments.
 */
export function extractJsonFromText(text: string): any {
  let clean = text.trim();
  
  // Remove markdown code fences
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/;
  const match = clean.match(fenceRegex);
  if (match) {
    clean = match[1].trim();
  } else {
    clean = clean.replace(/```(?:json)?/g, '').trim();
  }
  
  // Remove C-style comments (block and trailing)
  // Note: This is a simple implementation and might fail on nested structures or complex strings,
  // but it handles most common AI-generated JSON cases.
  clean = clean.replace(/\/\*[\s\S]*?\*\//g, '');
  
  // Only remove trailing comments if they are not part of a URL
  // We look for // that is NOT preceded by : (to avoid https://)
  clean = clean.split('\n').map(line => {
    const commentIndex = line.indexOf('//');
    if (commentIndex !== -1 && (commentIndex === 0 || line[commentIndex - 1] !== ':')) {
      return line.substring(0, commentIndex).trim();
    }
    return line;
  }).join('\n');
  
  clean = clean.trim();
  
  // Find the first '{' and the matching last '}'
  const firstBrace = clean.indexOf('{');
  if (firstBrace === -1) return JSON.parse(clean);
  
  let count = 0;
  let lastBrace = -1;
  for (let i = firstBrace; i < clean.length; i++) {
    if (clean[i] === '{') count++;
    else if (clean[i] === '}') {
      count--;
      if (count === 0) {
        lastBrace = i;
        break;
      }
    }
  }
  
  const jsonStr = lastBrace !== -1 ? clean.substring(firstBrace, lastBrace + 1) : clean.substring(firstBrace);
  return JSON.parse(jsonStr);
}

/**
 * Truncates and cleans page text for AI consumption.
 */
export function cleanPageText(text: string, maxLength = 4000): string {
  const normalized = text
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return normalized.slice(0, maxLength).trimEnd() + '\n[truncated]';
}
