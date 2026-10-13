/**
 * Security containment and prompt injection sanitizer.
 */
export function sanitizeAgentMessage(message, options = {}) {
  const rawText = typeof message === 'string' ? message : (message?.content || JSON.stringify(message || ''));
  if (!rawText || rawText.trim().length === 0) {
    return { isSafe: true, isInfected: false, sanitizedMessage: "", detectedPatterns: [], riskLevel: 'NONE' };
  }

  const injectionPatterns = [
    { rx: /<\/?(?:system|instruction_override|developer_override)>/gi, name: "System tag breakout attempt", risk: 'CRITICAL' },
    { rx: /<\|(?:im_start|im_end)\|>/gi, name: "ChatML delimiter breakout", risk: 'CRITICAL' },
    { rx: /\[\/?(?:INST|SYS)\]/gi, name: "Llama-style tag injection", risk: 'CRITICAL' },
    { rx: /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|prompts|rules|constraints)\b/gi, name: "Directive override clause", risk: 'CRITICAL' }
  ];

  const detectedPatterns = [];
  let riskLevel = 'NONE';

  for (const pat of injectionPatterns) {
    if (pat.rx.test(rawText)) {
      detectedPatterns.push(pat.name);
      if (pat.risk === 'CRITICAL') riskLevel = 'CRITICAL';
    }
  }

  let sanitized = rawText;
  if (detectedPatterns.length > 0) {
    for (const pat of injectionPatterns) {
      sanitized = sanitized.replace(pat.rx, '[FILTERED]');
    }
  }

  return {
    isSafe: detectedPatterns.length === 0,
    isInfected: detectedPatterns.length > 0,
    sanitizedMessage: sanitized,
    detectedPatterns,
    riskLevel
  };
}
