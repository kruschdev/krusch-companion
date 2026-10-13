/**
 * Parse JSON from an AI response string.
 * Strips think tags, markdown code fences, and extracts JSON objects or arrays.
 */
export function parseAIJson(text, options = {}) {
  if (!text || typeof text !== 'string') {
    throw new Error('parseAIJson: input must be a non-empty string');
  }

  const stripped = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json|javascript|js)?\n?/gi, '')
    .replace(/```\n?/g, '')
    .trim();

  try {
    return JSON.parse(stripped);
  } catch {}

  const jsonMatch = stripped.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch {}
  }

  throw new Error(`Failed to parse AI JSON: ${stripped.slice(0, 100)}...`);
}
