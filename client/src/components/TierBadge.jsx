import React from 'react';

export function TierBadge({ tier, latencyMs }) {
  if (!tier) return null;

  let badgeClass = 'tier-l1';
  let label = 'L1 Edge (7B)';
  let icon = '⚡';

  if (tier === 'L0_heuristic') {
    badgeClass = 'tier-l0';
    label = 'L0 Heuristic (<15µs)';
    icon = '🚀';
  } else if (tier === 'L2_swarm') {
    badgeClass = 'tier-l2';
    label = 'L2 Swarm (14B)';
    icon = '🧠';
  } else if (tier === 'L3_cloud') {
    badgeClass = 'tier-l3';
    label = 'L3 Cloud';
    icon = '☁️';
  }

  return (
    <span className={`tier-badge ${badgeClass}`} title={`Routed through ${tier}${latencyMs ? ` in ${latencyMs}ms` : ''}`}>
      <span>{icon}</span>
      <span>{label}</span>
      {latencyMs !== undefined && latencyMs !== null && (
        <span style={{ opacity: 0.75, fontSize: '0.65rem' }}>{latencyMs}ms</span>
      )}
    </span>
  );
}

export default TierBadge;
